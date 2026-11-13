// Automatic verification of game servers (docs/hub/server-registration.md): in-memory SQLite, fake TrackMania
// servers on 127.0.0.1 (only possible with queryTestFlags.allowLocal), never the real network.
import { test, before, after, beforeEach } from 'node:test';
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
import { queryTestFlags, resetSlots, acquireSlot } from '../src/services/tmquery.ts';
import { recheckAll, recheckDue, removeLongOffline } from '../src/services/gameservers.ts';
import { startFake } from './fake-tm.ts';

let app: FastifyInstance;
let ctx: Ctx;
let dir: string;
const PORTAL = 'http://localhost:5174';
const WEB = 'https://site.example';

before(async () => {
  queryTestFlags.allowLocal = true;
  dir = mkdtempSync(join(tmpdir(), 'hub-srv2-'));
  const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'sqlite::memory:', STORAGE_DIR: join(dir, 'files'), HUB_DEV_LOGIN: '1', CRAWLER: '0', HUB_WEB_URL: WEB });
  ctx = await createCtx(cfg, { key: loadSigningKey(RFC8032_TEST1_SEED) });
  app = await buildApp(ctx);
});
after(async () => {
  queryTestFlags.allowLocal = false;
  await app.close();
  await ctx.db.destroy();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => resetSlots());

async function login(as: string, origin = PORTAL) {
  const r = await app.inject({ method: 'POST', url: '/auth/dev/login', payload: { as }, headers: { origin: PORTAL } });
  const cookie = r.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const me = await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie } });
  return { cookie, 'x-csrf-token': me.json().csrf as string, origin };
}
let ipn = 0;
const ip = () => '10.7.' + Math.floor(++ipn / 250) + '.' + (ipn % 250 + 1);
const post = (url: string, payload: unknown, headers: Record<string, string> = {}, remoteAddress = ip()) => app.inject({ method: 'POST', url, payload: payload as never, headers, remoteAddress });
const pubList = async () => (await app.inject({ method: 'GET', url: '/v1/servers' })).json() as { address: string; name: string; online: boolean; players: number | null; map: string | null; suggested: boolean }[];
const indexServers = async () => {
  const idx = (await app.inject({ method: 'GET', url: '/v1/index.json' })).json() as SignedHubIndex;
  return (verifyIndex(idx, [ctx.key.publicKey]) as unknown as HubIndexPayload).servers ?? [];
};
const row = (id: string) => ctx.db.selectFrom('game_servers').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

test('anonymous submission is not queried and stays pending', async () => {
  const f = await startFake('forever');
  const r = await post('/v1/servers', { game: 'tmnf', address: `127.0.0.1:${f.port}`, name: 'Anon Server', contact: 'me#1' });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().status, 'pending');
  assert.equal(f.connections(), 0, 'the hub did not connect');
  assert.deepEqual(await pubList(), []);
  await f.close();
});

test('logged in: answers as the chosen game -> verified, listed with the name from the server', async () => {
  const user = await login('author');
  const f = await startFake('forever', 'ok', { name: '$o$f00Real $fffName', players: 7, max: 30, map: 'A03-Race' });
  const r = await post('/v1/servers', { game: 'tmnf', address: `127.0.0.1:${f.port}`, name: 'Form name that is ignored', contact: '' }, user);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().status, 'verified');
  assert.equal(r.json().info.name, 'Real Name');
  assert.equal(f.connections(), 1, 'one connection for the submission');
  const list = (await pubList()).find((s) => s.address === `127.0.0.1:${f.port}`)!;
  assert.deepEqual([list.name, list.online, list.players, list.map, list.suggested], ['Real Name', true, 7, 'A03-Race', true]);
  assert.ok((await indexServers()).some((s) => s.address === `127.0.0.1:${f.port}` && s.name === 'Real Name'));
  // same server again: already listed
  assert.equal((await post('/v1/servers', { game: 'tmnf', address: `127.0.0.1:${f.port}` }, user)).statusCode, 409);
  // stored: a salted hash of the submitter's address, never the address itself
  const stored = await row(r.json().id);
  assert.equal(stored.submitter_hash!.length, 32);
  assert.ok(!JSON.stringify(stored).includes('10.7.'));
  assert.equal(stored.status, 'verified');
  await f.close();
});

