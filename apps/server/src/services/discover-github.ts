// Finds TrackMania projects on GitHub that nobody told the hub about, including those with 0 stars.
// Off by default (DISCOVER_GITHUB=1), runs once a day. Only public repository metadata is stored
// (docs/hub/discover-github.md). Results land in the `discovered` table as state "new"; an admin
// accepts them as unclaimed link-only projects, hides them or ignores them for good.
//
// GitHub search limits: 30 requests a minute with a token, 10 without, plus secondary limits
// (403/429 with Retry-After). The run spaces its requests, honours Retry-After and the rate-limit
// headers, backs off on 5xx and keeps an ETag per result page (a 304 costs nothing).
import { createHash } from 'node:crypto';
import { HUB_GAMES, type GameId, type HubProjectType } from '@tm-hub/shared';
import type { Ctx } from '../ctx.ts';
import type { DiscoveredTable } from '../db/db.ts';
import { catalogEntryForRepo, repoIn } from './catalog-seeds.ts';
import { createProject } from './projects.ts';
import { rebuildIndex } from './hubindex.ts';
import { HttpError, notFound, nowIso, parseJson, slugify } from '../util.ts';
import { githubHeaders } from '../sources/github.ts';

// ---------------------------------------------------------------- what to search for

/** GitHub topics that mean "this is about TrackMania". Each one is a search (`topic:x`). */
export const TM_TOPICS = [
  'trackmania', 'trackmania2020', 'trackmania-2020', 'tmnf', 'tmuf', 'tmforever', 'trackmania-forever', 'trackmania-nations', 'trackmania-united',
  'trackmania-nations-forever', 'trackmania-united-forever', 'trackmania-turbo', 'trackmania-2', 'maniaplanet', 'shootmania', 'openplanet', 'tminterface', 'tmlib', 'tmloader',
  'trackmania-exchange', 'nadeo', 'gbx', 'tmx',
] as const;
/** Topics that settle the question on their own (the rest are broad: gbx, tmx, nadeo). */
const STRONG_TOPICS = new Set(['trackmania', 'trackmania2020', 'trackmania-2020', 'tmnf', 'tmuf', 'tmforever', 'trackmania-forever', 'trackmania-nations', 'trackmania-united', 'trackmania-nations-forever',
  'trackmania-united-forever', 'trackmania-turbo', 'trackmania-2', 'maniaplanet', 'shootmania', 'openplanet', 'tminterface', 'tmloader']);

/** Free-text searches (name, description or README). */
export const TM_KEYWORDS = ['trackmania', 'TmForever', 'Openplanet plugin', 'ManiaPlanet', 'Nadeo'] as const;

export function buildQueries(): { id: string; q: string }[] {
  return [
    ...TM_TOPICS.map((t) => ({ id: `topic:${t}`, q: `topic:${t}` })),
    ...TM_KEYWORDS.map((k) => ({ id: `kw:${k}`, q: `"${k}" in:name,description,readme` })),
    { id: 'lang:angelscript', q: 'language:AngelScript trackmania' },
  ];
}

const KEYWORD = /trackmania|track\s?mania|tmforever|tm-?forever|maniaplanet|mania\s?planet|openplanet|tminterface|tm-?interface|nadeo|shootmania|tmloader|tmlib|\b(?:tmnf|tmuf|gbx)\b/i;

// ---------------------------------------------------------------- judging a search hit

/** The parts of a GitHub search item the hub looks at (raw API shape). */
export interface GhItem {
  full_name: string; name: string; description: string | null; html_url: string; homepage: string | null; language: string | null; topics?: string[];
  stargazers_count: number; forks_count: number; fork: boolean; archived: boolean; size: number; pushed_at: string | null; created_at: string | null;
  license?: { spdx_id?: string | null } | null; owner?: { login: string; type?: string }; score?: number; disabled?: boolean;
}

export interface Verdict { keep: boolean; reason: string | null; score: number; matchedTopics: string[] }

