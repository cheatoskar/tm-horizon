// npm run import-catalog -w @tm-hub/server [-- --crawl] [--catalog <catalog.json>] [--policy <release-policy.json>]
// Creates unclaimed projects from packages/catalog and the TMLoader mods of the bundled hub data.
// Idempotent: existing projects are updated (catalog entry, seed showcase, Discord id), unclaimed catalog projects the
// catalog no longer lists (or the release policy hides) become "hidden", hidden ones that are back become listed again.
// --catalog: another catalog file (e.g. the cleaned one of a release branch); its seed showcases are used too.
// --policy: the release policy (default: release-policy.json next to the catalog, if there is one).
// Without --crawl the sources are attached but not checked until someone presses "Check now".
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { createCtx } from '../src/ctx.ts';
import { useCatalogFile } from '../src/services/catalog-seeds.ts';
import { importCatalog } from '../src/sources/catalog-import.ts';

const arg = (name: string) => { const i = process.argv.indexOf(name); return i > 0 && process.argv[i + 1] ? resolve(process.argv[i + 1]) : undefined; };
const catalogPath = arg('--catalog');
const policyPath = arg('--policy');
if (catalogPath) useCatalogFile(catalogPath);

const ctx = await createCtx(loadConfig());
const r = await importCatalog(ctx, { crawl: process.argv.includes('--crawl'), catalogPath, policyPath });
console.log(`created ${r.created.length} unclaimed projects, ${r.sources} sources, ${r.icons} icons; hidden ${r.hidden.length}, restored ${r.restored.length}; skipped ${r.skipped.length}`);
for (const s of r.skipped) if (!s.endsWith('(exists)')) console.log('  skipped', s);
for (const h of r.hidden) console.log('  hidden', h);
for (const h of r.restored) console.log('  restored', h);
await ctx.db.destroy();
