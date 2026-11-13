// Related links of a mod ("Dazu gehört"): a companion page (bingo board, ...), docs, Discord, source,
// website. Sources, merged and validated (https, known kinds): the `links` of the catalog entry, and
// the catalog's `modLinks` list for TMLoader products (packages/catalog, MOD_LINKS in mods_seed.py).
import catalogJson from '@tm-hub/catalog/catalog.json';
import { cleanRelatedLinks, type RelatedLink } from '@tm-hub/shared/links';
import type { CatalogEntry } from '@tm-hub/shared';
import { backend, isNative } from './backend';
import { siteOfHost } from './sites';

export type { RelatedLink };

/** Community wiki for all TrackMania games. Always opened in the system browser (Cloudflare may block the embedded one). */
export const TM_WIKI = 'https://www.trackmania.wiki/';

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const ENTRIES = (catalogJson as unknown as { entries: (CatalogEntry & { links?: unknown })[] }).entries;
const MOD_LINKS = (catalogJson as unknown as { modLinks?: { mod: string; links: unknown }[] }).modLinks ?? [];

/** Links for a mod, found by any of its ids / names (TMLoader product name, catalog id, display name). */
export function relatedLinksOf(...keys: (string | null | undefined)[]): RelatedLink[] {
  const want = new Set(keys.filter((k): k is string => !!k).map(norm));
  if (!want.size) return [];
  const raw: unknown[] = [];
  for (const e of ENTRIES) if (e.links && (want.has(norm(e.id)) || want.has(norm(e.name)))) raw.push(...(e.links as unknown[]));
  for (const m of MOD_LINKS) if (want.has(norm(m.mod))) raw.push(...(m.links as unknown[]));
  return cleanRelatedLinks(raw);
}

export const companionOf = (links: RelatedLink[]): RelatedLink | undefined => links.find((l) => l.kind === 'companion');

/** The game the embedded browser should show a page for: this game if the site covers it, else the first installed one it covers. */
export function embeddedGameFor(url: string, game: string, installed: string[]): string | null {
  let host: string;
  try { host = new URL(url).hostname; } catch { return null; }
  const site = siteOfHost(host);
  if (!site) return null;
  if (site.games.includes(game)) return game;
  return site.games.find((g) => installed.includes(g)) ?? null;
}

/** Opens a related link: in the launcher's embedded browser when the site is one it lists (and the app is native), else in the system browser. */
export function openRelated(hub: { setPendingWeb: (v: { mode: 'maps'; game: string; url: string }) => void; games: { id: string; installed: boolean }[] }, go: (page: string, arg?: string) => void, link: RelatedLink, game: string) {
  const g = isNative ? embeddedGameFor(link.url, game, hub.games.filter((x) => x.installed).map((x) => x.id)) : null;
  if (g) {
    hub.setPendingWeb({ mode: 'maps', game: g, url: link.url });
    go('maps', `${g}@${new URL(link.url).hostname}`);
  } else backend.openExternal(link.url);
}
