// GitHub discovery with a mocked GitHub API: queries, filters, rate limits, ETags, dedupe, moderation, public list.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.ts';
import { createCtx, type Ctx } from '../src/ctx.ts';
import { buildApp } from '../src/app.ts';
import { loadSigningKey } from '../src/index/sign.ts';
import { RFC8032_TEST1_SEED } from '../scripts/make-index-fixtures.ts';
import { createProject } from '../src/services/projects.ts';
import { buildQueries, discoverGithub, discoverTick, guessGames, guessType, judge, type GhItem } from '../src/services/discover-github.ts';

const PORTAL = 'http://localhost:5174';
let app: FastifyInstance;
let ctx: Ctx;
let dir: string;

const item = (full: string, over: Partial<GhItem> = {}): GhItem => ({
  full_name: full, name: full.split('/')[1], description: null, html_url: `https://github.com/${full}`, homepage: null, language: null, topics: [], stargazers_count: 0, forks_count: 0,
  fork: false, archived: false, size: 120, pushed_at: '2026-10-01T00:00:00Z', created_at: '2025-01-01T00:00:00Z', license: null, owner: { login: full.split('/')[0] }, ...over,
});

// What the fake search returns per query; the requests it saw.
const answers: Record<string, GhItem[]> = {
  'topic:trackmania': [
    item('zed/zero-star-tool', { description: 'A tiny tool', topics: ['trackmania', 'tmnf'] }),
    item('zed/op-plugin', { description: 'Speed display', topics: ['openplanet'], language: 'AngelScript', stargazers_count: 3 }),
    item('zed/only-fork', { name: 'only-fork', fork: true, topics: ['trackmania'] }),
    item('zed/fork-with-releases', { fork: true, topics: ['trackmania'], description: 'Fork with its own builds' }),
    item('zed/dead-empty', { archived: true, size: 0, topics: ['trackmania'] }),
    item('zed/no-readme', { topics: ['trackmania'], description: 'Has no readme' }),
    item('zed/already-listed', { topics: ['trackmania'], description: 'Exists as a project' }),
    item('zed/shopping-list', { description: 'My groceries' }),
  ],
  '"Nadeo" in:name,description,readme': [
    item('zed/zero-star-tool', { description: 'A tiny tool', topics: ['trackmania', 'tmnf'] }), // also found by the other query: counted once
    item('zed/random-readme-mention', { description: 'Garden planner', stargazers_count: 0 }),
  ],
};
const seen: { url: string; auth: string | null; inm: string | null }[] = [];
const sleeps: number[] = [];
let limitOnce = true;
const fakeFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  const h = (init.headers ?? {}) as Record<string, string>;
  if (url.startsWith('https://api.github.com/search/repositories')) {
    const q = new URL(url).searchParams.get('q')!;
    seen.push({ url, auth: h.authorization ?? null, inm: h['if-none-match'] ?? null });
    if (q.startsWith('"Nadeo"') && limitOnce) {
      limitOnce = false;
      return new Response('{"message":"You have exceeded a secondary rate limit"}', { status: 403, headers: { 'retry-after': '7' } });
    }
    const etag = `"e-${q}"`;
    if (h['if-none-match'] === etag) return new Response(null, { status: 304 });
    return new Response(JSON.stringify({ total_count: 0, incomplete_results: false, items: answers[q] ?? [] }), { status: 200, headers: { 'content-type': 'application/json', etag, 'x-ratelimit-remaining': '25', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60) } });
  }
  const m = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/(readme|releases)/.exec(url);
  if (m) {
    if (m[2] === 'readme') return new Response(m[1] === 'zed/no-readme' ? '{}' : '{"name":"README.md"}', { status: m[1] === 'zed/no-readme' ? 404 : 200 });
    return new Response(JSON.stringify(m[1] === 'zed/fork-with-releases' ? [{ tag_name: 'v1' }] : []), { status: 200 });
  }
  return new Response('nope', { status: 404 });
}) as typeof fetch;
const fakeSleep = async (ms: number) => { sleeps.push(ms); };

async function login(as: string) {
  const r = await app.inject({ method: 'POST', url: '/auth/dev/login', payload: { as }, headers: { origin: PORTAL } });
  const cookie = r.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const me = await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } });
  return { cookie, 'x-csrf-token': me.json().csrf as string, origin: PORTAL };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hub-discover-'));
  const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'sqlite::memory:', STORAGE_DIR: join(dir, 'files'), HUB_DEV_LOGIN: '1', CRAWLER: '0', GITHUB_TOKEN: 'ghp_test', DISCOVER_GITHUB: '1' });
  ctx = await createCtx(cfg, { fetch: fakeFetch, key: loadSigningKey(RFC8032_TEST1_SEED) });
  app = await buildApp(ctx);
  // A project that already links this repository.
  await createProject(ctx, { name: 'Already listed', slug: 'already-listed', type: 'tool', summary: 'Exists as a project.', description: '', categories: [], tags: [], games: ['tmnf'], installs: {}, license: null, links: { source: 'https://github.com/Zed/Already-Listed' }, dependencies: [], conflicts: [] }, null, { state: 'listed' });
});
after(async () => {
  await app.close();
  await ctx.db.destroy();
  rmSync(dir, { recursive: true, force: true });
});

