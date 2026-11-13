// HTTP app: security headers, rate limits, cookies, uploads, auth, routes, GitHub App webhook.
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ZodError } from 'zod';
import type { Ctx } from './ctx.ts';
import { HttpError } from './util.ts';
import { authHook, authRoutes } from './http/auth.ts';
import { publicRoutes } from './routes/public.ts';
import { authorRoutes } from './routes/author.ts';
import { adminRoutes } from './routes/admin.ts';
import { serverRoutes } from './routes/servers.ts';
import type { Probe } from './services/reachability.ts';
import { discoverRoutes } from './routes/discover.ts';
import { githubClaim } from './services/claims.ts';
import { onGithubRelease, crawlTick } from './sources/crawler.ts';
import { registry } from './http/route.ts';
import { createTmfService, tmfRoutes, type TmfSource } from './services/tmf.ts';

export async function buildApp(ctx: Ctx, opts: { logger?: boolean; /** Tests: a stub instead of the real master server service (null = off). */ tmf?: TmfSource | null; /** Tests: a fake connect for the reachability self-test. */ probe?: Probe } = {}): Promise<FastifyInstance> {
  registry.length = 0;
  const app = Fastify({
    logger: opts.logger ? { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie'] } : false,
    trustProxy: ctx.cfg.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
  });
  await app.register(helmet, {
    // JSON API: nothing may be framed or executed from these responses.
    contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"], sandbox: [] } },
    frameguard: { action: 'deny' },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute', keyGenerator: (req) => req.ip });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: ctx.cfg.MAX_UPLOAD_MB * 1048576, files: 1, fields: 10 } });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code, message: err.message, details: err.details });
    if (err instanceof ZodError) return reply.code(400).send({ error: 'invalid', message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), details: err.issues });
    const e = err as { statusCode?: number; code?: string; message: string };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.code ?? 'error', message: e.message });
    req.log.error(err);
    if (!opts.logger) console.error(err);
    return reply.code(500).send({ error: 'internal', message: 'Something went wrong on the hub' });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found', message: 'No such endpoint' }));

  authHook(app, ctx);
  authRoutes(app, ctx, (userId, slug, token) => githubClaim(ctx, userId, slug, token));
  publicRoutes(app, ctx);
  authorRoutes(app, ctx);
  adminRoutes(app, ctx);
  serverRoutes(app, ctx, opts.probe);
  discoverRoutes(app, ctx);
  const tmfService = opts.tmf === undefined ? createTmfService(ctx.cfg) : null;
  tmfRoutes(app, opts.tmf === undefined ? tmfService : opts.tmf);
  if (tmfService) app.addHook('onClose', async () => tmfService.stop());

  // GitHub App webhook: "release published" -> check that repository now (HMAC-checked).
  app.post('/hooks/github', { config: { rawBody: true } }, async (req, reply) => {
    if (!ctx.cfg.GITHUB_WEBHOOK_SECRET) return reply.code(404).send({ error: 'not_found', message: 'Webhooks are off' });
    const body = JSON.stringify(req.body ?? {});
    const sig = String(req.headers['x-hub-signature-256'] ?? '');
    const want = 'sha256=' + createHmac('sha256', ctx.cfg.GITHUB_WEBHOOK_SECRET).update((req as unknown as { rawBody?: string }).rawBody ?? body).digest('hex');
    if (sig.length !== want.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return reply.code(401).send({ error: 'bad_signature', message: 'Signature mismatch' });
    const ev = req.headers['x-github-event'];
    const b = req.body as { action?: string; repository?: { full_name?: string } };
    if (ev === 'release' && ['published', 'released', 'prereleased'].includes(b.action ?? '') && b.repository?.full_name) {
      const n = await onGithubRelease(ctx, b.repository.full_name);
      if (n) setImmediate(() => crawlTick(ctx).catch(() => undefined));
      return { ok: true, sources: n };
    }
    return { ok: true, ignored: ev };
  });
  // Keep the raw body of webhook requests for the HMAC check.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    try {
      if (req.url.startsWith('/hooks/')) (req as unknown as { rawBody: string }).rawBody = body as string;
      done(null, body ? JSON.parse(body as string) : {});
    } catch (e) {
      (e as { statusCode?: number }).statusCode = 400;
      done(e as Error, undefined);
    }
  });
  return app;
}
