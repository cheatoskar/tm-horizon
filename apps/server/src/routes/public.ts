// Read API: search, projects, versions, the signed index, download redirects with counting, and the
// "Inhalt melden" notice form (DSA Art. 16). Downloads (docs/mod-publishing.md, "What Downloads counts") count once per installation
// and project and day: the launcher sends its random installation id (X-TMHub-Install header or ?install=),
// a browser download falls back to the client address. Either is only used in memory, as a salted hash
// that is thrown away at midnight (UTC); only the daily totals per version are stored.
import { z } from 'zod';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { HUB_CATEGORIES, HUB_INSTALL_TYPES, REPORT_REASONS } from '@tm-hub/shared';
import type { Ctx } from '../ctx.ts';
import { route, openapi } from '../http/route.ts';
import { searchProjects, projectBySlug, toHubProject, roleIn, gameEnum } from '../services/projects.ts';
import { toHubVersion } from '../services/versions.ts';
import { currentIndex } from '../services/hubindex.ts';
import { isAdmin } from '../services/users.ts';
import { CappedSet, HttpError, newId, notFound, nowIso, parseJson } from '../util.ts';

const slugParam = z.object({ slug: z.string().max(64) });
let salt = { day: '', value: Buffer.alloc(0) };
const seenToday = new CappedSet(100_000);

/** Who downloads, for counting once a day: the launcher's installation id (random, 16-64 characters) when it sends one, else the address. */
export function downloaderKey(header: string | string[] | undefined, query: string | undefined, ip: string): string {
  const id = (Array.isArray(header) ? header[0] : header) ?? query;
  return id && /^[A-Za-z0-9_-]{16,64}$/.test(id) ? `i:${id}` : `a:${ip}`;
}

