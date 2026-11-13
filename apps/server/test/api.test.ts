// End-to-end through the HTTP API (in-memory SQLite, temp storage, fake GitHub).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { HubProject, HubVersion, SignedHubIndex } from '@tm-hub/shared';
import { loadConfig } from '../src/config.ts';
import { createCtx, type Ctx } from '../src/ctx.ts';
import { buildApp } from '../src/app.ts';
import { verifyIndex, loadSigningKey, signAuthor } from '../src/index/sign.ts';
import { publishDue } from '../src/services/versions.ts';
import { crawlTick } from '../src/sources/crawler.ts';
import { RFC8032_TEST1_SEED, RFC8032_TEST2_SEED } from '../scripts/make-index-fixtures.ts';
import { makePe, makeZip, tmloaderZip } from './helpers.ts';

let app: FastifyInstance;
let ctx: Ctx;
let dir: string;
const PORTAL = 'http://localhost:5174';

// Fake GitHub: one repository with one release whose asset is a TMLoader zip.
const releases: { tag_name: string; prerelease: boolean; draft: boolean; body: string; published_at: string; assets: { name: string; size: number; browser_download_url: string }[] }[] = [];
const assetBytes = new Map<string, Buffer>();
const fakeFetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  const json = (v: unknown, h: Record<string, string> = {}) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json', etag: `"e${releases.length}"`, ...h } });
  if (url === 'https://api.github.com/repos/someone/cool-mod') return json({ full_name: 'someone/cool-mod', name: 'cool-mod', description: 'A cool mod for Forever', homepage: '', license: { spdx_id: 'MIT' }, owner: { login: 'someone' }, html_url: 'https://github.com/someone/cool-mod', topics: [], archived: false, default_branch: 'main' });
  if (url.startsWith('https://api.github.com/repos/someone/cool-mod/releases')) return json(releases);
  if (url === 'https://api.github.com/repos/someone/cool-mod/readme') return new Response('# Cool mod\n\n![shot](docs/shot.png)\n', { status: 200 });
  if (url.includes('/contents/docs/images')) return new Response('[]', { status: 404 });
  if (assetBytes.has(url)) return new Response(new Uint8Array(assetBytes.get(url)!), { status: 200 });
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

function multipart(file: { name: string; data: Buffer }, fields: Record<string, string>) {
  const b = '----hubtest' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${b}\r\ncontent-disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${b}\r\ncontent-disposition: form-data; name="file"; filename="${file.name}"\r\ncontent-type: application/octet-stream\r\n\r\n`), file.data, Buffer.from(`\r\n--${b}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
}
async function upload(a: Agent | { bearer: string }, slug: string, file: { name: string; data: Buffer }, meta: Record<string, unknown>) {
  const m = multipart(file, { meta: JSON.stringify(meta) });
  const auth = 'bearer' in a ? { authorization: `Bearer ${a.bearer}` } : H(a);
  return app.inject({ method: 'POST', url: `/v1/projects/${slug}/versions`, payload: m.payload, headers: { ...m.headers, ...auth } });
}
const index = async () => verifyIndex((await app.inject({ method: 'GET', url: '/v1/index.json' })).json() as SignedHubIndex, [ctx.key.publicKey]);

const projectInput = (slug: string) => ({
  name: 'Demo Shaders', slug, type: 'mod', summary: 'Shaders for Nations Forever.', description: '# Demo\n\nHello', categories: ['graphics'], tags: ['shader'], games: ['tmnf'],
  installs: { tmnf: { kind: 'tmloader-product', strip: 0, include: [] } }, license: 'MIT', links: { source: 'https://github.com/x/y' }, dependencies: [], conflicts: [], tmloaderProduct: 'DemoMod',
});

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hub-test-'));
  const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'sqlite::memory:', STORAGE_DIR: join(dir, 'files'), HUB_DEV_LOGIN: '1', HOLD_MINUTES: '60', CRAWLER: '0' });
  ctx = await createCtx(cfg, { fetch: fakeFetch, key: loadSigningKey(RFC8032_TEST1_SEED) });
  app = await buildApp(ctx);
});
after(async () => {
  await app.close();
  await ctx.db.destroy();
  rmSync(dir, { recursive: true, force: true });
});

