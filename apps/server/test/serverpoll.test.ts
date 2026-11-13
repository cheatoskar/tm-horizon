// Live server list: seed import, poller (fake servers on 127.0.0.1, never the real network) and GET /v1/servers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.ts';
import { createCtx, type Ctx } from '../src/ctx.ts';
import { buildApp } from '../src/app.ts';
import { loadSigningKey } from '../src/index/sign.ts';
import { RFC8032_TEST1_SEED } from '../scripts/make-index-fixtures.ts';
import { queryTestFlags, queryServer } from '../src/services/tmquery.ts';
import { importServerSeeds, type SeedFile } from '../src/services/server-seeds.ts';
import { pollDelay, pollTick, POLL_BASE_MS, POLL_EMPTY_MS, POLL_MAX_MS } from '../src/services/serverpoll.ts';
import { startFake } from './fake-tm.ts';

let app: FastifyInstance;
let ctx: Ctx;
let dir: string;
before(async () => {
  queryTestFlags.allowLocal = true;
  dir = mkdtempSync(join(tmpdir(), 'hub-poll-'));
  ctx = await createCtx(loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'sqlite::memory:', STORAGE_DIR: join(dir, 'files'), CRAWLER: '0' }), { key: loadSigningKey(RFC8032_TEST1_SEED) });
  app = await buildApp(ctx);
});
after(async () => {
  queryTestFlags.allowLocal = false;
  await app.close();
  await ctx.db.destroy();
  rmSync(dir, { recursive: true, force: true });
});

const list = async (q = '') => (await app.inject({ method: 'GET', url: '/v1/servers' + q })).json() as { login: string; address: string | null; game: string; name: string; state: string; online: boolean; players: number | null; maxPlayers: number | null; spectators: number | null; map: string | null; mode: string | null; pingMs: number | null; lastSeen: string | null; country: string | null }[];
const dbRow = (login: string) => ctx.db.selectFrom('game_servers').selectAll().where('login', '=', login).executeTakeFirstOrThrow();

test('backoff: 90 s, then 3, 6 and 10 minutes', () => {
  assert.deepEqual([0, 1, 2, 3, 9].map((n) => pollDelay(n) / 1000), [90, 180, 360, 600, 600]);
  assert.equal(pollDelay(50), POLL_MAX_MS);
  assert.equal(pollDelay(0), POLL_BASE_MS);
});

test('the query parser returns the title pack (United servers become tmuf)', async () => {
  const f = await startFake('forever', 'ok', { pack: 'United', spectators: 2 });
  const r = await queryServer('tmnf', `127.0.0.1:${f.port}`, { poll: true });
  assert.equal(r.info.packMask, 'United');
  assert.equal(r.info.spectators, 2);
  await f.close();
});

test('the separate TMX box is never contacted, whatever the name', async () => {
  await assert.rejects(queryServer('tmnf', '141.144.230.233:2350', { poll: true }), (e: Error & { kind?: string }) => e.kind === 'private');
});

