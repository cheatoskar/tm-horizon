// Passthrough of the researched catalog (packages/catalog/catalog.json), normalised:
// known keys only, unknown games dropped, empty strings to null, GitHub repository named.
// Entries without a URL are kept only when their file lives in a Discord post (hosting "discord-attachment").
import fs from 'node:fs';
import type { CatalogCategory, CatalogCollection, CatalogEntry, CatalogGameId, SourceStatus } from '../types.ts';
import type { SourceContext } from '../config.ts';
import { resolveFrom } from '../config.ts';
import { errorText, isGameId } from '../lib/util.ts';
import { cleanRelatedLinks } from '@tm-hub/shared/links';
import { githubRepoFromUrl } from './github.ts';

const CATEGORIES: CatalogCategory[] = ['exchange', 'mod', 'tool', 'skins', 'leaderboard', 'tas-plugin', 'servers', 'community', 'docs', 'events', 'environment'];
const STATUSES = ['alive', 'dead', 'unclear'] as const;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter((x): x is string => !!x) : []);
const CATALOG_ONLY_GAMES = ['tm1', 'tmsx', 'tmu2006'];
const isCatalogGame = (g: unknown): g is CatalogGameId => isGameId(g) || (typeof g === 'string' && CATALOG_ONLY_GAMES.includes(g));

export function normaliseCatalog(raw: unknown): { updated: string | null; entries: CatalogEntry[]; dropped: number; collections: CatalogCollection[] } {
  const doc = raw as { updated?: unknown; entries?: unknown; collections?: unknown };
  if (!doc || !Array.isArray(doc.entries)) throw new Error('catalog has no "entries" array');
  const seen = new Set<string>();
  const entries: CatalogEntry[] = [];
  let dropped = 0;
  for (const e of doc.entries as Record<string, unknown>[]) {
    const id = str(e.id);
    const name = str(e.name);
    const url = str(e.url);
    const category = str(e.category) as CatalogCategory | null;
    const hosting = str(e.hosting);
    if (!id || !name || (!url && hosting !== 'discord-attachment' && hosting !== 'pending') || !category || !CATEGORIES.includes(category) || seen.has(id)) {
      dropped++;
      continue;
    }
    seen.add(id);
    const status = str(e.status);
    const api = str(e.api);
    entries.push({
      id,
      name,
      category,
      games: Array.isArray(e.games) ? e.games.filter(isCatalogGame) : [],
      url,
      api,
      description: str(e.description),
      maintainer: str(e.maintainer),
      language: str(e.language),
      status: (STATUSES as readonly string[]).includes(status ?? '') ? (status as CatalogEntry['status']) : 'unclear',
      checked: str(e.checked),
      launcher: str(e.launcher),
      archive: str(e.archive),
      github: githubRepoFromUrl(url) ?? githubRepoFromUrl(api),
      ...(cleanRelatedLinks(e.links).length ? { links: cleanRelatedLinks(e.links) } : {}),
      ...(e.modType !== undefined || hosting
        ? {
            author: str(e.author),
            modType: str(e.modType),
            install: str(e.install),
            requires: strs(e.requires),
            hosting,
            urls: strs(e.urls),
            note: str(e.note),
            ...(e.installSpec !== undefined ? { installSpec: (e.installSpec as CatalogEntry['installSpec']) ?? null, downloadNote: str(e.downloadNote) } : {}),
          }
        : {}),
    });
  }
  const collections: CatalogCollection[] = [];
  for (const c of Array.isArray(doc.collections) ? (doc.collections as Record<string, unknown>[]) : []) {
    const id = str(c.id);
    const name = str(c.name);
    const ids = strs(c.entries);
    if (id && name && ids.length) collections.push({ id, name, ...(str(c.description) ? { description: str(c.description)! } : {}), entries: ids });
  }
  return { updated: str(doc.updated), entries, dropped, collections };
}

export async function buildCatalog(ctx: SourceContext): Promise<{ updated: string | null; entries: CatalogEntry[]; collections?: CatalogCollection[]; sources: SourceStatus[] }> {
  const cfg = ctx.config.catalog;
  const tryParse = (raw: unknown, id: string, cached = false) => {
    const c = normaliseCatalog(raw);
    if (c.dropped) ctx.warn(`catalog: ${c.dropped} entries without id/name/url/known category dropped`);
    return { updated: c.updated, entries: c.entries, collections: c.collections, sources: [{ id, ok: true, count: c.entries.length, sample: false, cached }] };
  };
  const errors: string[] = [];
  for (const p of cfg.paths) {
    const local = resolveFrom(ctx.root, p);
    if (!fs.existsSync(local)) continue;
    try {
      return tryParse(JSON.parse(fs.readFileSync(local, 'utf8')), 'catalog:file:' + p);
    } catch (e) {
      errors.push(`${p}: ${errorText(e)}`);
    }
  }
  if (cfg.url) {
    try {
      const { data, result } = await ctx.http.getJson<unknown>(cfg.url, { ttlMinutes: 30 });
      return tryParse(data, 'catalog:url', !!result.cache);
    } catch (e) {
      errors.push(`${cfg.url}: ${errorText(e)}`);
    }
  }
  const error = errors.join('; ') || 'no catalog path or url found';
  ctx.warn(`catalog: ${error}`);
  return { updated: null, entries: [], sources: [{ id: 'catalog', ok: false, count: 0, sample: false, error }] };
}
