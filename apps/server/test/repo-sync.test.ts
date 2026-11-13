// A claimed project takes name, summary, icon, banner, gallery, games and the showcase from its repository;
// browser add-ons keep one file per browser in one version; missing setup is a state, not a source error.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { createCtx } from '../src/ctx.ts';
import { createProject, sourcesOf } from '../src/services/projects.ts';
import { syncFromRepo } from '../src/services/repo-sync.ts';
import { addSource, checkSource } from '../src/sources/crawler.ts';
import { filesOf } from '../src/services/versions.ts';
import { validateShowcase } from '@tm-hub/shared/showcase';
import { loadSigningKey } from '../src/index/sign.ts';
import { RFC8032_TEST1_SEED } from '../scripts/make-index-fixtures.ts';
import { makeDemoPng, makeZip } from './helpers.ts';

const dir = mkdtempSync(join(tmpdir(), 'reposync-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const icon = makeDemoPng(256, 256, [200, 60, 20]);
const hero = makeDemoPng(1280, 720, [30, 120, 200]);
const shot = makeDemoPng(1280, 720, [10, 200, 30]);
const RAW = 'https://raw.githubusercontent.com/acme';
let showcase: Record<string, unknown> = {
  version: 1,
  blocks: [
    { type: 'hero', title: 'Bingo Plugin', tagline: 'Bingo boards inside TrackMania Forever.', image: 'images/cover.png' },
    { type: 'gallery', images: [{ url: 'images/a.png', caption: 'In the game' }] },
    { type: 'compat', rows: [{ game: 'tmnf', status: 'works' }, { game: 'tmuf', status: 'partial' }, { game: 'eswc', status: 'no' }] },
  ],
};
const zip = (n: string) => makeZip([{ name: 'manifest.json', data: `{"name":"${n}","manifest_version":3,"version":"1.0"}` }, { name: 'content.js', data: 'console.log(1)' }]);
const files: Record<string, Buffer> = {
  [`${RAW}/bingo/HEAD/docs/logo/logo-256.png`]: icon, [`${RAW}/bingo/HEAD/images/cover.png`]: hero, [`${RAW}/bingo/HEAD/images/a.png`]: shot,
  'https://dl.example/tool.zip': makeZip([{ name: 'dinput8.dll', data: 'MZ-a' }, { name: 'tool.ini', data: 'x=1' }]),
  'https://dl.example/prod.zip': makeZip([{ name: 'Prod/description.yaml', data: 'name: Prod' }, { name: 'Prod/1.1.0/description.yaml', data: 'version: 1.1.0' }, { name: 'Prod/1.1.0/Prod.dll', data: 'MZ-b' }]),
  'https://dl.example/ext-chrome.zip': zip('chrome'), 'https://dl.example/ext-firefox.zip': zip('firefox'),
};
const fakeFetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url === `${RAW}/bingo/HEAD/showcase.json`) return json(showcase);
  if (files[url]) return new Response(new Uint8Array(files[url]!), { status: 200, headers: { 'content-length': String(files[url]!.length) } });
  if (url.startsWith('https://api.github.com/repos/acme/ext/releases')) {
    return json([{ tag_name: 'v2.7.1', name: '2.7.1', prerelease: false, draft: false, published_at: new Date().toISOString(), body: 'notes', assets: [
      { name: 'Ext-2.7.1-chrome.zip', size: files['https://dl.example/ext-chrome.zip']!.length, browser_download_url: 'https://dl.example/ext-chrome.zip', download_count: 1 },
      { name: 'Ext-2.7.1-firefox.zip', size: files['https://dl.example/ext-firefox.zip']!.length, browser_download_url: 'https://dl.example/ext-firefox.zip', download_count: 1 },
    ] }]);
  }
  if (url.startsWith('https://api.github.com/repos/acme/plain/releases')) return json([{ tag_name: 'v1.0.0', name: '1.0.0', prerelease: false, draft: false, published_at: new Date().toISOString(), body: '', assets: [] }]);
  if (url.startsWith('https://api.github.com/repos/acme/tool/releases')) return json([{ tag_name: 'v1.1.0', name: '1.1.0', prerelease: false, draft: false, published_at: new Date().toISOString(), body: '', assets: [{ name: 'tool-1.1.0.zip', size: files['https://dl.example/tool.zip']!.length, browser_download_url: 'https://dl.example/tool.zip', download_count: 0 }] }]);
  if (url.startsWith('https://api.github.com/repos/acme/prod/releases')) return json([{ tag_name: 'v1.1.0', name: '1.1.0', prerelease: false, draft: false, published_at: new Date().toISOString(), body: '', assets: [{ name: 'prod.zip', size: files['https://dl.example/prod.zip']!.length, browser_download_url: 'https://dl.example/prod.zip', download_count: 0 }] }]);
  if (url.startsWith('https://api.github.com/repos/acme/empty/releases')) return json([]);
  return new Response('not found', { status: 404 });
}) as typeof fetch;

