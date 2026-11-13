// Catalog for public builds: catalog.json without the entries release-policy.json hides (and their mentions in
// collections, pictures, modLinks and showcases), so a public launcher does not even carry their URLs.
// The launcher's vite config writes it (generated/catalog.public.json) and imports it instead of catalog.json;
// apps/launcher/src-tauri/build.rs embeds the same file. What the launcher shows does not change: the runtime
// policy (apps/launcher/src/data/releasePolicy.ts) hides exactly these entries anyway.
//   node packages/catalog/public-catalog.mjs   writes generated/catalog.public.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_CATALOG = path.join(here, 'generated', 'catalog.public.json');
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

export function publicCatalog(catalog, policy) {
  const hidden = new Set([...Object.keys(policy.hide ?? {}), ...(policy.removed ?? [])]);
  const gone = new Set();
  for (const e of catalog.entries) if (hidden.has(e.id)) { gone.add(norm(e.id)); gone.add(norm(e.name)); }
  for (const id of hidden) gone.add(norm(id));
  const keep = (it) => !gone.has(norm(it.mod));
  return {
    ...catalog,
    collections: (catalog.collections ?? []).map((c) => ({ ...c, entries: c.entries.filter((id) => !hidden.has(id)) })),
    pictures: (catalog.pictures ?? []).filter(keep),
    modLinks: (catalog.modLinks ?? []).filter(keep),
    showcases: (catalog.showcases ?? []).filter(keep),
    entries: catalog.entries.filter((e) => !hidden.has(e.id)),
  };
}

/** Writes generated/catalog.public.json from catalog.json and release-policy.json; returns its path. */
export function writePublicCatalog() {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(here, f), 'utf8'));
  fs.mkdirSync(path.dirname(PUBLIC_CATALOG), { recursive: true });
  fs.writeFileSync(PUBLIC_CATALOG, JSON.stringify(publicCatalog(read('catalog.json'), read('release-policy.json')), null, 1) + '\n');
  return PUBLIC_CATALOG;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(writePublicCatalog());