test('logged in but the server does not answer as that game -> pending for an admin', async () => {
  const user = await login('author');
  const f = await startFake('sunrise');
  const r = await post('/v1/servers', { game: 'tmnf', address: `127.0.0.1:${f.port}`, name: 'Wrong game' }, user);
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual([r.json().status, r.json().reason], ['pending', 'unreachable']);
  assert.ok(!(await pubList()).some((s) => s.name === 'Wrong game'));
  assert.ok(ctx.notices.some((n) => n.kind === 'server' && n.text.includes('Wrong game')));
  // as Sunrise the same server passes; an earlier anonymous (pending) entry of it is settled by the passed check
  const anon = await post('/v1/servers', { game: 'tms', address: `127.0.0.1:${f.port}`, name: 'Anon first', contact: 'x#1' });
  assert.equal(anon.json().status, 'pending');
  const ok = await post('/v1/servers', { game: 'tms', address: `127.0.0.1:${f.port}` }, user);
  assert.equal(ok.json().status, 'verified');
  assert.equal(ok.json().id, anon.json().id);
  await f.close();
});

test('password server: waits (pending) until the operator proves ownership', async () => {
  const user = await login('author');
  const f = await startFake('forever', 'ok', { password: true, name: 'Locked Server' });
  const a = await post('/v1/servers', { game: 'tmnf', address: `127.0.0.1:${f.port}`, owner: true, contact: 'me#1234' }, user);
  assert.deepEqual([a.json().status, a.json().reason], ['pending', 'password']);
  assert.equal((await post('/v1/servers', { game: 'tmnf', address: `127.0.0.1:${f.port + 1}`, owner: true }, user)).statusCode, 400, 'owner needs a contact');
  assert.ok(!(await pubList()).some((s) => s.name === 'Locked Server'));
  const id = a.json().id as string;
  const code = (await post(`/v1/servers/${id}/claim-code`, {}, user)).json().code as string;
  f.update({ comment: `hello ${code} there` });
  const c = await post(`/v1/servers/${id}/claim`, {}, user);
  assert.equal(c.statusCode, 200, c.body);
  assert.equal(c.json().status, 'verified');
  const l = (await pubList()).find((s) => s.name === 'Locked Server')!;
  assert.equal(l.suggested, false);
  await f.close();
});

test('ownership proof: a checkbox alone gives no token; code in the name or comment does, once', async () => {
  const user = await login('author');
  const thief = await login('author2');
  const f = await startFake('forever', 'ok', { name: 'Proof Server' });
  const r = await post('/v1/servers', { game: 'tmnf', address: `127.0.0.1:${f.port}`, owner: true, contact: 'me#1' }, user);
  const id = r.json().id as string;
  assert.equal(r.json().status, 'verified');
  const row0 = await row(id);
  assert.deepEqual([row0.owner, row0.token_hash], [0, null], 'the checkbox does not make an owner');
  assert.equal((await pubList()).find((s) => s.name === 'Proof Server')!.suggested, true);
  assert.equal((await indexServers()).find((s) => s.name === 'Proof Server')!.suggested, true, 'index carries suggested');
  // the old token route is gone
  assert.equal((await post(`/v1/servers/${id}/token`, {}, user)).statusCode, 404);

  // no code asked yet; anonymous cannot ask
  assert.equal((await post(`/v1/servers/${id}/claim`, {}, user)).json().error, 'no_code');
  assert.equal((await post(`/v1/servers/${id}/claim-code`, {})).statusCode, 401);
  const c1 = await post(`/v1/servers/${id}/claim-code`, {}, user);
  const code = c1.json().code as string;
  assert.match(code, /^hz-[A-Z2-9]{4}$/);
  assert.equal((await post(`/v1/servers/${id}/claim-code`, {}, user)).json().code, code, 'same person, same code');

  // wrong code (not on the server): 422, code stays valid
  const miss = await post(`/v1/servers/${id}/claim`, {}, user);
  assert.equal(miss.statusCode, 422);
  assert.equal(miss.json().error, 'code_not_found');
  f.update({ name: 'Proof Server hz-XXXX' });
  assert.equal((await post(`/v1/servers/${id}/claim`, {}, user)).statusCode, 422, 'another code does not count');

  // somebody else cannot use my code, even with the code on the server
  f.update({ name: `Proof Server ${code.toLowerCase()}` });
  assert.equal((await post(`/v1/servers/${id}/claim`, {}, thief)).json().error, 'no_code');

  // right code in the name (any case): token, name stripped, owner, not suggested
  const ok = await post(`/v1/servers/${id}/claim`, {}, user);
  assert.equal(ok.statusCode, 200, ok.body);
  assert.match(ok.json().token, /^tmhs_/);
  assert.equal(ok.json().name, 'Proof Server');
  const after = await row(id);
  assert.deepEqual([after.owner, after.name, after.claim_code], [1, 'Proof Server', null]);
  assert.equal((await pubList()).find((s) => s.name === 'Proof Server')!.suggested, false);
  assert.equal((await indexServers()).find((s) => s.name === 'Proof Server')!.suggested, undefined);
  const an = await post('/v1/servers/announce', { name: 'Proof Server', players: 1, maxPlayers: 10 }, { authorization: `Bearer ${ok.json().token}` });
  assert.equal(an.statusCode, 200, an.body);

  // reuse: the code is used up, the same call again fails
  assert.equal((await post(`/v1/servers/${id}/claim`, {}, user)).json().error, 'no_code');
  await f.close();
});

