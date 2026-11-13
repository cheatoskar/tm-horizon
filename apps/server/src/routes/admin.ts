// Moderation: review queue (versions, claims, reports), approve/reject with a statement of reasons
// (DSA Art. 17), revocations, project removal, account suspension, audit log. Admins only.
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ReviewItem, StatementOfReasons } from '@tm-hub/shared';
import type { Ctx } from '../ctx.ts';
import { route } from '../http/route.ts';
import { projectBySlug } from '../services/projects.ts';
import { approveVersion, rejectVersion, revokeVersion, toHubVersion, versionById, REDRESS } from '../services/versions.ts';
import { grantClaim } from '../services/claims.ts';
import { rebuildIndex } from '../services/hubindex.ts';
import { suspendUser, unsuspendUser, hubUser } from '../services/users.ts';
import { HttpError, notFound, nowIso, parseJson } from '../util.ts';
import { statementInput } from './author.ts';

export function adminRoutes(app: FastifyInstance, ctx: Ctx) {
  const sor = (s: z.infer<typeof statementInput>, decision: StatementOfReasons['decision'], by: string): StatementOfReasons => ({
    decision, facts: s.facts, ground: s.ground, groundType: s.groundType, automated: s.automated, redress: s.redress || REDRESS, decidedAt: nowIso(), decidedBy: by,
  });

  route(app, { method: 'GET', url: '/v1/admin/queue', summary: 'Everything waiting for a decision', tags: ['admin'], auth: 'admin' }, async (): Promise<ReviewItem[]> => {
    const items: ReviewItem[] = [];
    const versions = await ctx.db.selectFrom('versions').innerJoin('projects', 'projects.id', 'versions.project_id').leftJoin('users', 'users.id', 'versions.uploader_id')
      .selectAll('versions').select(['projects.slug', 'projects.name', 'projects.claimed', 'users.name as uploader_name']).where('versions.status', 'in', ['review', 'held']).orderBy('versions.created_at').execute();
    for (const v of versions) items.push({ kind: 'version', id: v.id, created: v.created_at, project: { id: v.project_id, slug: v.slug, name: v.name, claimed: !!v.claimed }, version: toHubVersion(ctx, v, v.uploader_id ? { id: v.uploader_id, name: v.uploader_name ?? '?' } : null, true) });
    const claims = await ctx.db.selectFrom('claims').innerJoin('projects', 'projects.id', 'claims.project_id').innerJoin('users', 'users.id', 'claims.user_id')
      .select(['claims.id', 'claims.project_id', 'claims.method', 'claims.detail', 'claims.status', 'claims.created_at', 'claims.user_id', 'users.name as user_name', 'projects.slug', 'projects.name', 'projects.claimed'])
      .where('claims.status', '=', 'pending').where('claims.method', '=', 'manual').execute();
    for (const c of claims) items.push({ kind: 'claim', id: c.id, created: c.created_at, project: { id: c.project_id, slug: c.slug, name: c.name, claimed: !!c.claimed }, claim: { id: c.id, projectId: c.project_id, user: { id: c.user_id, name: c.user_name }, method: c.method as 'manual', detail: c.detail, status: 'pending', created: c.created_at } });
    const reports = await ctx.db.selectFrom('reports').innerJoin('projects', 'projects.id', 'reports.project_id').selectAll('reports').select(['projects.slug', 'projects.name as project_name', 'projects.claimed']).where('reports.status', '=', 'open').execute();
    for (const r of reports) items.push({ kind: 'report', id: r.id, created: r.created_at, project: { id: r.project_id, slug: r.slug, name: r.project_name, claimed: !!r.claimed }, report: {
      id: r.id, projectSlug: r.slug, versionId: r.version_id, reason: r.reason as never, explanation: r.explanation, location: r.location, name: r.name, email: r.email, goodFaith: true, status: 'open', created: r.created_at, resolution: null } });
    // Reports first (legal deadlines), then versions, then claims; oldest first inside each.
    const rank = { report: 0, version: 1, claim: 2 };
    return items.sort((a, b) => rank[a.kind] - rank[b.kind] || a.created.localeCompare(b.created));
  });

  const idParam = z.object({ id: z.string() });
  route(app, { method: 'POST', url: '/v1/admin/versions/:id/approve', summary: 'Publish a version from review', tags: ['admin'], auth: 'admin', params: idParam }, async (req, { params }) => {
    await approveVersion(ctx, await versionById(ctx, params.id), req.auth.user!.id);
    return { ok: true };
  });
  route(app, { method: 'POST', url: '/v1/admin/versions/:id/reject', summary: 'Reject with a statement of reasons', tags: ['admin'], auth: 'admin', params: idParam, body: statementInput }, async (req, { params, body }) => {
    await rejectVersion(ctx, await versionById(ctx, params.id), { ...body, redress: body.redress || REDRESS }, req.auth.user!.id);
    return { ok: true };
  });
  route(app, { method: 'POST', url: '/v1/admin/versions/:id/revoke', summary: 'Revoke a published version (launchers refuse and offer removal)', tags: ['admin'], auth: 'admin', params: idParam, body: statementInput }, async (req, { params, body }) => {
    await revokeVersion(ctx, await versionById(ctx, params.id), { ...body, redress: body.redress || REDRESS }, req.auth.user!.id);
    return { ok: true };
  });

  route(app, { method: 'POST', url: '/v1/admin/projects/:slug/remove', summary: 'Take a project down (statement of reasons stays visible)', tags: ['admin'], auth: 'admin', params: z.object({ slug: z.string() }), body: statementInput.extend({ revokeAll: z.boolean().default(false) }) }, async (req, { params, body }) => {
    const p = await projectBySlug(ctx, params.slug);
    const d = sor(body, 'remove-project', req.auth.user!.id);
    await ctx.db.updateTable('projects').set({ state: 'removed', removal: JSON.stringify(d), updated_at: nowIso() }).where('id', '=', p.id).execute();
    await ctx.db.updateTable('versions').set({ status: 'cancelled', publish_at: null }).where('project_id', '=', p.id).where('status', 'in', ['held', 'review']).execute();
    if (body.revokeAll) {
      const pub = await ctx.db.selectFrom('versions').selectAll().where('project_id', '=', p.id).where('status', '=', 'published').execute();
      for (const v of pub) await revokeVersion(ctx, v, { ...body, redress: body.redress || REDRESS }, req.auth.user!.id);
    }
    await ctx.audit(req.auth.user!.id, 'project.remove', p.id, d);
    await rebuildIndex(ctx);
    return { ok: true };
  });
  route(app, { method: 'POST', url: '/v1/admin/projects/:slug/restore', summary: 'Restore a removed project', tags: ['admin'], auth: 'admin', params: z.object({ slug: z.string() }) }, async (req, { params }) => {
    const p = await projectBySlug(ctx, params.slug);
    const published = await ctx.db.selectFrom('versions').select('id').where('project_id', '=', p.id).where('status', '=', 'published').executeTakeFirst();
    await ctx.db.updateTable('projects').set({ state: published ? 'listed' : 'draft', removal: null, updated_at: nowIso() }).where('id', '=', p.id).execute();
    await ctx.audit(req.auth.user!.id, 'project.restore', p.id);
    await rebuildIndex(ctx);
    return { ok: true };
  });

  route(app, { method: 'POST', url: '/v1/admin/claims/:id/decide', summary: 'Approve or reject a manual claim', tags: ['admin'], auth: 'admin', params: idParam, body: z.object({ approve: z.boolean(), note: z.string().max(1000).optional() }) }, async (req, { params, body }) => {
    const c = await ctx.db.selectFrom('claims').selectAll().where('id', '=', params.id).where('status', '=', 'pending').executeTakeFirst();
    if (!c) throw notFound('Claim not found');
    if (body.approve) {
      const p = await ctx.db.selectFrom('projects').selectAll().where('id', '=', c.project_id).executeTakeFirstOrThrow();
      await grantClaim(ctx, p, c.user_id, `manual review${body.note ? `: ${body.note}` : ''}`, req.auth.user!.id);
    } else {
      await ctx.db.updateTable('claims').set({ status: 'rejected', decided_at: nowIso() }).where('id', '=', c.id).execute();
      await ctx.audit(req.auth.user!.id, 'claim.reject', c.id, { note: body.note });
    }
    return { ok: true };
  });

  route(app, { method: 'POST', url: '/v1/admin/reports/:id/resolve', summary: 'Close a report (actioned or dismissed, with the reason given to the notifier)', tags: ['admin'], auth: 'admin', params: idParam, body: z.object({ status: z.enum(['actioned', 'dismissed']), resolution: z.string().trim().min(5).max(2000) }) }, async (req, { params, body }) => {
    const r = await ctx.db.updateTable('reports').set({ status: body.status, resolution: body.resolution, resolved_at: nowIso() }).where('id', '=', params.id).executeTakeFirst();
    if (!Number(r.numUpdatedRows)) throw notFound('Report not found');
    await ctx.audit(req.auth.user!.id, 'report.' + body.status, params.id, { resolution: body.resolution });
    return { ok: true };
  });

  route(app, { method: 'GET', url: '/v1/admin/users', summary: 'Find accounts', tags: ['admin'], auth: 'admin', query: z.object({ q: z.string().max(64).default('') }) }, async (_req, { query }) => {
    const rows = await ctx.db.selectFrom('users').selectAll().where((eb) => eb.or([eb('name', 'like', `%${query.q.replace(/[%_]/g, '')}%`), eb('id', '=', query.q)])).orderBy('created_at', 'desc').limit(50).execute();
    return Promise.all(rows.map(async (u) => ({ ...(await hubUser(ctx, u)), strikes: u.strikes, suspension: parseJson(u.suspension, null) })));
  });
  route(app, { method: 'POST', url: '/v1/admin/users/:id/suspend', summary: 'Suspend an account (repeated abuse), with a statement of reasons', tags: ['admin'], auth: 'admin', params: idParam, body: statementInput }, async (req, { params, body }) => {
    if (params.id === req.auth.user!.id) throw new HttpError(400, 'self', 'You cannot suspend yourself');
    await suspendUser(ctx, params.id, sor(body, 'suspend-account', req.auth.user!.id), req.auth.user!.id);
    return { ok: true };
  });
  route(app, { method: 'POST', url: '/v1/admin/users/:id/unsuspend', summary: 'Lift a suspension', tags: ['admin'], auth: 'admin', params: idParam }, async (req, { params }) => {
    await unsuspendUser(ctx, params.id, req.auth.user!.id);
    return { ok: true };
  });

  route(app, { method: 'GET', url: '/v1/admin/audit', summary: 'Audit log (newest first)', tags: ['admin'], auth: 'admin', query: z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }) }, async (_req, { query }) =>
    (await ctx.db.selectFrom('audit').selectAll().orderBy('id', 'desc').limit(query.limit).execute()).map((a) => ({ ...a, detail: parseJson(a.detail, null) })));

  route(app, { method: 'GET', url: '/v1/admin/revocations', summary: 'Revoked versions', tags: ['admin'], auth: 'admin' }, async () => ctx.db.selectFrom('revocations').selectAll().orderBy('revoked_at', 'desc').execute());

  route(app, { method: 'GET', url: '/v1/admin/notices', summary: 'Last moderation notices (also sent to the Discord webhook)', tags: ['admin'], auth: 'admin' }, async () => [...ctx.notices].reverse());
}