test('upload flow: new project -> review -> approve -> signed index -> counted download', async () => {
  const author = await login('author');
  const admin = await login('admin');
  const r = await app.inject({ method: 'POST', url: '/v1/projects', payload: projectInput('demo-shaders'), headers: H(author) });
  assert.equal(r.statusCode, 200, r.body);
  const up = await upload(author, 'demo-shaders', { name: 'demo.zip', data: tmloaderZip('DemoMod', '1.0.0') }, { version: '1.0.0', changelog: 'First' });
  assert.equal(up.statusCode, 200, up.body);
  const v1 = up.json() as HubVersion;
  assert.equal(v1.status, 'review');
  assert.ok(v1.report!.findings.some((f) => f.code === 'review.new-project'));
  // Not public yet.
  assert.equal((await app.inject({ method: 'GET', url: '/v1/projects/demo-shaders' })).statusCode, 404);
  assert.equal((await index()).projects.length, 0);

  const queue = (await app.inject({ method: 'GET', url: '/v1/admin/queue', headers: H(admin) })).json();
  assert.ok(queue.some((i: { id: string }) => i.id === v1.id));
  assert.equal((await app.inject({ method: 'GET', url: '/v1/admin/queue', headers: H(author) })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: `/v1/admin/versions/${v1.id}/approve`, headers: H(admin) })).statusCode, 200);

  const idx = await index();
  assert.equal(idx.projects.length, 1);
  const pv = idx.projects[0].versions[0];
  assert.equal(pv.version, '1.0.0');
  assert.match(pv.files[0].sha256, /^[0-9a-f]{64}$/);

  // Download: redirect to the stored copy, counted once per person and day.
  const dlPath = new URL(pv.files[0].url).pathname;
  const d1 = await app.inject({ method: 'GET', url: dlPath });
  assert.equal(d1.statusCode, 302);
  await app.inject({ method: 'GET', url: dlPath });
  const file = await app.inject({ method: 'GET', url: new URL(d1.headers.location as string).pathname });
  assert.equal(file.statusCode, 200);
  assert.equal(file.rawPayload.length, pv.files[0].size);
  const stats = (await app.inject({ method: 'GET', url: '/v1/projects/demo-shaders/stats', headers: H(author) })).json();
  assert.equal(stats.total, 1);
  assert.equal(stats.days[0].count, 1);

  // Search finds it.
  const s = (await app.inject({ method: 'GET', url: '/v1/projects?q=shader&game=tmnf' })).json();
  assert.equal(s.total, 1);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/projects?q=nothing-like-this' })).json().total, 0);
});

test('clean update is held for an hour, then published by the job; cancel works', async () => {
  const author = await login('author');
  const v2 = (await upload(author, 'demo-shaders', { name: 'demo.zip', data: tmloaderZip('DemoMod', '1.1.0') }, { version: '1.1.0' })).json() as HubVersion;
  assert.equal(v2.status, 'held', JSON.stringify(v2.report?.findings));
  assert.ok(ctx.notices.some((n) => n.kind === 'hold' && n.text.includes('1.1.0')));
  assert.equal(await publishDue(ctx), 0);
  assert.equal(await publishDue(ctx, new Date(Date.now() + 61 * 60_000).toISOString()), 1);
  assert.equal((await index()).projects[0].versions[0].version, '1.1.0');

  const v3 = (await upload(author, 'demo-shaders', { name: 'demo.zip', data: tmloaderZip('DemoMod', '1.2.0') }, { version: '1.2.0' })).json() as HubVersion;
  assert.equal((await app.inject({ method: 'POST', url: `/v1/versions/${v3.id}/cancel`, headers: H(author) })).statusCode, 200);
  assert.equal(await publishDue(ctx, new Date(Date.now() + 61 * 60_000).toISOString()), 0);
  // Same version number again: refused (immutable).
  assert.equal((await upload(author, 'demo-shaders', { name: 'demo.zip', data: tmloaderZip('DemoMod', '1.1.0') }, { version: '1.1.0' })).statusCode, 409);
});

