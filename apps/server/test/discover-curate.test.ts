// Curation of discovered repositories: the rules, the bulk apply (reject = hidden with a code, approve = link-only entry),
// Openplanet plugins with their openplanet.dev page. In-memory database, no network.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { createCtx } from '../src/ctx.ts';
import type { DiscoveredTable } from '../src/db/db.ts';
import { publicGithubProjects } from '../src/services/discover-github.ts';
import { classify, curateWaiting, applyCuration, bulkDecide, findDuplicates, summarize, type CurateContext, type Facts } from '../src/services/discover-curate.ts';
import { loadSigningKey } from '../src/index/sign.ts';
import { RFC8032_TEST1_SEED } from '../scripts/make-index-fixtures.ts';

const dir = mkdtempSync(join(tmpdir(), 'curate-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const NOW = Date.parse('2026-11-12T12:00:00Z');
const row = (o: Partial<DiscoveredTable> & { full_name: string }): DiscoveredTable => ({
  repo: o.full_name.toLowerCase(), owner: o.full_name.split('/')[0]!, name: o.full_name.split('/')[1]!, description: 'A tool for TrackMania that does a useful thing', html_url: `https://github.com/${o.full_name}`, homepage: null,
  language: 'C#', topics: '["trackmania"]', matched_topics: '["trackmania"]', stars: 0, forks: 0, is_fork: 0, archived: 0, license: null, pushed_at: '2026-06-01T00:00:00Z', created_gh: '2025-01-01T00:00:00Z',
  score: 8, games: '["tmnf"]', has_readme: null, has_releases: null, state: 'new', note: null, project_slug: null, first_seen: '2026-11-01T00:00:00Z', last_seen: '2026-11-01T00:00:00Z', decided_at: null, decided_by: null, ...o,
});
const ctxOf = (opPages: [string, string][] = [], known: string[] = []): CurateContext => ({ known: new Set(known), duplicateOf: new Map(), opPages: new Map(opPages), now: NOW });
const F = (o: Partial<Facts> = {}): Facts => ({ readmeChars: 800, tmMentions: 5, hasRelease: false, at: '2026-11-12T00:00:00Z', ...o });

test('rules: reject, approve and pending with a reason', () => {
  const c = ctxOf();
  assert.equal(classify(row({ full_name: 'a/tool' }), F(), c).code, 'approve');
  assert.equal(classify(row({ full_name: 'a/old', pushed_at: '2019-01-01T00:00:00Z' }), F(), c).bucket, 'pending');
  assert.match(classify(row({ full_name: 'a/old', pushed_at: '2019-01-01T00:00:00Z' }), F(), c).reason, /last push 2019-01-01, 0 stars, no release/);
  assert.equal(classify(row({ full_name: 'a/old', pushed_at: '2019-01-01T00:00:00Z', stars: 3 }), F(), c).bucket, 'approve', '3 stars');
  assert.equal(classify(row({ full_name: 'a/old', pushed_at: '2019-01-01T00:00:00Z' }), F({ hasRelease: true }), c).bucket, 'approve', 'a release');
  assert.equal(classify(row({ full_name: 'a/x', description: null }), F({ readmeChars: 0 }), c).code, 'near-empty');
  assert.equal(classify(row({ full_name: 'a/test-thing' }), F(), c).code, 'template-test');
  assert.equal(classify(row({ full_name: 'a/arch', archived: 1 }), F({ readmeChars: 120 }), c).code, 'archived-no-content');
  assert.equal(classify(row({ full_name: 'a/fk', is_fork: 1 }), F(), c).code, 'fork-no-own-work');
  assert.equal(classify(row({ full_name: 'a/fk', is_fork: 1, stars: 5 }), F(), c).bucket, 'pending', 'a fork with stars is not auto-approved');
  assert.equal(classify(row({ full_name: 'a/cats', description: 'Photos of my cats', topics: '[]' }), F({ tmMentions: 0 }), c).code, 'not-trackmania');
  assert.equal(classify(row({ full_name: 'a/tool' }), F(), ctxOf([], ['a/tool'])).code, 'duplicate-listed');
  assert.equal(classify(row({ full_name: 'a/tool' }), null, c).code, 'unchecked');
});

test('Openplanet plugins: page link when openplanet.dev knows it; AngelScript language tooling is not a plugin', () => {
  const plugin = row({ full_name: 'b/speed', language: 'AngelScript', description: 'Openplanet plugin that shows speed' });
  const withPage = classify(plugin, F(), ctxOf([['b/speed', 'https://openplanet.dev/plugin/speed']]));
  assert.deepEqual([withPage.code, withPage.openplanet, withPage.opPage], ['approve-openplanet', true, 'https://openplanet.dev/plugin/speed']);
  assert.equal(classify(plugin, F(), ctxOf()).opPage, null);
  const tooling = classify(row({ full_name: 'b/ij', language: 'AngelScript', description: 'AngelScript Intellij Plugin Language Support for TrackMania' }), F(), ctxOf());
  assert.equal(tooling.openplanet, false);
});

test('duplicates: same name and description, the one with most stars stays', () => {
  const a = row({ full_name: 'x/lib', stars: 5, description: 'A library for reading ManiaPlanet files' });
  const b = row({ full_name: 'y/lib', stars: 1, description: 'A library for reading ManiaPlanet files' });
  assert.deepEqual([...findDuplicates([a, b])], [['y/lib', 'x/lib']]);
});

test('apply: reject hides with a code, approve creates a link-only project, pending gets a note; bulk by filter', async () => {
  const ctx = await createCtx(loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'sqlite::memory:', STORAGE_DIR: join(dir, 'files'), CRAWLER: '0' }), { key: loadSigningKey(RFC8032_TEST1_SEED) });
  const rows = [row({ full_name: 'a/good', stars: 4 }), row({ full_name: 'a/empty', description: null }), row({ full_name: 'a/old', pushed_at: '2018-01-01T00:00:00Z' }),
    row({ full_name: 'a/plug', language: 'AngelScript', description: 'Openplanet plugin that shows speed', topics: '["openplanet"]', matched_topics: '["openplanet"]' })];
  for (const r of rows) await ctx.db.insertInto('discovered').values(r).execute();
  const facts: Record<string, Facts> = { 'a/good': F(), 'a/empty': F({ readmeChars: 0 }), 'a/old': F(), 'a/plug': F() };
  await ctx.db.insertInto('kv').values({ key: 'curate:facts', value: JSON.stringify(facts) }).execute();
  await ctx.db.insertInto('kv').values({ key: 'curate:oppages', value: JSON.stringify([['a/plug', 'https://openplanet.dev/plugin/plug']]) }).execute();
  const curated = await curateWaiting(ctx);
  const sum = summarize(curated, 5);
  assert.deepEqual([sum.approve.n, sum.reject.n, sum.pending.n], [2, 1, 1]);
  const res = await applyCuration(ctx, curated, 'tester', ['reject', 'approve', 'pending']);
  assert.deepEqual([res.approved, res.rejected, res.pending, res.failed.length], [2, 1, 1, 0], JSON.stringify(res.failed));
  const st = async (repo: string) => ctx.db.selectFrom('discovered').selectAll().where('repo', '=', repo).executeTakeFirstOrThrow();
  assert.equal((await st('a/empty')).state, 'hidden');
  assert.match((await st('a/empty')).note ?? '', /^curate:near-empty: /);
  assert.equal((await st('a/old')).state, 'new');
  assert.match((await st('a/old')).note ?? '', /^curate:pending: last push 2018-01-01/);
  const good = await ctx.db.selectFrom('projects').selectAll().where('source_url', '=', 'https://github.com/a/good').executeTakeFirstOrThrow();
  assert.deepEqual([good.state, Object.keys(JSON.parse(good.installs)).length], ['listed', 0], 'link-only: nothing to install');
  const plug = await ctx.db.selectFrom('projects').selectAll().where('source_url', '=', 'https://github.com/a/plug').executeTakeFirstOrThrow();
  assert.equal(plug.type, 'openplanet-plugin');
  assert.deepEqual(JSON.parse(plug.games), ['tm2020']);
  assert.equal(JSON.parse(plug.links).homepage, 'https://openplanet.dev/plugin/plug');
  assert.equal(JSON.parse(plug.links).source, 'https://github.com/a/plug');
  // what the launcher's per-game "More projects" reads
  const pub = await publicGithubProjects(ctx, { game: 'tm2020', page: 1, limit: 50 });
  const pp = pub.items.find((i) => i.repo === 'a/plug')!;
  assert.deepEqual([pp.type, pp.games, pp.link, pp.openplanetPage], ['openplanet-plugin', ['tm2020'], 'https://openplanet.dev/plugin/plug', 'https://openplanet.dev/plugin/plug']);
  assert.ok(pp.summary && pp.name);
  const pg = pub.items.find((i) => i.repo === 'a/good')!;
  assert.deepEqual([pg.link, pg.openplanetPage], ['https://github.com/a/good', null]);
  assert.equal((await publicGithubProjects(ctx, { game: 'tmuf', page: 1, limit: 50 })).items.some((i) => i.repo === 'a/plug'), false, 'a TM2020 plugin is not listed under the legacy games');
  // the bulk filter button decides for the whole list; a hidden repository comes back with the normal "restore"
  const bulk = await bulkDecide(ctx, ['a/old'], 'hide', 'tester');
  assert.equal(bulk.rejected, 1);
  assert.match((await st('a/old')).note ?? '', /^curate:manual: /);
  await ctx.db.destroy();
});
