// The signed index lists unclaimed catalog projects without hub versions, with their catalog entry (release policy
// applied); the import hides what the catalog or the policy no longer lists and brings it back when it returns.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HubIndexPayload } from '@tm-hub/shared';
import { loadConfig } from '../src/config.ts';
import { createCtx } from '../src/ctx.ts';
import { importCatalog } from '../src/sources/catalog-import.ts';
import { currentIndex } from '../src/services/hubindex.ts';
import { useCatalogFile } from '../src/services/catalog-seeds.ts';
import { loadSigningKey, verifyIndex } from '../src/index/sign.ts';
import { RFC8032_TEST1_SEED } from '../scripts/make-index-fixtures.ts';

const dir = mkdtempSync(join(tmpdir(), 'catidx-'));
after(() => { useCatalogFile(null); rmSync(dir, { recursive: true, force: true }); });

const entry = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, category: 'mod', games: ['tmnf', 'tmuf'], url: `https://github.com/acme/${id}`, api: null, description: `${name}, a mod for TrackMania.`,
  maintainer: 'acme', language: 'en', status: 'alive', checked: '2026-11-12', launcher: 'install/update from GitHub releases', author: 'Acme', ...extra,
});
const gh = (id: string) => ({ installSpec: { kind: 'tmloader-product', download: { github: `acme/${id}`, asset: `${id}-*.zip` }, games: ['tmnf', 'tmuf'], requires: ['TMLoader'] } });
const showcase = { version: 1, blocks: [{ type: 'hero', title: 'Alpha' }] };

function write(name: string, entries: unknown[], policy: Record<string, unknown> | null, showcases: unknown[] = []) {
  const d = join(dir, name);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'catalog.json'), JSON.stringify({ entries, showcases }));
  if (policy) writeFileSync(join(d, 'release-policy.json'), JSON.stringify(policy));
  return join(d, 'catalog.json');
}

const pub = loadSigningKey(RFC8032_TEST1_SEED).publicKey;
async function index(ctx: Awaited<ReturnType<typeof createCtx>>): Promise<HubIndexPayload> {
  return verifyIndex(await currentIndex(ctx), [pub]);
}

