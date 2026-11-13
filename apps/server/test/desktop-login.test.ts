// Desktop login of the launcher: system browser + loopback redirect with state and PKCE, one-time
// code swapped for a revocable token with the scope "desktop". Fake Discord/GitHub (no real OAuth calls).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.ts';
import { createCtx } from '../src/ctx.ts';
import { buildApp } from '../src/app.ts';
import { _expireDesktopCodes } from '../src/http/auth.ts';
import { queryTestFlags } from '../src/services/tmquery.ts';
import { loadSigningKey } from '../src/index/sign.ts';
import { RFC8032_TEST1_SEED } from '../scripts/make-index-fixtures.ts';

const dir = mkdtempSync(join(tmpdir(), 'dlogin-'));
after(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(join(dir, 'catalog.json'), JSON.stringify({ entries: [] }));

const fakeFetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url === 'https://discord.com/api/oauth2/token') return json({ access_token: 'tok' });
  if (url === 'https://discord.com/api/users/@me') return json({ id: '111111111111111111', username: 'racer', global_name: 'Racer' });
  throw new Error('unexpected network call ' + url);
}) as typeof fetch;

let ctx: Awaited<ReturnType<typeof createCtx>>;
let app: FastifyInstance;
after(async () => { await app?.close(); await ctx?.db.destroy(); });

async function setup() {
  if (app) return;
  const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'sqlite::memory:', STORAGE_DIR: join(dir, 'files'), DISCORD_CLIENT_ID: 'cid', DISCORD_CLIENT_SECRET: 'sec', GITHUB_CLIENT_ID: 'gid', GITHUB_CLIENT_SECRET: 'gsec' });
  ctx = await createCtx(cfg, { key: loadSigningKey(RFC8032_TEST1_SEED), fetch: fakeFetch });
  app = await buildApp(ctx, { tmf: null });
}

const b64 = (b: Buffer) => b.toString('base64url');
function pkce() {
  const verifier = b64(randomBytes(32));
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url'), state: b64(randomBytes(32)) };
}
let ipn = 0;
const ip = () => `10.77.0.${++ipn}`;

/** Runs start + provider callback like the browser would; returns the loopback URL the hub redirects to. */
async function browserLogin(p: { challenge: string; state: string }, port = 50123, extra = ''): Promise<URL> {
  const s = await app.inject({ method: 'GET', url: `/auth/discord/start?desktop=1&port=${port}&state=${p.state}&challenge=${p.challenge}${extra}`, remoteAddress: ip() });
  assert.equal(s.statusCode, 302, s.body);
  const oauthState = new URL(String(s.headers.location)).searchParams.get('state')!;
  const cookie = s.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const r = await app.inject({ method: 'GET', url: `/auth/discord/callback?code=abc&state=${oauthState}`, headers: { cookie }, remoteAddress: ip() });
  assert.equal(r.statusCode, 302, r.body);
  assert.ok(!r.cookies.some((c) => c.name.includes('session')), 'a desktop login sets no browser session');
  return new URL(String(r.headers.location));
}
const swap = (code: string, verifier: string) => app.inject({ method: 'POST', url: '/auth/desktop/token', payload: { code, verifier }, remoteAddress: ip() });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

test('full desktop flow: loopback redirect, PKCE swap, token works for /v1/me and launcher routes only', async () => {
  await setup();
  const p = pkce();
  const back = await browserLogin(p);
  assert.equal(back.origin, 'http://127.0.0.1:50123');
  assert.equal(back.pathname, '/callback');
  assert.equal(back.searchParams.get('state'), p.state);
  const code = back.searchParams.get('code')!;
  assert.ok(code.length >= 20);

  const r = await swap(code, p.verifier);
  assert.equal(r.statusCode, 200, r.body);
  const { token, user } = r.json() as { token: string; user: { name: string } };
  assert.match(token, /^tmh_/);
  assert.equal(user.name, 'Racer');
  const row = await ctx.db.selectFrom('tokens').selectAll().where('name', '=', 'TM Horizon launcher').executeTakeFirstOrThrow();
  assert.deepEqual(JSON.parse(row.scopes), ['desktop']);
  assert.notEqual(row.hash, token, 'only the hash is stored');

  const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(token) });
  assert.equal((me.json() as { user: { name: string } }).user.name, 'Racer');
  // launcher routes: claims list, server submission without a contact field
  assert.equal((await app.inject({ method: 'GET', url: '/v1/me/claims', headers: bearer(token) })).statusCode, 200);
  // (a closed port on 127.0.0.1: the logged-in check fails at once, without the real network)
  queryTestFlags.allowLocal = true;
  const srv = await app.inject({ method: 'POST', url: '/v1/servers', headers: bearer(token), payload: { game: 'eswc', address: '127.0.0.1:2399', name: 'Desktop Test' }, remoteAddress: ip() });
  queryTestFlags.allowLocal = false;
  assert.equal(srv.statusCode, 200, srv.body);
  const gs = await ctx.db.selectFrom('game_servers').selectAll().where('name', '=', 'Desktop Test').executeTakeFirstOrThrow();
  const racer = await ctx.db.selectFrom('users').select('id').where('name', '=', 'Racer').executeTakeFirstOrThrow();
  assert.equal(gs.submitter_id, racer.id, 'the hub account is the submitter (no contact field needed)');
  // without login a contact is still required
  assert.equal((await app.inject({ method: 'POST', url: '/v1/servers', payload: { game: 'eswc', address: '5.175.222.166:2350', name: 'No Contact' }, remoteAddress: ip() })).statusCode, 400);
  // not allowed: author-only and admin routes
  assert.equal((await app.inject({ method: 'POST', url: '/v1/projects', headers: bearer(token), payload: {} })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/me/tokens', headers: bearer(token) })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/admin/queue', headers: bearer(token) })).statusCode, 403);

  // logout revokes the token
  assert.equal((await app.inject({ method: 'POST', url: '/auth/desktop/revoke', headers: bearer(token) })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/me', headers: bearer(token) })).statusCode, 401);
});

