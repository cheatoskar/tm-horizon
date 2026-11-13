// Author signature for a version: node scripts/sign-version.ts <slug> <version> <file> (key in TMHUB_AUTHOR_KEY).
// Prints the base64 signature to paste into the portal or pass as "signature" to the upload API.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadSigningKey, signAuthor } from '../src/index/sign.ts';

const [slug, version, file] = process.argv.slice(2);
if (!slug || !version || !file || !process.env.TMHUB_AUTHOR_KEY) {
  console.error('usage: TMHUB_AUTHOR_KEY=<private seed> node scripts/sign-version.ts <slug> <version> <file>');
  process.exit(2);
}
const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
const key = loadSigningKey(process.env.TMHUB_AUTHOR_KEY);
console.log(JSON.stringify({ keyId: key.keyId, sha256: sha, signature: signAuthor(slug, version, sha, key) }, null, 2));