export function publicRoutes(app: FastifyInstance, ctx: Ctx) {
  route(app, {
    method: 'GET', url: '/v1/projects', summary: 'Search listed projects', tags: ['read'], auth: 'none',
    query: z.object({
      q: z.string().max(100).optional(), game: gameEnum.optional(), category: z.enum(HUB_CATEGORIES).optional(), tag: z.string().max(24).optional(),
      install: z.enum(HUB_INSTALL_TYPES).optional(), sort: z.enum(['popular', 'updated', 'new', 'name']).optional(),
      page: z.coerce.number().int().min(1).max(1000).optional(), limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
    response: 'SearchResult',
  }, async (_req, { query }) => searchProjects(ctx, query));

  const visible = async (slug: string, viewer: string | null) => {
    const p = await projectBySlug(ctx, slug);
    if (p.state !== 'listed') {
      const team = await roleIn(ctx, p.id, viewer);
      // Removed projects stay visible as a stub with the statement of reasons (DSA Art. 17).
      if (!team && !(viewer && (await isAdmin(ctx, viewer))) && p.state !== 'removed') throw notFound('Project not found');
    }
    return p;
  };

  route(app, { method: 'GET', url: '/v1/projects/:slug', summary: 'One project', tags: ['read'], auth: 'none', params: slugParam, response: 'HubProject' }, async (req, { params }) => {
    const viewer = req.auth.user?.id ?? null;
    const p = await visible(params.slug, viewer);
    const hp = await toHubProject(ctx, p, viewer);
    if (p.state === 'removed' && !hp.myRole && !req.auth.admin) return { ...hp, description: '', gallery: [], links: {}, showcase: null, showcaseFrom: null, sources: [] };
    return hp;
  });

  route(app, { method: 'GET', url: '/v1/projects/:slug/versions', summary: 'Versions of a project (team members also see unpublished ones)', tags: ['read'], auth: 'none', params: slugParam, response: 'HubVersion[]' }, async (req, { params }) => {
    const viewer = req.auth.user?.id ?? null;
    const p = await visible(params.slug, viewer);
    const team = !!(await roleIn(ctx, p.id, viewer)) || req.auth.admin;
    let q = ctx.db.selectFrom('versions').leftJoin('users', 'users.id', 'versions.uploader_id').selectAll('versions').select(['users.name as uploader_name']).where('project_id', '=', p.id);
    if (!team) q = q.where('status', 'in', ['published', 'revoked']);
    const rows = await q.orderBy('created_at', 'desc').execute();
    return rows.map((v) => toHubVersion(ctx, v, v.uploader_id ? { id: v.uploader_id, name: v.uploader_name ?? '?' } : null, team));
  });

  route(app, { method: 'GET', url: '/v1/index.json', summary: 'The signed hub index the launcher reads (SignedHubIndex)', tags: ['read'], auth: 'none', response: 'SignedHubIndex' }, async (_req, { reply }) => {
    reply.header('cache-control', 'public, max-age=60');
    return currentIndex(ctx);
  });

  route(app, { method: 'GET', url: '/v1/index/keys', summary: 'Public keys that sign the index (pin them in the launcher)', tags: ['read'], auth: 'none' }, async () => ({
    current: { keyId: ctx.key.keyId, publicKey: ctx.key.publicKey },
    accepted: (ctx.cfg.HUB_INDEX_PUBLIC_KEYS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  }));

  route(app, {
    method: 'GET', url: '/dl/:versionId/:file', summary: 'Download (counted, then redirected to the cached hub copy)', tags: ['read'], auth: 'none',
    params: z.object({ versionId: z.string().regex(/^v_[a-z0-9]{6,20}$/), file: z.string().max(160) }), query: z.object({ install: z.string().max(80).optional() }),
    rateLimit: { max: 120, timeWindow: '1 minute' },
  }, async (req, { params, query, reply }) => {
    const v = await ctx.db.selectFrom('versions').select(['id', 'project_id', 'status', 'storage_key', 'file_name', 'extra_files']).where('id', '=', params.versionId).executeTakeFirst();
    const extra = v && v.file_name !== params.file ? parseJson<{ name: string; storage_key: string }[]>(v.extra_files ?? null, []).find((x) => x.name === params.file) : undefined;
    if (!v || (v.file_name !== params.file && !extra)) throw notFound('File not found');
    if (extra) v.storage_key = extra.storage_key;
    if (v.status === 'revoked') throw new HttpError(410, 'revoked', 'This version was revoked');
    const team = req.auth.user ? !!(await roleIn(ctx, v.project_id, req.auth.user.id)) || req.auth.admin : false;
    if (v.status !== 'published' && !team) throw notFound('File not found');
    if (v.status === 'published') {
      const day = nowIso().slice(0, 10);
      if (salt.day !== day) { salt = { day, value: randomBytes(16) }; seenToday.clear(); }
      const who = createHash('sha256').update(salt.value).update(downloaderKey(req.headers['x-tmhub-install'], query.install, req.ip)).update(v.project_id).digest('base64url');
      if (seenToday.add(who)) {
        await ctx.db.insertInto('downloads_daily').values({ project_id: v.project_id, version_id: v.id, day, count: 1 }).onConflict((oc) => oc.columns(['version_id', 'day']).doUpdateSet((eb) => ({ count: eb('downloads_daily.count', '+', 1) }))).execute();
        await ctx.db.updateTable('versions').set((eb) => ({ downloads: eb('downloads', '+', 1) })).where('id', '=', v.id).execute();
        await ctx.db.updateTable('projects').set((eb) => ({ downloads: eb('downloads', '+', 1) })).where('id', '=', v.project_id).execute();
      }
    }
    reply.header('cache-control', 'no-store');
    return reply.redirect(ctx.storage.publicUrl(v.storage_key), 302);
  });

  route(app, {
    method: 'POST', url: '/v1/reports', summary: 'Report content (DSA Art. 16 notice); goes to the moderation queue', tags: ['read'], auth: 'none',
    body: z.object({
      projectSlug: z.string().max(64), versionId: z.string().max(40).nullable().optional(), reason: z.enum(REPORT_REASONS),
      explanation: z.string().trim().min(20).max(5000), location: z.string().trim().max(400),
      name: z.string().trim().max(100).nullable().optional(), email: z.string().trim().email().max(200).nullable().optional().or(z.literal('')),
      goodFaith: z.literal(true), website: z.string().max(0).optional(), // honeypot: must stay empty
    }),
    rateLimit: { max: 5, timeWindow: '1 hour' },
  }, async (_req, { body }) => {
    const p = await projectBySlug(ctx, body.projectSlug);
    if (body.versionId && !(await ctx.db.selectFrom('versions').select('id').where('id', '=', body.versionId).where('project_id', '=', p.id).executeTakeFirst())) throw notFound('Version not found');
    const id = newId('r');
    await ctx.db.insertInto('reports').values({
      id, project_id: p.id, version_id: body.versionId ?? null, reason: body.reason, explanation: body.explanation, location: body.location,
      name: body.name || null, email: body.email || null, status: 'open', resolution: null, created_at: nowIso(), resolved_at: null,
    }).execute();
    await ctx.notify({ kind: 'report', text: `New report (${body.reason}) for ${p.name}`, url: `${ctx.cfg.HUB_PORTAL_URL}admin` });
    // Art. 16(4): confirmation of receipt (shown in the form; by e-mail once mail is set up).
    return { id, received: true };
  });

  route(app, { method: 'GET', url: '/v1/openapi.json', summary: 'This API as OpenAPI 3.1', tags: ['meta'], auth: 'none' }, async () => openapi(ctx.cfg.HUB_PUBLIC_URL));

  route(app, { method: 'GET', url: '/healthz', summary: 'Health check', tags: ['meta'], auth: 'none' }, async () => {
    await ctx.db.selectFrom('kv').select('key').limit(1).execute();
    return { ok: true };
  });

  // Development / single-box: serve stored files from the folder (nginx does this in production).
  if (ctx.cfg.STORAGE === 'fs') {
    app.get('/files/*', async (req, reply) => {
      const key = (req.params as { '*': string })['*'];
      const data = await ctx.storage.get(key).catch(() => null);
      if (!data) return reply.code(404).send({ error: 'not_found', message: 'File not found' });
      const type = /\.png$/i.test(key) ? 'image/png' : /\.jpe?g$/i.test(key) ? 'image/jpeg' : /\.webp$/i.test(key) ? 'image/webp' : 'application/octet-stream';
      reply.header('content-type', type).header('cache-control', 'public, max-age=31536000, immutable').header('x-content-type-options', 'nosniff');
      if (type === 'application/octet-stream') reply.header('content-disposition', `attachment; filename="${key.split('/').pop()}"`);
      return reply.send(data);
    });
  }
}
