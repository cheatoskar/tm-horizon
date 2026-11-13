// Write API for the portal (session + CSRF) and API tokens (Bearer, scoped): projects, the
// "paste a URL" import, pictures, versions, team, connected sources, analytics, tokens, keys, claims.
import { markIconByAuthor } from '../services/logos.ts';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HUB_GAMES, type ApiTokenInfo, type DownloadStats, type GameId } from '@tm-hub/shared';
import type { Ctx } from '../ctx.ts';
import { route } from '../http/route.ts';
import { DESKTOP_SCOPE } from '../http/auth.ts';
import { createProject, downloadBreakdown, projectBySlug, projectCreateSchema, projectInputSchema, projectPatchSchema, projectTypeSchema, requireRole, toHubProject, updateProject, imageOf } from '../services/projects.ts';
import { cancelVersion, ingestVersion, toHubVersion, versionById, versionMetaSchema } from '../services/versions.ts';
import { rebuildIndex } from '../services/hubindex.ts';
import { storeImage } from '../services/images.ts';
import { adoptShowcase, clearShowcase, saveShowcase } from '../services/showcase.ts';
import { requestClaim, verifyTmloaderClaim } from '../services/claims.ts';
import { previewSource, importFromUrl, applyGithubImport } from '../sources/importer.ts';
import { addSource, checkSource, chooseAsset, normalizeServer } from '../sources/crawler.ts';
import { parseGithubRepo } from '../sources/github.ts';
import { keyIdOf, publicKeyObject } from '../index/sign.ts';
import { HttpError, badRequest, forbidden, newId, nowIso, randomToken, sha256hex } from '../util.ts';

const slugParam = z.object({ slug: z.string().max(64) });
const installSchema = z.object({ kind: z.enum(['tmloader-product', 'files']), base: z.enum(['game', 'gamedata', 'documents', 'tmi-plugins', 'tmi-scripts']).optional(), strip: z.number().int().min(0).max(3).optional(), include: z.array(z.string().max(200)).max(20).optional() });
const statementInput = z.object({ facts: z.string().trim().min(10).max(4000), ground: z.string().trim().min(3).max(300), groundType: z.enum(['terms', 'law']), automated: z.boolean().default(false), redress: z.string().max(1000).optional() });
export { statementInput };

/** API tokens may be limited to some projects. */
function tokenAllows(req: FastifyRequest, projectId: string) {
  const t = req.auth.token;
  if (t && t.projects && !t.projects.includes(projectId)) throw forbidden('This API token is not for this project');
}

