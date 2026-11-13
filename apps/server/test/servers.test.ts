// Game server registration through the HTTP API (in-memory SQLite, no network, no live hub).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { HubIndexPayload, SignedHubIndex } from '@tm-hub/shared';
import { loadConfig } from '../src/config.ts';
import { createCtx, type Ctx } from '../src/ctx.ts';
import { buildApp } from '../src/app.ts';
import { loadSigningKey, verifyIndex } from '../src/index/sign.ts';
import { RFC8032_TEST1_SEED } from '../scripts/make-index-fixtures.ts';
import { normalizeAddress, ANNOUNCE_MIN_GAP_MS } from '../src/services/gameservers.ts';

let app: FastifyInstance;
let ctx: Ctx;
let dir: string;
const PORTAL = 'http://localhost:5174';

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hub-srv-'));
  const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'sqlite::memory:', STORAGE_DIR: join(dir, 'files'), HUB_DEV_LOGIN: '1', CRAWLER: '0' });
  ctx = await createCtx(cfg, { key: loadSigningKey(RFC8032_TEST1_SEED) });
  app = await buildApp(ctx);
});
after(async () => {
  await app.close();
  await ctx.db.destroy();
  rmSync(dir, { recursive: true, force: true });
});

async function login(as: string) {
  const r = await app.inject({ method: 'POST', url: '/auth/dev/login', payload: { as }, headers: { origin: PORTAL } });
  const cookie = r.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const me = await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } });
  return { cookie, 'x-csrf-token': me.json().csrf as string, origin: PORTAL };
}
const form = (over: Record<string, unknown> = {}) => ({ game: 'tmnf', address: '5.175.222.165:7012', name: 'FreeZone Test', contact: 'owner#1234 on Discord', homepage: 'https://example.org/', ...over });
let ipn = 0;
const ip = () => '10.9.' + Math.floor(++ipn / 250) + '.' + (ipn % 250 + 1);
const submit = (payload: Record<string, unknown>, ip = '10.1.1.1') => app.inject({ method: 'POST', url: '/v1/servers', payload, remoteAddress: ip });

test('address rules: public only, default port', () => {
  assert.equal(normalizeAddress(' 5.175.222.165:7012 '), '5.175.222.165:7012');
  assert.equal(normalizeAddress('Play.Example.COM'), 'play.example.com:2350');
  for (const bad of ['127.0.0.1:2350', '10.0.0.5', '192.168.1.2:2350', '172.20.0.1', '169.254.1.1', 'localhost', 'server', 'a.local', '1.2.3', '1.2.3.4:0', '1.2.3.4:70000', 'http://x.y', 'a b.c', '999.1.1.1']) {
    assert.throws(() => normalizeAddress(bad), `${bad} must be refused`);
  }
});

test('submit: pending, nothing public, not in the index', async () => {
  const r = await submit(form());
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().received, true);
  assert.equal(r.headers['access-control-allow-origin'], '*');
  assert.deepEqual((await app.inject({ method: 'GET', url: '/v1/servers' })).json(), []);
  const idx = (await app.inject({ method: 'GET', url: '/v1/index.json' })).json() as SignedHubIndex;
  assert.deepEqual((JSON.parse(Buffer.from(idx.payload, 'base64').toString()) as HubIndexPayload).servers, []);
  // same server again: refused while pending
  assert.equal((await submit(form())).statusCode, 409);
  // the notice for the moderators went out
  assert.ok(ctx.notices.some((n) => n.kind === 'server' && n.text.includes('FreeZone Test')));
});

test('preflight, honeypot, validation, rate limit', async () => {
  const pre = await app.inject({ method: 'OPTIONS', url: '/v1/servers', headers: { origin: 'https://site.example', 'access-control-request-method': 'POST' } });
  assert.equal(pre.statusCode, 204);
  assert.equal(pre.headers['access-control-allow-origin'], '*');
  assert.equal((await submit(form({ website: 'spam' }), ip())).statusCode, 400);
  assert.equal((await submit(form({ address: '127.0.0.1:2350' }), ip())).statusCode, 400);
  assert.equal((await submit(form({ game: 'tm2020' }), ip())).statusCode, 400);
  assert.equal((await submit(form({ homepage: 'http://insecure.example' }), ip())).statusCode, 400);
  assert.equal((await submit(form({ name: 'x' }), ip())).statusCode, 400);
  assert.equal((await submit(form({ contact: '' }), ip())).statusCode, 400);
  const codes: number[] = [];
  for (let i = 0; i < 7; i++) codes.push((await submit(form({ address: `8.8.8.${i + 10}:2350`, name: `Rate ${i}` }), '10.3.3.3')).statusCode);
  assert.deepEqual(codes.slice(0, 5), [200, 200, 200, 200, 200]);
  assert.equal(codes[5], 429);
});

