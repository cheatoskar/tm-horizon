import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadSigningKey, signIndex, verifyIndex, verifyAuthorSignature, signAuthor } from '../src/index/sign.ts';
import { RFC8032_TEST1_SEED, RFC8032_TEST2_SEED, fixturePayload } from '../scripts/make-index-fixtures.ts';
import type { SignedHubIndex } from '@tm-hub/shared/hub';

const fx = (n: string) => JSON.parse(readFileSync(new URL(`../../launcher/src-tauri/tests/fixtures/hub/${n}`, import.meta.url), 'utf8'));
const keys = fx('keys.json');

test('RFC 8032 test key gives the published public key', () => {
  const k = loadSigningKey(RFC8032_TEST1_SEED);
  assert.equal(Buffer.from(k.publicKey, 'base64').toString('hex'), 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
});

test('sign and verify round trip, deterministic', () => {
  const k = loadSigningKey(RFC8032_TEST1_SEED);
  const a = signIndex(fixturePayload(), k);
  assert.deepEqual(verifyIndex(a, [k.publicKey]), fixturePayload());
  assert.equal(a.sig, signIndex(fixturePayload(), k).sig);
});

test('committed fixtures verify the same way the launcher must', () => {
  assert.equal(verifyIndex(fx('valid.json'), [keys.hubPublicKey]).seq, 7);
  assert.throws(() => verifyIndex(fx('tampered.json'), [keys.hubPublicKey]), /signature/);
  assert.throws(() => verifyIndex(fx('wrong-key.json'), [keys.hubPublicKey]), /signature/);
  assert.throws(() => verifyIndex(fx('valid.json'), []), /signature/);
  // key rotation: any pinned key may sign
  assert.equal(verifyIndex(fx('wrong-key.json'), [keys.hubPublicKey, keys.authorPublicKey]).seq, 7);
  const bad: SignedHubIndex = { ...fx('valid.json'), alg: 'rsa' };
  assert.throws(() => verifyIndex(bad, [keys.hubPublicKey]), /not a signed hub index/);
});

test('author signatures', () => {
  const a = loadSigningKey(RFC8032_TEST2_SEED);
  const sha = 'c'.repeat(64);
  const sig = signAuthor('demo', '1.0.0', sha, a);
  assert.ok(verifyAuthorSignature('demo', '1.0.0', sha, sig, a.publicKey));
  assert.ok(verifyAuthorSignature('demo', '1.0.0', sha.toUpperCase(), sig, a.publicKey));
  assert.ok(!verifyAuthorSignature('demo', '1.0.1', sha, sig, a.publicKey));
  assert.ok(!verifyAuthorSignature('demo', '1.0.0', 'd'.repeat(64), sig, a.publicKey));
  assert.ok(!verifyAuthorSignature('demo', '1.0.0', sha, 'garbage', a.publicKey));
  const v = fx('valid.json');
  const payload = verifyIndex(v, [keys.hubPublicKey]);
  const ver = payload.projects[0].versions[0];
  assert.ok(verifyAuthorSignature('demo-shaders', ver.version, ver.files[0].sha256, ver.authorSignature!.sig, keys.authorPublicKey));
});

test('a seed of the wrong length is refused', () => {
  assert.throws(() => loadSigningKey(Buffer.alloc(16).toString('base64')), /32-byte/);
});