test('a code works once, needs the right verifier and expires', async () => {
  await setup();
  const p = pkce();
  const code = (await browserLogin(p)).searchParams.get('code')!;
  assert.equal((await swap(code, p.verifier)).statusCode, 200);
  assert.equal((await swap(code, p.verifier)).statusCode, 400, 'reused code refused');

  const q = pkce();
  const code2 = (await browserLogin(q)).searchParams.get('code')!;
  const wrong = await swap(code2, pkce().verifier);
  assert.equal(wrong.statusCode, 400);
  assert.equal((wrong.json() as { error: string }).error, 'bad_verifier');
  assert.equal((await swap(code2, q.verifier)).statusCode, 400, 'a wrong verifier burns the code');

  const e = pkce();
  const code3 = (await browserLogin(e)).searchParams.get('code')!;
  _expireDesktopCodes();
  assert.equal((await swap(code3, e.verifier)).statusCode, 400, 'expired code refused');
});

test('start refuses bad loopback parameters; cancelled logins go back to the launcher', async () => {
  await setup();
  const p = pkce();
  const start = (q: string) => app.inject({ method: 'GET', url: `/auth/discord/start?${q}`, remoteAddress: ip() });
  assert.equal((await start(`desktop=1&port=80&state=${p.state}&challenge=${p.challenge}`)).statusCode, 400, 'privileged port');
  assert.equal((await start(`desktop=1&port=70000&state=${p.state}&challenge=${p.challenge}`)).statusCode, 400, 'port out of range');
  assert.equal((await start(`desktop=1&port=50123&state=${p.state}`)).statusCode, 400, 'challenge missing');
  assert.equal((await start(`desktop=1&port=50123&state=short&challenge=${p.challenge}`)).statusCode, 400, 'state too short');
  assert.equal((await start(`desktop=1&port=50123&state=${p.state}&challenge=abc`)).statusCode, 400, 'challenge not S256');
  // GitHub claim from the launcher needs a link ticket (the browser has no hub session)
  assert.equal((await app.inject({ method: 'GET', url: `/auth/github/start?desktop=1&port=50123&state=${p.state}&challenge=${p.challenge}&intent=claim:some-mod`, remoteAddress: ip() })).statusCode, 401);

  const s = await start(`desktop=1&port=50124&state=${p.state}&challenge=${p.challenge}`);
  const oauthState = new URL(String(s.headers.location)).searchParams.get('state')!;
  const cookie = s.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const r = await app.inject({ method: 'GET', url: `/auth/discord/callback?error=access_denied&state=${oauthState}`, headers: { cookie }, remoteAddress: ip() });
  const back = new URL(String(r.headers.location));
  assert.equal(back.origin, 'http://127.0.0.1:50124');
  assert.equal(back.searchParams.get('error'), 'access_denied');
  assert.equal(back.searchParams.get('code'), null);
});

test('a logged-in launcher links a GitHub claim with a one-time ticket', async () => {
  await setup();
  const p = pkce();
  const code = (await browserLogin(p)).searchParams.get('code')!;
  const { token } = (await swap(code, p.verifier)).json() as { token: string };
  const t = await app.inject({ method: 'POST', url: '/auth/desktop/ticket', headers: bearer(token) });
  assert.equal(t.statusCode, 200, t.body);
  const { ticket } = t.json() as { ticket: string };
  const q = pkce();
  const url = `/auth/github/start?desktop=1&port=50125&state=${q.state}&challenge=${q.challenge}&intent=claim:some-mod&ticket=${ticket}`;
  const ok = await app.inject({ method: 'GET', url, remoteAddress: ip() });
  assert.equal(ok.statusCode, 302, ok.body);
  assert.match(String(ok.headers.location), /^https:\/\/github\.com\/login\/oauth\/authorize\?/);
  assert.equal((await app.inject({ method: 'GET', url, remoteAddress: ip() })).statusCode, 400, 'ticket is single use');
  // session-only token routes stay closed to the launcher token
  assert.equal((await app.inject({ method: 'POST', url: '/v1/me/tokens', headers: bearer(token), payload: { name: 'x', scopes: ['projects:read'] } })).statusCode, 403);
});
