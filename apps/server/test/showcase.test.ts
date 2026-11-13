// Showcase pages: the editor API (strict validation, roles), showcase.json import from a repository
// (relative pictures, picture checks, plugin.json key) and the crawler refresh (portal edits win).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { HubProject } from '@tm-hub/shared';
import { loadConfig } from '../src/config.ts';
import { createCtx, type Ctx } from '../src/ctx.ts';
import { buildApp } from '../src/app.ts';
import { loadSigningKey } from '../src/index/sign.ts';
import { RFC8032_TEST1_SEED } from '../scripts/make-index-fixtures.ts';
import { importFromUrl } from '../src/sources/importer.ts';
import { refreshRepoShowcase, showcaseOptions } from '../src/services/showcase.ts';

let app: FastifyInstance;
let ctx: Ctx;
let dir: string;
const PORTAL = 'http://localhost:5174';
const RAW = 'https://raw.githubusercontent.com/someone/show-mod/main/';

// Fake GitHub: a repository with a showcase.json, pictures that answer HEAD.
const files = new Map<string, string>();
const pictures = new Map<string, { type: string; size: number } | 'down'>();
const heads: string[] = [];
const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  // the hub reads the repository at HEAD, the fake keeps its files under main
  const url = String(input instanceof Request ? input.url : input).replace('/someone/show-mod/HEAD/', '/someone/show-mod/main/');
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json', etag: '"e1"' } });
  if (url === 'https://api.github.com/repos/someone/show-mod') return json({ full_name: 'someone/show-mod', name: 'show-mod', description: 'A mod with a showcase page', homepage: '', license: { spdx_id: 'MIT' }, owner: { login: 'someone' }, html_url: 'https://github.com/someone/show-mod', topics: [], archived: false, default_branch: 'main' });
  if (url.startsWith('https://api.github.com/repos/someone/show-mod/releases')) return json([]);
  if (url === 'https://api.github.com/repos/someone/show-mod/readme') return new Response('# Show mod\n', { status: 200 });
  if (url.includes('/contents/docs/images')) return new Response('[]', { status: 404 });
  if (url.startsWith(RAW) && files.has(url.slice(RAW.length)) && (init?.method ?? 'GET') === 'GET') return new Response(files.get(url.slice(RAW.length))!, { status: 200 });
  if (init?.method === 'HEAD') {
    heads.push(url);
    const p = pictures.get(url);
    if (p === 'down') throw new Error('ECONNRESET');
    if (p) return new Response(null, { status: 200, headers: { 'content-type': p.type, 'content-length': String(p.size) } });
  }
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
const projectInput = (slug: string) => ({
  name: 'Showcase Demo', slug, type: 'mod', summary: 'A mod with a showcase page.', description: '# Demo', categories: ['graphics'], tags: [], games: ['tmnf'],
  installs: { tmnf: { kind: 'tmloader-product', strip: 0, include: [] } }, license: 'MIT', links: {}, dependencies: [], conflicts: [], tmloaderProduct: 'ShowDemo',
});
const IMG = `${RAW}docs/images/a.png`;
const doc = (extra: unknown[] = []) => ({ version: 1, theme: { accent: 'green' }, blocks: [{ type: 'hero', title: 'Showcase Demo', image: IMG }, { type: 'text', markdown: 'Hello **world**' }, ...extra] });
const IMPORT = { url: 'https://github.com/someone/show-mod', games: ['tmnf' as const], install: { kind: 'tmloader-product' as const, strip: 0 } };

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hub-showcase-'));
  const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'sqlite::memory:', STORAGE_DIR: join(dir, 'files'), HUB_DEV_LOGIN: '1', HOLD_MINUTES: '60', CRAWLER: '0' });
  ctx = await createCtx(cfg, { fetch: fakeFetch, key: loadSigningKey(RFC8032_TEST1_SEED) });
  app = await buildApp(ctx);
});
after(async () => {
  await app.close();
  await ctx.db.destroy();
  rmSync(dir, { recursive: true, force: true });
});