/** Score and filter. Score >= 3 = clearly about TrackMania. A README-only hit (1 point) is not enough. */
export function judge(it: GhItem): Verdict {
  const topics = (it.topics ?? []).map((t) => t.toLowerCase());
  const matchedTopics = topics.filter((t) => (TM_TOPICS as readonly string[]).includes(t));
  const strong = matchedTopics.filter((t) => STRONG_TOPICS.has(t));
  let score = 1; // it came out of a search
  score += Math.min(strong.length, 3) * 4 + (matchedTopics.length > strong.length ? 1 : 0);
  if (KEYWORD.test(it.name)) score += 4;
  if (KEYWORD.test(it.description ?? '')) score += 3;
  if (it.language === 'AngelScript') score += 3;
  if (/trackmania|openplanet|tmnf|tmx|exchange/i.test(it.homepage ?? '')) score += 2;
  if (it.stargazers_count > 0) score += 1;
  const v = (keep: boolean, reason: string | null): Verdict => ({ keep, reason, score, matchedTopics });
  if (it.disabled) return v(false, 'disabled');
  if (!it.size) return v(false, it.archived ? 'archived and empty' : 'empty');
  if (score < 3) return v(false, 'weak match (README mention only)');
  return v(true, null);
}

const GAME_BY_TOPIC: [RegExp, GameId[]][] = [
  [/tmforever|trackmania-forever|tmnf|tmuf|nations-forever|united-forever|trackmania-nations|trackmania-united/, ['tmnf', 'tmuf']],
  [/trackmania2020|trackmania-2020|tm2020/, ['tm2020']],
  [/maniaplanet|trackmania-2$|tm2\b/, ['tm2-stadium', 'tm2-canyon', 'tm2-valley', 'tm2-lagoon']],
  [/shootmania/, ['sm-storm']],
  [/turbo/, ['turbo']],
];
/** Games from topics, name and description. `guessed` when nothing pointed anywhere (Trackmania 2020 is then the default). */
export function guessGames(topics: string[], name: string, description: string | null): { games: GameId[]; guessed: boolean } {
  const text = [...topics, name, description ?? ''].join(' ').toLowerCase();
  const out = new Set<GameId>();
  for (const [re, games] of GAME_BY_TOPIC) if (re.test(text)) games.forEach((g) => out.add(g));
  if (/\bopenplanet\b/.test(text) && !out.size) out.add('tm2020');
  if (/\btmnf\b/.test(text)) out.add('tmnf');
  if (/\btmuf\b/.test(text)) out.add('tmuf');
  if (/\btm2020\b|trackmania 2020/.test(text)) out.add('tm2020');
  const games = HUB_GAMES.filter((g) => out.has(g));
  return games.length ? { games, guessed: false } : { games: ['tm2020'], guessed: true };
}

export function guessType(topics: string[], language: string | null): HubProjectType {
  const t = topics.map((x) => x.toLowerCase());
  if (t.includes('openplanet') || language === 'AngelScript') return 'openplanet-plugin';
  if (t.includes('tminterface')) return 'tmi-plugin';
  if (t.includes('tmlib') || t.includes('gbx')) return 'library';
  return 'tool';
}

// ---------------------------------------------------------------- talking to GitHub

export interface DiscoverOptions {
  /** Pages per query (100 results each). GitHub returns at most 1000 results per query. */
  maxPages?: number;
  /** Tests: a clock that does not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Longest wait for a rate-limit reset inside one run; longer ends the run (the job retries later). */
  maxWaitMs?: number;
  /** Only these queries (tests). */
  queries?: { id: string; q: string }[];
  /** Readme checks per run (each is one core API request). */
  maxReadmeChecks?: number;
}

export interface DiscoverSummary { queries: number; requests: number; notModified: number; seen: number; added: number; updated: number; skipped: number; known: number; rateLimited: boolean; error: string | null }

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const PER_PAGE = 100;

class RateLimited extends Error {}

async function kvGet(ctx: Ctx, key: string): Promise<string | null> {
  return (await ctx.db.selectFrom('kv').select('value').where('key', '=', key).executeTakeFirst())?.value ?? null;
}
async function kvSet(ctx: Ctx, key: string, value: string): Promise<void> {
  const r = await ctx.db.updateTable('kv').set({ value }).where('key', '=', key).executeTakeFirst();
  if (!Number(r.numUpdatedRows)) await ctx.db.insertInto('kv').values({ key, value }).execute();
}

