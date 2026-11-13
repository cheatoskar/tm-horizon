// The bundled catalog (packages/catalog/catalog.json) as a lookup for the hub: which catalog entry a
// repository belongs to, and the seed showcases (packages/catalog/showcases/*.json) a project can adopt.
// Read once per process; a missing or broken file means "no catalog" (never an error).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { CatalogEntry } from '@tm-hub/shared';
import { cleanShowcase, type Showcase } from '@tm-hub/shared/showcase';
import type { ProjectsTable } from '../db/db.ts';

interface Seed { mod: string; showcase: unknown; text: string }
let cached: { entries: CatalogEntry[]; seeds: Seed[] } | null = null;

function load() {
  if (cached) return cached;
  try {
    const file = createRequire(import.meta.url).resolve('@tm-hub/catalog/catalog.json');
    const j = JSON.parse(readFileSync(file, 'utf8')) as { entries?: CatalogEntry[]; showcases?: { mod: string; showcase: unknown }[] };
    cached = { entries: j.entries ?? [], seeds: (j.showcases ?? []).map((s) => ({ ...s, text: JSON.stringify(s.showcase).toLowerCase() })) };
  } catch {
    cached = { entries: [], seeds: [] };
  }
  return cached;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
/** "owner/repo" of a GitHub link anywhere in the text, or null. */
export function repoIn(text: string | null | undefined): string | null {
  const m = /github(?:usercontent)?\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?(?=[/?#"\s]|$)/i.exec(text ?? '');
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}
const mentionsRepo = (text: string, repo: string) => {
  const r = repo.toLowerCase();
  return [`github.com/${r}/`, `github.com/${r}"`, `raw.githubusercontent.com/${r}/`].some((n) => text.includes(n));
};

/** Catalog entry whose link is this GitHub repository. */
export function catalogEntryForRepo(fullName: string): CatalogEntry | null {
  const r = fullName.toLowerCase();
  return load().entries.find((e) => repoIn(e.url) === r || repoIn(e.installSpec?.download.github ? `github.com/${e.installSpec.download.github}` : null) === r) ?? null;
}
export const catalogEntryById = (id: string | null | undefined): CatalogEntry | null => (id ? load().entries.find((e) => e.id === id) ?? null : null);

/** Seed showcase for a mod: by catalog id / name / slug, or by its repository (the seed's pictures and links point there). */
export function seedShowcase(keys: (string | null | undefined)[], repo: string | null): Showcase | null {
  const want = new Set(keys.filter((k): k is string => !!k).map(norm).filter(Boolean));
  const seed = load().seeds.find((s) => want.has(norm(s.mod))) ?? (repo ? load().seeds.find((s) => mentionsRepo(s.text, repo)) : undefined);
  return seed ? cleanShowcase(seed.showcase) : null;
}

/** Seed showcase of a hub project (catalog id, name, slug, repository from its source link or links). */
export function seedShowcaseFor(p: Pick<ProjectsTable, 'catalog_id' | 'name' | 'slug' | 'source_url' | 'links'>): Showcase | null {
  const entry = catalogEntryById(p.catalog_id);
  return seedShowcase([p.catalog_id, p.name, p.slug, entry?.name], repoIn(p.source_url) ?? repoIn(p.links));
}
