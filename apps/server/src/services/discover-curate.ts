// Bulk curation of the discovered GitHub repositories (docs/hub/curation.md). Every waiting repository ("new") lands in
// one of three buckets, with a reason code and a one-line reason:
//   reject   hidden with the code in the note (reversible: "Back to the list" in the portal), never deleted;
//   approve  accepted as a link-only entry (text and link, no third-party pictures; authors can claim or remove it);
//   pending  stays waiting for the owner, with the reason why it is neither.
// The rules are a pure function (classify) over the stored metadata plus a few facts fetched from GitHub once
// (README size and TrackMania mentions, any release) and the openplanet.dev plugin list. Only public metadata.
import type { Ctx } from '../ctx.ts';
import type { DiscoveredTable } from '../db/db.ts';
import { githubHeaders } from '../sources/github.ts';
import { acceptDiscovered, knownRepos } from './discover-github.ts';
import { rebuildIndex } from './hubindex.ts';
import { nowIso, parseJson } from '../util.ts';

export type Bucket = 'reject' | 'approve' | 'pending';
export interface Decision { bucket: Bucket; code: string; reason: string; openplanet: boolean; opPage: string | null }

/** What GitHub told about one repository (null = not asked or the limit was reached). */
export interface Facts { readmeChars: number | null; tmMentions: number | null; hasRelease: boolean | null; at: string }

export interface CurateContext {
  known: Set<string>;
  /** repo -> the better repository with the same name and description. */
  duplicateOf: Map<string, string>;
  /** repo -> its openplanet.dev page. */
  opPages: Map<string, string>;
  now: number;
}

export const KEYWORD_G = /trackmania|track\s?mania|tmforever|tm-?forever|maniaplanet|mania\s?planet|openplanet|tminterface|tm-?interface|nadeo|shootmania|tmloader|tmlib|\b(?:tmnf|tmuf|gbx)\b/gi;
const KEYWORD = new RegExp(KEYWORD_G.source, 'i');
const TEMPLATE = /^(test|testing|tests|template|example|examples|sample|hello[-_ ]?world|demo|my[-_ ]?(first|project|repo|plugin)|untitled|tmp|temp|playground|sandbox|learning|practice)([-_ .\d]|$)/i;
const YEARS3 = 3 * 365 * 86_400_000;

/** An Openplanet plugin: the openplanet.dev list names it, or it says so, or it is AngelScript for TrackMania (not editor tooling for the language). */
export const isOpenplanet = (r: DiscoveredTable, opPage: string | null = null) => {
  if (opPage) return true;
  const text = `${r.name} ${r.description ?? ''}`;
  if (parseJson<string[]>(r.topics, []).some((t) => t.toLowerCase() === 'openplanet') || /openplanet/i.test(text)) return !/vs ?code|intellij|language server|syntax|grammar/i.test(text);
  return r.language === 'AngelScript' && !/vs ?code|intellij|language server|syntax|grammar|highlight|editor|jetbrains/i.test(text);
};

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : 'never');