/** Spaces search requests: 30/min with a token, 10/min without, a little slower than the limit. */
class Gate {
  private last = 0;
  private gapMs: number;
  private sleep: (ms: number) => Promise<void>;
  constructor(gapMs: number, sleep: (ms: number) => Promise<void>) {
    this.gapMs = gapMs;
    this.sleep = sleep;
  }
  async wait() {
    const wait = this.last + this.gapMs - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.last = Date.now();
  }
}

interface Page { status: number; items: GhItem[]; incomplete: boolean; count: number }

async function searchPage(ctx: Ctx, q: string, page: number, gate: Gate, o: Required<Pick<DiscoverOptions, 'sleep' | 'maxWaitMs'>>, stats: DiscoverSummary): Promise<Page> {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=${PER_PAGE}&page=${page}`;
  const etagKey = 'discover:etag:' + createHash('sha1').update(url).digest('hex').slice(0, 24);
  const prev = parseJson<{ etag: string; n: number } | null>(await kvGet(ctx, etagKey), null);
  for (let attempt = 0; ; attempt++) {
    await gate.wait();
    stats.requests++;
    const r = await ctx.fetch(url, { headers: githubHeaders(ctx, prev ? { 'if-none-match': prev.etag } : {}) });
    if (r.status === 304 && prev) { stats.notModified++; return { status: 304, items: [], incomplete: false, count: prev.n }; }
    const remaining = r.headers.get('x-ratelimit-remaining');
    const reset = Number(r.headers.get('x-ratelimit-reset') ?? 0) * 1000;
    if (r.ok) {
      const j = (await r.json()) as { items?: GhItem[]; incomplete_results?: boolean };
      const items = j.items ?? [];
      const etag = r.headers.get('etag');
      if (etag) await kvSet(ctx, etagKey, JSON.stringify({ etag, n: items.length }));
      // The window is used up: wait for it before the next request instead of running into a 403.
      if (remaining === '0' && reset > Date.now()) {
        const ms = reset - Date.now() + 500;
        if (ms > o.maxWaitMs) throw new RateLimited(`search limit used up, resets in ${Math.round(ms / 1000)} s`);
        await o.sleep(ms);
      }
      return { status: r.status, items, incomplete: !!j.incomplete_results, count: items.length };
    }
    if (r.status === 422) return { status: 422, items: [], incomplete: false, count: 0 };
    const limited = r.status === 429 || (r.status === 403 && (remaining === '0' || r.headers.has('retry-after') || /rate limit|abuse|secondary/i.test(await r.text().catch(() => ''))));
    if (limited || r.status >= 500) {
      if (attempt >= 3) throw limited ? new RateLimited(`GitHub kept refusing (HTTP ${r.status})`) : new Error(`GitHub search: HTTP ${r.status}`);
      const retryAfter = Number(r.headers.get('retry-after'));
      const ms = retryAfter > 0 ? retryAfter * 1000 : limited && reset > Date.now() ? reset - Date.now() + 500 : Math.min(2 ** attempt * 5000, 60_000);
      if (limited && ms > o.maxWaitMs) throw new RateLimited(`GitHub asks to wait ${Math.round(ms / 1000)} s`);
      await o.sleep(ms);
      continue;
    }
    throw new Error(`GitHub search: HTTP ${r.status}`);
  }
}

async function ghCore(ctx: Ctx, path: string): Promise<{ status: number; json: any }> {
  const r = await ctx.fetch(`https://api.github.com${path}`, { headers: githubHeaders(ctx) });
  if (r.status === 403 || r.status === 429) throw new RateLimited(`GitHub core limit (HTTP ${r.status})`);
  return { status: r.status, json: r.ok ? await r.json() : null };
}

// ---------------------------------------------------------------- what is known already

