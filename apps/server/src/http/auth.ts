// Login with Discord or GitHub (OAuth 2, no passwords), sessions in an httpOnly cookie, CSRF token
// per session (header X-CSRF-Token on every changing request) plus an Origin check, API tokens for CI.
// Development only: HUB_DEV_LOGIN=1 adds made-up accounts (refused in production by config.ts).
// Desktop login (TM Horizon launcher): the launcher opens /auth/<provider>/start?desktop=1&port&state&challenge in
// the system browser and listens on 127.0.0.1:<port>. The provider still redirects to this hub's registered
// callback; for a desktop login the hub then sets no cookie but sends a one-time code to the loopback address,
// which the launcher swaps (with its PKCE verifier) for a revocable API token with the scope "desktop".
// Docs: docs/hub/architecture.md (Security).
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Ctx } from '../ctx.ts';
import { HttpError, addMinutes, newId, nowIso, randomToken, sha256hex } from '../util.ts';
import { isAdmin, upsertUser, hubUser, type OAuthProfile } from '../services/users.ts';
import { isRepoAdmin } from '../sources/github.ts';
import { claimByDiscordId } from '../services/claims.ts';
import { route, type Auth } from './route.ts';
import { isLoopbackHost } from '../config.ts';

const SESSION_DAYS = 30;
export const sessionCookie = (ctx: Ctx) => (ctx.cfg.production ? '__Host-tmhub_session' : 'tmhub_session');
const STATE_COOKIE = 'tmhub_oauth';

function cookieOpts(ctx: Ctx, maxAge: number) {
  // Secure also in development: browsers accept Secure cookies on http://localhost.
  return { httpOnly: true, secure: ctx.cfg.production || ctx.cfg.HUB_PUBLIC_URL.startsWith('https://') || /localhost|127\.0\.0\.1/.test(ctx.cfg.HUB_PUBLIC_URL), sameSite: 'lax' as const, path: '/', maxAge };
}

export async function createSession(ctx: Ctx, reply: FastifyReply, userId: string) {
  const token = randomToken();
  const at = nowIso();
  await ctx.db.insertInto('sessions').values({ id_hash: sha256hex(token), user_id: userId, csrf: randomToken(18), created_at: at, last_seen: at, expires_at: addMinutes(at, SESSION_DAYS * 1440) }).execute();
  reply.setCookie(sessionCookie(ctx), token, cookieOpts(ctx, SESSION_DAYS * 86400));
}

