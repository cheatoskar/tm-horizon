// Ed25519 signing and verification of the hub index and of author signatures (node:crypto only).
// Keys are raw 32-byte values in base64: the private key is the seed (from HUB_INDEX_SIGNING_KEY,
// never written into the repository), the public key is what the launcher pins.
import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { HUB_INDEX_SIG_PREFIX, authorSigMessage, type HubIndexPayload, type SignedHubIndex } from '@tm-hub/shared/hub';

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface SigningKey {
  keyId: string;
  publicKey: string;
  privateKey: KeyObject;
}

/** First 16 hex chars of SHA-256 over the raw public key. */
export const keyIdOf = (rawPublic: Buffer) => createHash('sha256').update(rawPublic).digest('hex').slice(0, 16);

export function publicKeyObject(publicKeyB64: string): KeyObject {
  const raw = Buffer.from(publicKeyB64, 'base64');
  if (raw.length !== 32) throw new Error('Ed25519 public key must be 32 bytes');
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

export function rawPublicOf(key: KeyObject): Buffer {
  const der = createPublicKey(key).export({ format: 'der', type: 'spki' }) as Buffer;
  return der.subarray(der.length - 32);
}

/** Accepts a base64 32-byte seed or a PKCS#8 PEM. */
export function loadSigningKey(secret: string): SigningKey {
  const s = secret.trim();
  let privateKey: KeyObject;
  if (s.startsWith('-----BEGIN')) privateKey = createPrivateKey(s);
  else {
    const seed = Buffer.from(s, 'base64');
    if (seed.length !== 32) throw new Error('HUB_INDEX_SIGNING_KEY must be a base64 32-byte Ed25519 seed or a PKCS#8 PEM');
    privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('signing key is not Ed25519');
  const raw = rawPublicOf(privateKey);
  return { keyId: keyIdOf(raw), publicKey: raw.toString('base64'), privateKey };
}

export function signIndex(payload: HubIndexPayload, key: SigningKey): SignedHubIndex {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const sig = sign(null, Buffer.concat([Buffer.from(HUB_INDEX_SIG_PREFIX, 'utf8'), bytes]), key.privateKey);
  return { format: 'tmhub-signed-index', v: 1, alg: 'ed25519', keyId: key.keyId, payload: bytes.toString('base64'), sig: sig.toString('base64') };
}

/** Verifies against the pinned public keys (base64). Returns the payload or throws. */
export function verifyIndex(doc: SignedHubIndex, pinned: string[]): HubIndexPayload {
  if (doc?.format !== 'tmhub-signed-index' || doc.v !== 1 || doc.alg !== 'ed25519') throw new Error('not a signed hub index');
  const bytes = Buffer.from(doc.payload, 'base64');
  const msg = Buffer.concat([Buffer.from(HUB_INDEX_SIG_PREFIX, 'utf8'), bytes]);
  const sig = Buffer.from(doc.sig, 'base64');
  const ok = pinned.some((pk) => {
    try { return verify(null, msg, publicKeyObject(pk), sig); } catch { return false; }
  });
  if (!ok) throw new Error('index signature does not match a pinned key');
  const payload = JSON.parse(bytes.toString('utf8')) as HubIndexPayload;
  if (payload.format !== 'tmhub-index' || payload.schemaVersion !== 1) throw new Error('unknown index format');
  return payload;
}

export function verifyAuthorSignature(slug: string, version: string, sha256: string, sigB64: string, publicKeyB64: string): boolean {
  try {
    return verify(null, Buffer.from(authorSigMessage(slug, version, sha256), 'utf8'), publicKeyObject(publicKeyB64), Buffer.from(sigB64, 'base64'));
  } catch {
    return false;
  }
}

export function signAuthor(slug: string, version: string, sha256: string, key: SigningKey): string {
  return sign(null, Buffer.from(authorSigMessage(slug, version, sha256), 'utf8'), key.privateKey).toString('base64');
}
