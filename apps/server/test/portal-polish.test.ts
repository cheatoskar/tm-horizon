// Portal polish (2026-11-11): project types, the opt-in import preview, catalog seed showcases,
// what "Downloads" counts (hub installs once per installation and day + GitHub release downloads),
// and the browser extension rules of the checks.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { projectTypeOfCatalog, type HubIndexPayload, type HubProject, type SignedHubIndex, type SourcePreview } from '@tm-hub/shared';
import { loadConfig } from '../src/config.ts';
import { createCtx, type Ctx } from '../src/ctx.ts';
import { buildApp } from '../src/app.ts';
import { loadSigningKey } from '../src/index/sign.ts';
import { RFC8032_TEST1_SEED } from '../scripts/make-index-fixtures.ts';
import { createProject } from '../src/services/projects.ts';
import { approveVersion, ingestVersion } from '../src/services/versions.ts';
import { downloaderKey } from '../src/routes/public.ts';
import { runChecks } from '../src/checks/pipeline.ts';
import { catalogEntryForRepo, seedShowcase, seedShowcaseFor } from '../src/services/catalog-seeds.ts';
import { refreshGithubDownloads } from '../src/sources/crawler.ts';
import { makeDemoPng, makePe, makeZip, tmloaderZip } from './helpers.ts';

let app: FastifyInstance;
let ctx: Ctx;
let dir: string;
const PORTAL = 'http://localhost:5174';

// Fake GitHub: a browser extension with one file per browser, pictures in the README and the release, a Discord invite.
const manifest = JSON.stringify({ manifest_version: 3, name: 'Ext', version: '2.0.0', permissions: ['storage'], host_permissions: ['https://tmnf.exchange/*'] });
const extZip = makeZip([{ name: 'manifest.json', data: manifest }, { name: 'content.js', data: 'document.title += "!";' }, { name: 'popup.html', data: '<p>hi</p>' }]);
const png = makeDemoPng(1280, 720, [30, 120, 200]);
const releases = [
  { tag_name: 'v2.0.0', prerelease: false, draft: false, body: 'Two', published_at: '2026-11-01T00:00:00Z', assets: [
    { name: 'Ext-2.0.0-chrome.zip', size: extZip.length, download_count: 120, browser_download_url: 'https://dl.example/chrome.zip' },
    { name: 'Ext-2.0.0-firefox.zip', size: extZip.length, download_count: 30, browser_download_url: 'https://dl.example/firefox.zip' },
    { name: 'screenshot.png', size: png.length, download_count: 999, browser_download_url: 'https://dl.example/shot.png' },
    { name: 'checksums.txt', size: 10, download_count: 5, browser_download_url: 'https://dl.example/sums.txt' }] },
  { tag_name: 'v1.0.0', prerelease: false, draft: false, body: 'One', published_at: '2026-10-01T00:00:00Z', assets: [
    { name: 'Ext-1.0.0-chrome.zip', size: extZip.length, download_count: 50, browser_download_url: 'https://dl.example/chrome1.zip' }] },
];
const fakeFetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json', etag: '"e1"' } });
  if (url === 'https://api.github.com/repos/someone/ext') return json({ full_name: 'someone/ext', name: 'ext', description: 'A browser extension for TMX', homepage: '', license: { spdx_id: 'MIT' }, owner: { login: 'someone' }, html_url: 'https://github.com/someone/ext', topics: ['browser-extension'], archived: false, default_branch: 'main' });
  if (url.startsWith('https://api.github.com/repos/someone/ext/releases')) return json(releases);
  if (url === 'https://api.github.com/repos/someone/ext/readme') return new Response('# Ext\n\n![shot](docs/a.png)\n\nJoin us: https://discord.gg/abcd1234\n', { status: 200 });
  if (url.includes('/contents/docs/images')) return new Response('[]', { status: 404 });
  if (url === 'https://raw.githubusercontent.com/someone/ext/main/docs/a.png' || url === 'https://dl.example/shot.png') return new Response(new Uint8Array(png), { status: 200 });
  if (url.startsWith('https://dl.example/') && url.endsWith('.zip')) return new Response(new Uint8Array(extZip), { status: 200 });
  return new Response('nope', { status: 404 });
}) as typeof fetch;

