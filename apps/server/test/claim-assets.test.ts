// Claimed catalog projects (2026-11-11): the catalog import sets the logo (never over a picture somebody set, never failing),
// a GitHub claim connects the verified repository and takes its first release, and "Import from GitHub" applies only what was ticked.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { HubProject } from '@tm-hub/shared';
import { catalogLogoUrl, modIconMap } from '@tm-hub/shared/logo';
import { loadConfig } from '../src/config.ts';
import { createCtx, type Ctx } from '../src/ctx.ts';
import { buildApp } from '../src/app.ts';
import { loadSigningKey } from '../src/index/sign.ts';
import { RFC8032_TEST1_SEED } from '../scripts/make-index-fixtures.ts';
import { importCatalog } from '../src/sources/catalog-import.ts';
import { githubClaim } from '../src/services/claims.ts';
import { createProject } from '../src/services/projects.ts';
import { storeImage } from '../src/services/images.ts';
import { makeDemoPng, makeZip } from './helpers.ts';

let app: FastifyInstance;
let ctx: Ctx;
let dir: string;
const PORTAL = 'http://localhost:5174';

const logo = makeDemoPng(256, 256, [200, 60, 20]);
const own = makeDemoPng(128, 128, [10, 10, 10]);
const shot = makeDemoPng(1280, 720, [30, 120, 200]);
const modZip = makeZip([{ name: 'GameData/Shaders/a.txt', data: 'hello' }]);
const rel = (tag: string, assets: string[]) => ({ tag_name: tag, prerelease: false, draft: false, body: tag, published_at: '2026-11-01T00:00:00Z', assets: assets.map((n) => ({ name: n, size: modZip.length, download_count: 1, browser_download_url: `https://dl.example/${tag}/${n}` })) });
const repoJson = (name: string) => ({ full_name: `acme/${name}`, name, description: 'Shiny things for TrackMania', homepage: '', license: { spdx_id: 'MIT' }, owner: { login: 'acme' }, html_url: `https://github.com/acme/${name}`, topics: [], archived: false, default_branch: 'main' });
const releasesOf: Record<string, unknown[]> = { shiny: [rel('v1.0.0', ['Shiny-1.0.0.zip'])], twofiles: [rel('v1.0.0', ['Twofiles-a.zip', 'Twofiles-b.zip'])], bare: [rel('v1.0.0', ['Bare-1.0.0.zip'])] };

const fakeFetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json', etag: '"e1"' } });
  const m = /^https:\/\/api\.github\.com\/repos\/acme\/(\w+)(\/releases.*|\/readme)?(\?.*)?$/.exec(url);
  if (m) {
    if (!releasesOf[m[1]!]) return new Response('nope', { status: 404 });
    if (!m[2]) return json(repoJson(m[1]!));
    if (m[2].startsWith('/releases')) return json(releasesOf[m[1]!]);
    return new Response(`# ${m[1]}\n\n![shot](docs/a.png)\n`, { status: 200 });
  }
  if (url.includes('/contents/docs/images')) return new Response('[]', { status: 404 });
  if (url === 'https://img.example/alpha.png') return new Response(new Uint8Array(logo), { status: 200 });
  if (/^https:\/\/raw\.githubusercontent\.com\/acme\/\w+\/main\/docs\/a\.png$/.test(url)) return new Response(new Uint8Array(shot), { status: 200 });
  if (url.startsWith('https://dl.example/') && url.endsWith('.zip')) return new Response(new Uint8Array(modZip), { status: 200 });
  return new Response('nope', { status: 404 });
}) as typeof fetch;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hub-claim-assets-'));
  const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'sqlite::memory:', STORAGE_DIR: join(dir, 'files'), HUB_DEV_LOGIN: '1', CRAWLER: '0' });
  ctx = await createCtx(cfg, { fetch: fakeFetch, key: loadSigningKey(RFC8032_TEST1_SEED) });
  app = await buildApp(ctx);
});
after(async () => {
  await app.close();
  await ctx.db.destroy();
  rmSync(dir, { recursive: true, force: true });
});

type Agent = { cookie: string; csrf: string; id: string };
async function login(as: string): Promise<Agent> {
  const r = await app.inject({ method: 'POST', url: '/auth/dev/login', payload: { as }, headers: { origin: PORTAL } });
  const cookie = r.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const me = await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } });
  return { cookie, csrf: me.json().csrf, id: (await ctx.db.selectFrom('identities').select('user_id').where('provider_id', '=', as).executeTakeFirstOrThrow()).user_id };
}
const H = (a: Agent) => ({ cookie: a.cookie, 'x-csrf-token': a.csrf, origin: PORTAL });
const iconKey = async (slug: string) => (await ctx.db.selectFrom('images').innerJoin('projects', 'projects.id', 'images.project_id').select('images.storage_key').where('projects.slug', '=', slug).where('images.kind', '=', 'icon').executeTakeFirst())?.storage_key ?? null;