export function authorRoutes(app: FastifyInstance, ctx: Ctx) {
  const me = (req: FastifyRequest) => req.auth.user!;

  route(app, { method: 'GET', url: '/v1/me/projects', summary: 'Projects I am a member of', tags: ['author'], auth: 'user', scope: 'projects:read' }, async (req) => {
    const rows = await ctx.db.selectFrom('projects').innerJoin('members', 'members.project_id', 'projects.id').selectAll('projects').where('members.user_id', '=', me(req).id).orderBy('projects.updated_at', 'desc').execute();
    return Promise.all(rows.map((p) => toHubProject(ctx, p, me(req).id)));
  });

  route(app, { method: 'POST', url: '/v1/projects', summary: 'Create a project by hand (type is required)', tags: ['author'], auth: 'user', body: projectCreateSchema, rateLimit: { max: 10, timeWindow: '1 hour' } }, async (req, { body }) => {
    const p = await createProject(ctx, body, { id: me(req).id, name: me(req).name });
    return toHubProject(ctx, p, me(req).id);
  });

  route(app, {
    method: 'POST', url: '/v1/sources/preview', summary: 'What the hub finds behind a GitHub repository or TMLoader server URL', tags: ['author'], auth: 'user',
    body: z.object({ url: z.string().trim().min(3).max(400), product: z.string().max(64).nullable().optional() }), rateLimit: { max: 30, timeWindow: '10 minutes' },
  }, async (_req, { body }) => previewSource(ctx, body.url, body.product ?? null));

  route(app, {
    method: 'POST', url: '/v1/projects/import', summary: 'Create a project from a GitHub repository or TMLoader server (the hub watches it from then on)', tags: ['author'], auth: 'user',
    body: z.object({
      url: z.string().trim().max(400), product: z.string().max(64).nullable().optional(), slug: z.string().optional(), name: z.string().trim().min(2).max(64).optional(),
      games: z.array(z.enum(HUB_GAMES as [GameId, ...GameId[]])).min(1), install: installSchema, assetPattern: z.string().max(120).nullable().optional(),
      // What the author confirmed in the import preview (each item is opt-in; docs/mod-publishing.md).
      type: projectTypeSchema,
      summary: z.string().trim().min(10).max(200).optional(), description: z.string().max(50_000).optional(), license: z.string().trim().max(64).nullable().optional(),
      links: projectInputSchema.shape.links.optional(), images: z.array(z.string().url().max(500)).max(12).optional(), banner: z.string().url().max(500).nullable().optional(),
      showcase: z.enum(['repo', 'catalog']).nullable().optional(), importLatest: z.boolean().optional(),
    }),
    rateLimit: { max: 10, timeWindow: '1 hour' },
  }, async (req, { body }) => {
    const r = await importFromUrl(ctx, body, { id: me(req).id, name: me(req).name });
    return { project: await toHubProject(ctx, r.project, me(req).id), first: r.first, pictureErrors: r.pictureErrors };
  });

  route(app, {
    method: 'POST', url: '/v1/projects/:slug/import-github', summary: 'Take over the ticked items of the GitHub import preview into an existing project and connect the repository as its source', tags: ['author'], auth: 'user', params: slugParam,
    body: z.object({
      url: z.string().trim().min(3).max(400), summary: z.string().trim().min(10).max(200).optional(), description: z.string().max(50_000).optional(), license: z.string().trim().max(64).nullable().optional(),
      links: projectInputSchema.shape.links.optional(), images: z.array(z.string().url().max(500)).max(12).optional(), banner: z.string().url().max(500).nullable().optional(),
      showcase: z.enum(['repo', 'catalog']).nullable().optional(), games: z.array(z.enum(HUB_GAMES as [GameId, ...GameId[]])).min(1).optional(), install: installSchema.optional(), assetPattern: z.string().max(120).nullable().optional(),
    }),
    rateLimit: { max: 10, timeWindow: '1 hour' },
  }, async (req, { params, body }) => {
    const p = await projectBySlug(ctx, params.slug);
    await requireRole(ctx, p.id, me(req).id, ['owner', 'maintainer']);
    return applyGithubImport(ctx, p, body, me(req).id);
  });

  route(app, { method: 'PATCH', url: '/v1/projects/:slug', summary: 'Edit project details (slug never changes)', tags: ['author'], auth: 'user', params: slugParam, body: projectPatchSchema }, async (req, { params, body }) => {
    const p = await projectBySlug(ctx, params.slug);
    await requireRole(ctx, p.id, me(req).id, ['owner', 'maintainer']);
    const next = await updateProject(ctx, p, body, me(req).id);
    if (next.state === 'listed') await rebuildIndex(ctx);
    return toHubProject(ctx, next, me(req).id);
  });

  // ---------------------------------------------------------------- showcase page
  route(app, {
    method: 'PUT', url: '/v1/projects/:slug/showcase', summary: 'Set the showcase page (blocks, packages/shared/showcase.schema.json); 400 with the list of problems', tags: ['author'], auth: 'user', params: slugParam,
    body: z.record(z.string(), z.unknown()), rateLimit: { max: 60, timeWindow: '1 hour' },
  }, async (req, { params, body }) => {
    const p = await projectBySlug(ctx, params.slug);
    await requireRole(ctx, p.id, me(req).id, ['owner', 'maintainer']);
    const showcase = await saveShowcase(ctx, p, body, me(req).id);
    if (p.state === 'listed') await rebuildIndex(ctx);
    return { showcase, showcaseFrom: 'portal' };
  });

  route(app, {
    method: 'POST', url: '/v1/projects/:slug/showcase/adopt', summary: "Take over the repository's showcase.json (from=repo) or the catalog's seed showcase (from=catalog)", tags: ['author'], auth: 'user', params: slugParam,
    body: z.object({ from: z.enum(['repo', 'catalog']) }), rateLimit: { max: 30, timeWindow: '1 hour' },
  }, async (req, { params, body }) => {
    const p = await projectBySlug(ctx, params.slug);
    await requireRole(ctx, p.id, me(req).id, ['owner', 'maintainer']);
    const showcase = await adoptShowcase(ctx, p, body.from, me(req).id);
    if (p.state === 'listed') await rebuildIndex(ctx);
    return { showcase, showcaseFrom: body.from };
  });

  route(app, { method: 'DELETE', url: '/v1/projects/:slug/showcase', summary: "Remove the showcase page (the repository's showcase.json stays out until it is taken over again)", tags: ['author'], auth: 'user', params: slugParam }, async (req, { params }) => {
    const p = await projectBySlug(ctx, params.slug);
    await requireRole(ctx, p.id, me(req).id, ['owner', 'maintainer']);
    await clearShowcase(ctx, p, me(req).id);
    if (p.state === 'listed') await rebuildIndex(ctx);
    return { ok: true };
  });

  // ---------------------------------------------------------------- pictures
  route(app, {
    method: 'POST', url: '/v1/projects/:slug/images', summary: 'Upload a picture (multipart: file, kind=icon|banner|gallery, caption)', tags: ['author'], auth: 'user', params: slugParam, multipart: true,
    rateLimit: { max: 60, timeWindow: '1 hour' },
  }, async (req, { params }) => {
    const p = await projectBySlug(ctx, params.slug);
    await requireRole(ctx, p.id, me(req).id, ['owner', 'maintainer']);
    const part = await req.file({ limits: { fileSize: ctx.cfg.MAX_IMAGE_MB * 1048576, files: 1 } });
    if (!part) throw badRequest('No file');
    const data = await part.toBuffer();
    const fields = Object.fromEntries(Object.entries(part.fields).map(([k, v]) => [k, (v as { value?: string }).value]));
    const kind = z.enum(['icon', 'banner', 'gallery']).parse(fields.kind);
    const last = await ctx.db.selectFrom('images').select((eb) => eb.fn.max('ord').as('m')).where('project_id', '=', p.id).executeTakeFirst();
    const img = await storeImage(ctx, p.id, kind, data, Number(last?.m ?? -1) + 1, fields.caption ?? null);
    if (kind === 'icon') await markIconByAuthor(ctx, p.id);
    await ctx.db.updateTable('projects').set({ updated_at: nowIso() }).where('id', '=', p.id).execute();
    if (p.state === 'listed') await rebuildIndex(ctx);
    return img;
  });

  route(app, { method: 'PUT', url: '/v1/projects/:slug/images/order', summary: 'Order of the gallery', tags: ['author'], auth: 'user', params: slugParam, body: z.object({ ids: z.array(z.string()).max(20) }) }, async (req, { params, body }) => {
    const p = await projectBySlug(ctx, params.slug);
    await requireRole(ctx, p.id, me(req).id, ['owner', 'maintainer']);
    for (const [i, id] of body.ids.entries()) await ctx.db.updateTable('images').set({ ord: i }).where('id', '=', id).where('project_id', '=', p.id).execute();
    if (p.state === 'listed') await rebuildIndex(ctx);
    const rows = await ctx.db.selectFrom('images').selectAll().where('project_id', '=', p.id).where('kind', '=', 'gallery').orderBy('ord').execute();
    return rows.map((r) => imageOf(ctx, r));
  });

  route(app, { method: 'DELETE', url: '/v1/projects/:slug/images/:id', summary: 'Remove a picture', tags: ['author'], auth: 'user', params: z.object({ slug: z.string(), id: z.string() }) }, async (req, { params }) => {
    const p = await projectBySlug(ctx, params.slug);
    await requireRole(ctx, p.id, me(req).id, ['owner', 'maintainer']);
    const gone = await ctx.db.selectFrom('images').select('kind').where('id', '=', params.id).where('project_id', '=', p.id).executeTakeFirst();
    await ctx.db.deleteFrom('images').where('id', '=', params.id).where('project_id', '=', p.id).execute();
    if (gone?.kind === 'icon') await markIconByAuthor(ctx, p.id);
    if (p.state === 'listed') await rebuildIndex(ctx);
    return { ok: true };
  });

  // ---------------------------------------------------------------- versions
  route(app, {
    method: 'POST', url: '/v1/projects/:slug/versions', summary: 'Upload a version (multipart: file + meta JSON {version, channel, changelog, installs?, signature?}). API tokens need versions:write.',
    tags: ['author'], auth: 'user', scope: 'versions:write', params: slugParam, multipart: true, rateLimit: { max: 20, timeWindow: '1 hour' },
  }, async (req, { params }) => {
    const p = await projectBySlug(ctx, params.slug);
    tokenAllows(req, p.id);
    await requireRole(ctx, p.id, me(req).id, ['owner', 'maintainer', 'uploader']);
    const part = await req.file({ limits: { fileSize: ctx.cfg.MAX_UPLOAD_MB * 1048576, files: 1, fields: 10, fieldSize: 64 * 1024 } });
    if (!part) throw badRequest('No file');
    const data = await part.toBuffer().catch((e) => { throw new HttpError(413, 'too_large', String((e as Error).message)); });
    if (part.file.truncated) throw new HttpError(413, 'too_large', `Files up to ${ctx.cfg.MAX_UPLOAD_MB} MB`);
    const raw = (part.fields.meta as { value?: string } | undefined)?.value;
    let metaIn: unknown;
    try { metaIn = raw ? JSON.parse(raw) : Object.fromEntries(Object.entries(part.fields).filter(([k]) => k !== 'file').map(([k, v]) => [k, (v as { value?: string }).value])); } catch { throw badRequest('meta is not JSON'); }
    const meta = versionMetaSchema.safeParse(metaIn);
    if (!meta.success) throw badRequest(meta.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const v = await ingestVersion(ctx, { project: p, fileName: part.filename, data, meta: meta.data, origin: req.auth.via === 'token' ? 'api-token' : 'upload', uploaderId: me(req).id });
    return toHubVersion(ctx, v, { id: me(req).id, name: me(req).name }, true);
  });

  route(app, { method: 'POST', url: '/v1/versions/:id/cancel', summary: 'Stop a version during its hold (or withdraw it from review)', tags: ['author'], auth: 'user', params: z.object({ id: z.string() }) }, async (req, { params }) => {
    const v = await versionById(ctx, params.id);
    await requireRole(ctx, v.project_id, me(req).id, ['owner', 'maintainer']);
    await cancelVersion(ctx, v, me(req).id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- team
  route(app, {
    method: 'POST', url: '/v1/projects/:slug/team', summary: 'Add or change a member (by hub user id or provider:username)', tags: ['author'], auth: 'user', params: slugParam,
    body: z.object({ user: z.string().trim().min(3).max(80), role: z.enum(['maintainer', 'uploader', 'owner']) }),
  }, async (req, { params, body }) => {
    const p = await projectBySlug(ctx, params.slug);
    await requireRole(ctx, p.id, me(req).id, ['owner']);
    const [prov, uname] = body.user.includes(':') ? body.user.split(':', 2) : [null, null];
    const target = prov
      ? await ctx.db.selectFrom('identities').select('user_id as id').where('provider', '=', prov).where('username', '=', uname!).executeTakeFirst()
      : await ctx.db.selectFrom('users').select('id').where('id', '=', body.user).executeTakeFirst();
    if (!target) throw new HttpError(404, 'user_not_found', 'No hub account with that name; they have to log in once first');
    await ctx.db.deleteFrom('members').where('project_id', '=', p.id).where('user_id', '=', target.id).execute();
    if (body.role === 'owner') {
      // Ownership transfer: the old owner stays as maintainer; updates get a human look for 14 days.
      await ctx.db.updateTable('members').set({ role: 'maintainer' }).where('project_id', '=', p.id).where('role', '=', 'owner').execute();
      await ctx.db.updateTable('projects').set({ owner_changed_at: nowIso() }).where('id', '=', p.id).execute();
    }
    await ctx.db.insertInto('members').values({ project_id: p.id, user_id: target.id, role: body.role, added_at: nowIso() }).execute();
    await ctx.audit(me(req).id, 'team.set', p.id, { user: target.id, role: body.role });
    return (await toHubProject(ctx, p, me(req).id)).team;
  });

  route(app, { method: 'DELETE', url: '/v1/projects/:slug/team/:userId', summary: 'Remove a member', tags: ['author'], auth: 'user', params: z.object({ slug: z.string(), userId: z.string() }) }, async (req, { params }) => {
    const p = await projectBySlug(ctx, params.slug);
    if (params.userId !== me(req).id) await requireRole(ctx, p.id, me(req).id, ['owner']);
    const role = await ctx.db.selectFrom('members').select('role').where('project_id', '=', p.id).where('user_id', '=', params.userId).executeTakeFirst();
    if (role?.role === 'owner') throw new HttpError(409, 'owner', 'Hand the project to someone else first');
    await ctx.db.deleteFrom('members').where('project_id', '=', p.id).where('user_id', '=', params.userId).execute();
    await ctx.audit(me(req).id, 'team.remove', p.id, { user: params.userId });
    return { ok: true };
  });

  // ---------------------------------------------------------------- connected sources
  route(app, {
    method: 'POST', url: '/v1/projects/:slug/sources', summary: 'Connect a GitHub repository or TMLoader server to an existing project', tags: ['author'], auth: 'user', params: slugParam,
    body: z.object({ url: z.string().trim().max(400), product: z.string().max(64).nullable().optional(), assetPattern: z.string().max(120).nullable().optional() }),
  }, async (req, { params, body }) => {
    const p = await projectBySlug(ctx, params.slug);
    await requireRole(ctx, p.id, me(req).id, ['owner', 'maintainer']);
    const repo = parseGithubRepo(body.url);
    const server = repo ? null : normalizeServer(body.url);
    if (!repo && !server) throw badRequest('Paste a GitHub repository URL or a TMLoader server URL (https)');
    if (server && !body.product) throw badRequest('Pick the product of the TMLoader server');
    const id = await addSource(ctx, p.id, repo ? 'github' : 'tmloader', repo ?? server!, body.product ?? null, body.assetPattern ?? null);
    if (server && !p.tmloader_product) await ctx.db.updateTable('projects').set({ tmloader_product: body.product! }).where('id', '=', p.id).execute();
    await ctx.audit(me(req).id, 'source.add', p.id, { target: repo ?? server });
    return { id, first: await checkSource(ctx, id) };
  });

  const ownSource = async (req: FastifyRequest, id: string) => {
    const s = await ctx.db.selectFrom('sources').selectAll().where('id', '=', id).executeTakeFirst();
    if (!s) throw new HttpError(404, 'not_found', 'Source not found');
    await requireRole(ctx, s.project_id, me(req).id, ['owner', 'maintainer']);
    return s;
  };
  const lastNow = new Map<string, number>();
  route(app, { method: 'POST', url: '/v1/sources/:id/check', summary: 'Check now', tags: ['author'], auth: 'user', params: z.object({ id: z.string() }) }, async (req, { params }) => {
    const s = await ownSource(req, params.id);
    if (Date.now() - (lastNow.get(s.id) ?? 0) < 120_000) throw new HttpError(429, 'too_often', 'Checked a moment ago; try again in two minutes');
    lastNow.set(s.id, Date.now());
    return checkSource(ctx, s.id, { force: true });
  });
  route(app, { method: 'POST', url: '/v1/sources/:id/choose', summary: 'Pick the release file when several fit (remembered for later releases)', tags: ['author'], auth: 'user', params: z.object({ id: z.string() }), body: z.object({ tag: z.string().max(100), asset: z.string().max(200) }) }, async (req, { params, body }) => {
    const s = await ownSource(req, params.id);
    return chooseAsset(ctx, s.id, body.tag, body.asset);
  });
  route(app, { method: 'DELETE', url: '/v1/sources/:id', summary: 'Disconnect a source (versions stay)', tags: ['author'], auth: 'user', params: z.object({ id: z.string() }) }, async (req, { params }) => {
    const s = await ownSource(req, params.id);
    await ctx.db.deleteFrom('sources').where('id', '=', s.id).execute();
    await ctx.audit(me(req).id, 'source.remove', s.project_id, { target: s.target });
    return { ok: true };
  });

  // ---------------------------------------------------------------- analytics
  route(app, { method: 'GET', url: '/v1/projects/:slug/stats', summary: 'Downloads per version and day (daily totals only, no personal data)', tags: ['author'], auth: 'user', params: slugParam, query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }) }, async (req, { params, query }): Promise<DownloadStats> => {
    const p = await projectBySlug(ctx, params.slug);
    await requireRole(ctx, p.id, me(req).id, ['owner', 'maintainer', 'uploader']);
    const since = new Date(Date.now() - query.days * 86400_000).toISOString().slice(0, 10);
    const rows = await ctx.db.selectFrom('downloads_daily').innerJoin('versions', 'versions.id', 'downloads_daily.version_id').select(['downloads_daily.day', 'versions.version', 'downloads_daily.count'])
      .where('downloads_daily.project_id', '=', p.id).where('downloads_daily.day', '>=', since).orderBy('downloads_daily.day').execute();
    const kinds = (await ctx.db.selectFrom('sources').select('kind').where('project_id', '=', p.id).execute()).map((s) => s.kind);
    return { days: rows.map((r) => ({ day: r.day, version: r.version, count: r.count })), total: p.downloads, breakdown: downloadBreakdown(p, kinds) };
  });

  // ---------------------------------------------------------------- API tokens
  route(app, { method: 'GET', url: '/v1/me/tokens', summary: 'My API tokens', tags: ['account'], auth: 'user' }, async (req): Promise<ApiTokenInfo[]> => {
    const rows = await ctx.db.selectFrom('tokens').selectAll().where('user_id', '=', me(req).id).orderBy('created_at', 'desc').execute();
    return rows.map((t) => ({ id: t.id, name: t.name, scopes: JSON.parse(t.scopes), projects: t.projects ? JSON.parse(t.projects) : null, created: t.created_at, lastUsed: t.last_used, expires: t.expires_at, revoked: !!t.revoked_at }));
  });
  route(app, {
    method: 'POST', url: '/v1/me/tokens', summary: 'Create an API token (shown once)', tags: ['account'], auth: 'user',
    body: z.object({ name: z.string().trim().min(1).max(60), scopes: z.array(z.enum(['versions:write', 'projects:read'])).min(1), projects: z.array(z.string()).max(50).nullable().default(null), expiresDays: z.number().int().min(1).max(365).nullable().default(180) }),
    rateLimit: { max: 20, timeWindow: '1 hour' },
  }, async (req, { body }): Promise<ApiTokenInfo> => {
    if (req.auth.via !== 'session') throw forbidden('Tokens are created in the portal');
    const token = `tmh_${randomToken(30)}`;
    const t = { id: newId('t'), user_id: me(req).id, name: body.name, hash: sha256hex(token), scopes: JSON.stringify(body.scopes), projects: body.projects ? JSON.stringify(body.projects) : null,
      created_at: nowIso(), last_used: null, expires_at: body.expiresDays ? new Date(Date.now() + body.expiresDays * 86400_000).toISOString() : null, revoked_at: null };
    await ctx.db.insertInto('tokens').values(t).execute();
    await ctx.audit(me(req).id, 'token.create', t.id, { scopes: body.scopes });
    return { id: t.id, name: t.name, scopes: body.scopes, projects: body.projects, created: t.created_at, lastUsed: null, expires: t.expires_at, revoked: false, token };
  });
  route(app, { method: 'DELETE', url: '/v1/me/tokens/:id', summary: 'Revoke an API token', tags: ['account'], auth: 'user', params: z.object({ id: z.string() }) }, async (req, { params }) => {
    await ctx.db.updateTable('tokens').set({ revoked_at: nowIso() }).where('id', '=', params.id).where('user_id', '=', me(req).id).execute();
    await ctx.audit(me(req).id, 'token.revoke', params.id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- author keys
  route(app, { method: 'POST', url: '/v1/me/keys', summary: 'Add an Ed25519 public key for signed versions', tags: ['account'], auth: 'user', body: z.object({ publicKey: z.string().trim().max(100) }) }, async (req, { body }) => {
    try { publicKeyObject(body.publicKey); } catch { throw badRequest('Not an Ed25519 public key (base64 of 32 bytes)'); }
    const keyId = keyIdOf(Buffer.from(body.publicKey, 'base64'));
    if (await ctx.db.selectFrom('author_keys').select('key_id').where('key_id', '=', keyId).executeTakeFirst()) throw new HttpError(409, 'key_exists', 'This key is registered already');
    await ctx.db.insertInto('author_keys').values({ key_id: keyId, user_id: me(req).id, public_key: body.publicKey, added_at: nowIso(), revoked_at: null }).execute();
    await ctx.audit(me(req).id, 'key.add', keyId);
    await rebuildIndex(ctx);
    return { keyId };
  });
  route(app, { method: 'DELETE', url: '/v1/me/keys/:keyId', summary: 'Remove a signing key', tags: ['account'], auth: 'user', params: z.object({ keyId: z.string() }) }, async (req, { params }) => {
    await ctx.db.updateTable('author_keys').set({ revoked_at: nowIso() }).where('key_id', '=', params.keyId).where('user_id', '=', me(req).id).execute();
    await ctx.audit(me(req).id, 'key.revoke', params.keyId);
    await rebuildIndex(ctx);
    return { ok: true };
  });

  // ---------------------------------------------------------------- claims
  route(app, {
    method: 'POST', url: '/v1/projects/:slug/claim', summary: 'Request a claim (tmloader-token or manual; GitHub claims go through /auth/github/start?intent=claim:<slug>)', tags: ['author'], auth: 'user', scope: DESKTOP_SCOPE, params: slugParam,
    body: z.object({ method: z.enum(['tmloader-token', 'manual']), message: z.string().max(2000).nullable().optional() }), rateLimit: { max: 10, timeWindow: '1 hour' },
  }, async (req, { params, body }) => {
    const p = await projectBySlug(ctx, params.slug);
    return requestClaim(ctx, p, me(req).id, body.method, body.message ?? null);
  });
  route(app, { method: 'POST', url: '/v1/claims/:id/verify', summary: 'Check the claim token file on the TMLoader server', tags: ['author'], auth: 'user', scope: DESKTOP_SCOPE, params: z.object({ id: z.string() }), rateLimit: { max: 20, timeWindow: '1 hour' } }, async (req, { params }) => ({
    ok: await verifyTmloaderClaim(ctx, params.id, me(req).id),
  }));
  route(app, { method: 'GET', url: '/v1/me/claims', summary: 'My claim requests', tags: ['author'], auth: 'user', scope: DESKTOP_SCOPE }, async (req) => {
    const rows = await ctx.db.selectFrom('claims').innerJoin('projects', 'projects.id', 'claims.project_id').select(['claims.id', 'claims.method', 'claims.detail', 'claims.status', 'claims.created_at', 'projects.slug', 'projects.name'])
      .where('claims.user_id', '=', me(req).id).orderBy('claims.created_at', 'desc').execute();
    return rows;
  });
}
