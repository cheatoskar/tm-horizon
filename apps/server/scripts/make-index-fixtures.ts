// Writes signed-index test fixtures shared by the server tests and the launcher's Rust tests
// (apps/launcher/src-tauri/tests/fixtures/hub/). The keys are the public test vectors of RFC 8032
// section 7.1 (TEST 1 and TEST 2), known to everyone, never used outside tests.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HubIndexPayload } from '@tm-hub/shared/hub';
import { loadSigningKey, signAuthor, signIndex } from '../src/index/sign.ts';

export const RFC8032_TEST1_SEED = Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex').toString('base64');
export const RFC8032_TEST2_SEED = Buffer.from('4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb', 'hex').toString('base64');

export function fixturePayload(seq = 7): HubIndexPayload {
  const author = loadSigningKey(RFC8032_TEST2_SEED);
  const sha = 'a'.repeat(64);
  return {
    format: 'tmhub-index', schemaVersion: 1, hub: 'https://hub.example.invalid/', generated: '2026-11-10T12:00:00.000Z', seq,
    expires: '2026-11-17T12:00:00.000Z',
    projects: [{
      id: 'p_fixture', slug: 'demo-shaders', name: 'Demo Shaders', summary: 'Fixture project.', author: 'Fixture Author', claimed: true,
      catalogId: null, icon: null, banner: null, gallery: [], categories: ['graphics'], tags: ['shader'], games: ['tmnf', 'tmuf'], license: 'MIT',
      links: { source: 'https://github.com/example/demo' }, dependencies: [{ id: 'CoreMod', version: '^1.0.0', tmloader: true }], conflicts: [],
      authorKeys: [{ keyId: author.keyId, publicKey: author.publicKey }], downloads: 3, updated: '2026-11-10T11:00:00.000Z',
      versions: [{
        id: 'v_fixture', version: '1.2.0', channel: 'stable', published: '2026-11-10T11:00:00.000Z', changelog: 'Fixture.',
        installs: { tmnf: { kind: 'tmloader-product', strip: 0, include: [] }, tmuf: { kind: 'tmloader-product', strip: 0, include: [] } },
        files: [{ name: 'demo-shaders-1.2.0.zip', size: 1234, sha256: sha, url: 'https://hub.example.invalid/dl/v_fixture/demo-shaders-1.2.0.zip' }],
        authorSignature: { keyId: author.keyId, sig: signAuthor('demo-shaders', '1.2.0', sha, author) }, verified: true,
      }],
    }],
    revoked: [{ project: 'demo-shaders', version: '1.1.0', sha256: 'b'.repeat(64), reason: 'Fixture revocation.', revoked: '2026-11-09T10:00:00.000Z' }],
  };
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/').replace(/^\//, '')}` || process.argv[1]?.endsWith('make-index-fixtures.ts')) {
  const here = dirname(fileURLToPath(import.meta.url));
  const out = join(here, '../../launcher/src-tauri/tests/fixtures/hub');
  mkdirSync(out, { recursive: true });
  const hub = loadSigningKey(RFC8032_TEST1_SEED);
  const other = loadSigningKey(RFC8032_TEST2_SEED);
  const valid = signIndex(fixturePayload(), hub);
  const write = (name: string, v: unknown) => writeFileSync(join(out, name), JSON.stringify(v, null, 2) + '\n');
  write('valid.json', valid);
  write('older.json', signIndex(fixturePayload(6), hub));
  // Payload changed after signing (download URL swapped).
  const p = fixturePayload();
  p.projects[0].versions[0].files[0].url = 'https://evil.example.invalid/x.zip';
  write('tampered.json', { ...valid, payload: Buffer.from(JSON.stringify(p)).toString('base64') });
  write('wrong-key.json', signIndex(fixturePayload(), other));
  write('keys.json', { hubPublicKey: hub.publicKey, hubKeyId: hub.keyId, authorPublicKey: other.publicKey, authorKeyId: other.keyId, note: 'RFC 8032 7.1 TEST 1 / TEST 2 keys, test only' });
  console.log(`fixtures written to ${out}`);
}
