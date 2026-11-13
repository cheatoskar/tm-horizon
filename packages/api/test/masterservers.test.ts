// ESWC getservers.php and the TMF master server envelope, against handwritten fixtures and a local
// TLS 1.0 server. No request leaves the machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import https from 'node:https';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { offlineContext, root } from './helpers.ts';
import { buildEswcMaster, EswcError, eswcGetServersUrl, parseEswcServers, tls10Get } from '../src/sources/eswc-master.ts';

const fx = (name: string) => fs.readFileSync(path.join(root, 'test', 'fixtures', name), 'latin1');

// ------------------------------------------------------------- ESWC

test('eswc: getservers.php URL as the game builds it', () => {
  const cfg = { host: 'game.trackmanianations.com', path: '/online_game', version: '0.1.7.9', lang: 'en' };
  assert.equal(eswcGetServersUrl(cfg), 'https://game.trackmanianations.com/online_game/getservers.php?ver=0.1.7.9&lang=en');
  assert.equal(eswcGetServersUrl(cfg, 'a b'), 'https://game.trackmanianations.com/online_game/getservers.php?ver=0.1.7.9&lang=en&login=a%20b');
});

test('eswc: parse the master server list', () => {
  const list = parseEswcServers(fx('eswc-getservers.txt'));
  assert.equal(list.length, 3);
  assert.deepEqual(list[1], {
    id: 'eswc-master:Normal Europe', game: 'eswc', name: 'Normal Europe', level: 'Normal',
    players: 17, servers: 5, buddies: 2, address: 'master2.trackmanianations.com', port: 443,
  });
  assert.equal(list[2].level, 'Expert');
  assert.deepEqual(parseEswcServers('0;0\r\nNo server available\r\n'), []);
  assert.throws(() => parseEswcServers('3;0\nBad version\n'), (e: unknown) => e instanceof EswcError && e.status === 3 && /Bad version/.test(e.message));
  assert.throws(() => parseEswcServers('0;2\na;b;1;c;0;1;1;0\n'), /announced 2/);
  assert.throws(() => parseEswcServers('<html>'), /unexpected first line/);
});

/** A throwaway self-signed key and certificate for the local TLS 1.0 server, made with openssl at test
 * time (no private key in the repository); null when openssl is not on the PATH (the test is skipped). */
function testTls(): { key: Buffer; cert: Buffer } | null {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmhub-tls-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-subj', '/CN=127.0.0.1',
      '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
    return { key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) };
  } catch {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const TLS = testTls();

function tls10Server(body: string): Promise<{ url: string; close: () => void; seen: string[] }> {
  const seen: string[] = [];
  const server = https.createServer(
    {
      key: TLS!.key,
      cert: TLS!.cert,
      minVersion: 'TLSv1',
      maxVersion: 'TLSv1',
      ciphers: 'AES256-SHA:@SECLEVEL=0',
    },
    (req, res) => {
      seen.push(req.url ?? '');
      res.end(body);
    },
  );
  return new Promise((ok) =>
    server.listen(0, '127.0.0.1', () => ok({ url: `https://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close(), seen })),
  );
}

test('eswc: TLS 1.0 with AES256-SHA works from Node (local server, like the old Nadeo host)', { skip: TLS ? false : 'openssl not found' }, async () => {
  const srv = await tls10Server(fx('eswc-getservers.txt'));
  try {
    const r = await tls10Get(`${srv.url}/online_game/getservers.php?ver=0.1.7.9&lang=en`, 'tm-hub-test', 3000);
    assert.equal(r.status, 200);
    assert.equal(r.protocol, 'TLSv1');
    assert.match(r.fingerprint ?? '', /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    assert.equal(parseEswcServers(r.body).length, 3);
    assert.deepEqual(srv.seen, ['/online_game/getservers.php?ver=0.1.7.9&lang=en']);
  } finally {
    srv.close();
  }
});

test('eswc: build source is off by default, uses the login, pins the certificate', async () => {
  const off = offlineContext((c) => (c.servers.eswcMaster.enabled = false));
  assert.deepEqual(await buildEswcMaster(off), { masterServers: [], sources: [] });

  const ctx = offlineContext((c) => { c.servers.eswcMaster.enabled = true; c.servers.eswcMaster.certSha256 = null; }, { ESWC_LOGIN: 'player1' });
  ctx.http.offline = false;
  const urls: string[] = [];
  const ok = await buildEswcMaster(ctx, async (u) => {
    urls.push(u);
    return { status: 200, body: fx('eswc-getservers.txt'), fingerprint: 'AA:BB', protocol: 'TLSv1' };
  });
  assert.match(urls[0], /&login=player1$/);
  assert.equal(ok.masterServers.length, 3);
  assert.equal(ok.sources[0].ok, true);

  const pinned = offlineContext((c) => {
    c.servers.eswcMaster.enabled = true;
    c.servers.eswcMaster.certSha256 = 'CC:DD';
  });
  pinned.http.offline = false;
  const bad = await buildEswcMaster(pinned, async () => ({ status: 200, body: fx('eswc-getservers.txt'), fingerprint: 'AA:BB', protocol: 'TLSv1' }));
  assert.equal(bad.sources[0].ok, false);
  assert.match(bad.sources[0].error ?? '', /certificate changed/);
  assert.equal(pinned.warnings.length, 1);
});

// ------------------------------------------------------------- TMF