test('malicious uploads are rejected with a statement of reasons, nothing stored publicly', async () => {
  const author = await login('author');
  const evil = makeZip([{ name: 'DemoMod/2.0.0/description.yaml', data: 'x' }, { name: '../../../evil.dll', data: makePe() }]);
  const r = (await upload(author, 'demo-shaders', { name: 'evil.zip', data: evil }, { version: '2.0.0' })).json() as HubVersion;
  assert.equal(r.status, 'rejected');
  assert.equal(r.decision?.automated, true);
  assert.ok(r.report!.findings.some((f) => f.code === 'zip.path-traversal'));
  const swapped = tmloaderZip('DemoMod', '2.0.1', [], makePe({ imports: { 'WININET.dll': ['InternetOpenA'] } }));
  const f = (await upload(author, 'demo-shaders', { name: 'demo.zip', data: swapped }, { version: '2.0.1' })).json() as HubVersion;
  assert.equal(f.status, 'review');
  assert.ok(f.report!.findings.some((x) => x.code === 'diff.new-sensitive-imports'));
});

test('CSRF, origin and roles', async () => {
  const author = await login('author');
  const other = await login('author2');
  const noCsrf = await app.inject({ method: 'PATCH', url: '/v1/projects/demo-shaders', payload: { summary: 'Changed summary text' }, headers: { cookie: author.cookie, origin: PORTAL } });
  assert.equal(noCsrf.statusCode, 403);
  assert.equal(noCsrf.json().error, 'csrf');
  const evilOrigin = await app.inject({ method: 'PATCH', url: '/v1/projects/demo-shaders', payload: { summary: 'Changed summary text' }, headers: { ...H(author), origin: 'https://evil.example' } });
  assert.equal(evilOrigin.statusCode, 403);
  const notMember = await app.inject({ method: 'PATCH', url: '/v1/projects/demo-shaders', payload: { summary: 'Changed summary text' }, headers: H(other) });
  assert.equal(notMember.statusCode, 403);
  const ok = await app.inject({ method: 'PATCH', url: '/v1/projects/demo-shaders', payload: { summary: 'Changed summary text' }, headers: H(author) });
  assert.equal(ok.statusCode, 200, ok.body);
  const bad = await app.inject({ method: 'PATCH', url: '/v1/projects/demo-shaders', payload: { links: { homepage: 'javascript:alert(1)' } }, headers: H(author) });
  assert.equal(bad.statusCode, 400);
});

test('related links: https and known kinds only, stored and returned with the project', async () => {
  const author = await login('author');
  const patch = (related: unknown) => app.inject({ method: 'PATCH', url: '/v1/projects/demo-shaders', payload: { links: { source: 'https://github.com/x/y', related } }, headers: H(author) });
  assert.equal((await patch([{ kind: 'companion', label: 'Board', url: 'http://example.com/a' }])).statusCode, 400);
  assert.equal((await patch([{ kind: 'forum', label: 'Board', url: 'https://example.com/a' }])).statusCode, 400);
  assert.equal((await patch([{ kind: 'docs', label: '', url: 'https://example.com/a' }])).statusCode, 400);
  const ok = await patch([{ kind: 'companion', label: 'Bingo board', url: 'https://example.com/bingo' }, { kind: 'docs', label: 'Docs', url: 'https://example.com/docs' }]);
  assert.equal(ok.statusCode, 200, ok.body);
  const got = (await app.inject({ method: 'GET', url: '/v1/projects/demo-shaders' })).json();
  assert.deepEqual(got.links.related.map((l: { kind: string }) => l.kind), ['companion', 'docs']);
  assert.equal(got.links.source, 'https://github.com/x/y');
  // The old fields alone still work.
  assert.equal((await app.inject({ method: 'PATCH', url: '/v1/projects/demo-shaders', payload: { links: { homepage: 'https://example.com' } }, headers: H(author) })).statusCode, 200);
});

