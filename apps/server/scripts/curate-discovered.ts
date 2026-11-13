// npm run curate-discovered -w @tm-hub/server [-- --apply [reject,approve,pending]] [--no-gather] [--examples 15] [--json file]
// Sorts every waiting discovered GitHub repository into reject / approve / pending (services/discover-curate.ts).
// Without --apply it only prints the numbers and examples per bucket (a dry run); GitHub facts (README, releases)
// and the openplanet.dev list are fetched once and cached in the database (--no-gather uses the cache only).
import { writeFileSync } from 'node:fs';
import { loadConfig } from '../src/config.ts';
import { createCtx } from '../src/ctx.ts';
import { applyCuration, curateWaiting, summarize, type Bucket } from '../src/services/discover-curate.ts';

const args = process.argv.slice(2);
const val = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const ctx = await createCtx(loadConfig());
const curated = await curateWaiting(ctx, { gather: !args.includes('--no-gather'), log: (s) => console.error('  ', s) });
const sum = summarize(curated, Number(val('--examples') ?? 15));
for (const k of ['reject', 'approve', 'pending'] as Bucket[]) {
  console.log(`\n== ${k.toUpperCase()}: ${sum[k].n}  ${JSON.stringify(sum[k].codes)}`);
  for (const e of sum[k].examples) console.log(`  ${e.name} | ${e.url} | ${e.code}: ${e.reason}`);
}
if (val('--json')) writeFileSync(val('--json')!, JSON.stringify(curated.map((c) => ({ repo: c.row.full_name, url: c.row.html_url, stars: c.row.stars, ...c.decision })), null, 1));
const ai = args.indexOf('--apply');
if (ai >= 0) {
  const list = (args[ai + 1] && !args[ai + 1]!.startsWith('--') ? args[ai + 1]! : 'reject,approve').split(',') as Bucket[];
  const r = await applyCuration(ctx, curated, 'system:curation', list);
  console.log(`\napplied (${list.join(', ')}): ${r.rejected} rejected, ${r.approved} approved, ${r.pending} noted pending, ${r.failed.length} failed`);
  for (const f of r.failed.slice(0, 20)) console.log('  failed', f.repo, f.error);
} else console.log('\ndry run, nothing changed (add --apply to apply)');
await ctx.db.destroy();