test('queries: topics, keywords and AngelScript are all searched', () => {
  const qs = buildQueries().map((q) => q.q);
  for (const t of ['tmnf', 'tmuf', 'tmforever', 'trackmania-nations', 'trackmania-united', 'maniaplanet', 'openplanet', 'tminterface', 'tmlib', 'trackmania2020']) assert.ok(qs.includes(`topic:${t}`), t);
  for (const k of ['trackmania', 'TmForever', 'Openplanet plugin', 'ManiaPlanet', 'Nadeo']) assert.ok(qs.some((q) => q.startsWith(`"${k}" in:`)), k);
  assert.ok(qs.includes('language:AngelScript trackmania'));
});

test('judging: a topic or a keyword in name/description counts, a README mention alone does not, empty repositories are out', () => {
  assert.equal(judge(item('a/b', { topics: ['trackmania'] })).keep, true);
  assert.equal(judge(item('a/trackmania-tool')).keep, true);
  assert.equal(judge(item('a/b', { description: 'plugin for Openplanet' })).keep, true);
  assert.equal(judge(item('a/b', { language: 'AngelScript' })).keep, true);
  assert.equal(judge(item('a/b')).keep, false);
  assert.match(judge(item('a/b', { archived: true, size: 0, topics: ['trackmania'] })).reason!, /archived and empty/);
  assert.deepEqual(judge(item('a/b', { topics: ['trackmania', 'tmnf', 'cats'] })).matchedTopics, ['trackmania', 'tmnf']);
  assert.deepEqual(guessGames(['tmnf', 'tmuf'], 'x', null), { games: ['tmnf', 'tmuf'], guessed: false });
  assert.deepEqual(guessGames([], 'x', 'a mod'), { games: ['tm2020'], guessed: true });
  assert.equal(guessType(['openplanet'], null), 'openplanet-plugin');
  assert.equal(guessType([], 'AngelScript'), 'openplanet-plugin');
});

test('a run: filters, dedupe, rate limit wait, token, ETag on the second run', async () => {
  const queries = [{ id: 'a', q: 'topic:trackmania' }, { id: 'b', q: '"Nadeo" in:name,description,readme' }];
  const s = await discoverGithub(ctx, { queries, sleep: fakeSleep, maxPages: 2 });
  assert.equal(s.error, null);
  assert.equal(s.queries, 2);
  assert.ok(sleeps.includes(7000), 'waited the Retry-After of 7 s, got ' + sleeps.join(','));
  assert.ok(seen.every((r) => r.auth === 'Bearer ghp_test'), 'authenticated with the hub token');
  const rows = await ctx.db.selectFrom('discovered').select(['repo', 'state', 'note']).orderBy('repo').execute();
  const by = Object.fromEntries(rows.map((r) => [r.repo, r]));
  assert.equal(by['zed/zero-star-tool'].state, 'new', '0-star repository is offered');
  assert.equal(by['zed/op-plugin'].state, 'new');
  assert.equal(by['zed/fork-with-releases'].state, 'new', 'fork with its own releases is kept');
  assert.equal(by['zed/only-fork'].state, 'skipped');
  assert.equal(by['zed/only-fork'].note, 'fork without releases');
  assert.equal(by['zed/dead-empty'].note, 'archived and empty');
  assert.equal(by['zed/no-readme'].note, 'no README');
  assert.equal(by['zed/already-listed'].state, 'known', 'a repository the hub has is not offered again');
  assert.equal(by['zed/shopping-list'].state, 'skipped');
  assert.equal(by['zed/random-readme-mention'].state, 'skipped');
  assert.equal(s.seen, 9, 'zero-star-tool found by two queries is one candidate');

  // Second run: the same pages answer 304, nothing is added twice.
  seen.length = 0;
  const again = await discoverGithub(ctx, { queries, sleep: fakeSleep, maxPages: 2 });
  assert.equal(again.notModified, 2);
  assert.ok(seen.every((r) => r.inm), 'conditional requests');
  assert.equal((await ctx.db.selectFrom('discovered').select('repo').execute()).length, rows.length);
});

