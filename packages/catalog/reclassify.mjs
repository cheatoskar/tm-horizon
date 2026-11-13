// Applies types.json (category / modType review) to catalog.json in place, without a full rebuild (a rebuild
// resets every link status; build_catalog.py applies the same file at its end). Prints every change.
// Run: node reclassify.mjs [--check]   (--check: exit 1 when catalog.json is not up to date, changes nothing)
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const check = process.argv.includes('--check');
const types = JSON.parse(fs.readFileSync(path.join(here, 'types.json'), 'utf8')).entries;
const file = path.join(here, 'catalog.json');
const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
const byId = new Map(catalog.entries.map((e) => [e.id, e]));
const changes = [];
for (const [id, t] of Object.entries(types)) {
  const e = byId.get(id);
  if (!e) { console.warn(`types.json: ${id} is not in catalog.json`); continue; }
  for (const k of ['category', 'modType']) {
    if (t[k] === undefined || e[k] === t[k]) continue;
    changes.push(`${id}: ${k} ${e[k] ?? '-'} -> ${t[k]}`);
    e[k] = t[k];
  }
}
for (const c of changes) console.log(c);
if (check) process.exit(changes.length ? 1 : 0);
if (changes.length) fs.writeFileSync(file, JSON.stringify(catalog, null, 1) + '\n');
console.log(`${changes.length} change(s)`);