/** Resolves the session cookie or the API token; enforces CSRF and Origin for changing session requests. */
export function authHook(app: FastifyInstance, ctx: Ctx) {
  app.decorateRequest('auth', null as unknown as Auth);
  app.addHook('onRequest', async (req) => {
    const auth: Auth = { user: null, admin: false, via: null, csrf: null, token: null };
    req.auth = auth;
    const bearer = /^Bearer\s+(tmh_[\w-]{20,})$/.exec(req.headers.authorization ?? '')?.[1];
    if (bearer) {
      const t = await ctx.db.selectFrom('tokens').selectAll().where('hash', '=', sha256hex(bearer)).executeTakeFirst();
      if (!t || t.revoked_at || (t.expires_at && t.expires_at < nowIso())) throw new HttpError(401, 'bad_token', 'API token unknown, expired or revoked');
      auth.user = (await ctx.db.selectFrom('users').selectAll().where('id', '=', t.user_id).executeTakeFirst()) ?? null;
      auth.via = 'token';
      auth.token = { id: t.id, scopes: JSON.parse(t.scopes), projects: t.projects ? JSON.parse(t.projects) : null };
      await ctx.db.updateTable('tokens').set({ last_used: nowIso() }).where('id', '=', t.id).execute();
      return;
    }
    const raw = req.cookies?.[sessionCookie(ctx)];
    if (raw) {
      const s = await ctx.db.selectFrom('sessions').selectAll().where('id_hash', '=', sha256hex(raw)).executeTakeFirst();
      if (s && s.expires_at > nowIso()) {
        auth.user = (await ctx.db.selectFrom('users').selectAll().where('id', '=', s.user_id).executeTakeFirst()) ?? null;
        auth.via = auth.user ? 'session' : null;
        auth.csrf = s.csrf;
        if (Date.now() - Date.parse(s.last_seen) > 3600_000) await ctx.db.updateTable('sessions').set({ last_seen: nowIso() }).where('id_hash', '=', s.id_hash).execute();
      }
    }
    if (auth.user) auth.admin = await isAdmin(ctx, auth.user.id);
    const changing = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (changing && !req.url.startsWith('/hooks/')) {
      const origin = req.headers.origin;
      const allowed = [ctx.cfg.HUB_PORTAL_URL, ctx.cfg.HUB_PUBLIC_URL, ...(ctx.cfg.HUB_WEB_URL ? [ctx.cfg.HUB_WEB_URL] : [])].map((u) => new URL(u).origin);
      // The public server form (anonymous POST /v1/servers from the website) is meant to be called from other origins; a session needs a matching origin.
      const openForm = !auth.user && req.url === '/v1/servers';
      if (origin && !openForm && !allowed.includes(origin)) throw new HttpError(403, 'bad_origin', 'Request from another site refused');
      if (auth.via === 'session' && req.headers['x-csrf-token'] !== auth.csrf) throw new HttpError(403, 'csrf', 'Missing or wrong CSRF token; reload the page');
    }
  });
}

/** Launcher loopback (desktop login): port on 127.0.0.1, the launcher's own state and its PKCE challenge. */
interface DesktopReturn { port: number; state: string; challenge: string }
interface OAuthState { provider: 'discord' | 'github'; next: string; intent: string | null; exp: number; linkTo: string | null; desktop: DesktopReturn | null }
const states = new Map<string, OAuthState>();

/** Scope of launcher tokens; routes the launcher may call list it (http/route.ts). */
export const DESKTOP_SCOPE = 'desktop';
const DESKTOP_TOKEN_DAYS = 90;
const DESKTOP_CODE_MS = 2 * 60_000;
/** One-time codes handed to the launcher's loopback address (memory only: a hub restart just means "log in again"). */
const desktopCodes = new Map<string, { userId: string; challenge: string; exp: number }>();
/** Short tickets that let a logged-in launcher link a second login (GitHub claim) to its account. */
const desktopTickets = new Map<string, { userId: string; exp: number }>();
const B64URL = /^[A-Za-z0-9_-]+$/;
const pkceS256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function sweep<V extends { exp: number }>(m: Map<string, V>) {
  const now = Date.now();
  for (const [k, v] of m) if (v.exp < now) m.delete(k);
}
/** Tests only. */
export function _expireDesktopCodes() { for (const v of desktopCodes.values()) v.exp = 0; }
// A path in the portal, or "web:/path" for a page of the public website (HUB_WEB_URL), e.g. the server form.
const safeNext = (n: string | undefined) => (n && /^(web:)?\/[\w\-/?=&.%]*$/.test(n) && !n.replace(/^web:/, '').startsWith('//') ? n : '/');

