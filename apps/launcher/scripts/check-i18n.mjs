// Checks the UI language files in src/i18n: every language must have every key of en.json
// (plural keys: the forms its language needs) with the same {placeholders}, and no extra keys.
// Run: npm run check-i18n   (exit code 1 on any problem)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'i18n');
// parts/<feature>.<lang>.json are merged into the language (a key may exist only once).
const partsDir = join(dir, 'parts');
const partFiles = existsSync(partsDir) ? readdirSync(partsDir).filter((f) => f.endsWith('.json')) : [];
const dupes = [];
const load = (lang) => {
  const out = JSON.parse(readFileSync(join(dir, `${lang}.json`), 'utf8'));
  for (const f of partFiles.filter((f) => f.endsWith(`.${lang}.json`))) {
    for (const [k, v] of Object.entries(JSON.parse(readFileSync(join(partsDir, f), 'utf8')))) {
      if (k in out) dupes.push(`${lang}: ${k} in parts/${f} exists already`);
      out[k] = v;
    }
  }
  return out;
};
const LANGS = ['de', 'pl', 'fr'];
// Plural forms the UI needs per language (Intl.PluralRules categories used by tp() in i18n/index.tsx).
const FORMS = { en: ['one', 'other'], de: ['one', 'other'], fr: ['one', 'other'], pl: ['one', 'few', 'many', 'other'] };
const PLURAL_RE = /^(.+)\.(one|few|many|other)$/;

const placeholders = (s) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort().join(',');

const en = load('en');
const problems = dupes;

// Plural groups: a key "x.one" in English makes "x" a plural group (x.one / x.few / x.many / x.other).
const groups = new Map();
for (const key of Object.keys(en)) {
  if (key.endsWith('.one')) groups.set(key.slice(0, -4), []);
}
for (const key of Object.keys(en)) {
  const m = PLURAL_RE.exec(key);
  if (m && groups.has(m[1])) groups.get(m[1]).push(m[2]);
}
const base = (key) => {
  const m = PLURAL_RE.exec(key);
  return m && groups.has(m[1]) ? m[1] : null;
};
for (const [b, forms] of groups) {
  for (const f of FORMS.en) if (!forms.includes(f)) problems.push(`en: ${b}.${f} is missing`);
}

for (const lang of LANGS) {
  const dict = load(lang);
  const expected = new Set();
  for (const key of Object.keys(en)) {
    const b = base(key);
    if (!b) expected.add(key);
  }
  for (const b of groups.keys()) for (const f of FORMS[lang]) expected.add(`${b}.${f}`);

  for (const key of expected) {
    if (!(key in dict)) { problems.push(`${lang}: missing ${key}`); continue; }
    if (typeof dict[key] !== 'string' || dict[key].trim() === '') { problems.push(`${lang}: empty ${key}`); continue; }
    // Placeholders are compared with the English text (plural forms: with en .other).
    const b = base(key);
    const ref = b ? en[`${b}.other`] : en[key];
    if (placeholders(dict[key]) !== placeholders(ref)) {
      problems.push(`${lang}: ${key} has {${placeholders(dict[key])}} but English has {${placeholders(ref)}}`);
    }
  }
  for (const key of Object.keys(dict)) if (!expected.has(key)) problems.push(`${lang}: extra key ${key}`);
}

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\ncheck-i18n: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log(`check-i18n: ok (${Object.keys(en).length} English keys, ${LANGS.join(', ')} complete)`);
