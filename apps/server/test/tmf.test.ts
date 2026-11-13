// GET /tmf/servers with a stub service: no network, the master server is never contacted.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { TmfServersResponse } from '@tm-hub/shared';
import { loadConfig } from '../src/config.ts';
import { createCtx } from '../src/ctx.ts';
import { buildApp } from '../src/app.ts';
import { createTmfService, type TmfSource } from '../src/services/tmf.ts';

const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'sqlite::memory:', STORAGE_DIR: './data/test-tmf' });
const ctx = await createCtx(cfg);
after(() => ctx.db.destroy());

const sample = (game: 'tmnf' | 'tmuf', over: Partial<TmfServersResponse> = {}): TmfServersResponse => ({
  game, status: 'ok', fetchedAt: '2026-11-12T18:00:00.000Z', nextPollAt: '2026-11-12T18:01:30.000Z', error: null,
  servers: [{
    id: 'tmf-master:frl_cup', source: 'tmf-master', sample: false, game, title: null, name: 'Forever Racing League', nameRaw: '$o$f80Forever',
    description: null, login: 'frl_cup', players: 12, maxPlayers: 32, spectators: 1, zone: null, mode: null, private: false,
    join: 'tmtp://#join=frl_cup', club: null,
  }],
  ...over,
});
let calls = 0;
const stub = (over: Partial<TmfServersResponse> = {}): TmfSource => ({ get: (g) => { calls++; return sample(g, over); } });

test('switched off by default: 503 tmf-disabled, no service created', async () => {
  assert.equal(cfg.TMF_ENABLED, false);
  assert.equal(createTmfService(cfg), null);
  const app = await buildApp(ctx);
  const r = await app.inject({ method: 'GET', url: '/tmf/servers?game=tmnf' });
  assert.equal(r.statusCode, 503);
  assert.equal(r.json().error, 'tmf-disabled');
  await app.close();
});

test('both TMF_ENABLED and TMF_LIVE are needed', () => {
  for (const env of [{ TMF_ENABLED: '1' }, { TMF_LIVE: '1' }]) {
    assert.equal(createTmfService(loadConfig({ NODE_ENV: 'test', ...env }), {}), null);
  }
});

test('enabled: contract shape, served from the cache', async () => {
  const app = await buildApp(ctx, { tmf: stub() });
  const r = await app.inject({ method: 'GET', url: '/tmf/servers?game=tmuf' });
  assert.equal(r.statusCode, 200);
  assert.match(String(r.headers['cache-control']), /max-age=30/);
  const b = r.json() as TmfServersResponse;
  assert.equal(b.game, 'tmuf');
  assert.equal(b.status, 'ok');
  assert.equal(b.servers[0]!.join, 'tmtp://#join=frl_cup');
  assert.equal(b.servers[0]!.source, 'tmf-master');
  await app.close();
});

test('errors map cleanly: bad game 400, stale/unavailable 200 with error text, service disabled 503', async () => {
  let app = await buildApp(ctx, { tmf: stub() });
  assert.equal((await app.inject({ method: 'GET', url: '/tmf/servers' })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: '/tmf/servers?game=tm2' })).json().error, 'invalid');
  await app.close();
  app = await buildApp(ctx, { tmf: stub({ status: 'stale', error: 'SearchNew: master server error 106' }) });
  let r = await app.inject({ method: 'GET', url: '/tmf/servers?game=tmnf' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().status, 'stale');
  await app.close();
  app = await buildApp(ctx, { tmf: stub({ status: 'unavailable', servers: [], fetchedAt: null, error: 'x' }) });
  r = await app.inject({ method: 'GET', url: '/tmf/servers?game=tmnf' });
  assert.equal(r.json().status, 'unavailable');
  await app.close();
  app = await buildApp(ctx, { tmf: stub({ status: 'disabled', servers: [] }) });
  r = await app.inject({ method: 'GET', url: '/tmf/servers?game=tmnf' });
  assert.equal(r.statusCode, 503);
  assert.equal(r.json().error, 'tmf-disabled');
  await app.close();
});
