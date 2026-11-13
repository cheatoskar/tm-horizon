// Checks the website language files in src/i18n: every key of en.json must exist in de, pl and fr,
// and the other files must not have keys English lacks.
// Run: npm run check-i18n -w @tm-hub/web   (exit code 1 when a key is missing)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'i18n');
const load = (lang) => JSON.parse(readFileSync(join(dir, `${lang}.json`), 'utf8'));
const LANGS = ['de', 'pl', 'fr'];

const en = load('en');
let missing = 0;
let extra = 0;
for (const lang of LANGS) {
  const dict = load(lang);
  for (const key of Object.keys(en)) {
    if (!(key in dict)) { console.error(`${lang}: missing ${key}`); missing++; }
  }
  for (const key of Object.keys(dict)) {
    if (!(key in en)) { console.error(`${lang}: extra key ${key}`); extra++; }
  }
}

if (extra) console.error(`check-i18n: ${extra} extra key(s) (warning)`);
if (missing) {
  console.error(`check-i18n: ${missing} missing key(s)`);
  process.exit(1);
}
console.log(`check-i18n: ok (${Object.keys(en).length} English keys, ${LANGS.join(', ')} complete)`);