test('admin only: list, approve (token once), index, announce, rate limit, public list, remove', async () => {
  const admin = await login('admin');
  const author = await login('author');
  assert.equal((await app.inject({ method: 'GET', url: '/v1/admin/servers', headers: author })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/admin/servers' })).statusCode, 401);

  const pending = (await app.inject({ method: 'GET', url: '/v1/admin/servers?status=pending', headers: admin })).json() as { id: string; address: string; contact: string }[];
  const mine = pending.find((p) => p.address === '5.175.222.165:7012')!;
  assert.ok(mine && mine.contact.includes('Discord'));

  // no token before approval
  const early = await app.inject({ method: 'POST', url: '/v1/servers/announce', headers: { authorization: 'Bearer tmhs_aaaaaaaaaaaaaaaaaaaaaaaa' }, payload: { name: 'x', players: 1, maxPlayers: 2 } });
  assert.equal(early.statusCode, 401);

  assert.equal((await app.inject({ method: 'POST', url: `/v1/admin/servers/${mine.id}/approve`, headers: author })).statusCode, 403);
  const ap = await app.inject({ method: 'POST', url: `/v1/admin/servers/${mine.id}/approve`, headers: admin });
  assert.equal(ap.statusCode, 200, ap.body);
  const token = ap.json().token as string;
  assert.match(token, /^tmhs_[A-Za-z0-9_-]{20,}$/);
  // the token is not stored in clear text, and not shown in listings
  const row = await ctx.db.selectFrom('game_servers').selectAll().where('id', '=', mine.id).executeTakeFirstOrThrow();
  assert.notEqual(row.token_hash, token);
  assert.equal(row.token_hash!.length, 64);
  assert.ok(!JSON.stringify((await app.inject({ method: 'GET', url: '/v1/admin/servers?status=approved', headers: admin })).json()).includes(token));

  // signed index now carries the server (without the contact)
  const idx = (await app.inject({ method: 'GET', url: '/v1/index.json' })).json() as SignedHubIndex;
  const payload = verifyIndex(idx, [ctx.key.publicKey]) as unknown as HubIndexPayload;
  assert.deepEqual(payload.servers, [{ game: 'tmnf', address: '5.175.222.165:7012', name: 'FreeZone Test', homepage: 'https://example.org/' }]);
  assert.ok(!JSON.stringify(payload).includes('Discord'));

  // announce: bad scheme, wrong token, good token, too soon
  const body = { name: 'FreeZone Test', players: 12, maxPlayers: 40, spectators: 1, map: 'A01-Race', mode: 'TimeAttack' };
  assert.equal((await app.inject({ method: 'POST', url: '/v1/servers/announce', payload: body })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/servers/announce', headers: { authorization: 'Bearer tmhs_wrongwrongwrongwrongwrong' }, payload: body })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/servers/announce', headers: { authorization: `Bearer ${token}` }, payload: { ...body, players: -1 } })).statusCode, 400);
  const ok = await app.inject({ method: 'POST', url: '/v1/servers/announce', headers: { authorization: `Bearer ${token}` }, payload: body });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().nextInSeconds, ANNOUNCE_MIN_GAP_MS / 1000);
  const soon = await app.inject({ method: 'POST', url: '/v1/servers/announce', headers: { authorization: `Bearer ${token}` }, payload: body });
  assert.equal(soon.statusCode, 429);
  assert.ok(Number(soon.headers['retry-after']) > 0);

  // public list shows the live data
  const pub = (await app.inject({ method: 'GET', url: '/v1/servers' })).json() as { address: string; online: boolean; players: number; map: string; contact?: string }[];
  assert.equal(pub.length, 1);
  assert.deepEqual([pub[0]!.online, pub[0]!.players, pub[0]!.map, pub[0]!.contact], [true, 12, 'A01-Race', undefined]);

  // old announcement counts as offline
  await ctx.db.updateTable('game_servers').set({ announced_at: new Date(Date.now() - 30 * 60_000).toISOString() }).where('id', '=', mine.id).execute();
  assert.equal(((await app.inject({ method: 'GET', url: '/v1/servers' })).json() as { online: boolean }[])[0]!.online, false);

  // new token replaces the old one
  const second = (await app.inject({ method: 'POST', url: `/v1/admin/servers/${mine.id}/approve`, headers: admin })).json().token as string;
  assert.notEqual(second, token);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/servers/announce', headers: { authorization: `Bearer ${token}` }, payload: body })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/servers/announce', headers: { authorization: `Bearer ${second}` }, payload: body })).statusCode, 200);

  // remove: out of the index, token dead, can be submitted again
  assert.equal((await app.inject({ method: 'POST', url: `/v1/admin/servers/${mine.id}/remove`, headers: admin, payload: { note: 'gone' } })).statusCode, 200);
  const idx2 = (await app.inject({ method: 'GET', url: '/v1/index.json' })).json() as SignedHubIndex;
  assert.deepEqual((verifyIndex(idx2, [ctx.key.publicKey]) as unknown as HubIndexPayload).servers, []);
  await ctx.db.updateTable('game_servers').set({ announced_at: null }).where('id', '=', mine.id).execute();
  assert.equal((await app.inject({ method: 'POST', url: '/v1/servers/announce', headers: { authorization: `Bearer ${second}` }, payload: body })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: `/v1/admin/servers/${mine.id}/approve`, headers: admin })).statusCode, 409);
  assert.equal((await submit(form(), '10.4.4.4')).statusCode, 200);
});

test('reject keeps the server out', async () => {
  const admin = await login('admin');
  const r = await submit(form({ address: '9.9.9.9:2350', name: 'Spam server' }), '10.5.5.5');
  assert.equal(r.statusCode, 200);
  const id = r.json().id as string;
  assert.equal((await app.inject({ method: 'POST', url: `/v1/admin/servers/${id}/reject`, headers: admin, payload: { note: 'no' } })).statusCode, 200);
  assert.ok(!((await app.inject({ method: 'GET', url: '/v1/servers' })).json() as { address: string }[]).some((s) => s.address === '9.9.9.9:2350'));
  assert.equal((await app.inject({ method: 'POST', url: `/v1/admin/servers/${id}/reject`, headers: admin, payload: {} })).statusCode, 404);
});