test('logo pick: TMLoader index icon first, then the website art, else nothing', () => {
  const icons = modIconMap([{ id: 'TMVS', name: 'TM Vibrant Shaders', icon: 'https://x/icon.png' }]);
  assert.equal(catalogLogoUrl({ id: 'tm-vibrant-shaders', name: 'TM Vibrant Shaders' }, icons, { 'tm-vibrant-shaders': { url: 'https://x/art.png' } })?.url, 'https://x/icon.png');
  assert.equal(catalogLogoUrl({ id: 'other', name: 'Other' }, icons, { other: { url: 'https://x/art.png' } })?.source, 'entry-art');
  assert.equal(catalogLogoUrl({ id: 'none', name: 'None' }, icons, { none: { url: null } }), null);
});

test('catalog import sets the icon once, keeps an icon somebody set, and survives a broken logo', async () => {
  const entry = (id: string, name: string) => ({ id, name, category: 'mod', modType: 'graphics', games: ['tmnf'], url: `https://github.com/acme/${id}`, description: `${name}, a mod for TrackMania.`, author: 'Acme', status: 'alive' });
  const catalogPath = join(dir, 'catalog.json'), modsPath = join(dir, 'mods.json'), artPath = join(dir, 'art.json');
  writeFileSync(catalogPath, JSON.stringify({ entries: [entry('alpha', 'Alpha'), entry('beta', 'Beta'), entry('gamma', 'Gamma')] }));
  writeFileSync(modsPath, JSON.stringify({ mods: [{ id: 'alpha', name: 'Alpha', icon: 'https://img.example/alpha.png', type: 'program' }] }));
  // beta: its art URL answers 404; gamma: nothing known.
  writeFileSync(artPath, JSON.stringify({ beta: { url: 'https://img.example/gone.png' } }));
  const r1 = await importCatalog(ctx, { catalogPath, modsPath, artPath });
  assert.equal(r1.icons, 1);
  const first = await iconKey('alpha');
  assert.ok(first, 'alpha has an icon');
  assert.equal(await iconKey('beta'), null, 'a broken logo is skipped, not an error');
  assert.equal(await iconKey('gamma'), null);

  // The author replaces the icon; the re-import must not bring the catalog logo back over it.
  const alpha = await ctx.db.selectFrom('projects').select('id').where('slug', '=', 'alpha').executeTakeFirstOrThrow();
  await storeImage(ctx, alpha.id, 'icon', own, 0, null);
  const authors = await iconKey('alpha');
  assert.notEqual(authors, first);
  const r2 = await importCatalog(ctx, { catalogPath, modsPath, artPath });
  assert.equal(r2.icons, 0);
  assert.equal(await iconKey('alpha'), authors);

  // An existing project without an icon gets one on the re-import.
  await ctx.db.deleteFrom('images').where('project_id', '=', alpha.id).execute();
  assert.equal((await importCatalog(ctx, { catalogPath, modsPath, artPath })).icons, 1);
  assert.equal(await iconKey('alpha'), first);
});

test('an icon the author removed in the portal stays removed after a catalog re-import', async () => {
  const catalogPath = join(dir, 'catalog.json'), modsPath = join(dir, 'mods.json'), artPath = join(dir, 'art.json');
  const alpha = await ctx.db.selectFrom('projects').select('id').where('slug', '=', 'alpha').executeTakeFirstOrThrow();
  const author = await login('admin');
  await ctx.db.insertInto('members').values({ project_id: alpha.id, user_id: author.id, role: 'owner', added_at: new Date().toISOString() }).execute();
  const icon = await ctx.db.selectFrom('images').select('id').where('project_id', '=', alpha.id).where('kind', '=', 'icon').executeTakeFirstOrThrow();
  const del = await app.inject({ method: 'DELETE', url: `/v1/projects/alpha/images/${icon.id}`, headers: H(author) });
  assert.equal(del.statusCode, 200, del.body);
  assert.equal(await iconKey('alpha'), null);
  assert.equal((await importCatalog(ctx, { catalogPath, modsPath, artPath })).icons, 0, 'the catalog logo does not come back');
  assert.equal(await iconKey('alpha'), null);
});

async function catalogProject(slug: string, withInstall: boolean) {
  return createProject(ctx, {
    name: slug, slug, type: 'mod', summary: 'A mod for TrackMania.', description: 'Imported text.\n\n*Imported from the TM Horizon catalog; not claimed by its author yet.*', categories: [], tags: [], games: ['tmnf'],
    installs: withInstall ? { tmnf: { kind: 'files', base: 'game', strip: 0, include: [] } } : {}, license: null, links: { source: `https://github.com/acme/${slug}` }, dependencies: [], conflicts: [],
  }, null, { author_name: 'Acme', catalog_id: slug, source_url: `https://github.com/acme/${slug}`, state: 'listed' });
}