type Agent = { cookie: string; csrf: string };
async function login(as: string): Promise<Agent> {
  const r = await app.inject({ method: 'POST', url: '/auth/dev/login', payload: { as }, headers: { origin: PORTAL } });
  assert.equal(r.statusCode, 200, r.body);
  const cookie = r.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const me = await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } });
  return { cookie, csrf: me.json().csrf };
}
const H = (a: Agent) => ({ cookie: a.cookie, 'x-csrf-token': a.csrf, origin: PORTAL });
const indexPayload = async () => JSON.parse(Buffer.from(((await app.inject({ method: 'GET', url: '/v1/index.json' })).json() as SignedHubIndex).payload, 'base64').toString('utf8')) as HubIndexPayload;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hub-polish-'));
  const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'sqlite::memory:', STORAGE_DIR: join(dir, 'files'), HUB_DEV_LOGIN: '1', CRAWLER: '0' });
  ctx = await createCtx(cfg, { fetch: fakeFetch, key: loadSigningKey(RFC8032_TEST1_SEED) });
  app = await buildApp(ctx);
});
after(async () => {
  await app.close();
  await ctx.db.destroy();
  rmSync(dir, { recursive: true, force: true });
});

test('project type: required when an author creates a project, catalog types map onto it', async () => {
  const author = await login('author');
  const input = { name: 'Typed', slug: 'typed-mod', summary: 'A project with a type.', description: '', categories: [], tags: [], games: ['tmnf'], installs: {}, license: null, links: {}, dependencies: [], conflicts: [] };
  assert.equal((await app.inject({ method: 'POST', url: '/v1/projects', payload: input, headers: H(author) })).statusCode, 400);
  const ok = await app.inject({ method: 'POST', url: '/v1/projects', payload: { ...input, type: 'texture-pack' }, headers: H(author) });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal((ok.json() as HubProject).type, 'texture-pack');
  const patched = await app.inject({ method: 'PATCH', url: '/v1/projects/typed-mod', payload: { type: 'skin' }, headers: H(author) });
  assert.equal((patched.json() as HubProject).type, 'skin');
  assert.equal((await app.inject({ method: 'PATCH', url: '/v1/projects/typed-mod', payload: { type: 'nonsense' }, headers: H(author) })).statusCode, 400);

  assert.equal(projectTypeOfCatalog('browser-addon', 'browser-addon'), 'browser-extension');
  assert.equal(projectTypeOfCatalog('skins', 'texturepack'), 'texture-pack');
  assert.equal(projectTypeOfCatalog('tool', 'tas'), 'tas');
  assert.equal(projectTypeOfCatalog('tool', 'server'), 'server');
  assert.equal(projectTypeOfCatalog('mod', 'plugin'), 'openplanet-plugin');
  assert.equal(projectTypeOfCatalog('tas-plugin', null), 'tmi-plugin');
  assert.equal(projectTypeOfCatalog('events', null), 'event');
  assert.equal(projectTypeOfCatalog('mod', 'hud'), 'mod');
});

test('catalog seed showcases: found by repository and name, offered on the project', async () => {
  assert.equal(catalogEntryForRepo('cheatoskar/TM-Vibrant-Shaders')?.id, 'tm-vibrant-shaders');
  assert.ok(seedShowcase([], 'cheatoskar/tm-vibrant-shaders'), 'by repository');
  assert.ok(seedShowcase(['TM Vibrant Shaders'], null), 'by name');
  assert.equal(seedShowcase(['nothing-here'], 'someone/ext'), null);

  const author = await login('author');
  const p = await createProject(ctx, {
    name: 'TM Vibrant Shaders', slug: 'tmvs-copy', type: 'mod', summary: 'Shader pack for the Forever games.', description: '', categories: [], tags: [], games: ['tmnf'],
    installs: {}, license: null, links: { source: 'https://github.com/cheatoskar/TM-Vibrant-Shaders' }, dependencies: [], conflicts: [],
  }, { id: (await ctx.db.selectFrom('identities').select('user_id').where('provider_id', '=', 'author').executeTakeFirstOrThrow()).user_id, name: 'Dev Author' });
  assert.ok(seedShowcaseFor(p));
  const before = (await app.inject({ method: 'GET', url: '/v1/projects/tmvs-copy', headers: H(author) })).json() as HubProject;
  assert.equal(before.showcase, null);
  assert.equal(before.catalogShowcase, true);
  const adopt = await app.inject({ method: 'POST', url: '/v1/projects/tmvs-copy/showcase/adopt', payload: { from: 'catalog' }, headers: H(author) });
  assert.equal(adopt.statusCode, 200, adopt.body);
  const after = (await app.inject({ method: 'GET', url: '/v1/projects/tmvs-copy', headers: H(author) })).json() as HubProject;
  assert.equal(after.showcaseFrom, 'catalog');
  assert.ok(after.showcase!.blocks.some((b) => b.type === 'hero'));
  // Someone else cannot adopt; a project without a seed gets a clear 404.
  const other = await login('author2');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/projects/tmvs-copy/showcase/adopt', payload: { from: 'catalog' }, headers: H(other) })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/projects/typed-mod/showcase/adopt', payload: { from: 'catalog' }, headers: H(author) })).statusCode, 404);
});