/** Every repository the hub already has: projects (source link, links), GitHub sources, catalog entries. Lower case "owner/repo". */
export async function knownRepos(ctx: Ctx): Promise<Set<string>> {
  const out = new Set<string>();
  const add = (r: string | null | undefined) => { if (r) out.add(r.toLowerCase()); };
  for (const p of await ctx.db.selectFrom('projects').select(['source_url', 'links']).execute()) { add(repoIn(p.source_url)); add(repoIn(parseJson<{ source?: string }>(p.links, {}).source)); }
  for (const s of await ctx.db.selectFrom('sources').select('target').where('kind', '=', 'github').execute()) add(s.target);
  return out;
}

// ---------------------------------------------------------------- one run

const rowOf = (it: GhItem, v: Verdict, at: string): Omit<DiscoveredTable, 'state' | 'first_seen' | 'decided_at' | 'decided_by' | 'project_slug' | 'has_readme' | 'has_releases' | 'note'> => ({
  repo: it.full_name.toLowerCase(), full_name: it.full_name, owner: it.owner?.login ?? it.full_name.split('/')[0], name: it.name, description: (it.description ?? '').slice(0, 400) || null,
  html_url: it.html_url, homepage: it.homepage && /^https:\/\//i.test(it.homepage) ? it.homepage.slice(0, 300) : null, language: it.language, topics: JSON.stringify((it.topics ?? []).slice(0, 30)),
  matched_topics: JSON.stringify(v.matchedTopics), stars: it.stargazers_count, forks: it.forks_count, is_fork: it.fork ? 1 : 0, archived: it.archived ? 1 : 0, license: it.license?.spdx_id && it.license.spdx_id !== 'NOASSERTION' ? it.license.spdx_id : null,
  pushed_at: it.pushed_at, created_gh: it.created_at, score: v.score, games: JSON.stringify(guessGames(it.topics ?? [], it.name, it.description).games), last_seen: at,
});