async function discordProfile(ctx: Ctx, code: string, redirect: string): Promise<OAuthProfile> {
  const tok = await ctx.fetch('https://discord.com/api/oauth2/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: ctx.cfg.DISCORD_CLIENT_ID!, client_secret: ctx.cfg.DISCORD_CLIENT_SECRET!, grant_type: 'authorization_code', code, redirect_uri: redirect }),
  });
  if (!tok.ok) throw new HttpError(502, 'oauth', 'Discord login failed');
  const { access_token } = (await tok.json()) as { access_token: string };
  const me = (await (await ctx.fetch('https://discord.com/api/users/@me', { headers: { authorization: `Bearer ${access_token}` } })).json()) as { id: string; username: string; global_name?: string; avatar?: string };
  return { provider: 'discord', providerId: me.id, username: me.username, name: me.global_name || me.username, avatar: me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=128` : null };
}

async function githubToken(ctx: Ctx, code: string, redirect: string): Promise<string> {
  const tok = await ctx.fetch('https://github.com/login/oauth/access_token', {
    method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: ctx.cfg.GITHUB_CLIENT_ID, client_secret: ctx.cfg.GITHUB_CLIENT_SECRET, code, redirect_uri: redirect }),
  });
  const j = (await tok.json()) as { access_token?: string };
  if (!j.access_token) throw new HttpError(502, 'oauth', 'GitHub login failed');
  return j.access_token;
}

async function githubProfile(ctx: Ctx, token: string): Promise<OAuthProfile> {
  const me = (await (await ctx.fetch('https://api.github.com/user', { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'TM-Horizon-hub (+https://tm-horizon.com)' } })).json()) as { id: number; login: string; name?: string; avatar_url?: string };
  return { provider: 'github', providerId: String(me.id), username: me.login, name: me.name || me.login, avatar: me.avatar_url ?? null };
}

/** Claim through GitHub: the OAuth token proves repo admin rights once and is then dropped. */
export type ClaimHandler = (userId: string, slug: string, ghToken: string) => Promise<string>;

export function authRoutes(app: FastifyInstance, ctx: Ctx, onGithubClaim: ClaimHandler) {
  const providers = () => [ctx.cfg.DISCORD_CLIENT_ID && ctx.cfg.DISCORD_CLIENT_SECRET ? 'discord' : null, ctx.cfg.GITHUB_CLIENT_ID && ctx.cfg.GITHUB_CLIENT_SECRET ? 'github' : null].filter(Boolean) as string[];
  const redirectFor = (p: string) => `${ctx.cfg.HUB_PUBLIC_URL}auth/${p}/callback`;

  route(app, { method: 'GET', url: '/v1/config', summary: 'Public settings of this hub (login providers, limits)', tags: ['meta'], auth: 'none' }, async () => ({
    providers: providers(), devLogin: ctx.cfg.HUB_DEV_LOGIN && !ctx.cfg.production, maxUploadMb: ctx.cfg.MAX_UPLOAD_MB, maxImageMb: ctx.cfg.MAX_IMAGE_MB,
    holdMinutes: ctx.cfg.HOLD_MINUTES, publicUrl: ctx.cfg.HUB_PUBLIC_URL, portalUrl: ctx.cfg.HUB_PORTAL_URL, githubApp: ctx.cfg.GITHUB_APP_SLUG ? `https://github.com/apps/${ctx.cfg.GITHUB_APP_SLUG}/installations/new` : null,
    indexKey: { keyId: ctx.key.keyId, publicKey: ctx.key.publicKey },
  }));

  route(app, { method: 'GET', url: '/v1/me', summary: 'Logged-in user and CSRF token', tags: ['auth'], auth: 'none' }, async (req) => ({
    user: req.auth.user ? await hubUser(ctx, req.auth.user) : null, csrf: req.auth.csrf,
  }));

  route(app, {
    method: 'GET', url: '/auth/:provider/start', summary: 'Start Discord or GitHub login (redirect)', tags: ['auth'], auth: 'none',
    params: z.object({ provider: z.enum(['discord', 'github']) }),
    query: z.object({
      next: z.string().max(200).optional(), intent: z.string().regex(/^(claim:[a-z0-9-]{3,48}|link)$/).optional(),
      // Desktop login (launcher): all three or none.
      desktop: z.literal('1').optional(), port: z.coerce.number().int().min(1024).max(65535).optional(),
      state: z.string().min(20).max(100).regex(B64URL).optional(), challenge: z.string().length(43).regex(B64URL).optional(),
      ticket: z.string().min(20).max(100).regex(B64URL).optional(),
    }),
    rateLimit: { max: 30, timeWindow: '1 minute' },
  }, async (req, { params, query, reply }) => {
    if (!providers().includes(params.provider)) throw new HttpError(404, 'provider_off', `${params.provider} login is not configured`);
    if (query.intent?.startsWith('claim:') && params.provider !== 'github') throw new HttpError(400, 'bad_intent', 'Claims go through GitHub');
    let desktop: DesktopReturn | null = null;
    let linkTo: string | null = null;
    if (query.desktop) {
      if (!query.port || !query.state || !query.challenge) throw new HttpError(400, 'bad_desktop', 'Desktop login needs port, state and challenge');
      desktop = { port: query.port, state: query.state, challenge: query.challenge };
      // The browser has no hub session here: a launcher that is already logged in proves its account with a ticket.
      if (query.ticket) {
        sweep(desktopTickets);
        const t = desktopTickets.get(query.ticket);
        desktopTickets.delete(query.ticket);
        if (!t) throw new HttpError(400, 'bad_ticket', 'Link ticket expired; try again from the launcher');
        linkTo = t.userId;
      }
      if (query.intent && !linkTo) throw new HttpError(401, 'unauthorized', 'Log in first');
    } else {
      if (query.intent && !req.auth.user) throw new HttpError(401, 'unauthorized', 'Log in first');
      linkTo = query.intent ? req.auth.user!.id : null;
    }
    const state = randomToken(24);
    sweep(states);
    states.set(state, { provider: params.provider, next: safeNext(query.next), intent: query.intent ?? null, exp: Date.now() + 10 * 60_000, linkTo, desktop });
    reply.setCookie(STATE_COOKIE, state, cookieOpts(ctx, 600));
    const u = params.provider === 'discord'
      ? `https://discord.com/oauth2/authorize?${new URLSearchParams({ response_type: 'code', client_id: ctx.cfg.DISCORD_CLIENT_ID!, scope: 'identify', state, redirect_uri: redirectFor('discord'), prompt: 'none' })}`
      : `https://github.com/login/oauth/authorize?${new URLSearchParams({ client_id: ctx.cfg.GITHUB_CLIENT_ID!, state, redirect_uri: redirectFor('github'), allow_signup: 'false' })}`;
    return reply.redirect(u);
  });

  route(app, {
    method: 'GET', url: '/auth/:provider/callback', summary: 'OAuth callback', tags: ['auth'], auth: 'none',
    params: z.object({ provider: z.enum(['discord', 'github']) }), query: z.object({ code: z.string().max(200).optional(), state: z.string().max(100).optional(), error: z.string().max(200).optional() }),
    rateLimit: { max: 30, timeWindow: '1 minute' },
  }, async (req, { params, query, reply }) => {
    const st = query.state ? states.get(query.state) : undefined;
    if (query.state) states.delete(query.state);
    reply.clearCookie(STATE_COOKIE, { path: '/' });
    if (!st || st.exp < Date.now() || st.provider !== params.provider || req.cookies[STATE_COOKIE] !== query.state) throw new HttpError(400, 'bad_state', 'Login expired or started elsewhere; try again');
    const loopback = (q: Record<string, string>) => `http://127.0.0.1:${st.desktop!.port}/callback?${new URLSearchParams({ ...q, state: st.desktop!.state })}`;
    if (!query.code) {
      if (st.desktop) return reply.redirect(loopback({ error: (query.error ?? 'cancelled').slice(0, 60) }));
      return reply.redirect(`${ctx.cfg.HUB_PORTAL_URL}login?error=${encodeURIComponent(query.error ?? 'cancelled')}`);
    }
    let profile: OAuthProfile;
    let ghToken: string | null = null;
    if (params.provider === 'discord') profile = await discordProfile(ctx, query.code, redirectFor('discord'));
    else {
      ghToken = await githubToken(ctx, query.code, redirectFor('github'));
      profile = await githubProfile(ctx, ghToken);
    }
    const userId = await upsertUser(ctx, profile, st.linkTo);
    if (st.linkTo && userId !== st.linkTo) throw new HttpError(409, 'identity_taken', 'This login belongs to another hub account already');
    // Suspended accounts may still log in to read the statement of reasons and appeal; every
    // route that changes something refuses them (http/route.ts).
    // Desktop logins get no browser session: the launcher holds its own token.
    if (!st.desktop && (!req.auth.user || req.auth.user.id !== userId)) await createSession(ctx, reply, userId);
    let next = st.next;
    // The Discord id from the mod-channel export claims the unclaimed projects it belongs to (audit entry per claim).
    if (params.provider === 'discord' && !next.startsWith('web:')) {
      const slugs = await claimByDiscordId(ctx, userId, profile.providerId);
      if (slugs.length) next = slugs.length === 1 ? `/projects/${slugs[0]}?claimed=1` : '/projects?claimed=1';
    }
    let claimed = next !== st.next;
    if (st.intent?.startsWith('claim:') && ghToken) {
      try {
        next = await onGithubClaim(userId, st.intent.slice(6), ghToken);
        claimed = true;
      } catch (e) {
        if (!st.desktop) throw e;
        ghToken = null;
        return reply.redirect(loopback({ error: e instanceof HttpError ? e.code : 'claim_failed' }));
      }
    }
    ghToken = null;
    if (st.desktop) {
      sweep(desktopCodes);
      const code = randomToken(24);
      desktopCodes.set(code, { userId, challenge: st.desktop.challenge, exp: Date.now() + DESKTOP_CODE_MS });
      return reply.redirect(loopback({ code, ...(claimed ? { claimed: '1' } : {}) }));
    }
    if (next.startsWith('web:') && ctx.cfg.HUB_WEB_URL) return reply.redirect(ctx.cfg.HUB_WEB_URL.replace(/\/$/, '') + next.slice(4));
    return reply.redirect(ctx.cfg.HUB_PORTAL_URL.replace(/\/$/, '') + (next.startsWith('web:') ? '/' : next));
  });

  route(app, {
    method: 'POST', url: '/auth/desktop/token', summary: 'Launcher: swap the one-time loopback code (+ PKCE verifier) for a desktop API token', tags: ['auth'], auth: 'none',
    body: z.object({ code: z.string().min(20).max(100).regex(B64URL), verifier: z.string().min(43).max(128).regex(B64URL) }),
    rateLimit: { max: 20, timeWindow: '1 minute' },
  }, async (_req, { body }) => {
    sweep(desktopCodes);
    const c = desktopCodes.get(body.code);
    desktopCodes.delete(body.code); // single use, also after a wrong verifier
    if (!c || c.exp < Date.now()) throw new HttpError(400, 'bad_code', 'Login code unknown or expired; log in again');
    if (!sameText(pkceS256(body.verifier), c.challenge)) throw new HttpError(400, 'bad_verifier', 'Login code does not belong to this app');
    const user = await ctx.db.selectFrom('users').selectAll().where('id', '=', c.userId).executeTakeFirst();
    if (!user) throw new HttpError(400, 'bad_code', 'Account gone; log in again');
    const token = `tmh_${randomToken(30)}`;
    const at = nowIso();
    const t = { id: newId('t'), user_id: user.id, name: 'TM Horizon launcher', hash: sha256hex(token), scopes: JSON.stringify([DESKTOP_SCOPE]), projects: null,
      created_at: at, last_used: null, expires_at: addMinutes(at, DESKTOP_TOKEN_DAYS * 1440), revoked_at: null };
    await ctx.db.insertInto('tokens').values(t).execute();
    await ctx.audit(user.id, 'token.create', t.id, { scopes: [DESKTOP_SCOPE], via: 'desktop-login' });
    return { token, expires: t.expires_at, user: await hubUser(ctx, user) };
  });

  route(app, {
    method: 'POST', url: '/auth/desktop/ticket', summary: 'Launcher: short ticket to link a second login (GitHub claim) to this account', tags: ['auth'], auth: 'user', scope: DESKTOP_SCOPE,
    rateLimit: { max: 20, timeWindow: '1 minute' },
  }, async (req) => {
    sweep(desktopTickets);
    const ticket = randomToken(24);
    desktopTickets.set(ticket, { userId: req.auth.user!.id, exp: Date.now() + DESKTOP_CODE_MS });
    return { ticket };
  });

  route(app, {
    method: 'POST', url: '/auth/desktop/revoke', summary: 'Launcher: log out (revokes the calling desktop token)', tags: ['auth'], auth: 'none',
    rateLimit: { max: 20, timeWindow: '1 minute' },
  }, async (req) => {
    if (req.auth.via !== 'token' || !req.auth.token) throw new HttpError(401, 'unauthorized', 'Send the launcher token');
    if (!req.auth.token.scopes.includes(DESKTOP_SCOPE)) throw new HttpError(403, 'forbidden', 'Only launcher tokens log out here');
    await ctx.db.updateTable('tokens').set({ revoked_at: nowIso() }).where('id', '=', req.auth.token.id).execute();
    if (req.auth.user) await ctx.audit(req.auth.user.id, 'token.revoke', req.auth.token.id, { via: 'desktop-logout' });
    return { ok: true };
  });

  route(app, { method: 'POST', url: '/auth/logout', summary: 'Log out', tags: ['auth'], auth: 'none' }, async (req, { reply }) => {
    const raw = req.cookies?.[sessionCookie(ctx)];
    if (raw) await ctx.db.deleteFrom('sessions').where('id_hash', '=', sha256hex(raw)).execute();
    reply.clearCookie(sessionCookie(ctx), { path: '/' });
    return { ok: true };
  });

  if (ctx.cfg.HUB_DEV_LOGIN && !ctx.cfg.production) {
    const DEV: Record<string, OAuthProfile> = {
      admin: { provider: 'dev', providerId: 'admin', username: 'dev-admin', name: 'Dev Admin', avatar: null },
      author: { provider: 'dev', providerId: 'author', username: 'dev-author', name: 'Dev Author', avatar: null },
      author2: { provider: 'dev', providerId: 'author2', username: 'dev-author2', name: 'Second Author', avatar: null },
      user: { provider: 'dev', providerId: 'user', username: 'dev-user', name: 'Dev User', avatar: null },
    };
    ctx.cfg.admins.add('dev:admin');
    route(app, {
      method: 'POST', url: '/auth/dev/login', summary: 'DEVELOPMENT ONLY: log in as a made-up account', tags: ['auth'], auth: 'none',
      body: z.object({ as: z.enum(['admin', 'author', 'author2', 'user']) }),
    }, async (req, { body, reply }) => {
      // Second guard besides config.ts: only requests from this machine (the portal's dev proxy is local too).
      if (!isLoopbackHost(req.socket.remoteAddress)) throw new HttpError(403, 'dev-login-local-only', 'The development login works only from this computer');
      const id = await upsertUser(ctx, DEV[body.as]);
      req.log?.warn?.(`DEV LOGIN as ${body.as}`);
      await createSession(ctx, reply, id);
      return { ok: true, dev: true };
    });
    // Dev claim helper: behaves like a GitHub claim that proved admin rights.
    route(app, {
      method: 'POST', url: '/auth/dev/github-claim', summary: 'DEVELOPMENT ONLY: claim as if GitHub confirmed repo admin rights', tags: ['auth'], auth: 'user',
      body: z.object({ slug: z.string() }),
    }, async (req, { body }) => ({ next: await onGithubClaim(req.auth.user!.id, body.slug, 'dev') }));
  }
}

export { isRepoAdmin };
export type { FastifyRequest };