test('import preview shows everything it found; the import takes only what was confirmed', async () => {
  const author = await login('author');
  const pv = (await app.inject({ method: 'POST', url: '/v1/sources/preview', headers: H(author), payload: { url: 'https://github.com/someone/ext' } })).json() as SourcePreview;
  assert.equal(pv.type, 'browser-extension');
  assert.equal(pv.links.discord, 'https://discord.gg/abcd1234');
  assert.deepEqual(pv.images, ['https://raw.githubusercontent.com/someone/ext/main/docs/a.png', 'https://dl.example/shot.png']);
  assert.deepEqual(pv.imageFrom, ['readme', 'release']);
  assert.deepEqual(pv.assetInfo.map((a) => [a.name, a.downloads]), [['Ext-2.0.0-chrome.zip', 120], ['Ext-2.0.0-firefox.zip', 30]]);
  // Installable files of all releases: 120 + 30 + 50 (the picture and checksums.txt are not downloads of the extension).
  assert.equal(pv.githubDownloads, 200);

  // Pictures must come from the preview (no fetching of arbitrary URLs through the import).
  const bad = await app.inject({ method: 'POST', url: '/v1/projects/import', headers: H(author), payload: { url: 'https://github.com/someone/ext', type: 'browser-extension', games: ['tmnf'], install: { kind: 'files', base: 'game' }, assetPattern: 'Ext-*-chrome.zip', images: ['https://evil.example/x.png'] } });
  assert.equal(bad.statusCode, 400);
  // Type is required.
  assert.equal((await app.inject({ method: 'POST', url: '/v1/projects/import', headers: H(author), payload: { url: 'https://github.com/someone/ext', games: ['tmnf'], install: { kind: 'files', base: 'game' } } })).statusCode, 400);

  const imp = await app.inject({ method: 'POST', url: '/v1/projects/import', headers: H(author), payload: {
    url: 'https://github.com/someone/ext', type: 'browser-extension', games: ['tmnf'], install: { kind: 'files', base: 'game' }, assetPattern: 'Ext-*-chrome.zip',
    summary: 'Bulk downloads for TMX, as a browser extension.', description: '', license: null, links: { source: 'https://github.com/someone/ext' },
    images: ['https://dl.example/shot.png'], banner: null, showcase: null,
  } });
  assert.equal(imp.statusCode, 200, imp.body);
  const { project, first } = imp.json() as { project: HubProject; first: { imported: string[] } };
  assert.equal(project.type, 'browser-extension');
  assert.equal(project.summary, 'Bulk downloads for TMX, as a browser extension.');
  assert.equal(project.description, '');
  assert.equal(project.license, null);
  assert.deepEqual(project.links, { source: 'https://github.com/someone/ext' });
  assert.deepEqual(project.installs, {});
  assert.equal(project.gallery.length, 1);
  assert.equal(project.banner, null);
  // The extension's .js and .html files pass the browser rules; the first version waits for a person (new project).
  assert.deepEqual(first.imported, ['2.0.0']);
  const v = await ctx.db.selectFrom('versions').selectAll().where('project_id', '=', project.id).executeTakeFirstOrThrow();
  assert.equal(v.status, 'review', v.report ?? '');
  assert.equal(v.installs, '{}');
  assert.ok(!JSON.parse(v.report!).findings.some((f: { severity: string }) => f.severity === 'reject'));
  // GitHub's download sum was read with the first check; the hub has none yet.
  const p = (await app.inject({ method: 'GET', url: `/v1/projects/${project.slug}`, headers: H(author) })).json() as HubProject;
  assert.deepEqual(p.downloadStats, { total: 200, hub: 0, github: 200, notCounted: [] });

  // Published: the index says what it is and gives no game install (older launchers cannot install it into a game).
  await approveVersion(ctx, v, 'test');
  const ix = (await indexPayload()).projects.find((x) => x.slug === project.slug)!;
  assert.equal(ix.type, 'browser-extension');
  assert.deepEqual(ix.versions[0].installs, {});
  assert.equal(ix.downloads, 200);
  assert.deepEqual(ix.downloadsBy, { hub: 0, github: 200 });
});