test('catalog projects without versions are in the signed index with their catalog entry; policy and removals hide them', async () => {
  const ctx = await createCtx(loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'sqlite::memory:', STORAGE_DIR: join(dir, 'files') }), {
    key: loadSigningKey(RFC8032_TEST1_SEED), fetch: (async () => { throw new Error('no network in this test'); }) as typeof fetch,
  });
  const opts = (catalogPath: string) => ({ catalogPath, modsPath: join(dir, 'none.json'), icons: false });

  // 1st import: alpha installs from GitHub, beta is link only, gamma hidden, delta has no install, an exchange is not a project.
  const c1 = write('c1', [
    entry('alpha', 'Alpha Mod', gh('alpha')), entry('beta', 'Beta Mod', gh('beta')), entry('gamma', 'Gamma Mod', gh('gamma')),
    entry('delta', 'Delta Mod', { installSpec: null, downloadNote: 'Download on the author page' }), entry('ex', 'Some Exchange', { category: 'exchange' }),
  ], { hide: { gamma: 'no licence' }, linkOnly: { beta: 'no licence' }, noShowcase: { delta: 'no permission' } },
  [{ mod: 'alpha', showcase }, { mod: 'delta', showcase: { ...showcase, blocks: [{ type: 'hero', title: 'Delta' }] } }]);
  useCatalogFile(c1);
  const r1 = await importCatalog(ctx, opts(c1));
  assert.deepEqual(r1.created.sort(), ['alpha-mod', 'beta-mod', 'delta-mod']);
  assert.ok(r1.skipped.includes('gamma (hidden by the release policy)'));

  let pl = await index(ctx);
  assert.deepEqual(pl.projects.map((p) => p.catalogId).sort(), ['alpha', 'beta', 'delta', 'ex']);
  const ex = pl.projects.find((p) => p.catalogId === 'ex')!;
  assert.equal(ex.catalogOnly, true, 'a non-mod catalog entry is a catalog-only index entry');
  assert.equal(ex.catalogEntry?.category, 'exchange');
  assert.deepEqual([ex.id, ex.slug, ex.versions.length], ['c_ex', 'catalog-ex', 0]);
  assert.equal(pl.projects.find((p) => p.catalogId === 'alpha')!.catalogOnly, undefined);
  const alpha = pl.projects.find((p) => p.catalogId === 'alpha')!;
  assert.equal(alpha.versions.length, 0);
  assert.equal(alpha.catalogEntry?.id, 'alpha');
  assert.equal(alpha.catalogEntry?.installSpec?.download.github, 'acme/alpha', 'the catalog install spec goes through unchanged');
  assert.deepEqual(alpha.sources, [{ kind: 'github', target: 'acme/alpha', asset: 'alpha-*.zip' }]);
  assert.equal((alpha.showcase as { blocks: { title: string }[] } | undefined)?.blocks[0].title, 'Alpha');
  const beta = pl.projects.find((p) => p.catalogId === 'beta')!;
  assert.equal(beta.catalogEntry?.installSpec, null, 'link only: no install spec');
  assert.equal(beta.catalogEntry?.launcher, 'open download page');
  assert.equal(beta.sources, undefined, 'link only: the hub does not crawl it');
  const delta = pl.projects.find((p) => p.catalogId === 'delta')!;
  assert.equal(delta.showcase, undefined, 'noShowcase: no seed showcase');
  assert.equal(delta.catalogEntry?.downloadNote, 'Download on the author page');
  assert.deepEqual(pl.withdrawn, []);

  // A claimed catalog project keeps its catalog entry (and is never hidden by the import).
  await ctx.db.updateTable('projects').set({ claimed: 1 }).where('catalog_id', '=', 'delta').execute();
  // 2nd import: delta is claimed and gone from the catalog (untouched), alpha dropped from the catalog, beta now installable.
  const c2 = write('c2', [entry('beta', 'Beta Mod', gh('beta')), entry('gamma', 'Gamma Mod', gh('gamma'))], { hide: { gamma: 'no licence' } });
  useCatalogFile(c2);
  const r2 = await importCatalog(ctx, opts(c2));
  assert.equal(r2.created.length, 0);
  assert.deepEqual(r2.hidden, ['alpha']);
  const st = async (cid: string) => (await ctx.db.selectFrom('projects').select('state').where('catalog_id', '=', cid).executeTakeFirstOrThrow()).state;
  assert.equal(await st('alpha'), 'hidden');
  assert.equal(await st('delta'), 'listed', 'a claimed project is never hidden by the import');
  pl = await index(ctx);
  assert.deepEqual(pl.projects.map((p) => p.catalogId).sort(), ['beta', 'delta'], 'alpha hidden, the exchange gone with the catalog');
  assert.equal(pl.projects.find((p) => p.catalogId === 'beta')!.catalogEntry?.installSpec?.download.github, 'acme/beta', 'catalog entry refreshed');
  assert.equal(pl.projects.find((p) => p.catalogId === 'delta')!.claimed, true);
  assert.deepEqual(pl.withdrawn, ['alpha']);
  const search = await ctx.db.selectFrom('projects').select('slug').where('state', '=', 'listed').execute();
  assert.ok(!search.some((s) => s.slug === 'alpha-mod'), 'hidden projects are out of the listing');

  // 3rd import: alpha is back, beta turns link only (its source and installs go away).
  const c3 = write('c3', [entry('alpha', 'Alpha Mod', gh('alpha')), entry('beta', 'Beta Mod', gh('beta'))], { linkOnly: { beta: 'licence withdrawn' } });
  useCatalogFile(c3);
  const r3 = await importCatalog(ctx, opts(c3));
  assert.deepEqual(r3.restored, ['alpha']);
  pl = await index(ctx);
  assert.deepEqual(pl.projects.map((p) => p.catalogId).sort(), ['alpha', 'beta', 'delta']);
  assert.deepEqual(pl.withdrawn, []);
  const b = pl.projects.find((p) => p.catalogId === 'beta')!;
  assert.equal(b.catalogEntry?.installSpec, null);
  assert.equal(b.sources, undefined);
  const bRow = await ctx.db.selectFrom('projects').select(['id', 'installs']).where('catalog_id', '=', 'beta').executeTakeFirstOrThrow();
  assert.equal(bRow.installs, '{}');
  assert.equal((await ctx.db.selectFrom('sources').select('id').where('project_id', '=', bRow.id).execute()).length, 0);

  // Idempotent: the same import again changes nothing.
  const r4 = await importCatalog(ctx, opts(c3));
  assert.deepEqual([r4.created.length, r4.hidden.length, r4.restored.length], [0, 0, 0]);
  await ctx.db.destroy();
});