test('a limit that lasts too long ends the run with a flag instead of hanging', async () => {
  limitOnce = true;
  const wait: number[] = [];
  const hit = (async () => new Response('{}', { status: 429, headers: { 'retry-after': '900' } })) as typeof fetch;
  const c2 = { ...ctx, fetch: hit } as Ctx;
  const s = await discoverGithub(c2, { queries: [{ id: 'x', q: 'topic:nothing' }], sleep: async (ms) => { wait.push(ms); }, maxWaitMs: 60_000 });
  assert.equal(s.rateLimited, true);
  assert.deepEqual(wait, [], 'did not sleep 15 minutes');
  // ...and the job tries again after an hour, not a day.
  assert.equal(await discoverTick(ctx, { queries: [], sleep: fakeSleep }), null, 'too early after a run that ended on a limit');
});

test('the daily job: off by default, once a day when on', async () => {
  const off = await createCtx(loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'sqlite::memory:', STORAGE_DIR: join(dir, 'off') }), { fetch: fakeFetch, key: loadSigningKey(RFC8032_TEST1_SEED) });
  assert.equal(await discoverTick(off), null);
  await off.db.destroy();
  const first = await discoverTick(ctx, { queries: [], sleep: fakeSleep });
  assert.equal(first, null, 'the earlier runs were minutes ago');
  await ctx.db.deleteFrom('kv').where('key', '=', 'discover:last').execute();
  assert.ok(await discoverTick(ctx, { queries: [], sleep: fakeSleep }), 'no run recorded: runs');
  assert.equal(await discoverTick(ctx, { queries: [], sleep: fakeSleep }), null, 'and not again the same day');
});

test('moderation: admin list, accept as link-only unclaimed project, hide, ignore, bulk accept by topic, public list', async () => {
  const admin = await login('admin');
  const author = await login('author');
  assert.equal((await app.inject({ method: 'GET', url: '/v1/admin/discovered', headers: { cookie: author.cookie } })).statusCode, 403);
  const list = (await app.inject({ method: 'GET', url: '/v1/admin/discovered', headers: { cookie: admin.cookie } })).json();
  assert.equal(list.enabled, true);
  assert.equal(list.counts.new, 3);
  assert.deepEqual(list.items.map((i: { repo: string }) => i.repo).sort(), ['zed/fork-with-releases', 'zed/op-plugin', 'zed/zero-star-tool']);
  assert.equal(list.items.find((i: { repo: string }) => i.repo === 'zed/zero-star-tool').stars, 0);

  const acc = await app.inject({ method: 'POST', url: '/v1/admin/discovered/zed/op-plugin/accept', payload: {}, headers: admin });
  assert.equal(acc.statusCode, 200, acc.body);
  const p = (await app.inject({ method: 'GET', url: `/v1/projects/${acc.json().slug}` })).json();
  assert.equal(p.claimed, false);
  assert.equal(p.type, 'openplanet-plugin');
  assert.deepEqual(p.installs, {}, 'link only: nothing to install');
  assert.equal(p.sources.length, 0, 'no crawler source');
  assert.equal(p.links.source, 'https://github.com/zed/op-plugin');
  assert.equal(p.author.name ?? p.authorName ?? 'zed', 'zed');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/admin/discovered/zed/op-plugin/accept', payload: {}, headers: admin })).json().slug, acc.json().slug, 'idempotent');

  assert.equal((await app.inject({ method: 'POST', url: '/v1/admin/discovered/zed/fork-with-releases/hide', headers: admin })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/admin/discovered?state=hidden', headers: { cookie: admin.cookie } })).json().items.length, 1);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/admin/discovered/zed/fork-with-releases/restore', headers: admin })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/admin/discovered/zed/nothing/ignore', headers: admin })).statusCode, 404);

  // Bulk: both remaining ones have a matching topic.
  const bulk = (await app.inject({ method: 'POST', url: '/v1/admin/discovered/accept-with-topics', headers: admin })).json();
  assert.deepEqual(bulk.accepted.sort(), ['zed/fork-with-releases', 'zed/zero-star-tool']);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/admin/discovered', headers: { cookie: admin.cookie } })).json().items.length, 0);

  // Ignored forever stays ignored when a later run sees it again.
  await ctx.db.updateTable('discovered').set({ state: 'ignored' }).where('repo', '=', 'zed/shopping-list').execute();
  await discoverGithub(ctx, { queries: [{ id: 'a', q: 'topic:trackmania' }], sleep: fakeSleep });
  assert.equal((await ctx.db.selectFrom('discovered').select('state').where('repo', '=', 'zed/shopping-list').executeTakeFirstOrThrow()).state, 'ignored');

  // Public list for the website.
  const pub = (await app.inject({ method: 'GET', url: '/v1/github-projects?limit=50' })).json();
  assert.equal(pub.total, 3);
  assert.ok(pub.items.every((i: { repo: string; stars: number; games: string[] }) => i.repo.startsWith('zed/') && typeof i.stars === 'number' && i.games.length));
  assert.equal((await app.inject({ method: 'GET', url: '/v1/github-projects?game=tmnf' })).json().total, 1);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/github-projects?language=AngelScript' })).json().total, 1);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/github-projects?q=speed' })).json().total, 1);
});