test('ownership proof: expired code, and the comment counts as well', async () => {
  const user = await login('author');
  const f = await startFake('forever', 'ok', { name: 'Late Server' });
  const id = (await post('/v1/servers', { game: 'tmnf', address: `127.0.0.1:${f.port}` }, user)).json().id as string;
  const code = (await post(`/v1/servers/${id}/claim-code`, {}, user)).json().code as string;
  f.update({ comment: `x ${code}` });
  await ctx.db.updateTable('game_servers').set({ claim_expires: new Date(Date.now() - 1000).toISOString() }).where('id', '=', id).execute();
  const late = await post(`/v1/servers/${id}/claim`, {}, user);
  assert.equal(late.statusCode, 400);
  assert.equal(late.json().error, 'code_expired');
  assert.equal((await row(id)).owner, 0);
  // a fresh code works, with the code in the comment only
  const code2 = (await post(`/v1/servers/${id}/claim-code`, {}, user)).json().code as string;
  assert.notEqual(code2, code);
  f.update({ comment: `see ${code2}` });
  assert.equal((await post(`/v1/servers/${id}/claim`, {}, user)).statusCode, 200);
  await f.close();
});

test('check: login needed, shows the live answer, refuses private and closed targets', async () => {
  const user = await login('author');
  const f = await startFake('forever', 'ok', { name: 'Checked', players: 2, max: 8, map: 'A09-Race' });
  assert.equal((await post('/v1/servers/check', { game: 'tmnf', address: `127.0.0.1:${f.port}` })).statusCode, 401);
  const ok = await post('/v1/servers/check', { game: 'tmnf', address: `127.0.0.1:${f.port}` }, user);
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual([ok.json().info.name, ok.json().info.players, ok.json().info.map], ['Checked', 2, 'A09-Race']);
  assert.equal((await post('/v1/servers/check', { game: 'tmnf', address: '127.0.0.1:1999' }, user)).statusCode, 422);
  queryTestFlags.allowLocal = false;
  const priv = await post('/v1/servers/check', { game: 'tmnf', address: '10.0.0.5:2350' }, user);
  assert.equal(priv.statusCode, 400);
  assert.equal(priv.json().error, 'private_address');
  assert.equal((await post('/v1/servers/check', { game: 'tmnf', address: '8.8.8.8:80' }, user)).json().error, 'bad_port');
  queryTestFlags.allowLocal = true;
  await f.close();
});

test('global cap: the hub answers 503 instead of querying more than 30 times a minute', async () => {
  const user = await login('author');
  for (let i = 0; i < 30; i++) acquireSlot();
  const r = await post('/v1/servers/check', { game: 'tmnf', address: '127.0.0.1:2350' }, user);
  assert.equal(r.statusCode, 503);
  assert.equal(r.headers['retry-after'], '60');
});

test('limits: 10 per account and day, 5 per address and hour', async () => {
  const user = await login('author2');
  const codes: number[] = [];
  for (let i = 0; i < 12; i++) codes.push((await post('/v1/servers', { game: 'tmnf', address: `127.0.0.1:${2000 + i}`, name: `Dead ${i}` }, user)).statusCode);
  assert.equal(codes.filter((c) => c === 200).length, 10);
  assert.equal(codes[11], 429);
  const same = '10.99.0.1';
  const c2: number[] = [];
  for (let i = 0; i < 7; i++) c2.push((await post('/v1/servers', { game: 'tmnf', address: `127.0.0.1:${3000 + i}`, name: `Anon ${i}`, contact: 'x@y.z' }, {}, same)).statusCode);
  assert.deepEqual(c2.slice(0, 5), [200, 200, 200, 200, 200]);
  assert.equal(c2[5], 429);
});

