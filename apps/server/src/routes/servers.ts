// Game server registration: public form, operator announcements (token), public list and the admin
// decisions. Docs: docs/hub/server-registration.md.
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../ctx.ts';
import { route } from '../http/route.ts';
import { rebuildIndex } from '../services/hubindex.ts';
import { SERVER_GAMES, SERVER_STATUSES, announce, approveServer, checkServer, closeServer, claimCode, claimServer, publicServers, recheckAll, recheckServer, restoreServer, submitServer } from '../services/gameservers.ts';
import { HttpError } from '../util.ts';
import { DESKTOP_SCOPE } from '../http/auth.ts';
import { ReachError, REACH_PORT_MAX, REACH_PORT_MIN, selfTest, tcpProbe, type Probe } from '../services/reachability.ts';

const noCtl = (s: string) => !/[\u0000-\u001f\u007f]/.test(s);

export function serverRoutes(app: FastifyInstance, ctx: Ctx, probe: Probe = tcpProbe) {
  // The form lives on the static website (another origin). Anonymous calls: CORS open to everyone, no cookies.
  // The logged-in calls (check, submit as a user) work from HUB_WEB_URL with the visitor's session cookie.
  const webOrigin = ctx.cfg.HUB_WEB_URL ? new URL(ctx.cfg.HUB_WEB_URL).origin : null;
  const cors = (req: { headers: { origin?: string } }, reply: { header(k: string, v: string): unknown }) => {
    const credentials = !!webOrigin && req.headers.origin === webOrigin;
    reply.header('access-control-allow-origin', credentials ? webOrigin! : '*');
    if (credentials) { reply.header('access-control-allow-credentials', 'true'); reply.header('vary', 'Origin'); }
    reply.header('access-control-allow-methods', 'GET, POST, OPTIONS');
    reply.header('access-control-allow-headers', 'content-type, x-csrf-token');
    reply.header('access-control-max-age', '86400');
  };
  for (const url of ['/v1/servers', '/v1/servers/check', '/v1/servers/:id/claim-code', '/v1/servers/:id/claim', '/v1/me', '/v1/config']) app.options(url, async (req, reply) => { cors(req, reply); return reply.code(204).send(); });
  // GET /v1/me (login state) and the answers of the server calls carry the same headers.
  app.addHook('onSend', async (req, reply) => {
    const path = req.url.split('?')[0]!;
    if (webOrigin && req.headers.origin === webOrigin && (path === '/v1/me' || path === '/v1/config' || path.startsWith('/v1/servers'))) cors(req, reply);
  });

  route(app, {
    method: 'POST', url: '/v1/servers', summary: 'Submit a game server (public form; logged in: checked at once and listed when it answers)', tags: ['servers'], auth: 'none',
    body: z.object({
      game: z.enum(SERVER_GAMES), address: z.string().trim().min(3).max(260),
      name: z.string().trim().max(80).refine(noCtl, 'no control characters').optional(),
      contact: z.string().trim().max(200).refine(noCtl, 'no control characters').optional(),
      owner: z.boolean().optional(),
      homepage: z.string().trim().max(300).regex(/^https:\/\/[^\s]+$/i, 'must be an https link').nullable().optional().or(z.literal('')),
      website: z.string().max(0).optional(), // honeypot: must stay empty
    }),
    rateLimit: { max: 20, timeWindow: '1 hour' },
  }, async (req, { body, reply }) => {
    cors(req, reply);
    // Logged in on the website (session) or in the launcher (desktop token): the hub account is known.
    const user = req.auth.via === 'session' || (req.auth.via === 'token' && !!req.auth.token?.scopes.includes(DESKTOP_SCOPE)) ? req.auth.user : null;
    if (user?.suspended_at) throw new HttpError(403, 'suspended', 'This account is suspended');
    if (!user && (body.name?.length ?? 0) < 3) throw new HttpError(400, 'invalid_body', 'name: at least 3 characters');
    const r = await submitServer(ctx, { game: body.game, address: body.address, name: body.name, contact: body.contact, owner: body.owner, homepage: body.homepage || null, userId: user?.id ?? null, ip: req.ip });
    if (r.status === 'verified') await rebuildIndex(ctx);
    return { received: true, ...r };
  });

  route(app, {
    method: 'POST', url: '/v1/servers/check', summary: 'Ask a game server what it answers (name, players, map); logged in, one connection, 3 s', tags: ['servers'], auth: 'user',
    body: z.object({ game: z.enum(SERVER_GAMES), address: z.string().trim().min(3).max(260) }),
    rateLimit: { max: 20, timeWindow: '1 hour' },
  }, async (req, { body, reply }) => {
    cors(req, reply);
    if (req.auth.via !== 'session') throw new HttpError(403, 'forbidden', 'Log in on the website to check a server');
    try {
      return await checkServer(body.game, body.address);
    } catch (e) {
      if (e instanceof HttpError && e.status === 503) reply.header('retry-after', '60');
      throw e;
    }
  });

  const idP = z.object({ id: z.string().max(40) });
  route(app, { method: 'POST', url: '/v1/servers/:id/claim-code', summary: 'Ownership proof, step 1: a code (valid 30 min) to put into the server name or comment', tags: ['servers'], auth: 'user', params: idP, rateLimit: { max: 20, timeWindow: '1 hour' } }, async (req, { params, reply }) => {
    cors(req, reply);
    if (req.auth.via !== 'session') throw new HttpError(403, 'forbidden', 'Log in on the website');
    return claimCode(ctx, params.id, req.auth.user!.id);
  });
  route(app, { method: 'POST', url: '/v1/servers/:id/claim', summary: 'Ownership proof, step 2: the hub queries the server once; with the code in name or comment the caller gets the announce token (shown once)', tags: ['servers'], auth: 'user', params: idP, rateLimit: { max: 20, timeWindow: '1 hour' } }, async (req, { params, reply }) => {
    cors(req, reply);
    if (req.auth.via !== 'session') throw new HttpError(403, 'forbidden', 'Log in on the website');
    const r = await claimServer(ctx, params.id, req.auth.user!.id);
    await rebuildIndex(ctx);
    return r;
  });

  route(app, { method: 'GET', url: '/v1/servers', summary: 'Approved game servers with their last announcement', tags: ['servers'], auth: 'none' }, async (_req, { reply }) => {
    reply.header('cache-control', 'public, max-age=60');
    return publicServers(ctx);
  });

  route(app, {
    method: 'POST', url: '/v1/servers/announce', summary: 'Announce name, players and map of an approved server (Bearer token from the approval)', tags: ['servers'], auth: 'none',
    body: z.object({
      name: z.string().trim().min(1).max(120).refine(noCtl, 'no control characters'),
      players: z.number().int().min(0).max(255), maxPlayers: z.number().int().min(0).max(255), spectators: z.number().int().min(0).max(255).optional(),
      map: z.string().trim().max(120).nullable().optional(), mode: z.string().trim().max(40).nullable().optional(), version: z.string().trim().max(40).nullable().optional(),
    }),
    rateLimit: { max: 60, timeWindow: '1 hour' },
  }, async (req, { body, reply }) => {
    const m = /^Bearer (tmhs_[A-Za-z0-9_-]{20,80})$/.exec(String(req.headers.authorization ?? ''));
    if (!m) throw new HttpError(401, 'bad_token', 'Send the announce token as "Authorization: Bearer tmhs_..."');
    try {
      return await announce(ctx, m[1]!, body);
    } catch (e) {
      if (e instanceof HttpError && e.status === 429) reply.header('retry-after', String((e.details as { retryAfterSeconds: number }).retryAfterSeconds));
      throw e;
    }
  });

  // Self-test for launcher-hosted servers: TCP connect back to the CALLER's address only.
  route(app, {
    method: 'POST', url: '/v1/servers/reachability', summary: 'Is my game port reachable from the internet? (connects back to the caller only, ports 2350-2399)', tags: ['servers'], auth: 'none',
    body: z.object({ port: z.number().int().min(REACH_PORT_MIN).max(REACH_PORT_MAX) }),
    rateLimit: { max: 12, timeWindow: '1 hour' },
  }, async (req, { body, reply }) => {
    reply.header('cache-control', 'no-store');
    try {
      return await selfTest(req.ip, body.port, probe);
    } catch (e) {
      if (e instanceof ReachError) throw new HttpError(e.status, e.code, e.message);
      throw e;
    }
  });

  // ---- admin
  const idParam = z.object({ id: z.string().max(40) });
  route(app, { method: 'GET', url: '/v1/admin/servers', summary: 'Submitted game servers (contact included)', tags: ['admin'], auth: 'admin', query: z.object({ status: z.enum(SERVER_STATUSES).default('pending') }) }, async (_req, { query }) => {
    const rows = await ctx.db.selectFrom('game_servers').select(['id', 'game', 'address', 'name', 'contact', 'homepage', 'status', 'note', 'created_at', 'decided_at', 'announced_at', 'submitter_id', 'owner', 'verified_at', 'last_check_at', 'last_ok_at', 'offline_since', 'check_info']).where('status', '=', query.status).orderBy('created_at').execute();
    return rows.map((r) => ({ ...r, owner: !!r.owner, check_info: r.check_info ? JSON.parse(r.check_info) : null }));
  });
  route(app, { method: 'POST', url: '/v1/admin/servers/:id/approve', summary: 'Approve a server (or issue a new announce token); the token is shown once. owner: the operator is known', tags: ['admin'], auth: 'admin', params: idParam, body: z.object({ owner: z.boolean().optional() }) }, async (req, { params, body }) => {
    const r = await approveServer(ctx, params.id, req.auth.user!.id, { owner: body.owner });
    await rebuildIndex(ctx);
    return r;
  });
  route(app, { method: 'POST', url: '/v1/admin/servers/:id/recheck', summary: 'Ask the server again now', tags: ['admin'], auth: 'admin', params: idParam }, async (_req, { params }) => {
    const result = await recheckServer(ctx, params.id);
    return { result };
  });
  route(app, { method: 'POST', url: '/v1/admin/servers/recheck-all', summary: 'Re-check every listed server in the background', tags: ['admin'], auth: 'admin' }, async () => {
    void recheckAll(ctx).then(() => rebuildIndex(ctx)).catch((e) => console.error('[hub] recheck failed', (e as Error).message));
    return { started: true };
  });
  route(app, { method: 'POST', url: '/v1/admin/servers/:id/restore', summary: 'Bring a removed or rejected server back (to where it was before an automatic removal)', tags: ['admin'], auth: 'admin', params: idParam }, async (req, { params }) => {
    const r = await restoreServer(ctx, params.id, req.auth.user!.id);
    await rebuildIndex(ctx);
    return r;
  });
  route(app, { method: 'POST', url: '/v1/admin/servers/:id/reject', summary: 'Reject a submission', tags: ['admin'], auth: 'admin', params: idParam, body: z.object({ note: z.string().trim().max(500).default('') }) }, async (req, { params, body }) => {
    await closeServer(ctx, params.id, 'rejected', body.note, req.auth.user!.id);
    return { ok: true };
  });
  route(app, { method: 'POST', url: '/v1/admin/servers/:id/remove', summary: 'Take a listed server down (its token stops working)', tags: ['admin'], auth: 'admin', params: idParam, body: z.object({ note: z.string().trim().max(500).default('') }) }, async (req, { params, body }) => {
    await closeServer(ctx, params.id, 'removed', body.note, req.auth.user!.id);
    await rebuildIndex(ctx);
    return { ok: true };
  });
}