async function setup() {
  const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'sqlite::memory:', STORAGE_DIR: join(dir, `files-${Math.random()}`) });
  return createCtx(cfg, { key: loadSigningKey(RFC8032_TEST1_SEED), fetch: fakeFetch });
}
const base = { categories: [], tags: [], license: null, links: {}, dependencies: [], conflicts: [], tmloaderProduct: null, description: '' };

test('showcase "icon" is optional, an https PNG/WebP on GitHub; old files stay valid', () => {
  const blocks = [{ type: 'hero', title: 'X' }];
  assert.equal(validateShowcase({ version: 1, blocks }).ok, true);
  const ok = validateShowcase({ version: 1, icon: 'https://raw.githubusercontent.com/a/b/HEAD/docs/logo/logo-256.png', blocks });
  assert.equal(ok.ok, true);
  assert.equal(ok.showcase?.icon, 'https://raw.githubusercontent.com/a/b/HEAD/docs/logo/logo-256.png');
  const bad = validateShowcase({ version: 1, icon: 'https://example.org/logo.jpg', blocks });
  assert.equal(bad.ok, false);
  assert.equal(bad.showcase?.icon, undefined, 'lenient: a bad icon is dropped, the rest stays');
});

test('claimed project: the repository wins (name, summary, games, banner, gallery, icon); unchanged repo = no refetch', async () => {
  const ctx = await setup();
  const p = await createProject(ctx, { ...base, name: '100% TMX + Bingo', slug: 'bingo', type: 'mod', summary: 'Seeded catalog text here.', games: ['tmnf'], installs: { tmnf: { kind: 'tmloader-product', strip: 0, include: [] } } }, null, { state: 'listed', catalog_id: 'bingo' });
  await ctx.db.updateTable('projects').set({ claimed: 1 }).where('id', '=', p.id).execute();
  const row = await ctx.db.selectFrom('projects').selectAll().where('id', '=', p.id).executeTakeFirstOrThrow();
  const r = await syncFromRepo(ctx, row, 'acme/bingo', { force: true });
  assert.deepEqual([...r.changed].sort(), ['banner', 'gallery', 'games', 'icon', 'name', 'showcase', 'summary'], JSON.stringify(r));
  const after1 = await ctx.db.selectFrom('projects').selectAll().where('id', '=', p.id).executeTakeFirstOrThrow();
  assert.equal(after1.name, 'Bingo Plugin');
  assert.equal(after1.summary, 'Bingo boards inside TrackMania Forever.');
  assert.deepEqual(JSON.parse(after1.games), ['tmnf', 'tmuf']);
  assert.deepEqual(Object.keys(JSON.parse(after1.installs)).sort(), ['tmnf', 'tmuf'], 'the install of a new game copies the existing one');
  const kinds = (await ctx.db.selectFrom('images').select('kind').where('project_id', '=', p.id).execute()).map((i) => i.kind).sort();
  assert.deepEqual(kinds, ['banner', 'gallery', 'icon']);
  // Nothing changed in the repository: a crawler run (no force) stops after showcase.json.
  const again = await syncFromRepo(ctx, after1, 'acme/bingo');
  assert.equal(again.ran, false);
  // Unclaimed projects are left alone.
  const other = await createProject(ctx, { ...base, name: 'Other', slug: 'other', type: 'mod', summary: 'Seeded catalog text here.', games: ['tmnf'], installs: {} }, null, { state: 'listed' });
  assert.deepEqual((await syncFromRepo(ctx, other, 'acme/bingo')).skipped, ['not claimed']);
  await ctx.db.destroy();
});

