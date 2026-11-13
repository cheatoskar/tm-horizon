// GitHub discovery: the moderation list for admins and the public list of accepted repositories
// (what the website's "All TrackMania projects on GitHub" page is built from). services/discover-github.ts.
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../ctx.ts';
import { route } from '../http/route.ts';
import { gameEnum, projectTypeSchema } from '../services/projects.ts';
import { acceptDiscovered, acceptWithTopics, decideDiscovered, discoverGithub, discoveredCounts, listDiscovered, publicGithubProjects } from '../services/discover-github.ts';
import { rebuildIndex } from '../services/hubindex.ts';
import { bulkDecide, curateWaiting, summarize } from '../services/discover-curate.ts';
import { toDiscovered } from '../services/discover-github.ts';
import { HttpError, parseJson } from '../util.ts';

const repoParam = z.object({ owner: z.string().max(40), name: z.string().max(100) });

export function discoverRoutes(app: FastifyInstance, ctx: Ctx) {
  route(app, {
    method: 'GET', url: '/v1/github-projects', summary: 'TrackMania projects found on GitHub and accepted by the hub (link-only entries)', tags: ['read'], auth: 'none',
    query: z.object({ game: gameEnum.optional(), language: z.string().max(40).optional(), q: z.string().max(100).optional(), page: z.coerce.number().int().min(1).max(1000).default(1), limit: z.coerce.number().int().min(1).max(200).default(100) }),
  }, async (_req, { query }) => publicGithubProjects(ctx, query));

  route(app, { method: 'GET', url: '/v1/admin/discovered', summary: 'Repositories found on GitHub, by state (default: new)', tags: ['admin'], auth: 'admin',
    query: z.object({ state: z.enum(['new', 'accepted', 'hidden', 'ignored', 'skipped', 'known']).default('new') }) }, async (_req, { query }) => ({
    enabled: ctx.cfg.DISCOVER_GITHUB, counts: await discoveredCounts(ctx), last: parseJson((await ctx.db.selectFrom('kv').select('value').where('key', '=', 'discover:last').executeTakeFirst())?.value, null),
    items: await listDiscovered(ctx, query.state),
  }));

  const path = '/v1/admin/discovered/:owner/:name';
  route(app, { method: 'POST', url: `${path}/accept`, summary: 'Accept as an unclaimed link-only project', tags: ['admin'], auth: 'admin', params: repoParam,
    body: z.object({ games: z.array(gameEnum).max(12).optional(), type: projectTypeSchema.optional() }) }, async (req, { params, body }) => {
    const slug = await acceptDiscovered(ctx, `${params.owner}/${params.name}`, req.auth.user!.id, body);
    await rebuildIndex(ctx);
    return { ok: true, slug };
  });
  for (const [what, summary] of [['hide', 'Hide for now (can be restored)'], ['ignore', 'Ignore forever'], ['restore', 'Back to the waiting list']] as const) {
    route(app, { method: 'POST', url: `${path}/${what}`, summary, tags: ['admin'], auth: 'admin', params: repoParam }, async (req, { params }) => {
      await decideDiscovered(ctx, `${params.owner}/${params.name}`, what, req.auth.user!.id);
      return { ok: true };
    });
  }
  route(app, { method: 'GET', url: '/v1/admin/discovered-curation', summary: 'Waiting repositories sorted into approve / reject / pending with a reason (from the cached GitHub facts)', tags: ['admin'], auth: 'admin' }, async () => {
    const curated = await curateWaiting(ctx);
    const sum = summarize(curated, 0);
    return {
      counts: Object.fromEntries((['approve', 'reject', 'pending'] as const).map((b) => [b, { n: sum[b].n, codes: sum[b].codes }])),
      items: curated.map(({ row, decision }) => ({ ...toDiscovered(row), bucket: decision.bucket, code: decision.code, reason: decision.reason, openplanet: decision.openplanet, openplanetPage: decision.opPage })),
    };
  });
  route(app, { method: 'POST', url: '/v1/admin/discovered/bulk', summary: 'Accept or hide the given waiting repositories in one go (the portal filter)', tags: ['admin'], auth: 'admin',
    body: z.object({ repos: z.array(z.string().max(140)).min(1).max(1000), action: z.enum(['accept', 'hide']) }) }, async (req, { body }) => bulkDecide(ctx, body.repos, body.action, req.auth.user!.id));
  route(app, { method: 'POST', url: '/v1/admin/discovered/accept-with-topics', summary: 'Accept every waiting repository that has at least one matching TrackMania topic', tags: ['admin'], auth: 'admin' }, async (req) =>
    acceptWithTopics(ctx, req.auth.user!.id));
  route(app, { method: 'POST', url: '/v1/admin/discovered/run', summary: 'Search GitHub now (needs DISCOVER_GITHUB=1)', tags: ['admin'], auth: 'admin', rateLimit: { max: 2, timeWindow: '10 minutes' } }, async () => {
    if (!ctx.cfg.DISCOVER_GITHUB) throw new HttpError(409, 'off', 'GitHub discovery is off (DISCOVER_GITHUB=1 turns it on)');
    return discoverGithub(ctx);
  });
}
