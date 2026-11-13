// Reachability self-test: connects back to the caller only, game ports only, rate-limited, and the
// real TCP probe against a local listener. No outside network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.ts';
import { createCtx, type Ctx } from '../src/ctx.ts';
import { buildApp } from '../src/app.ts';
import { loadSigningKey } from '../src/index/sign.ts';
import { RFC8032_TEST1_SEED } from '../scripts/make-index-fixtures.ts';
import { plainIp, selfTest, tcpProbe, type ProbeResult } from '../src/services/reachability.ts';

let app: FastifyInstance;
let ctx: Ctx;
let dir: string;
const probes: { ip: string; port: number }[] = [];
let answer: ProbeResult = 'open';

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hub-reach-'));
  const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'sqlite::memory:', STORAGE_DIR: join(dir, 'files'), CRAWLER: '0' });
  ctx = await createCtx(cfg, { key: loadSigningKey(RFC8032_TEST1_SEED) });
  app = await buildApp(ctx, {
    tmf: null,
    probe: async (ip, port) => {
      probes.push({ ip, port });
      return answer;
    },
  });
});
after(async () => {
  await app.close();
  await ctx.db.destroy();
  rmSync(dir, { recursive: true, force: true });
});

const reach = (payload: unknown, remoteAddress: string) => app.inject({ method: 'POST', url: '/v1/servers/reachability', payload: payload as object, remoteAddress });

test('connects back to the caller address only', async () => {
  probes.length = 0;
  // an address in the body is ignored: the target is always the request's source
  const r = await reach({ port: 2351, ip: '8.8.8.8', host: '1.1.1.1' }, '85.10.20.30');
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json(), { ip: '85.10.20.30', port: 2351, tcp: 'open' });
  assert.deepEqual(probes, [{ ip: '85.10.20.30', port: 2351 }]);
  assert.equal(r.headers['cache-control'], 'no-store');
  answer = 'timeout';
  assert.equal((await reach({ port: 2350 }, '85.10.20.31')).json().tcp, 'timeout');
  answer = 'open';
});

test('only game ports 2350-2399, never XML-RPC', async () => {
  probes.length = 0;
  for (const port of [5000, 2349, 2400, 80, 3450, 0, -1, 2350.5]) {
    assert.equal((await reach({ port }, '85.10.20.40')).statusCode, 400, `port ${port}`);
  }
  assert.equal((await reach({}, '85.10.20.40')).statusCode, 400);
  assert.equal(probes.length, 0, 'nothing was probed');
});

test('private and local callers are refused', async () => {
  probes.length = 0;
  for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.20', '100.64.3.4', '::1', '::ffff:192.168.0.2']) {
    const r = await reach({ port: 2350 }, ip);
    assert.equal(r.statusCode, 400, ip);
    assert.equal(r.json().error, 'private_address');
  }
  assert.equal(probes.length, 0);
});

test('rate limit per caller', async () => {
  const codes: number[] = [];
  for (let i = 0; i < 14; i++) codes.push((await reach({ port: 2350 }, '85.10.20.50')).statusCode);
  assert.deepEqual(codes.slice(0, 12), Array(12).fill(200));
  assert.equal(codes[12], 429);
  // another caller is not affected
  assert.equal((await reach({ port: 2350 }, '85.10.20.51')).statusCode, 200);
});

test('one probe per address at a time', async () => {
  let release: () => void = () => undefined;
  const slow = () => new Promise<ProbeResult>((r) => { release = () => r('open'); });
  const first = selfTest('85.10.20.60', 2350, slow);
  await assert.rejects(selfTest('85.10.20.60', 2350, slow), (e: { code: string }) => e.code === 'busy');
  release();
  assert.equal((await first).tcp, 'open');
  assert.equal(plainIp('::ffff:85.1.2.3'), '85.1.2.3');
});

test('real TCP probe: open and closed', async () => {
  const srv = createServer((s) => s.destroy());
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as AddressInfo).port;
  assert.equal(await tcpProbe('127.0.0.1', port), 'open');
  await new Promise<void>((r) => srv.close(() => r()));
  assert.equal(await tcpProbe('127.0.0.1', port), 'closed');
});