test('browser add-on: one version with one file per browser; missing setup is "setupNeeded", not an error', async () => {
  const ctx = await setup();
  const ext = await createProject(ctx, { ...base, name: 'Ext', slug: 'ext', type: 'browser-extension', summary: 'A browser add-on for TMX.', games: ['tmnf'], installs: {} }, null, { state: 'listed' });
  const sid = await addSource(ctx, ext.id, 'github', 'acme/ext', null, null);
  const res = await checkSource(ctx, sid, { force: true });
  assert.deepEqual(res.imported, ['2.7.1'], JSON.stringify(res));
  const v = await ctx.db.selectFrom('versions').selectAll().where('project_id', '=', ext.id).executeTakeFirstOrThrow();
  const fs = filesOf(ctx, v);
  assert.deepEqual(fs.map((f) => f.label).sort(), ['chrome', 'firefox']);
  assert.equal((await ctx.db.selectFrom('sources').select('asset_pattern').where('id', '=', sid).executeTakeFirstOrThrow()).asset_pattern, '[all]');

  const plain = await createProject(ctx, { ...base, name: 'Plain', slug: 'plain', type: 'mod', summary: 'A mod without games yet.', games: ['tmnf'], installs: {} }, null, { state: 'listed' });
  const ps = await addSource(ctx, plain.id, 'github', 'acme/plain', null, null);
  const r2 = await checkSource(ctx, ps, { force: true });
  assert.equal(r2.error, null);
  const [src] = await sourcesOf(ctx, plain.id);
  assert.equal(src!.lastError, null);
  assert.equal(src!.setupNeeded, true);
  await ctx.db.destroy();
});

test('setup is derived: games from showcase compat, install type from the release zip; nothing to set up without releases', async () => {
  const ctx = await setup();
  const mk = async (slug: string, type: 'tool' | 'mod') => {
    const p = await createProject(ctx, { ...base, name: slug, slug, type, summary: 'A project that needs its setup.', games: ['tmnf'], installs: {} }, null, { state: 'listed' });
    return { p, sid: await addSource(ctx, p.id, 'github', `acme/${slug}`, null, null) };
  };
  const t = await mk('tool', 'tool');
  const r1 = await checkSource(ctx, t.sid, { force: true });
  assert.deepEqual(r1.imported, ['1.1.0'], JSON.stringify(r1));
  const tp = await ctx.db.selectFrom('projects').select('installs').where('id', '=', t.p.id).executeTakeFirstOrThrow();
  assert.deepEqual(JSON.parse(tp.installs), { tmnf: { kind: 'files', base: 'game', strip: 0, include: [] } });
  assert.equal((await sourcesOf(ctx, t.p.id))[0]!.setupNeeded, undefined);

  const m = await mk('prod', 'mod');
  assert.deepEqual((await checkSource(ctx, m.sid, { force: true })).imported, ['1.1.0']);
  const mp = await ctx.db.selectFrom('projects').select('installs').where('id', '=', m.p.id).executeTakeFirstOrThrow();
  assert.equal(JSON.parse(mp.installs).tmnf.kind, 'tmloader-product');

  const e = await mk('empty', 'tool');
  await checkSource(ctx, e.sid, { force: true });
  assert.equal((await sourcesOf(ctx, e.p.id))[0]!.setupNeeded, undefined, 'no release, nothing to set up');
  // a release that cannot be read says why, in one line
  const plain = await mk('plain', 'mod');
  await checkSource(ctx, plain.sid, { force: true });
  const [ps] = await sourcesOf(ctx, plain.p.id);
  assert.equal(ps!.setupNeeded, true);
  assert.match(ps!.setupReason ?? '', /Install type missing/);
  await ctx.db.destroy();
});

test('the icon file is looked at on every check, not only when showcase.json changed', async () => {
  const ctx = await setup();
  const p = await createProject(ctx, { ...base, name: 'Bingo', slug: 'bingo2', type: 'mod', summary: 'Seeded catalog text here.', games: ['tmnf'], installs: { tmnf: { kind: 'tmloader-product', strip: 0, include: [] } } }, null, { state: 'listed' });
  await ctx.db.updateTable('projects').set({ claimed: 1 }).where('id', '=', p.id).execute();
  const row = () => ctx.db.selectFrom('projects').selectAll().where('id', '=', p.id).executeTakeFirstOrThrow();
  const key = `${RAW}/bingo/HEAD/docs/logo/logo-256.png`;
  const saved = files[key]; delete files[key];
  try {
    assert.ok(!(await syncFromRepo(ctx, await row(), 'acme/bingo', { force: true })).changed.includes('icon'));
    files[key] = saved!; // the logo PR is merged later; showcase.json is the same
    const r = await syncFromRepo(ctx, await row(), 'acme/bingo');
    assert.equal(r.ran, false);
    assert.deepEqual(r.changed, ['icon']);
  } finally { files[key] = saved!; }
  await ctx.db.destroy();
});