export async function discoverGithub(ctx: Ctx, opts: DiscoverOptions = {}): Promise<DiscoverSummary> {
  const sleep = opts.sleep ?? realSleep;
  const maxWaitMs = opts.maxWaitMs ?? 120_000;
  const maxPages = opts.maxPages ?? 3;
  const gate = new Gate(ctx.cfg.GITHUB_TOKEN ? 2300 : 6500, sleep);
  const stats: DiscoverSummary = { queries: 0, requests: 0, notModified: 0, seen: 0, added: 0, updated: 0, skipped: 0, known: 0, rateLimited: false, error: null };
  const known = await knownRepos(ctx);
  const at = nowIso();
  const seenThisRun = new Set<string>();
  const candidates: GhItem[] = [];
  try {
    for (const query of opts.queries ?? buildQueries()) {
      stats.queries++;
      for (let page = 1; page <= maxPages; page++) {
        const res = await searchPage(ctx, query.q, page, gate, { sleep, maxWaitMs }, stats);
        for (const it of res.items) {
          const key = it.full_name.toLowerCase();
          if (seenThisRun.has(key)) continue;
          seenThisRun.add(key);
          stats.seen++;
          candidates.push(it);
        }
        if (res.count < PER_PAGE) break;
      }
    }
  } catch (e) {
    stats.rateLimited = e instanceof RateLimited;
    stats.error = (e as Error).message;
  }

  let readmeBudget = opts.maxReadmeChecks ?? (ctx.cfg.GITHUB_TOKEN ? 300 : 20);
  try {
    for (const it of candidates) {
      const repo = it.full_name.toLowerCase();
      const row = await ctx.db.selectFrom('discovered').selectAll().where('repo', '=', repo).executeTakeFirst();
      if (known.has(repo) || catalogEntryForRepo(it.full_name)) {
        // Already a project or catalog entry: never offered. A row that was waiting is closed.
        if (row && row.state === 'new') await ctx.db.updateTable('discovered').set({ state: 'known', last_seen: at }).where('repo', '=', repo).execute();
        else if (!row) await ctx.db.insertInto('discovered').values({ ...rowOf(it, judge(it), at), state: 'known', first_seen: at, decided_at: null, decided_by: null, project_slug: null, has_readme: null, has_releases: null, note: null }).execute();
        stats.known++;
        continue;
      }
      const v = judge(it);
      // Decided rows only get fresh numbers; a skipped one is looked at again when the repository was pushed to.
      if (row && (row.state !== 'skipped' || row.pushed_at === it.pushed_at)) {
        const fresh = rowOf(it, v, at);
        await ctx.db.updateTable('discovered').set({ stars: fresh.stars, forks: fresh.forks, pushed_at: fresh.pushed_at, archived: fresh.archived, description: fresh.description, topics: fresh.topics, matched_topics: fresh.matched_topics, language: fresh.language, last_seen: at }).where('repo', '=', repo).execute();
        stats.updated++;
        continue;
      }
      let skip = v.keep ? null : v.reason;
      let hasReadme: number | null = null;
      let hasReleases: number | null = null;
      if (!skip) {
        try {
          if (it.fork) {
            // A fork is only interesting with releases of its own.
            const rel = await ghCore(ctx, `/repos/${it.full_name}/releases?per_page=1`);
            hasReleases = Array.isArray(rel.json) && rel.json.length ? 1 : 0;
            if (!hasReleases) skip = 'fork without releases';
          }
          if (!skip && readmeBudget > 0) {
            readmeBudget--;
            hasReadme = (await ghCore(ctx, `/repos/${it.full_name}/readme`)).status === 200 ? 1 : 0;
            if (!hasReadme) skip = 'no README';
          }
        } catch (e) {
          if (!(e instanceof RateLimited)) throw e;
          readmeBudget = 0; // README unknown (null): offered anyway, an admin sees it on the card
        }
      }
      const base = { ...rowOf(it, v, at), first_seen: at, decided_at: null, decided_by: null, project_slug: null, has_readme: hasReadme, has_releases: hasReleases };
      if (row) await ctx.db.updateTable('discovered').set({ ...base, first_seen: row.first_seen, state: skip ? 'skipped' : 'new', note: skip }).where('repo', '=', repo).execute();
      else await ctx.db.insertInto('discovered').values({ ...base, state: skip ? 'skipped' : 'new', note: skip }).execute();
      if (skip) stats.skipped++;
      else stats.added++;
    }
  } catch (e) {
    stats.error = stats.error ?? (e as Error).message;
  }
  // Waiting repositories whose README was not checked yet (budget ran out earlier): catch up with what is left of this run's budget.
  if (readmeBudget > 0) {
    const open = await ctx.db.selectFrom('discovered').select('full_name').where('state', '=', 'new').where('has_readme', 'is', null).limit(readmeBudget).execute();
    try {
      for (const r of open) {
        const ok = (await ghCore(ctx, `/repos/${r.full_name}/readme`)).status === 200;
        await ctx.db.updateTable('discovered').set(ok ? { has_readme: 1 } : { has_readme: 0, state: 'skipped', note: 'no README' }).where('repo', '=', r.full_name.toLowerCase()).execute();
      }
    } catch { /* limit reached: the rest next run */ }
  }
  await kvSet(ctx, 'discover:last', JSON.stringify({ at, ...stats }));
  if (stats.added) await ctx.notify({ kind: 'review', text: `GitHub discovery: ${stats.added} new TrackMania project${stats.added === 1 ? '' : 's'} waiting in Admin > Discovered` });
  return stats;
}

/** Scheduled job: once a day when DISCOVER_GITHUB=1; a run that ended on a rate limit is retried after an hour. */
export async function discoverTick(ctx: Ctx, opts: DiscoverOptions = {}): Promise<DiscoverSummary | null> {
  if (!ctx.cfg.DISCOVER_GITHUB) return null;
  const last = parseJson<{ at?: string; error?: string | null } | null>(await kvGet(ctx, 'discover:last'), null);
  const age = last?.at ? Date.now() - Date.parse(last.at) : Infinity;
  if (age < (last?.error ? 3_600_000 : 86_400_000)) return null;
  return discoverGithub(ctx, opts);
}

// ---------------------------------------------------------------- moderation and public list

