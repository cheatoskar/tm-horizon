// Creates a new Ed25519 key pair for the hub index (or an author key). Run it yourself on a trusted
// machine: npm run generate-key -w @tm-hub/server
// It prints the private seed once. Put it into the server's secret store (HUB_INDEX_SIGNING_KEY in
// /etc/tm-hub/hub.env, mode 600) and keep an offline copy; it is never written into the repository.
// The public key goes into the launcher (PINNED_KEYS in apps/launcher/src-tauri/src/hubindex.rs) and
// into HUB_INDEX_PUBLIC_KEYS of the server.
import { generateKeyPairSync } from 'node:crypto';
import { keyIdOf, rawPublicOf } from '../src/index/sign.ts';

const { privateKey } = generateKeyPairSync('ed25519');
const der = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
const seed = der.subarray(der.length - 32).toString('base64');
const pub = rawPublicOf(privateKey);
const author = process.argv.includes('--author');
console.log(author ? '# Author key (sign versions with: npm run sign-version)' : '# TM Horizon Hub index key');
console.log(`keyId:       ${keyIdOf(pub)}`);
console.log(`public key:  ${pub.toString('base64')}`);
console.log(`private key: ${seed}`);
console.log('');
console.log(author
  ? 'Add the public key in the portal (Account > Signing keys). Keep the private key secret.'
  : 'HUB_INDEX_SIGNING_KEY=<private key>  (server secret only)\nHUB_INDEX_PUBLIC_KEYS=<public key>   (server env, comma-separated during a key change)\nLauncher: add the public key to PINNED_KEYS in apps/launcher/src-tauri/src/hubindex.rs');
