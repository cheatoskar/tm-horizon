// npm run import-catalog -w @tm-hub/server [-- --crawl]
// Creates unclaimed projects from packages/catalog and the TMLoader mods of the bundled hub data.
// Without --crawl the sources are attached but not checked until someone presses "Check now".
import { loadConfig } from '../src/config.ts';
import { createCtx } from '../src/ctx.ts';
import { importCatalog } from '../src/sources/catalog-import.ts';

const ctx = await createCtx(loadConfig());
const r = await importCatalog(ctx, { crawl: process.argv.includes('--crawl') });
console.log(`created ${r.created.length} unclaimed projects, ${r.sources} sources, ${r.icons} icons; skipped ${r.skipped.length}`);
for (const s of r.skipped) console.log('  skipped', s);
await ctx.db.destroy();