test('editor API: strict validation, roles, stored and returned cleaned', async () => {
  const author = await login('author');
  const other = await login('user');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/projects', payload: projectInput('showcase-demo'), headers: H(author) })).statusCode, 200);
  const put = (a: Agent, body: unknown) => app.inject({ method: 'PUT', url: '/v1/projects/showcase-demo/showcase', payload: body as object, headers: H(a) });

  const ok = await put(author, doc());
  assert.equal(ok.statusCode, 200, ok.body);
  const p = (await app.inject({ method: 'GET', url: '/v1/projects/showcase-demo', headers: H(author) })).json() as HubProject;
  assert.equal(p.showcase?.blocks.length, 2);
  assert.equal(p.showcase?.theme?.accent, 'green');
  assert.equal(p.showcaseFrom, 'portal');

  // Bad data is a 400 with the list of problems, and nothing changes.
  const bad = await put(author, doc([{ type: 'gallery', images: [{ url: 'https://evil.example/a.png' }] }, { type: 'video', url: 'https://evil.example/v' }, { type: 'nope' }]));
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, 'bad_showcase');
  const paths = (bad.json().details.issues as { path: string }[]).map((i) => i.path);
  assert.ok(paths.includes('blocks[2].images[0].url') && paths.includes('blocks[3].url') && paths.includes('blocks[4].type'), paths.join());
  assert.equal(((await app.inject({ method: 'GET', url: '/v1/projects/showcase-demo', headers: H(author) })).json() as HubProject).showcase?.blocks.length, 2);
  assert.equal((await put(author, { blocks: Array.from({ length: 31 }, () => ({ type: 'text', markdown: 'x' })) })).statusCode, 400);
  assert.equal((await put(author, { blocks: [{ type: 'text', markdown: '<script>alert(1)</script>' }], extra: 1 })).statusCode, 400);

  // Only owners and maintainers; a stranger gets 403.
  assert.equal((await put(other, doc())).statusCode, 403);
  assert.equal((await app.inject({ method: 'DELETE', url: '/v1/projects/showcase-demo/showcase', headers: H(other) })).statusCode, 403);
  assert.equal((await app.inject({ method: 'PUT', url: '/v1/projects/showcase-demo/showcase', payload: doc() as object })).statusCode, 401);

  // The hub's own storage host is an allowed picture host (the test storage is http://localhost, which no https URL can use; the allowlist rule itself is tested in packages/shared).
  assert.deepEqual(showcaseOptions(ctx).imageHosts, [new URL(ctx.storage.publicUrl('images/x.png')).hostname]);

  assert.equal((await app.inject({ method: 'DELETE', url: '/v1/projects/showcase-demo/showcase', headers: H(author) })).statusCode, 200);
  const gone = (await app.inject({ method: 'GET', url: '/v1/projects/showcase-demo', headers: H(author) })).json() as HubProject;
  assert.equal(gone.showcase, null);
  assert.equal(gone.showcaseFrom, null);
});

test('import: showcase.json of the repository, relative pictures resolved, bad pictures dropped', async () => {
  files.set('showcase.json', JSON.stringify({
    version: 1,
    blocks: [
      { type: 'hero', title: 'Show mod', image: 'docs/images/a.png' },
      { type: 'gallery', images: [{ url: 'docs/images/a.png', caption: 'ok' }, { url: 'docs/images/page.png' }, { url: 'docs/images/huge.png' }, { url: 'docs/images/flaky.png' }, { url: '../../etc/passwd.png' }] },
      { type: 'text', markdown: 'Hi' },
    ],
  }));
  pictures.set(IMG, { type: 'image/png', size: 1000 });
  pictures.set(`${RAW}docs/images/page.png`, { type: 'text/html', size: 100 });
  pictures.set(`${RAW}docs/images/huge.png`, { type: 'image/png', size: 9 * 1048576 });
  pictures.set(`${RAW}docs/images/flaky.png`, 'down');
  const r = await importFromUrl(ctx, { ...IMPORT, slug: 'show-mod' }, null);
  const row = await ctx.db.selectFrom('projects').selectAll().where('id', '=', r.project.id).executeTakeFirstOrThrow();
  assert.equal(row.showcase_from, 'repo');
  const sc = JSON.parse(row.showcase!);
  const at = (f: string) => `${RAW.replace('/main/', '/HEAD/')}${f}`;
  assert.equal(sc.blocks[0].image, at('docs/images/a.png'));
  // page.png (not a picture) and huge.png (9 MB) are gone, flaky.png stays (a network error is not a verdict), the ../ path never resolved
  assert.deepEqual(sc.blocks[1].images.map((i: { url: string }) => i.url), [at('docs/images/a.png'), at('docs/images/flaky.png')]);
  assert.equal(sc.blocks.length, 3);
});

