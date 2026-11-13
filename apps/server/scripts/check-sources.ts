// npm run check-sources -w @tm-hub/server [-- <project slug>...]
// Checks every source of the claimed projects (or of the given slugs) now, like "Check now" in the portal
// (icon, showcase, games, releases), then rebuilds and re-signs the index. For operators, on the box.
import { loadConfig } from '../src/config.ts';
import { createCtx } from '../src/ctx.ts';
import { checkSource } from '../src/sources/crawler.ts';
import { rebuildIndex } from '../src/services/hubindex.ts';

const slugs = process.argv.slice(2);
const ctx = await createCtx(loadConfig());
let q = ctx.db.selectFrom('sources').innerJoin('projects', 'projects.id', 'sources.project_id').select(['sources.id as id', 'sources.target as target', 'projects.slug as slug']);
q = slugs.length ? q.where('projects.slug', 'in', slugs) : q.where('projects.claimed', '=', 1);
for (const s of await q.orderBy('projects.slug').execute()) {
  const r = await checkSource(ctx, s.id, { force: true });
  console.log(`${s.slug} <- ${s.target}: imported [${r.imported.join(', ')}] skipped [${r.skipped.join('; ')}]${r.needsChoice ? ` needs choice ${r.needsChoice.tag}` : ''}${r.error ? ` ERROR ${r.error}` : ''}`);
}
const idx = await rebuildIndex(ctx);
console.log('index rebuilt, seq', JSON.parse(Buffer.from(idx.payload, 'base64').toString('utf8')).seq);
await ctx.db.destroy();
