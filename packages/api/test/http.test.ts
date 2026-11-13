// Cache behaviour of the HTTP client against a local server (no internet needed).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Http } from '../src/lib/http.ts';
import { tempDir } from './helpers.ts';

let hits: Record<string, number> = {};
let lastUa = '';
const file = Buffer.alloc(100_000, 7);
const server = http.createServer((req, res) => {
  hits[req.url!] = (hits[req.url!] ?? 0) + 1;
  lastUa = String(req.headers['user-agent']);
  if (req.url === '/index.json') {
    if (req.headers['if-none-match'] === '"v1"') return res.writeHead(304).end();
    return res.writeHead(200, { ETag: '"v1"', 'Content-Type': 'application/json' }).end('{"ok":true}');
  }
  if (req.url === '/mod.zip') {
    if (req.headers['if-modified-since'] === 'Mon, 01 Jan 2024 00:00:00 GMT') return res.writeHead(304).end();
    return res.writeHead(200, { 'Last-Modified': 'Mon, 01 Jan 2024 00:00:00 GMT' }).end(file);
  }
  if (req.url === '/limited') return res.writeHead(429).end('slow down');
  res.writeHead(404).end('missing');
});
await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

test('fresh cache entries need no request, stale ones are revalidated with ETag', async () => {
  hits = {};
  const dir = tempDir();
  const h = new Http(dir, 'tm-hub-test/1');
  const a = await h.getJson<{ ok: boolean }>(`${base}/index.json`, { ttlMinutes: 10 });
  assert.equal(a.data.ok, true);
  assert.equal(a.result.cache, null);
  assert.equal(lastUa, 'tm-hub-test/1');
  const b = await h.getJson(`${base}/index.json`, { ttlMinutes: 10 });
  assert.equal(b.result.cache, 'fresh');
  assert.equal(hits['/index.json'], 1);
  h.save();
  const h2 = new Http(dir, 'tm-hub-test/1');
  const c = await h2.getJson(`${base}/index.json`, { ttlMinutes: 0 });
  assert.equal(c.result.cache, 'revalidated');
  assert.equal(hits['/index.json'], 2);
  h2.offline = true;
  const d = await h2.getJson(`${base}/index.json`);
  assert.equal(d.result.cache, 'stale');
});

test('errors: 404 throws, 429 falls back to nothing when there is no copy', async () => {
  const h = new Http(tempDir(), 'tm-hub-test/1');
  await assert.rejects(h.get(`${base}/nothing`), /HTTP 404/);
  await assert.rejects(h.get(`${base}/limited`), /HTTP 429/);
});

test('hashFile downloads once and revalidates with Last-Modified', async () => {
  hits = {};
  const h = new Http(tempDir(), 'tm-hub-test/1');
  const expected = crypto.createHash('sha256').update(file).digest('hex');
  const a = await h.hashFile(`${base}/mod.zip`, 24);
  assert.deepEqual(a, { sha256: expected, size: file.length, cached: false });
  const b = await h.hashFile(`${base}/mod.zip`, 24);
  assert.equal(b.cached, true);
  assert.equal(hits['/mod.zip'], 1);
  const c = await h.hashFile(`${base}/mod.zip`, 0);
  assert.equal(c.cached, true);
  assert.equal(c.sha256, expected);
  assert.equal(hits['/mod.zip'], 2);
});
