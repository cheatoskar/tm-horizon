// npm run recheck-dinput8 -w @tm-hub/server
// After the dinput8.dll exception (checks/dinput8.ts): versions of the allowed projects that were rejected only because of
// dinput8.dll are removed (a rejected version keeps no file), their releases are marked unseen, the sources are checked
// again and the index is re-signed. Other rejections stay.
import { loadConfig } from '../src/config.ts';
import { createCtx } from '../src/ctx.ts';
import { DINPUT8_ALLOWED } from '../src/checks/dinput8.ts';
import { checkSource } from '../src/sources/crawler.ts';
import { rebuildIndex } from '../src/services/hubindex.ts';
import { parseJson } from '../src/util.ts';

const ctx = await createCtx(loadConfig());
for (const e of DINPUT8_ALLOWED) {
  const srcs = await ctx.db.selectFrom('sources').innerJoin('projects', 'projects.id', 'sources.project_id').select(['sources.id as sid', 'projects.id as pid', 'projects.slug as slug', 'projects.claimed as claimed'])
    .where('sources.kind', '=', 'github').where('sources.target', 'in', [e.repo, e.repo.replace('cheatoskar/', 'cheatoskar/')]).execute();
  for (const s of srcs) {
    if (!s.claimed || (e.projectId && e.projectId !== s.pid)) continue;
    const rej = await ctx.db.selectFrom('versions').selectAll().where('project_id', '=', s.pid).where('status', '=', 'rejected').execute();
    for (const v of rej) {
      const findings = parseJson<{ findings?: { severity: string; code: string }[] }>(v.report, {}).findings ?? [];
      const rejects = findings.filter((f) => f.severity === 'reject').map((f) => f.code);
      if (!rejects.length || rejects.some((c) => c !== 'type.dinput8')) continue;
      await ctx.db.deleteFrom('versions').where('id', '=', v.id).execute();
      for (const ref of [`v${v.version}`, v.version]) await ctx.db.deleteFrom('source_seen').where('source_id', '=', s.sid).where('ref', '=', ref).execute();
      console.log(`${s.slug}: removed rejected ${v.version} (dinput8 only)`);
    }
    const r = await checkSource(ctx, s.sid, { force: true });
    console.log(`${s.slug}: imported [${r.imported.join(', ')}] skipped [${r.skipped.join('; ')}]${r.error ? ' ERROR ' + r.error : ''}`);
  }
}
const idx = await rebuildIndex(ctx);
console.log('index rebuilt, seq', JSON.parse(Buffer.from(idx.payload, 'base64').toString('utf8')).seq);
await ctx.db.destroy();