export function classify(r: DiscoveredTable, f: Facts | null, c: CurateContext): Decision {
  const opPage = c.opPages.get(r.repo) ?? null;
  const op = isOpenplanet(r, opPage);
  const d = (bucket: Bucket, code: string, reason: string): Decision => ({ bucket, code, reason, openplanet: op, opPage });
  const stars = r.stars;
  const desc = (r.description ?? '').trim();
  const pushed = r.pushed_at ? Date.parse(r.pushed_at) : NaN;
  const hasRelease = f?.hasRelease ?? (r.has_releases == null ? null : !!r.has_releases);
  const readme = f?.readmeChars ?? null;

  if (c.known.has(r.repo)) return d('reject', 'duplicate-listed', 'The hub already lists a project for this repository');
  const dup = c.duplicateOf.get(r.repo);
  if (dup) return d('reject', 'duplicate', `Same name and description as ${dup}, which is the better one`);
  if (!f) return d('pending', 'unchecked', 'README and releases not checked yet (run the facts step)');

  if (r.is_fork && stars < 3 && !hasRelease) return d('reject', 'fork-no-own-work', 'Fork without stars or releases of its own');
  if (TEMPLATE.test(r.name) && stars < 3 && !hasRelease) return d('reject', 'template-test', `Name "${r.name}" looks like a template or test repository`);
  if (!readme && !desc && stars < 3 && !hasRelease) return d('reject', 'near-empty', 'No README, no description, no stars, no release');
  if ((readme ?? 0) < 100 && !desc && stars === 0 && !hasRelease) return d('reject', 'near-empty', 'README under 100 characters and no description');
  if (r.archived && stars < 3 && !hasRelease && (readme ?? 0) < 500) return d('reject', 'archived-no-content', 'Archived, no stars, no release, hardly any README');
  const named = KEYWORD.test(r.name) || KEYWORD.test(desc) || parseJson<string[]>(r.topics, []).some((t) => KEYWORD.test(t));
  if (!named && (f.tmMentions ?? 0) < 2 && !op) return d('reject', 'not-trackmania', 'Name, description and topics never say TrackMania, the README hardly does');

  const content = (readme ?? 0) >= 100 || desc.length >= 10;
  const recent = Number.isFinite(pushed) && c.now - pushed < YEARS3;
  if (!r.is_fork && content && (recent || stars >= 3 || hasRelease)) {
    return d('approve', op ? 'approve-openplanet' : 'approve', `${recent ? `pushed ${day(r.pushed_at)}` : stars >= 3 ? `${stars} stars` : 'has a release'}${op ? (opPage ? ', Openplanet plugin with an openplanet.dev page' : ', Openplanet plugin (repository link)') : ''}`);
  }
  const why: string[] = [];
  if (r.is_fork) why.push('fork');
  if (!content) why.push('no usable README or description');
  if (!recent && stars < 3 && !hasRelease) why.push(`last push ${day(r.pushed_at)}, ${stars} star${stars === 1 ? '' : 's'}, no release`);
  return d('pending', 'review', why.join('; ') || 'needs a look');
}

// ---------------------------------------------------------------- facts from GitHub

const factKey = 'curate:facts';
export async function loadFacts(ctx: Ctx): Promise<Record<string, Facts>> {
  const row = await ctx.db.selectFrom('kv').select('value').where('key', '=', factKey).executeTakeFirst();
  return parseJson<Record<string, Facts>>(row?.value, {});
}
async function saveFacts(ctx: Ctx, facts: Record<string, Facts>) {
  const value = JSON.stringify(facts);
  const r = await ctx.db.updateTable('kv').set({ value }).where('key', '=', factKey).executeTakeFirst();
  if (!Number(r.numUpdatedRows)) await ctx.db.insertInto('kv').values({ key: factKey, value }).execute();
}

/** README size and TrackMania mentions, and whether the repository has a release. Asks GitHub for what is missing or older than 3 days. */
export async function gatherFacts(ctx: Ctx, rows: DiscoveredTable[], opts: { concurrency?: number; maxAgeMs?: number; log?: (s: string) => void } = {}): Promise<Record<string, Facts>> {
  const facts = await loadFacts(ctx);
  const maxAge = opts.maxAgeMs ?? 3 * 86_400_000;
  const todo = rows.filter((r) => !facts[r.repo] || Date.now() - Date.parse(facts[r.repo]!.at) > maxAge);
  let i = 0;
  let stop = false;
  const readmeOf = async (full: string): Promise<{ chars: number; hits: number }> => {
    const res = await ctx.fetch(`https://api.github.com/repos/${full}/readme`, { headers: githubHeaders(ctx, { accept: 'application/vnd.github.raw+json' }) });
    if (res.status === 404) return { chars: 0, hits: 0 };
    if (res.status === 403 || res.status === 429) { stop = true; throw new Error('rate limit'); }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = (await res.text()).slice(0, 60_000);
    return { chars: text.trim().length, hits: (text.match(KEYWORD_G) ?? []).length };
  };
  const releaseOf = async (full: string): Promise<boolean> => {
    const res = await ctx.fetch(`https://api.github.com/repos/${full}/releases?per_page=1`, { headers: githubHeaders(ctx) });
    if (res.status === 404) return false;
    if (res.status === 403 || res.status === 429) { stop = true; throw new Error('rate limit'); }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = (await res.json()) as unknown[];
    return Array.isArray(j) && j.length > 0;
  };
  const worker = async () => {
    while (!stop) {
      const r = todo[i++];
      if (!r) return;
      try {
        const [rd, rel] = [await readmeOf(r.full_name), await releaseOf(r.full_name)];
        facts[r.repo] = { readmeChars: rd.chars, tmMentions: rd.hits, hasRelease: rel, at: nowIso() };
      } catch (e) { opts.log?.(`${r.full_name}: ${(e as Error).message}`); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 4, todo.length) }, worker));
  if (todo.length) await saveFacts(ctx, facts);
  return facts;
}