test('GitHub claim connects the repository and takes its first release', async () => {
  await catalogProject('shiny', true);
  const owner = await login('author');
  const path = await githubClaim(ctx, owner.id, 'shiny', 'dev');
  assert.equal(path, '/projects/shiny?claimed=1');
  const p = (await app.inject({ method: 'GET', url: '/v1/projects/shiny', headers: H(owner) })).json() as HubProject;
  assert.equal(p.claimed, true);
  assert.equal(p.sources.length, 1);
  assert.equal(p.sources[0]!.target, 'acme/shiny');
  assert.ok(p.sources[0]!.lastCheck, 'first check ran');
  const vs = (await app.inject({ method: 'GET', url: '/v1/projects/shiny/versions', headers: H(owner) })).json() as { version: string }[];
  assert.deepEqual(vs.map((v) => v.version), ['1.0.0']);
});

test('several fitting release files: connected, waiting for the choice; choosing takes the release', async () => {
  await catalogProject('twofiles', true);
  const owner = await login('author2');
  await githubClaim(ctx, owner.id, 'twofiles', 'dev');
  let p = (await app.inject({ method: 'GET', url: '/v1/projects/twofiles', headers: H(owner) })).json() as HubProject;
  assert.deepEqual(p.sources[0]!.needsChoice?.assets, ['Twofiles-a.zip', 'Twofiles-b.zip']);
  const pick = await app.inject({ method: 'POST', url: `/v1/sources/${p.sources[0]!.id}/choose`, payload: { tag: 'v1.0.0', asset: 'Twofiles-a.zip' }, headers: H(owner) });
  assert.equal(pick.statusCode, 200, pick.body);
  p = (await app.inject({ method: 'GET', url: '/v1/projects/twofiles', headers: H(owner) })).json() as HubProject;
  assert.equal(p.sources[0]!.needsChoice, null);
  assert.equal(((await app.inject({ method: 'GET', url: '/v1/projects/twofiles/versions', headers: H(owner) })).json() as unknown[]).length, 1);
});

test('Import from GitHub on a claimed project applies only the ticked items', async () => {
  await catalogProject('bare', false);
  const owner = await login('user');
  await githubClaim(ctx, owner.id, 'bare', 'dev');
  let p = (await app.inject({ method: 'GET', url: '/v1/projects/bare', headers: H(owner) })).json() as HubProject;
  // No install type yet: the source is connected, but no release was taken (and none was marked as seen).
  assert.equal(p.sources.length, 1);
  assert.equal(p.sources[0]!.imported, 0);
  assert.equal(p.gallery.length, 0);
  const summaryBefore = p.summary, descBefore = p.description;

  const pv = (await app.inject({ method: 'POST', url: '/v1/sources/preview', payload: { url: 'https://github.com/acme/bare' }, headers: H(owner) })).json() as { images: string[] };
  const pic = 'https://raw.githubusercontent.com/acme/bare/main/docs/a.png';
  assert.deepEqual(pv.images, [pic]);
  // A picture that was not in the preview is refused.
  const bad = await app.inject({ method: 'POST', url: '/v1/projects/bare/import-github', payload: { url: 'https://github.com/acme/bare', images: ['https://evil.example/x.png'] }, headers: H(owner) });
  assert.equal(bad.statusCode, 400);
  // Nobody else may apply.
  const other = await login('author2');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/projects/bare/import-github', payload: { url: 'https://github.com/acme/bare' }, headers: H(other) })).statusCode, 403);

  const ok = await app.inject({ method: 'POST', url: '/v1/projects/bare/import-github', headers: H(owner), payload: {
    url: 'https://github.com/acme/bare', license: 'MIT', links: { homepage: 'https://acme.example/bare' }, images: [pic], games: ['tmnf'], install: { kind: 'files', base: 'game' },
  } });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual((ok.json() as { applied: string[] }).applied, ['license', 'links', 'games', '1 gallery pictures']);
  p = (await app.inject({ method: 'GET', url: '/v1/projects/bare', headers: H(owner) })).json() as HubProject;
  assert.equal(p.gallery.length, 1);
  assert.equal(p.license, 'MIT');
  assert.equal(p.links.homepage, 'https://acme.example/bare');
  assert.equal(p.links.source, 'https://github.com/acme/bare', 'existing links stay');
  assert.equal(p.summary, summaryBefore, 'not ticked: unchanged');
  assert.equal(p.description, descBefore, 'not ticked: unchanged');
  assert.equal(p.sources.length, 1, 'no second source');
  assert.equal(p.sources[0]!.imported, 1, 'the release came in once the install type was known');
});