test('seed import is idempotent, polls fill in live data, backoff and offline mark, nothing is deleted', async () => {
  const fa = await startFake('forever', 'ok', { name: '$o$f00Alpha $fffServer', players: 12, max: 40, spectators: 1, map: 'A05-Race', mode: 3 });
  const fb = await startFake('forever', 'ok', { name: 'Beta United', players: 30, max: 40, pack: 'United' });
  const fc = await startFake('forever', 'silent');
  const seed: SeedFile = { date: '2026-11-12', servers: [
    { game: 'tmnf', address: `127.0.0.1:${fa.port}`, login: 'seed_alpha', name: 'Seed alpha', country: null },
    { game: 'tmnf', address: `127.0.0.1:${fb.port}`, login: 'seed_beta', name: 'Seed beta', country: null },
    { game: 'tmnf', address: `127.0.0.1:${fc.port}`, login: 'seed_silent', name: 'Seed silent', country: null },
    { game: 'tmnf', address: '141.144.230.233:2350', login: 'seed_tmx', name: '100% TMX', country: null },
    { game: 'eswc', address: '', login: 'seed_eswc', name: 'ESWC Somebody', country: 'FR' },
  ] };
  assert.deepEqual(await importServerSeeds(ctx, seed), { created: 5, updated: 0 });
  assert.deepEqual(await importServerSeeds(ctx, seed), { created: 0, updated: 5 });
  assert.equal((await dbRow('seed_alpha')).status, 'approved');

  // before any poll: listed, no live data
  assert.ok((await list()).every((s) => s.state === 'unknown' && s.players === null));

  const t0 = Date.now();
  assert.equal(await pollTick(ctx, { now: t0 }), 4, 'four with an address (the TMX box is asked, refused before any connection)');
  assert.equal(fa.connections(), 1);
  assert.equal(await pollTick(ctx, { now: t0 + 30_000 }), 0, 'nothing is due after 30 s');
  assert.equal(fa.connections(), 1);

  let all = await list();
  assert.deepEqual(all.map((s) => s.login).slice(0, 2), ['seed_beta', 'seed_alpha'], 'most players first');
  const alpha = all.find((s) => s.login === 'seed_alpha')!;
  assert.deepEqual([alpha.name, alpha.state, alpha.players, alpha.maxPlayers, alpha.spectators, alpha.map, alpha.mode], ['Alpha Server', 'online', 12, 40, 1, 'A05-Race', 'Rounds']);
  assert.ok(alpha.pingMs! >= 0 && alpha.lastSeen);
  assert.equal(all.find((s) => s.login === 'seed_beta')!.game, 'tmuf', 'a United pack makes it tmuf');
  assert.equal(all.find((s) => s.login === 'seed_alpha')!.game, 'tmnf', 'Stadium pack does not change the seed value');
  assert.equal(all.find((s) => s.login === 'seed_tmx')!.state, 'unknown');
  const eswc = all.find((s) => s.login === 'seed_eswc')!;
  assert.deepEqual([eswc.address, eswc.state, eswc.country, eswc.players], [null, 'unknown', 'FR', null]);
  assert.deepEqual((await list('?game=tmuf')).map((s) => s.login).sort(), ['seed_alpha', 'seed_beta', 'seed_silent', 'seed_tmx'], 'tmuf list also carries the Nations servers');
  assert.deepEqual((await list('?game=tmnf')).map((s) => s.login).sort(), ['seed_alpha', 'seed_silent', 'seed_tmx']);
  assert.deepEqual((await list('?game=eswc')).map((s) => s.login), ['seed_eswc']);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/servers?game=nope' })).statusCode, 400);
  assert.match(String((await app.inject({ method: 'GET', url: '/v1/servers' })).headers['cache-control']), /max-age=60/);

  // update on the server shows up at the next poll (91 s later)
  fa.update({ players: 20 });
  await pollTick(ctx, { now: t0 + 91_000 });
  assert.equal((await list()).find((s) => s.login === 'seed_alpha')!.players, 20);
  assert.equal(Date.parse((await dbRow('seed_alpha')).next_poll_at!) - (t0 + 91_000), POLL_BASE_MS, 'players: 90 s');

  // the silent one: failures back off, offline after three, still listed
  let r = await dbRow('seed_silent');
  assert.equal(r.poll_fail, 1);
  assert.equal(Date.parse(r.next_poll_at!) - t0, 180_000, 'first failure waits 3 min');
  assert.equal((await list()).find((s) => s.login === 'seed_silent')!.state, 'unknown');
  await pollTick(ctx, { now: t0 + 200_000 });
  await pollTick(ctx, { now: t0 + 600_000 });
  r = await dbRow('seed_silent');
  assert.equal(r.poll_fail, 3);
  assert.equal(Date.parse(r.next_poll_at!) - (t0 + 600_000), POLL_MAX_MS);
  all = await list();
  assert.equal(all.find((s) => s.login === 'seed_silent')!.state, 'offline');
  assert.equal(all.at(-1)!.login, 'seed_silent', 'offline servers sort last');
  assert.equal(all.length, 5, 'nothing was deleted');

  // empty: every 5 minutes, back to 90 s once somebody is on
  const T = t0 + 1_300_000;
  fa.update({ players: 0 });
  await pollTick(ctx, { now: T });
  assert.equal(Date.parse((await dbRow('seed_alpha')).next_poll_at!) - T, POLL_EMPTY_MS);
  const conn = fa.connections();
  await pollTick(ctx, { now: T + 200_000 });
  assert.equal(fa.connections(), conn, 'the empty server is not asked again after 200 s');
  fa.update({ players: 3 });
  await pollTick(ctx, { now: T + POLL_EMPTY_MS });
  assert.equal(Date.parse((await dbRow('seed_alpha')).next_poll_at!) - (T + POLL_EMPTY_MS), POLL_BASE_MS);

  for (const f of [fa, fb, fc]) await f.close();
});
