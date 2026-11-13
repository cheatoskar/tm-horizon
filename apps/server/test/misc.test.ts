import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageInfo, stripMetadata } from '../src/services/images.ts';
import { patternFromName, pickAsset, parseGithubRepo, globMatch } from '../src/sources/github.ts';
import { detectInstall } from '../src/sources/importer.ts';
import { normalizeServer } from '../src/sources/crawler.ts';
import { wrapTmloader } from '../src/checks/zipwrite.ts';
import { unzipAll } from '../src/checks/zip.ts';
import { compareVersions } from '../src/util.ts';
import { loadConfig, isLoopbackHost } from '../src/config.ts';
import { createCtx } from '../src/ctx.ts';
import { importCatalog } from '../src/sources/catalog-import.ts';
import { loadSigningKey } from '../src/index/sign.ts';
import { RFC8032_TEST1_SEED } from '../scripts/make-index-fixtures.ts';
import { makeDemoPng, makePe, makeZip, tmloaderZip } from './helpers.ts';

test('PNG metadata (text chunks) is stripped, size read from the header', () => {
  const png = makeDemoPng(320, 180, [10, 20, 30]);
  assert.deepEqual(imageInfo(png), { type: 'png', width: 320, height: 180 });
  assert.ok(png.includes(Buffer.from('secret gps')));
  const clean = stripMetadata(png, 'png');
  assert.ok(!clean.includes(Buffer.from('secret gps')));
  assert.deepEqual(imageInfo(clean), { type: 'png', width: 320, height: 180 });
  assert.equal(imageInfo(Buffer.from('<svg onload=alert(1)>')), null);
});

test('JPEG EXIF is stripped', () => {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x20, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const exif = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, 0x10]), Buffer.from('Exif\0\0GPS-HERE')]);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8]), exif, sof, Buffer.from([0xff, 0xda, 0x00, 0x02, 1, 2, 3, 0xff, 0xd9])]);
  assert.deepEqual(imageInfo(jpg), { type: 'jpeg', width: 32, height: 16 });
  const clean = stripMetadata(jpg, 'jpeg');
  assert.ok(!clean.includes(Buffer.from('GPS-HERE')));
  assert.deepEqual(imageInfo(clean), { type: 'jpeg', width: 32, height: 16 });
});

test('asset detection and remembered pattern', () => {
  const a = (name: string) => ({ name, size: 1, url: 'https://x/' + name, contentType: null });
  assert.equal(pickAsset([a('Mod-1.0.0.zip'), a('Mod-1.0.0.pdb'), a('Source code.zip')], null).asset?.name, 'Mod-1.0.0.zip');
  assert.equal(pickAsset([a('Mod-1.0.0.zip'), a('Mod.dll')], null).asset?.name, 'Mod-1.0.0.zip');
  assert.equal(pickAsset([a('ModA-1.0.zip'), a('ModB-1.0.zip')], null).asset, null);
  assert.equal(pickAsset([a('ModA-1.1.zip'), a('ModB-1.1.zip')], patternFromName('ModB-1.0.zip')).asset?.name, 'ModB-1.1.zip');
  assert.equal(patternFromName('TMVibrantShaders-v1.4.0-beta.2.zip'), 'TMVibrantShaders-*.zip');
  assert.ok(globMatch('Mod-*.zip', 'mod-2.0.zip'));
  assert.equal(parseGithubRepo('https://github.com/cheatoskar/TM-Vibrant-Shaders/releases'), 'cheatoskar/TM-Vibrant-Shaders');
  assert.equal(parseGithubRepo('https://gitlab.com/a/b'), null);
  assert.equal(normalizeServer('https://donadigo.com/modloader/index.json'), 'https://donadigo.com/modloader/');
  assert.equal(normalizeServer('http://donadigo.com/modloader/'), null);
});

test('install type detection from the layout', () => {
  assert.equal(detectInstall('m.zip', tmloaderZip()).install?.kind, 'tmloader-product');
  assert.deepEqual(detectInstall('m.zip', makeZip([{ name: 'Pack/GameData/Skins/x.dds', data: 'x' }])).install, { kind: 'files', base: 'game', strip: 1, include: [] });
  assert.equal(detectInstall('m.zip', makeZip([{ name: 'Skins/Vehicles/x.zip', data: 'x' }])).install?.base, 'documents');
  assert.equal(detectInstall('d3d11.dll', makePe()).install, null);
});

test('TMLoader wrapping is deterministic and passes the zip checks', () => {
  const meta = { product: 'Cool', version: '1.0.0', executable: 'Cool.dll', dependencies: [{ id: 'CoreMod', version: '^1.0.0' }], name: 'Cool', author: 'Me' };
  const a = wrapTmloader(meta, [{ path: 'Cool.dll', data: makePe() }]);
  const b = wrapTmloader(meta, [{ path: 'Cool.dll', data: makePe() }]);
  assert.deepEqual(a, b);
  const paths = unzipAll(a).files.map((f) => f.path);
  assert.deepEqual(paths, ['Cool/description.yaml', 'Cool/1.0.0/description.yaml', 'Cool/1.0.0/Cool.dll']);
  assert.throws(() => wrapTmloader({ ...meta, product: '../x' }, []));
});