test('downloads: once per installation, project and day; GitHub sum refreshed at most daily; untracked sources named', async () => {
  assert.equal(downloaderKey('a'.repeat(32), undefined, '1.2.3.4'), `i:${'a'.repeat(32)}`);
  assert.equal(downloaderKey(undefined, 'b'.repeat(20), '1.2.3.4'), `i:${'b'.repeat(20)}`);
  assert.equal(downloaderKey('short', undefined, '1.2.3.4'), 'a:1.2.3.4');
  assert.equal(downloaderKey('../../etc', undefined, '1.2.3.4'), 'a:1.2.3.4');

  const p = await createProject(ctx, {
    name: 'Counted', slug: 'counted-mod', type: 'mod', summary: 'A mod whose downloads are counted.', description: '', categories: [], tags: [], games: ['tmnf'],
    installs: { tmnf: { kind: 'tmloader-product', strip: 0, include: [] } }, license: null, links: {}, dependencies: [], conflicts: [], tmloaderProduct: 'Counted',
  }, null, { state: 'listed' });
  const ids: string[] = [];
  for (const ver of ['1.0.0', '1.1.0']) {
    const v = await ingestVersion(ctx, { project: p, fileName: `Counted-${ver}.zip`, data: tmloaderZip('Counted', ver), meta: { version: ver, channel: 'stable', changelog: '' }, origin: 'upload', uploaderId: null });
    await approveVersion(ctx, v, 'test');
    ids.push(v.id);
  }
  const name = async (id: string) => (await ctx.db.selectFrom('versions').select('file_name').where('id', '=', id).executeTakeFirstOrThrow()).file_name;
  const get = async (id: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url: `/dl/${id}/${await name(id)}`, headers, remoteAddress: '203.0.113.7' });
  const one = 'install-one-0000000000';
  const two = 'install-two-0000000000';
  assert.equal((await get(ids[0], { 'x-tmhub-install': one })).statusCode, 302);
  await get(ids[0], { 'x-tmhub-install': one }); // same installation, same day
  await get(ids[1], { 'x-tmhub-install': one }); // same installation, another version of the same project
  await get(ids[1], { 'x-tmhub-install': two }); // another installation behind the same address
  await get(ids[0]); // a browser download from that address
  await get(ids[0]); // and again
  const row = await ctx.db.selectFrom('projects').select(['downloads']).where('id', '=', p.id).executeTakeFirstOrThrow();
  assert.equal(row.downloads, 3);
  const daily = await ctx.db.selectFrom('downloads_daily').select(({ fn }) => fn.sum<number>('count').as('n')).where('project_id', '=', p.id).executeTakeFirstOrThrow();
  assert.equal(Number(daily.n), 3);
  // Nothing about the downloader is stored: only day, version and count.
  const cols = Object.keys((await ctx.db.selectFrom('downloads_daily').selectAll().where('project_id', '=', p.id).executeTakeFirstOrThrow()));
  assert.deepEqual(cols.sort(), ['count', 'day', 'project_id', 'version_id']);

  // A TMLoader server and a GitHub repository as sources: GitHub adds its sum, TMLoader is named as not counted.
  await ctx.db.insertInto('sources').values({ id: 's_tml', project_id: p.id, kind: 'tmloader', target: 'https://tml.example/', product: 'Counted', asset_pattern: null, etag: null, last_check: null, next_check: null, last_error: null, imported: 0, needs_choice: null, webhook: 0, quiet_checks: 0, created_at: new Date().toISOString() }).execute();
  await ctx.db.insertInto('sources').values({ id: 's_gh', project_id: p.id, kind: 'github', target: 'someone/ext', product: null, asset_pattern: null, etag: null, last_check: null, next_check: null, last_error: null, imported: 0, needs_choice: null, webhook: 0, quiet_checks: 0, created_at: new Date().toISOString() }).execute();
  const fresh = await ctx.db.selectFrom('projects').selectAll().where('id', '=', p.id).executeTakeFirstOrThrow();
  assert.equal(await refreshGithubDownloads(ctx, fresh, 'someone/ext'), 200);
  const again = await ctx.db.selectFrom('projects').selectAll().where('id', '=', p.id).executeTakeFirstOrThrow();
  assert.equal(await refreshGithubDownloads(ctx, again, 'someone/ext'), null, 'not again within a day');
  const author = await login('admin');
  const hp = (await app.inject({ method: 'GET', url: '/v1/projects/counted-mod', headers: H(author) })).json() as HubProject;
  assert.deepEqual(hp.downloadStats, { total: 203, hub: 3, github: 200, notCounted: ['tmloader'] });
  assert.equal(hp.downloads, 203);
  const stats = (await app.inject({ method: 'GET', url: '/v1/projects/counted-mod/stats?days=7', headers: H(author) })).json();
  assert.equal(stats.total, 3);
  assert.deepEqual(stats.breakdown, hp.downloadStats);
});