export interface DiscoveredItem {
  repo: string; fullName: string; owner: string; name: string; description: string | null; url: string; homepage: string | null; language: string | null; topics: string[];
  matchedTopics: string[]; stars: number; forks: number; isFork: boolean; archived: boolean; license: string | null; pushed: string | null; score: number; games: GameId[]; gamesGuessed: boolean;
  hasReadme: boolean | null; state: string; note: string | null; projectSlug: string | null; firstSeen: string;
}

export const toDiscovered = (r: DiscoveredTable): DiscoveredItem => ({
  repo: r.repo, fullName: r.full_name, owner: r.owner, name: r.name, description: r.description, url: r.html_url, homepage: r.homepage, language: r.language, topics: parseJson(r.topics, []),
  matchedTopics: parseJson(r.matched_topics, []), stars: r.stars, forks: r.forks, isFork: !!r.is_fork, archived: !!r.archived, license: r.license, pushed: r.pushed_at, score: r.score,
  games: parseJson(r.games, []), gamesGuessed: guessGames(parseJson(r.topics, []), r.name, r.description).guessed, hasReadme: r.has_readme == null ? null : !!r.has_readme, state: r.state, note: r.note,
  projectSlug: r.project_slug, firstSeen: r.first_seen,
});

export async function listDiscovered(ctx: Ctx, state: string): Promise<DiscoveredItem[]> {
  const rows = await ctx.db.selectFrom('discovered').selectAll().where('state', '=', state).orderBy('score', 'desc').orderBy('stars', 'desc').orderBy('repo').limit(500).execute();
  return rows.map(toDiscovered);
}

export async function discoveredCounts(ctx: Ctx): Promise<Record<string, number>> {
  const rows = await ctx.db.selectFrom('discovered').select(['state']).select((eb) => eb.fn.countAll().as('n')).groupBy('state').execute();
  return Object.fromEntries(rows.map((r) => [r.state, Number(r.n)]));
}

async function freeSlug(ctx: Ctx, name: string, owner: string): Promise<string> {
  const taken = async (s: string) => !!(await ctx.db.selectFrom('projects').select('id').where('slug', '=', s).executeTakeFirst());
  let s = slugify(name);
  if (s.length < 3) s = slugify(`${owner}-${name}`);
  if (!(await taken(s))) return s;
  const withOwner = slugify(`${owner}-${name}`);
  if (!(await taken(withOwner))) return withOwner;
  for (let i = 2; ; i++) { const c = `${withOwner.slice(0, 44)}-${i}`; if (!(await taken(c))) return c; }
}

/** Accepts one discovered repository as an unclaimed, link-only project (no install, no source: the crawler never touches it). */
export async function acceptDiscovered(ctx: Ctx, repo: string, actor: string, over: { games?: GameId[]; type?: HubProjectType } = {}): Promise<string> {
  const row = await ctx.db.selectFrom('discovered').selectAll().where('repo', '=', repo.toLowerCase()).executeTakeFirst();
  if (!row) throw notFound('Not in the discovered list');
  if (row.state === 'accepted' && row.project_slug) return row.project_slug;
  if (row.state === 'known' || row.state === 'skipped') throw new HttpError(409, 'not_offered', 'This repository is not on the list (already a project, or filtered out)');
  if ((await knownRepos(ctx)).has(row.repo)) {
    await ctx.db.updateTable('discovered').set({ state: 'known' }).where('repo', '=', row.repo).execute();
    throw new HttpError(409, 'exists', 'The hub already has a project for this repository');
  }
  const topics = parseJson<string[]>(row.topics, []);
  const games = over.games?.length ? over.games : guessGames(topics, row.name, row.description).games;
  const summary = (row.description ?? '').trim();
  const links: Record<string, string> = { source: row.html_url, issues: `${row.html_url}/issues` };
  if (row.homepage) links.homepage = row.homepage;
  const p = await createProject(ctx, {
    name: row.name.slice(0, 64).padEnd(2, '_'), slug: await freeSlug(ctx, row.name, row.owner), type: over.type ?? guessType(topics, row.language),
    summary: (summary.length >= 10 ? summary : `${row.name} for TrackMania`).slice(0, 200),
    description: `${summary}\n\n*Found on GitHub by the TM Horizon crawler. Link only: the files are on GitHub. Not claimed by its author yet.*`,
    categories: [], tags: [], games, installs: {}, license: row.license, links, dependencies: [], conflicts: [], tmloaderProduct: null,
  }, null, { author_name: row.owner, source_url: row.html_url, state: 'listed' });
  await ctx.db.updateTable('discovered').set({ state: 'accepted', project_slug: p.slug, decided_at: nowIso(), decided_by: actor }).where('repo', '=', row.repo).execute();
  await ctx.audit(actor, 'discovered.accept', row.repo, { slug: p.slug });
  return p.slug;
}