test('cross-origin: the website may call with the login, other sites may not', async () => {
  const web = await login('author', WEB);
  const f = await startFake('forever');
  const pre = await app.inject({ method: 'OPTIONS', url: '/v1/servers/check', headers: { origin: WEB, 'access-control-request-method': 'POST' } });
  assert.equal(pre.headers['access-control-allow-origin'], WEB);
  assert.equal(pre.headers['access-control-allow-credentials'], 'true');
  const ok = await post('/v1/servers/check', { game: 'tmnf', address: `127.0.0.1:${f.port}` }, web);
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.headers['access-control-allow-origin'], WEB);
  const evil = await post('/v1/servers/check', { game: 'tmnf', address: `127.0.0.1:${f.port}` }, { ...web, origin: 'https://evil.example' });
  assert.equal(evil.statusCode, 403);
  const me = await app.inject({ method: 'GET', url: '/v1/me', headers: { origin: WEB, cookie: web.cookie } });
  assert.equal(me.headers['access-control-allow-origin'], WEB);
  // anonymous submissions from any origin still work (public form)
  const anon = await post('/v1/servers', { game: 'tmnf', address: `127.0.0.1:${f.port + 1}`, name: 'Anon X', contact: 'c' }, { origin: 'https://other.example' });
  assert.equal(anon.statusCode, 200, anon.body);
  assert.equal(anon.headers['access-control-allow-origin'], '*');
  await f.close();
});

test('re-check job: offline marks, 14 days -> soft removal, admin restores', async () => {
  const user = await login('author');
  const admin = await login('admin');
  const f = await startFake('forever', 'ok', { name: 'Flaky Server' });
  const r = await post('/v1/servers', { game: 'tmnf', address: `127.0.0.1:${f.port}` }, user);
  const id = r.json().id as string;
  assert.equal(r.json().status, 'verified');

  // goes away
  await f.close();
  const res = await recheckAll(ctx);
  assert.ok(res.checked >= 1);
  const off = await row(id);
  assert.ok(off.offline_since);
  assert.equal((await pubList()).find((s) => s.name === 'Flaky Server')!.online, false);
  assert.equal(off.status, 'verified', 'still listed, just offline');

  // two weeks later
  await ctx.db.updateTable('game_servers').set({ offline_since: new Date(Date.now() - 15 * 86400_000).toISOString() }).where('id', '=', id).execute();
  assert.deepEqual(await removeLongOffline(ctx), [id]);
  const gone = await row(id);
  assert.equal(gone.status, 'removed');
  assert.equal(gone.note, 'auto:offline:verified');
  assert.ok(!(await pubList()).some((s) => s.name === 'Flaky Server'));

  // admin sees it under removed and restores it
  const removed = (await app.inject({ method: 'GET', url: '/v1/admin/servers?status=removed', headers: admin })).json() as { id: string }[];
  assert.ok(removed.some((x) => x.id === id));
  assert.equal((await post(`/v1/admin/servers/${id}/restore`, {}, user)).statusCode, 403);
  const rs = await post(`/v1/admin/servers/${id}/restore`, {}, admin);
  assert.equal(rs.statusCode, 200, rs.body);
  assert.equal(rs.json().status, 'verified');
  assert.ok((await pubList()).some((s) => s.name === 'Flaky Server'));

  // comes back: "re-check now" clears the offline mark
  const f2 = await startFake('forever', 'ok', { name: 'Flaky Server' });
  await ctx.db.updateTable('game_servers').set({ address: `127.0.0.1:${f2.port}` }).where('id', '=', id).execute();
  const rc = await post(`/v1/admin/servers/${id}/recheck`, {}, admin);
  assert.deepEqual(rc.json(), { result: 'online' });
  assert.equal((await row(id)).offline_since, null);
  await f2.close();
});

test('re-check runs every 6 hours, not more often', async () => {
  const now = Date.now();
  assert.equal(await recheckDue(ctx, now), true);
  assert.equal(await recheckDue(ctx, now + 3600_000), false);
  assert.equal(await recheckDue(ctx, now + 6 * 3600_000 + 1000), true);
});

test('admin: verified list, approve as owner issues a token, remove', async () => {
  const user = await login('author');
  const admin = await login('admin');
  const f = await startFake('forever', 'ok', { name: 'Admin Test' });
  const r = await post('/v1/servers', { game: 'tmnf', address: `127.0.0.1:${f.port}` }, user);
  const id = r.json().id as string;
  const list = (await app.inject({ method: 'GET', url: '/v1/admin/servers?status=verified', headers: admin })).json() as { id: string; check_info: { name: string }; owner: boolean }[];
  const mine = list.find((x) => x.id === id)!;
  assert.deepEqual([mine.check_info.name, mine.owner], ['Admin Test', false]);
  const ap = await post(`/v1/admin/servers/${id}/approve`, { owner: true }, admin);
  assert.equal(ap.statusCode, 200, ap.body);
  assert.match(ap.json().token, /^tmhs_/);
  const after = (await pubList()).find((s) => s.name === 'Admin Test')!;
  assert.equal(after.suggested, false);
  assert.equal((await post(`/v1/admin/servers/${id}/remove`, { note: 'x' }, admin)).statusCode, 200);
  assert.ok(!(await indexServers()).some((s) => s.name === 'Admin Test'));
  await f.close();
});