test('browser extension checks: scripts pass, programs, miners and missing manifests do not', async () => {
  const base = { fileName: 'ext.zip', installs: {}, projectType: 'browser-extension', version: '1.0.0', newProject: false, uploaderId: null, origin: 'upload' } as const;
  const zip = (files: { name: string; data: string | Buffer; method?: 0 | 8 }[]) => makeZip(files);
  const ok = await runChecks({ ...base, data: zip([{ name: 'ext/manifest.json', data: manifest }, { name: 'ext/bg.js', data: 'chrome.storage.local.get();' }, { name: 'ext/icon.svg', data: '<svg/>' }]) });
  assert.equal(ok.verdict, 'clean', JSON.stringify(ok.findings));
  // The same files under a game install type are refused (.js is never installed into a game).
  const asMod = await runChecks({ ...base, projectType: 'mod', installs: { tmnf: 'files:game' }, data: zip([{ name: 'manifest.json', data: manifest }, { name: 'bg.js', data: '1' }]) });
  assert.equal(asMod.verdict, 'rejected');

  const miner = await runChecks({ ...base, data: zip([{ name: 'manifest.json', data: manifest }, { name: 'm.js', data: 'new CoinHive.Anonymous("x").start()' }]) });
  assert.ok(miner.findings.some((f) => f.code === 'browser.miner' && f.severity === 'reject'));
  const exe = await runChecks({ ...base, data: zip([{ name: 'manifest.json', data: manifest }, { name: 'helper.dat', data: makePe() }]) });
  assert.equal(exe.verdict, 'rejected');
  const bat = await runChecks({ ...base, data: zip([{ name: 'manifest.json', data: manifest }, { name: 'run.bat', data: 'echo' }]) });
  assert.equal(bat.verdict, 'rejected');
  const noManifest = await runChecks({ ...base, data: zip([{ name: 'bg.js', data: '1' }]) });
  assert.ok(noManifest.findings.some((f) => f.code === 'browser.no-manifest'));
  const evalCode = await runChecks({ ...base, data: zip([{ name: 'manifest.json', data: manifest }, { name: 'x.js', data: 'eval(atob("YWxlcnQoMSk="))' }]) });
  assert.equal(evalCode.verdict, 'flagged');
  const wide = await runChecks({ ...base, data: zip([{ name: 'manifest.json', data: JSON.stringify({ manifest_version: 3, permissions: ['cookies'], host_permissions: ['<all_urls>'] }) }]) });
  assert.ok(wide.findings.some((f) => f.code === 'browser.permissions' && f.severity === 'flag'));
  const big = await runChecks({ ...base, data: zip([{ name: 'manifest.json', data: manifest }, { name: 'a.js', data: randomBytes(21 * 1048576), method: 0 }]) });
  assert.ok(big.findings.some((f) => f.code === 'browser.too-large' && f.severity === 'reject'));
});