/** openplanet.dev plugin list -> repo (lower case) to plugin page, from the source links of the plugins. */
export async function openplanetPages(ctx: Ctx, log?: (s: string) => void): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    for (let page = 1, pages = 1; page <= pages && page <= 200; page++) {
      const r = await ctx.fetch(`https://openplanet.dev/api/plugins?page=${page}`, { headers: { 'user-agent': 'TM-Horizon-hub (+https://tm-horizon.com)', accept: 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { pages?: number; items?: { url?: string; identifier?: string; links?: Record<string, unknown> }[] };
      pages = Math.max(1, Number(j.pages) || 1);
      for (const x of j.items ?? []) {
        const pageUrl = `https://openplanet.dev/${String(x.url ?? `plugin/${x.identifier ?? ''}`).replace(/^\//, '')}`;
        if (!/^https:\/\/openplanet\.dev\/plugin\/[\w.-]+$/.test(pageUrl)) continue;
        for (const v of Object.values(x.links ?? {})) {
          const m = typeof v === 'string' ? /github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?(?:[/#?].*)?$/i.exec(v) : null;
          if (m) out.set(m[1]!.toLowerCase(), pageUrl);
        }
      }
      await new Promise((res) => setTimeout(res, 300));
    }
  } catch (e) { log?.(`openplanet.dev: ${(e as Error).message}`); }
  return out;
}

// ---------------------------------------------------------------- the whole run

export interface CuratedRow { row: DiscoveredTable; decision: Decision }

/** Same name and description (20+ characters) as another waiting or accepted repository: the one with most stars (then newest push) stays. */
export function findDuplicates(rows: DiscoveredTable[]): Map<string, string> {
  const groups = new Map<string, DiscoveredTable[]>();
  for (const r of rows) {
    const d = (r.description ?? '').trim().toLowerCase();
    if (d.length < 20) continue;
    const k = `${r.name.toLowerCase()}\u0000${d}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  const out = new Map<string, string>();
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => (b.state === 'accepted' ? 1 : 0) - (a.state === 'accepted' ? 1 : 0) || b.stars - a.stars || (b.pushed_at ?? '').localeCompare(a.pushed_at ?? '') || a.repo.localeCompare(b.repo));
    for (const r of g.slice(1)) if (r.state === 'new') out.set(r.repo, g[0]!.full_name);
  }
  return out;
}

export async function curateWaiting(ctx: Ctx, opts: { gather?: boolean; log?: (s: string) => void } = {}): Promise<CuratedRow[]> {
  const waiting = await ctx.db.selectFrom('discovered').selectAll().where('state', '=', 'new').orderBy('repo').execute();
  const accepted = await ctx.db.selectFrom('discovered').selectAll().where('state', '=', 'accepted').execute();
  const facts = opts.gather ? await gatherFacts(ctx, waiting, { log: opts.log }) : await loadFacts(ctx);
  const opPages = opts.gather ? await openplanetPages(ctx, opts.log) : new Map<string, string>(parseJson<[string, string][]>((await ctx.db.selectFrom('kv').select('value').where('key', '=', 'curate:oppages').executeTakeFirst())?.value, []));
  if (opts.gather) {
    const value = JSON.stringify([...opPages]);
    const r = await ctx.db.updateTable('kv').set({ value }).where('key', '=', 'curate:oppages').executeTakeFirst();
    if (!Number(r.numUpdatedRows)) await ctx.db.insertInto('kv').values({ key: 'curate:oppages', value }).execute();
  }
  const c: CurateContext = { known: await knownRepos(ctx), duplicateOf: findDuplicates([...waiting, ...accepted]), opPages, now: Date.now() };
  return waiting.map((row) => ({ row, decision: classify(row, facts[row.repo] ?? null, c) }));
}

export interface ApplyResult { rejected: number; approved: number; pending: number; failed: { repo: string; error: string }[] }

/** Applies the buckets asked for. Reject = hidden with the code in the note; approve = link-only project; pending = the one-line reason as the note. */
export async function applyCuration(ctx: Ctx, curated: CuratedRow[], actor: string, buckets: Bucket[]): Promise<ApplyResult> {
  const res: ApplyResult = { rejected: 0, approved: 0, pending: 0, failed: [] };
  for (const { row, decision: d } of curated) {
    if (!buckets.includes(d.bucket)) continue;
    try {
      if (d.bucket === 'reject') {
        await ctx.db.updateTable('discovered').set({ state: 'hidden', note: `curate:${d.code}: ${d.reason}`.slice(0, 300), decided_at: nowIso(), decided_by: actor }).where('repo', '=', row.repo).where('state', '=', 'new').execute();
        await ctx.audit(actor, 'discovered.curate-reject', row.repo, { code: d.code });
        res.rejected++;
      } else if (d.bucket === 'approve') {
        await acceptDiscovered(ctx, row.repo, actor, d.openplanet ? { type: 'openplanet-plugin', games: openplanetGames(row), homepage: d.opPage ?? undefined, openplanet: true } : {});
        await ctx.audit(actor, 'discovered.curate-approve', row.repo, { code: d.code });
        res.approved++;
      } else {
        await ctx.db.updateTable('discovered').set({ note: `curate:pending: ${d.reason}`.slice(0, 300) }).where('repo', '=', row.repo).where('state', '=', 'new').execute();
        res.pending++;
      }
    } catch (e) { res.failed.push({ repo: row.repo, error: (e as Error).message }); }
  }
  if (res.approved) await rebuildIndex(ctx);
  return res;
}

/** Openplanet plugins: TM2020 unless the topics or text say ManiaPlanet or Turbo. */
function openplanetGames(row: DiscoveredTable): ('tm2020' | 'tm2-stadium' | 'tm2-canyon' | 'tm2-valley' | 'tm2-lagoon' | 'turbo')[] {
  const text = `${row.topics} ${row.name} ${row.description ?? ''}`.toLowerCase();
  if (/maniaplanet|trackmania-2\b|tm2\b/.test(text) && !/2020/.test(text)) return ['tm2-stadium', 'tm2-canyon', 'tm2-valley', 'tm2-lagoon'];
  if (/turbo/.test(text) && !/2020/.test(text)) return ['turbo'];
  return ['tm2020'];
}

/** Bulk decision of an admin for the repositories of a portal filter: accept (link-only entries) or hide with the reason "manual". */
export async function bulkDecide(ctx: Ctx, repos: string[], action: 'accept' | 'hide', actor: string): Promise<ApplyResult> {
  const want = new Set(repos.map((r) => r.toLowerCase()));
  const curated = (await curateWaiting(ctx)).filter((c) => want.has(c.row.repo)).map((c) => ({
    row: c.row,
    decision: action === 'accept' ? { ...c.decision, bucket: 'approve' as const } : { ...c.decision, bucket: 'reject' as const, code: 'manual', reason: 'Hidden by an admin (bulk)' },
  }));
  return applyCuration(ctx, curated, actor, ['approve', 'reject']);
}

export function summarize(curated: CuratedRow[], examples = 15) {
  const buckets: Record<Bucket, { n: number; codes: Record<string, number>; examples: { name: string; url: string; reason: string; code: string }[] }> = {
    reject: { n: 0, codes: {}, examples: [] }, approve: { n: 0, codes: {}, examples: [] }, pending: { n: 0, codes: {}, examples: [] },
  };
  for (const { decision: d } of curated) {
    const b = buckets[d.bucket];
    b.n++;
    b.codes[d.code] = (b.codes[d.code] ?? 0) + 1;
  }
  for (const k of ['reject', 'approve', 'pending'] as Bucket[]) {
    // spread the examples over the codes, most stars first inside a code
    const byCode = new Map<string, CuratedRow[]>();
    for (const c of curated.filter((x) => x.decision.bucket === k)) (byCode.get(c.decision.code) ?? byCode.set(c.decision.code, []).get(c.decision.code)!).push(c);
    const lists = [...byCode.values()].map((l) => l.sort((a, b) => b.row.stars - a.row.stars));
    for (let i = 0; buckets[k].examples.length < examples && lists.some((l) => l[i]); i++) {
      for (const l of lists) if (l[i] && buckets[k].examples.length < examples) buckets[k].examples.push({ name: l[i]!.row.full_name, url: l[i]!.row.html_url, reason: l[i]!.decision.reason, code: l[i]!.decision.code });
    }
  }
  return buckets;
}
