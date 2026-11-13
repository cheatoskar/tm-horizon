// Claiming an unclaimed project (imported from the catalog or crawled before its author signed up):
// - GitHub: log in with GitHub; if the account is admin of the linked repository the claim is approved at once.
// - TMLoader server: put the shown token into <server>/tmhub-claim.txt, then "Verify".
// - Manual: a message to the admins (review queue).
import type { ClaimRequest } from '@tm-hub/shared';
import type { Ctx } from '../ctx.ts';
import type { ProjectsTable } from '../db/db.ts';
import { HttpError, newId, nowIso, randomToken } from '../util.ts';
import { isRepoAdmin } from '../sources/github.ts';
import { rebuildIndex } from './hubindex.ts';
import { connectGithubSource } from '../sources/importer.ts';

export async function grantClaim(ctx: Ctx, p: ProjectsTable, userId: string, how: string, actor: string) {
  const user = await ctx.db.selectFrom('users').select(['id', 'name']).where('id', '=', userId).executeTakeFirstOrThrow();
  const at = nowIso();
  await ctx.db.deleteFrom('members').where('project_id', '=', p.id).where('role', '=', 'owner').execute();
  await ctx.db.deleteFrom('members').where('project_id', '=', p.id).where('user_id', '=', userId).execute();
  await ctx.db.insertInto('members').values({ project_id: p.id, user_id: userId, role: 'owner', added_at: at }).execute();
  // owner_changed_at: the next versions get a human look (diff.owner-change) for 14 days.
  await ctx.db.updateTable('projects').set({ claimed: 1, author_name: user.name, owner_changed_at: at, updated_at: at }).where('id', '=', p.id).execute();
  await ctx.db.updateTable('claims').set({ status: 'rejected', decided_at: at }).where('project_id', '=', p.id).where('status', '=', 'pending').where('user_id', '!=', userId).execute();
  await ctx.db.updateTable('claims').set({ status: 'approved', decided_at: at }).where('project_id', '=', p.id).where('status', '=', 'pending').where('user_id', '=', userId).execute();
  await ctx.audit(actor, 'project.claim', p.id, { userId, how });
  await ctx.notify({ kind: 'claim', text: `${user.name} claimed ${p.name} (${how})` });
  await rebuildIndex(ctx);
}

/** Discord login: claims every unclaimed project whose catalog entry names this Discord user id as its poster. Returns the claimed slugs. */
export async function claimByDiscordId(ctx: Ctx, userId: string, discordId: string): Promise<string[]> {
  if (!/^\d{15,25}$/.test(discordId)) return [];
  const user = await ctx.db.selectFrom('users').select(['id', 'suspended_at']).where('id', '=', userId).executeTakeFirst();
  if (!user || user.suspended_at) return [];
  const rows = await ctx.db.selectFrom('projects').selectAll().where('claimed', '=', 0).where('claim_discord_id', '=', discordId).where('state', '=', 'listed').execute();
  for (const p of rows) await grantClaim(ctx, p, userId, `discord user id ${discordId} (poster of the catalog entry)`, userId);
  return rows.map((p) => p.slug);
}

/** GitHub OAuth claim. Returns the portal path to go to. */
export async function githubClaim(ctx: Ctx, userId: string, slug: string, ghToken: string): Promise<string> {
  const p = await ctx.db.selectFrom('projects').selectAll().where('slug', '=', slug).executeTakeFirst();
  if (!p) return '/?claim=not-found';
  const sources = await ctx.db.selectFrom('sources').select('target').where('project_id', '=', p.id).where('kind', '=', 'github').execute();
  const repos = [...sources.map((s) => s.target), ...(/github\.com\/([^/]+\/[^/#?]+)/.exec(p.source_url ?? '')?.[1] ? [/github\.com\/([^/]+\/[^/#?]+)/.exec(p.source_url!)![1].replace(/\.git$/, '')] : [])];
  if (!repos.length) return `/projects/${slug}/claim?result=no-repo`;
  const dev = ghToken === 'dev' && ctx.cfg.HUB_DEV_LOGIN && !ctx.cfg.production;
  for (const repo of new Set(repos)) {
    if (dev || (await isRepoAdmin(ctx, repo, ghToken))) {
      await grantClaim(ctx, p, userId, `github admin of ${repo}${dev ? ' (dev)' : ''}`, userId);
      // The verified repository becomes the project's source and is checked right away (a failure here never undoes the claim).
      await connectGithubSource(ctx, p, repo).catch(() => undefined);
      return `/projects/${slug}?claimed=1`;
    }
  }
  return `/projects/${slug}/claim?result=not-admin`;
}

export async function requestClaim(ctx: Ctx, p: ProjectsTable, userId: string, method: 'tmloader-token' | 'manual', message: string | null): Promise<ClaimRequest> {
  if (p.claimed) throw new HttpError(409, 'claimed', 'This project has an owner already');
  const open = await ctx.db.selectFrom('claims').select('id').where('project_id', '=', p.id).where('user_id', '=', userId).where('status', '=', 'pending').where('method', '=', method).executeTakeFirst();
  if (open) await ctx.db.deleteFrom('claims').where('id', '=', open.id).execute();
  const detail = method === 'tmloader-token' ? `tmhub-claim-${randomToken(18)}` : (message ?? '').slice(0, 2000);
  const row = { id: newId('c'), project_id: p.id, user_id: userId, method, detail, status: 'pending', created_at: nowIso(), decided_at: null };
  await ctx.db.insertInto('claims').values(row).execute();
  if (method === 'manual') await ctx.notify({ kind: 'claim', text: `Manual claim request for ${p.name}` });
  const u = await ctx.db.selectFrom('users').select(['id', 'name']).where('id', '=', userId).executeTakeFirstOrThrow();
  return { id: row.id, projectId: p.id, user: u, method, detail, status: 'pending', created: row.created_at };
}

/** Checks <server>/tmhub-claim.txt for the claim token of a TMLoader-sourced project. */
export async function verifyTmloaderClaim(ctx: Ctx, claimId: string, userId: string): Promise<boolean> {
  const c = await ctx.db.selectFrom('claims').selectAll().where('id', '=', claimId).where('user_id', '=', userId).where('status', '=', 'pending').executeTakeFirst();
  if (!c || c.method !== 'tmloader-token') throw new HttpError(404, 'not_found', 'Claim not found');
  const p = await ctx.db.selectFrom('projects').selectAll().where('id', '=', c.project_id).executeTakeFirstOrThrow();
  const servers = await ctx.db.selectFrom('sources').select('target').where('project_id', '=', p.id).where('kind', '=', 'tmloader').execute();
  for (const s of servers) {
    try {
      const r = await ctx.fetch(`${s.target}tmhub-claim.txt`, { headers: { 'user-agent': 'TM-Horizon-hub (+https://tm-horizon.com)' }, redirect: 'manual' });
      if (r.ok && (await r.text()).includes(c.detail)) {
        await grantClaim(ctx, p, userId, `token file on ${s.target}`, userId);
        return true;
      }
    } catch { /* try next */ }
  }
  return false;
}
