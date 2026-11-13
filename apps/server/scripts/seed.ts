// Development data: the catalog import (unclaimed projects) plus a demo project that went through the
// real upload pipeline (published versions, one held update, one flagged in review, one rejected),
// a report and a claim request, so every portal page has something to show.
// npm run seed -w @tm-hub/server   (add -- --fresh to delete data/hub.sqlite first)
import { rmSync } from 'node:fs';
import { loadConfig } from '../src/config.ts';
import { createCtx } from '../src/ctx.ts';
import { importCatalog } from '../src/sources/catalog-import.ts';
import { createProject } from '../src/services/projects.ts';
import { ingestVersion, approveVersion, publishDue } from '../src/services/versions.ts';
import { upsertUser } from '../src/services/users.ts';
import { storeImage } from '../src/services/images.ts';
import { rebuildIndex } from '../src/services/hubindex.ts';
import { requestClaim } from '../src/services/claims.ts';
import { makeDemoPng, makePe, tmloaderZip, makeZip } from '../test/helpers.ts';
import { newId, nowIso } from '../src/util.ts';

const cfg = loadConfig();
if (cfg.production) throw new Error('seed is for development only');
if (process.argv.includes('--fresh') && cfg.DATABASE_URL.startsWith('sqlite:')) {
  for (const f of ['', '-wal', '-shm']) rmSync(cfg.DATABASE_URL.slice(7) + f, { force: true });
}
const ctx = await createCtx(cfg);
if (await ctx.db.selectFrom('projects').select('id').where('slug', '=', 'demo-shaders').executeTakeFirst()) {
  console.log('already seeded (use --fresh to start over)');
  process.exit(0);
}
const cat = await importCatalog(ctx);
console.log(`catalog: ${cat.created.length} unclaimed projects, ${cat.sources} sources (not crawled)`);

const author = await upsertUser(ctx, { provider: 'dev', providerId: 'author', username: 'dev-author', name: 'Dev Author', avatar: null });
await upsertUser(ctx, { provider: 'dev', providerId: 'admin', username: 'dev-admin', name: 'Dev Admin', avatar: null });
const second = await upsertUser(ctx, { provider: 'dev', providerId: 'author2', username: 'dev-author2', name: 'Second Author', avatar: null });

const p = await createProject(ctx, {
  name: 'Demo Shaders', slug: 'demo-shaders', type: 'mod', summary: 'Example shader pack for Nations and United Forever (development seed, not a real mod).',
  description: '# Demo Shaders\n\nA made-up project that went through the real upload checks.\n\n- Bloom and colour grading\n- Works with **CoreMod**\n\n```ini\n[Shader]\nBloom=0.35\n```',
  categories: ['graphics'], tags: ['shader', 'bloom'], games: ['tmnf', 'tmuf'],
  installs: { tmnf: { kind: 'tmloader-product', strip: 0, include: [] }, tmuf: { kind: 'tmloader-product', strip: 0, include: [] } },
  license: 'MIT', links: { source: 'https://github.com/example/demo-shaders', discord: 'https://discord.gg/example' },
  dependencies: [{ id: 'CoreMod', version: '^1.0.0', tmloader: true }], conflicts: [], tmloaderProduct: 'DemoShaders',
}, { id: author, name: 'Dev Author' });
await ctx.db.insertInto('members').values({ project_id: p.id, user_id: second, role: 'uploader', added_at: nowIso() }).execute();
await storeImage(ctx, p.id, 'icon', makeDemoPng(256, 256, [255, 107, 26]), 0, null);
await storeImage(ctx, p.id, 'banner', makeDemoPng(1280, 400, [40, 60, 110]), 0, null);
const colours: [number, number, number][] = [[30, 120, 200], [200, 80, 60], [60, 160, 90]];
for (const [i, c] of colours.entries()) await storeImage(ctx, p.id, 'gallery', makeDemoPng(1280, 720, c), i, `Screenshot ${i + 1}`);

const up = (version: string, data: Buffer, changelog: string) =>
  ingestVersion(ctx, { project: p, fileName: `DemoShaders-${version}.zip`, data, meta: { version, channel: version.includes('-') ? 'beta' : 'stable', changelog }, origin: 'upload', uploaderId: author });
const v1 = await up('1.0.0', tmloaderZip('DemoShaders', '1.0.0'), '## 1.0.0\n- First release');
await approveVersion(ctx, v1, 'seed');
await up('1.1.0', tmloaderZip('DemoShaders', '1.1.0'), '## 1.1.0\n- Softer bloom');
await publishDue(ctx, new Date(Date.now() + 2 * 3600_000).toISOString());
await up('1.2.0', tmloaderZip('DemoShaders', '1.2.0'), '## 1.2.0\n- Night tone curve');
await up('1.3.0-beta.1', tmloaderZip('DemoShaders', '1.3.0-beta.1', [], makePe({ imports: { 'KERNEL32.dll': ['LoadLibraryA'], 'WININET.dll': ['InternetOpenA', 'InternetReadFile'] } })), 'Beta: update check');
await up('1.3.1', makeZip([{ name: 'DemoShaders/1.3.1/description.yaml', data: 'x' }, { name: '../../evil.dll', data: makePe() }]), 'Broken upload');

const other = await createProject(ctx, {
  name: 'Snow Skins', slug: 'snow-skins', type: 'skin', summary: 'Winter car skins for Stadium (development seed).', description: 'Skins pack.', categories: ['skins'], tags: ['winter'],
  games: ['tmnf'], installs: { tmnf: { kind: 'files', base: 'documents', strip: 0, include: [] } }, license: 'CC-BY-4.0', links: {}, dependencies: [], conflicts: [], tmloaderProduct: null,
}, { id: author, name: 'Dev Author' });
await ingestVersion(ctx, {
  project: other, fileName: 'snow-skins.zip', data: makeZip([{ name: 'Skins/Vehicles/CarCommon/Snow.zip', data: makeZip([{ name: 'Diffuse.dds', data: 'DDS ' }]), method: 0 }]),
  meta: { version: '1.0.0', channel: 'stable', changelog: 'First' }, origin: 'upload', uploaderId: author,
});

await ctx.db.insertInto('reports').values({
  id: newId('r'), project_id: p.id, version_id: null, reason: 'copyright', explanation: 'The bloom shader looks copied from another mod without credit (seed example).',
  location: `${cfg.HUB_PORTAL_URL}p/demo-shaders`, name: null, email: null, status: 'open', resolution: null, created_at: nowIso(), resolved_at: null,
}).execute();
const unclaimed = await ctx.db.selectFrom('projects').selectAll().where('claimed', '=', 0).orderBy('name').limit(1).executeTakeFirst();
if (unclaimed) await requestClaim(ctx, unclaimed, second, 'manual', 'I made this mod; the Discord post is mine (seed example).');
await rebuildIndex(ctx);
console.log('seeded: demo-shaders (published 1.0.0 + 1.1.0, held 1.2.0, review 1.3.0-beta.1, rejected 1.3.1), snow-skins (review), 1 report, 1 claim');
await ctx.db.destroy();