test('crawler refresh: repository changes are taken over, unchanged data costs no picture checks, portal edits win', async () => {
  const row = () => ctx.db.selectFrom('projects').selectAll().where('slug', '=', 'show-mod').executeTakeFirstOrThrow();
  const before = heads.length;
  files.set('showcase.json', JSON.stringify({ version: 1, blocks: [{ type: 'hero', title: 'Show mod 2', image: 'docs/images/a.png' }] }));
  assert.equal(await refreshRepoShowcase(ctx, await row(), 'someone/show-mod'), 'updated');
  assert.equal(JSON.parse((await row()).showcase!).blocks[0].title, 'Show mod 2');
  const headsAfterUpdate = heads.length;
  assert.ok(headsAfterUpdate > before);
  assert.equal(await refreshRepoShowcase(ctx, await row(), 'someone/show-mod'), 'same');
  assert.equal(heads.length, headsAfterUpdate, 'unchanged showcase: no HEAD requests');

  // plugin.json "showcase" key is the second place; showcase.json goes away
  files.delete('showcase.json');
  files.set('plugin.json', JSON.stringify({ name: 'x', showcase: { version: 1, blocks: [{ type: 'text', markdown: 'From plugin.json' }] } }));
  assert.equal(await refreshRepoShowcase(ctx, await row(), 'someone/show-mod'), 'updated');
  assert.equal(JSON.parse((await row()).showcase!).blocks[0].markdown, 'From plugin.json');

  // An author who wrote the showcase in the portal is never overwritten.
  await ctx.db.updateTable('projects').set({ showcase: JSON.stringify({ version: 1, blocks: [{ type: 'text', markdown: 'Mine' }] }), showcase_from: 'portal' }).where('slug', '=', 'show-mod').execute();
  assert.equal(await refreshRepoShowcase(ctx, await row(), 'someone/show-mod'), 'skipped');
  assert.equal(JSON.parse((await row()).showcase!).blocks[0].markdown, 'Mine');

  // Invalid files are ignored (the old showcase stays).
  await ctx.db.updateTable('projects').set({ showcase_from: 'repo' }).where('slug', '=', 'show-mod').execute();
  files.set('plugin.json', '{ not json');
  assert.equal(await refreshRepoShowcase(ctx, await row(), 'someone/show-mod'), 'skipped');
  files.set('plugin.json', JSON.stringify({ showcase: { blocks: [{ type: 'script' }] } }));
  assert.equal(await refreshRepoShowcase(ctx, await row(), 'someone/show-mod'), 'skipped');
  assert.equal(JSON.parse((await row()).showcase!).blocks[0].markdown, 'Mine');
});

test('the signed index carries the showcase of a listed project', async () => {
  const { buildPayload } = await import('../src/services/hubindex.ts');
  // a listed project with one published version (rows written directly: the upload pipeline is tested elsewhere)
  const p = await ctx.db.selectFrom('projects').selectAll().where('slug', '=', 'show-mod').executeTakeFirstOrThrow();
  await ctx.db.updateTable('projects').set({ state: 'listed' }).where('id', '=', p.id).execute();
  await ctx.db.insertInto('versions').values({
    id: 'v_show1', project_id: p.id, version: '1.0.0', channel: 'stable', changelog: 'x', games: '["tmnf"]', installs: '{}', status: 'published', publish_at: null, published_at: '2026-11-01T00:00:00Z',
    origin: 'test', uploader_id: null, signature: null, verified: 0, report: null, decision: null, file_name: 'a.zip', file_size: 1, file_sha256: 'a'.repeat(64), storage_key: 'x', downloads: 0, created_at: '2026-11-01T00:00:00Z',
  }).execute();
  const payload = await buildPayload(ctx, 1);
  const hit = payload.projects.find((x) => x.slug === 'show-mod');
  assert.equal(hit?.showcase?.blocks[0]?.type, 'text');
  await ctx.db.updateTable('projects').set({ showcase: null }).where('id', '=', p.id).execute();
  assert.equal('showcase' in ((await buildPayload(ctx, 2)).projects.find((x) => x.slug === 'show-mod') ?? {}), false);
});