export async function decideDiscovered(ctx: Ctx, repo: string, decision: 'hide' | 'ignore' | 'restore', actor: string): Promise<void> {
  const state = decision === 'hide' ? 'hidden' : decision === 'ignore' ? 'ignored' : 'new';
  const r = await ctx.db.updateTable('discovered').set({ state, decided_at: nowIso(), decided_by: actor }).where('repo', '=', repo.toLowerCase()).where('state', 'in', ['new', 'hidden', 'ignored']).executeTakeFirst();
  if (!Number(r.numUpdatedRows)) throw notFound('Not in the discovered list');
  await ctx.audit(actor, `discovered.${decision}`, repo.toLowerCase());
}

/** Bulk: accept every waiting repository that has at least one matching TrackMania topic. */
export async function acceptWithTopics(ctx: Ctx, actor: string): Promise<{ accepted: string[]; failed: { repo: string; error: string }[] }> {
  const rows = await ctx.db.selectFrom('discovered').selectAll().where('state', '=', 'new').orderBy('score', 'desc').execute();
  const out = { accepted: [] as string[], failed: [] as { repo: string; error: string }[] };
  for (const r of rows) {
    if (!parseJson<string[]>(r.matched_topics, []).length) continue;
    try { await acceptDiscovered(ctx, r.repo, actor); out.accepted.push(r.repo); } catch (e) { out.failed.push({ repo: r.repo, error: (e as Error).message }); }
  }
  if (out.accepted.length) await rebuildIndex(ctx);
  return out;
}

/** Public list for the website: accepted repositories (listed projects), newest push first. */
export async function publicGithubProjects(ctx: Ctx, q: { game?: string; language?: string; q?: string; page: number; limit: number }) {
  let query = ctx.db.selectFrom('discovered').innerJoin('projects', 'projects.slug', 'discovered.project_slug').where('discovered.state', '=', 'accepted').where('projects.state', '=', 'listed');
  if (q.game) query = query.where('discovered.games', 'like', `%"${q.game.replace(/[^a-z0-9-]/g, '')}"%`);
  if (q.language) query = query.where('discovered.language', '=', q.language);
  for (const t of (q.q ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5)) {
    const like = `%${t.replace(/[%_\\]/g, '')}%`;
    query = query.where((eb) => eb.or([eb('discovered.repo', 'like', like), eb('discovered.description', 'like', like), eb('discovered.topics', 'like', like)]));
  }
  const total = Number((await query.select((eb) => eb.fn.countAll().as('n')).executeTakeFirst())?.n ?? 0);
  const rows = await query.selectAll('discovered').select(['projects.claimed as claimed']).orderBy('discovered.pushed_at', 'desc').orderBy('discovered.repo').limit(q.limit).offset((q.page - 1) * q.limit).execute();
  return { total, page: q.page, items: rows.map((r) => ({ ...toPublic(toDiscovered(r)), claimed: !!r.claimed })) };
}

const toPublic = (d: DiscoveredItem) => ({
  repo: d.fullName, name: d.name, owner: d.owner, description: d.description, url: d.url, homepage: d.homepage, language: d.language, topics: d.topics, stars: d.stars, license: d.license,
  archived: d.archived, pushed: d.pushed, games: d.games, slug: d.projectSlug,
});