test('version ordering', () => {
  assert.deepEqual(['1.10.0', '1.2.0', '1.2.0-beta.1', '1.9'].sort(compareVersions), ['1.2.0-beta.1', '1.2.0', '1.9', '1.10.0']);
});

test('config refuses dev login and missing key in production', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production', HUB_DEV_LOGIN: '1', HUB_INDEX_SIGNING_KEY: RFC8032_TEST1_SEED, HUB_PUBLIC_URL: 'https://a/', HUB_PORTAL_URL: 'https://a/' }), /DEV_LOGIN/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', HUB_PUBLIC_URL: 'https://a/', HUB_PORTAL_URL: 'https://a/' }), /SIGNING_KEY/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', HUB_INDEX_SIGNING_KEY: RFC8032_TEST1_SEED, HUB_PUBLIC_URL: 'http://a/', HUB_PORTAL_URL: 'https://a/' }), /https/);
});

test('dev login only in development and on loopback', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'development', HUB_DEV_LOGIN: '1', HOST: '0.0.0.0' }), /HOST=127\.0\.0\.1/);
  assert.throws(() => loadConfig({ NODE_ENV: 'development', HUB_DEV_LOGIN: '1', HOST: '192.168.1.5' }), /HOST=127\.0\.0\.1/);
  assert.equal(loadConfig({ NODE_ENV: 'development', HUB_DEV_LOGIN: '1', HOST: '127.0.0.1' }).HUB_DEV_LOGIN, true);
  assert.equal(loadConfig({ NODE_ENV: 'development', HUB_DEV_LOGIN: '1', HOST: 'localhost' }).HUB_DEV_LOGIN, true);
  assert.equal(loadConfig({ NODE_ENV: 'development', HUB_DEV_LOGIN: '0', HOST: '0.0.0.0' }).HUB_DEV_LOGIN, false);
  for (const h of ['127.0.0.1', '::1', '[::1]', '::ffff:127.0.0.1', 'localhost']) assert.ok(isLoopbackHost(h), h);
  for (const h of ['0.0.0.0', '10.0.0.1', '128.0.0.1', 'example.org', undefined]) assert.ok(!isLoopbackHost(h), String(h));
});

test('catalog import creates unclaimed, credited projects with sources (no network)', async () => {
  const ctx = await createCtx(loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'sqlite::memory:', STORAGE_DIR: './data/test-files' }), { key: loadSigningKey(RFC8032_TEST1_SEED), fetch: (async () => { throw new Error('no network in this test'); }) as typeof fetch });
  const r = await importCatalog(ctx);
  assert.ok(r.created.length > 50, String(r.created.length));
  const all = await ctx.db.selectFrom('projects').selectAll().execute();
  assert.ok(all.every((p) => p.claimed === 0 && p.catalog_id));
  const centerspeed = all.filter((p) => /centerspeed/i.test(p.name));
  assert.equal(centerspeed.length, 1, 'catalog entry and TMLoader mod merged');
  const srcs = await ctx.db.selectFrom('sources').selectAll().execute();
  assert.ok(srcs.every((s) => s.next_check === null), 'not crawled without --crawl');
  const again = await importCatalog(ctx);
  assert.equal(again.created.length, 0, 'idempotent');
  await ctx.db.destroy();
});

test('SSRF guard refuses local and private addresses, follows redirects hop by hop', async () => {
  const { assertPublicUrl, guardedFetch, isPrivateIp } = await import('../src/net.ts');
  for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.0.1', '172.20.0.1', '100.64.0.1', '::1', 'fd00::1', '::ffff:127.0.0.1']) assert.ok(isPrivateIp(ip), ip);
  assert.ok(!isPrivateIp('140.82.112.3'));
  await assert.rejects(assertPublicUrl('https://127.0.0.1/x'), /private or local/);
  await assert.rejects(assertPublicUrl('https://localhost/x'), /private or local/);
  await assert.rejects(assertPublicUrl('http://example.com/'), /https/);
  const hops: string[] = [];
  const base = (async (u: string) => { hops.push(u); return new Response('', { status: 302, headers: { location: 'https://127.0.0.1/admin' } }); }) as unknown as typeof fetch;
  await assert.rejects(guardedFetch(base)('https://140.82.112.3/start'), /private or local/);
  assert.deepEqual(hops, ['https://140.82.112.3/start']);
});

test('preview: unreachable source is a 502 with the reason, not a 500', async () => {
  const { previewSource } = await import('../src/sources/importer.ts');
  const ctx = await createCtx(loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'sqlite::memory:', STORAGE_DIR: './data/test-files' }), { key: loadSigningKey(RFC8032_TEST1_SEED), fetch: (async () => { throw new Error('getaddrinfo ENOTFOUND api.github.com'); }) as typeof fetch });
  await assert.rejects(previewSource(ctx, 'https://github.com/a/b', null), (e: { status?: number; message: string }) => e.status === 502 && /ENOTFOUND/.test(e.message));
  await ctx.db.destroy();
});