test('API tokens: scoped, project-bound, revocable; author signatures verified', async () => {
  const author = await login('author');
  const created = (await app.inject({ method: 'POST', url: '/v1/me/tokens', payload: { name: 'CI', scopes: ['versions:write'] }, headers: H(author) })).json();
  assert.match(created.token, /^tmh_/);
  const key = loadSigningKey(RFC8032_TEST2_SEED);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/me/keys', payload: { publicKey: key.publicKey }, headers: H(author) })).statusCode, 200);

  // The hub copy of a TMLoader zip is the zip itself; sign its hash.
  const data = tmloaderZip('DemoMod', '3.0.0');
  const sha = (await import('node:crypto')).createHash('sha256').update(data).digest('hex');
  const r = await upload({ bearer: created.token }, 'demo-shaders', { name: 'demo.zip', data }, { version: '3.0.0', signature: { keyId: key.keyId, sig: signAuthor('demo-shaders', '3.0.0', sha, key) } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((r.json() as HubVersion).verified, true);
  assert.equal((r.json() as HubVersion).origin, 'api-token');

  // A token cannot do session-only things.
  assert.equal((await app.inject({ method: 'PATCH', url: '/v1/projects/demo-shaders', payload: { summary: 'Token tries this' }, headers: { authorization: `Bearer ${created.token}` } })).statusCode, 403);
  // A forged signature is a hard reject.
  const bad = await upload({ bearer: created.token }, 'demo-shaders', { name: 'demo.zip', data: tmloaderZip('DemoMod', '3.0.1') }, { version: '3.0.1', signature: { keyId: key.keyId, sig: signAuthor('demo-shaders', '3.0.1', 'f'.repeat(64), key) } });
  assert.equal((bad.json() as HubVersion).status, 'rejected');
  await app.inject({ method: 'DELETE', url: `/v1/me/tokens/${created.id}`, headers: H(author) });
  assert.equal((await upload({ bearer: created.token }, 'demo-shaders', { name: 'demo.zip', data }, { version: '3.0.2' })).statusCode, 401);
});

test('report -> admin queue -> revoke -> revocation list in the signed index', async () => {
  const admin = await login('admin');
  const rep = await app.inject({ method: 'POST', url: '/v1/reports', headers: { origin: PORTAL }, payload: { projectSlug: 'demo-shaders', reason: 'malware', explanation: 'The DLL phones home to an unknown server.', location: 'https://hub/p/demo-shaders', goodFaith: true } });
  assert.equal(rep.statusCode, 200, rep.body);
  const noGoodFaith = await app.inject({ method: 'POST', url: '/v1/reports', headers: { origin: PORTAL }, payload: { projectSlug: 'demo-shaders', reason: 'malware', explanation: 'x'.repeat(30), location: 'x' } });
  assert.equal(noGoodFaith.statusCode, 400);
  const q = (await app.inject({ method: 'GET', url: '/v1/admin/queue', headers: H(admin) })).json();
  assert.equal(q[0].kind, 'report');
  assert.equal(q[0].report.name, null, 'notifier name is not the project name');
  assert.equal(q[0].project.name, 'Demo Shaders');
  const vs = (await app.inject({ method: 'GET', url: '/v1/projects/demo-shaders/versions', headers: H(admin) })).json() as HubVersion[];
  const pub = vs.find((v) => v.version === '1.1.0')!;
  const rv = await app.inject({ method: 'POST', url: `/v1/admin/versions/${pub.id}/revoke`, headers: H(admin), payload: { facts: 'Confirmed: the DLL downloads code at runtime.', ground: 'Nutzungsbedingungen § 4', groundType: 'terms' } });
  assert.equal(rv.statusCode, 200, rv.body);
  const idx = await index();
  assert.ok(idx.revoked.some((x) => x.version === '1.1.0' && x.sha256 === pub.files[0].sha256));
  assert.ok(!idx.projects[0].versions.some((v) => v.version === '1.1.0'));
  assert.equal((await app.inject({ method: 'GET', url: new URL(pub.files[0].url).pathname })).statusCode, 410);
  await app.inject({ method: 'POST', url: `/v1/admin/reports/${rep.json().id}/resolve`, headers: H(admin), payload: { status: 'actioned', resolution: 'Version 1.1.0 revoked.' } });
});

test('paste a GitHub URL: preview, import, crawl the next release, claim of a crawled project', async () => {
  const author = await login('author');
  releases.push({ tag_name: 'v0.9.0', prerelease: false, draft: false, body: 'Old', published_at: '2026-10-01T00:00:00Z', assets: [{ name: 'CoolMod-0.9.0.zip', size: 10, browser_download_url: 'https://dl.example/0.9.0.zip' }] });
  releases.unshift({ tag_name: 'v1.0.0', prerelease: false, draft: false, body: '## Changes\n- first', published_at: '2026-11-01T00:00:00Z', assets: [
    { name: 'CoolMod-1.0.0.zip', size: 10, browser_download_url: 'https://dl.example/1.0.0.zip' }, { name: 'CoolMod-1.0.0.pdb', size: 1, browser_download_url: 'https://dl.example/x.pdb' }] });
  assetBytes.set('https://dl.example/1.0.0.zip', tmloaderZip('CoolMod', '1.0.0'));
  assetBytes.set('https://dl.example/0.9.0.zip', tmloaderZip('CoolMod', '0.9.0'));

  const pv = (await app.inject({ method: 'POST', url: '/v1/sources/preview', headers: H(author), payload: { url: 'https://github.com/someone/cool-mod' } })).json();
  assert.equal(pv.asset, 'CoolMod-1.0.0.zip');
  assert.equal(pv.install.kind, 'tmloader-product');
  assert.equal(pv.license, 'MIT');
  assert.ok(pv.description.includes('raw.githubusercontent.com/someone/cool-mod/main/docs/shot.png'));

  const imp = await app.inject({ method: 'POST', url: '/v1/projects/import', headers: H(author), payload: { url: 'https://github.com/someone/cool-mod', type: 'mod', games: ['tmnf', 'tmuf'], install: pv.install } });
  assert.equal(imp.statusCode, 200, imp.body);
  const { project, first } = imp.json() as { project: HubProject; first: { imported: string[] } };
  assert.deepEqual(first.imported, ['1.0.0']); // only the newest release on the first check
  assert.equal(project.sources[0].assetPattern, 'CoolMod-*.zip'); // remembered from the first release
  const vs = (await app.inject({ method: 'GET', url: `/v1/projects/${project.slug}/versions`, headers: H(author) })).json() as HubVersion[];
  assert.equal(vs[0].origin, 'github:someone/cool-mod@v1.0.0');
  assert.equal(vs[0].changelog, '## Changes\n- first');
  assert.equal(vs[0].status, 'review');

  // Next release arrives: the crawler picks it with the remembered pattern.
  releases.unshift({ tag_name: 'v1.1.0', prerelease: false, draft: false, body: 'More', published_at: '2026-11-09T00:00:00Z', assets: [{ name: 'CoolMod-1.1.0.zip', size: 10, browser_download_url: 'https://dl.example/1.1.0.zip' }, { name: 'Other-1.1.0.zip', size: 10, browser_download_url: 'https://dl.example/o.zip' }] });
  assetBytes.set('https://dl.example/1.1.0.zip', tmloaderZip('CoolMod', '1.1.0'));
  await ctx.db.updateTable('sources').set({ next_check: '2000-01-01T00:00:00.000Z' }).execute();
  await crawlTick(ctx);
  const after = (await app.inject({ method: 'GET', url: `/v1/projects/${project.slug}/versions`, headers: H(author) })).json() as HubVersion[];
  assert.ok(after.some((v) => v.version === '1.1.0' && v.origin.endsWith('@v1.1.0')), JSON.stringify(after.map((v) => v.version)));

  // Duplicate source is refused.
  const dup = await app.inject({ method: 'POST', url: '/v1/projects/import', headers: H(author), payload: { url: 'https://github.com/someone/cool-mod', type: 'mod', games: ['tmnf'], install: pv.install } });
  assert.equal(dup.statusCode, 409);
});

test('unclaimed crawled project can be claimed through GitHub (dev stand-in)', async () => {
  const { importFromUrl } = await import('../src/sources/importer.ts');
  releases.length = 0;
  await ctx.db.deleteFrom('sources').execute();
  const r = await importFromUrl(ctx, { url: 'https://github.com/someone/cool-mod', slug: 'cool-mod-unclaimed', games: ['tmnf'], install: { kind: 'tmloader-product', strip: 0 } }, null, { catalog_id: 'mod-cool' });
  assert.equal(r.project.claimed, 0);
  const user = await login('author2');
  const c = await app.inject({ method: 'POST', url: '/auth/dev/github-claim', headers: H(user), payload: { slug: 'cool-mod-unclaimed' } });
  assert.equal(c.json().next, '/projects/cool-mod-unclaimed?claimed=1');
  const p = (await app.inject({ method: 'GET', url: '/v1/projects/cool-mod-unclaimed', headers: H(user) })).json() as HubProject;
  assert.equal(p.claimed, true);
  assert.equal(p.myRole, 'owner');
});

test('import: several release files and none chosen is refused; a project found by its repository link is offered for claiming', async () => {
  const { importFromUrl } = await import('../src/sources/importer.ts');
  const author = await login('author2');
  await ctx.db.deleteFrom('sources').execute();
  releases.length = 0;
  releases.push({ tag_name: 'v2.0.0', prerelease: false, draft: false, body: '', published_at: '2026-11-10T00:00:00Z', assets: [
    { name: 'CoolMod-Setup.zip', size: 10, browser_download_url: 'https://dl.example/a.zip' }, { name: 'CoolMod-Portable.zip', size: 10, browser_download_url: 'https://dl.example/b.zip' }] });
  const install = { kind: 'tmloader-product' as const, strip: 0 };
  const pv = (await app.inject({ method: 'POST', url: '/v1/sources/preview', headers: H(author), payload: { url: 'https://github.com/someone/cool-mod' } })).json();
  assert.equal(pv.assets.length, 2);
  assert.equal(pv.asset, null);
  // A project of this repository exists (found by its link, no watched source): the preview says so, a second import is refused.
  assert.ok(pv.existing?.slug, JSON.stringify(pv.existing));
  assert.equal(pv.existing.viaRepo, true);
  const second = await app.inject({ method: 'POST', url: '/v1/projects/import', headers: H(author), payload: { url: 'https://github.com/someone/cool-mod', type: 'mod', games: ['tmnf'], install } });
  assert.equal(second.statusCode, 409);
  // "owner/cool-mod-2" is another repository.
  const { projectOfRepo } = await import('../src/sources/importer.ts');
  assert.equal(await projectOfRepo(ctx, 'someone/cool-mod-2'), undefined);
  assert.ok(await projectOfRepo(ctx, 'Someone/Cool-Mod'));
  // The server refuses to import without a choice (the hub's own crawl passes owner null).
  await assert.rejects(importFromUrl(ctx, { url: 'https://github.com/someone/cool-mod', slug: 'cool-two-files', games: ['tmnf'], install }, null), /Several release files/);
  await assert.rejects(importFromUrl(ctx, { url: 'https://github.com/someone/cool-mod', slug: 'cool-two-files', games: ['tmnf'], install, assetPattern: 'Nope-*.zip' }, null), /Several release files/);
});

test('suspension: writes refused, the account sees the statement of reasons', async () => {
  const admin = await login('admin');
  const victim = await login('user');
  const me = (await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: victim.cookie } })).json();
  const s = await app.inject({ method: 'POST', url: `/v1/admin/users/${me.user.id}/suspend`, headers: H(admin), payload: { facts: 'Uploaded malware twice after a warning.', ground: 'Nutzungsbedingungen § 6', groundType: 'terms' } });
  assert.equal(s.statusCode, 200, s.body);
  const again = await login('user');
  const me2 = (await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: again.cookie } })).json();
  assert.equal(me2.user.suspended, true);
  assert.match(me2.user.suspension.facts, /malware/);
  const w = await app.inject({ method: 'POST', url: '/v1/projects', payload: projectInput('blocked-proj'), headers: H(again) });
  assert.equal(w.statusCode, 403);
  assert.equal(w.json().error, 'suspended');
});

test('OpenAPI lists the routes', async () => {
  const o = (await app.inject({ method: 'GET', url: '/v1/openapi.json' })).json();
  assert.ok(o.paths['/v1/projects/{slug}/versions'].post);
  assert.ok(o.paths['/v1/index.json'].get);
});
