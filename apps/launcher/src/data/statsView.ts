// Pure helpers of the Statistics page (unit-tested in statsView.test.ts): the map table's filter and
// sort, the copy filter's choices and the TMX picture addresses of a map.

/** A search for the map table set by another page (the .Gbx dialog's "Statistics"); read once. */
export const statsIntent = { q: '' };

/** TM Horizon's image proxy (the hub's /ext-img/; apps/web/deploy/ext-img.conf, packages/shared/src/extimg.ts). */
export const EXT_IMG = 'https://hub.tm-horizon.com/ext-img/';

/** Exchange hosts the proxy serves track pictures of, by its site code. */
const TMX_SITES: Record<string, string> = {
  'tmnf.exchange': 'tmnf',
  'tmuf.exchange': 'tmuf',
  'nations.tm-exchange.com': 'nations',
  'sunrise.tm-exchange.com': 'sunrise',
  'original.tm-exchange.com': 'original',
};

/** The track thumbnail through the proxy (the player's address never reaches TMX), or null for another host. */
export function tmxThumbProxy(site: string | null | undefined, trackId: number | null | undefined): string | null {
  const code = site ? TMX_SITES[site.toLowerCase()] : undefined;
  if (!code || !trackId || !Number.isInteger(trackId) || trackId <= 0 || trackId > 999_999_999) return null;
  return `${EXT_IMG}tmx/${code}/${trackId}/thumbnail`;
}

/** Mania Exchange (ManiaPlanet) and Trackmania Exchange (2020): no proxy, pictures at /mapthumb/<id>. */
const MX_SITES = new Set(['tm.mania.exchange', 'trackmania.exchange']);

/** The same picture straight from the exchange (TMX when the proxy does not answer; MX always). */
export function tmxThumbDirect(site: string | null | undefined, trackId: number | null | undefined): string | null {
  const host = site?.toLowerCase();
  if (!host || !trackId || !Number.isInteger(trackId) || trackId <= 0) return null;
  if (MX_SITES.has(host)) return `https://${host}/mapthumb/${trackId}`;
  if (!TMX_SITES[host]) return null;
  return `https://${host}/trackshow/${trackId}/thumbnail`;
}

/** The map's page on its exchange. */
export function tmxPage(site: string | null | undefined, trackId: number | null | undefined): string | null {
  const host = site?.toLowerCase();
  if (!host || !trackId || trackId <= 0 || !(MX_SITES.has(host) || TMX_SITES[host])) return null;
  return MX_SITES.has(host) ? `https://${host}/mapshow/${trackId}` : `https://${host}/trackshow/${trackId}`;
}

export interface MapRowLike {
  family: string; uid: string; name: string; env: string | null; runs: number; bestMs: number | null; bestRespawns: number | null;
  lastAt: number; finishes: number | null; starts: number | null; hostBestMs: number | null; cleanRuns?: number; cleanBestMs?: number | null;
}

export type SortKey = 'name' | 'runs' | 'bestMs' | 'bestRespawns' | 'finishes' | 'starts' | 'lastAt';

export interface TableView { fam: string; q: string; clean: boolean; sort: { key: SortKey; desc: boolean } }

/** Best time shown for a row: with "No respawns only" the best run without a respawn. */
export const shownBest = (m: MapRowLike, clean: boolean): number | null => (clean ? m.cleanBestMs ?? null : m.bestMs ?? m.hostBestMs);

/** The table's rows: game, search text (format codes already stripped by `plain`), "No respawns only", sort. */
export function tableRows<T extends MapRowLike>(maps: T[], v: TableView, plain: (s: string) => string = (s) => s): T[] {
  const ql = v.q.trim().toLowerCase();
  const list = maps.filter((m) => (!v.fam || m.family === v.fam)
    && (!ql || plain(m.name).toLowerCase().includes(ql) || (m.env ?? '').toLowerCase().includes(ql))
    && (!v.clean || (m.cleanRuns ?? 0) > 0));
  const val = (m: T): string | number => {
    switch (v.sort.key) {
      case 'name': return plain(m.name).toLowerCase();
      case 'bestMs': return shownBest(m, v.clean) ?? Infinity;
      // Rows without a known respawn count go last in both directions.
      case 'bestRespawns': return m.bestRespawns ?? (v.sort.desc ? -Infinity : Infinity);
      default: return m[v.sort.key] ?? -1;
    }
  };
  return [...list].sort((a, b) => { const x = val(a), y = val(b); const c = x < y ? -1 : x > y ? 1 : 0; return v.sort.desc ? -c : c; });
}

/** First click on a column: numbers high to low, names A-Z, times and respawns low to high. */
export const firstDesc = (key: SortKey) => key !== 'name' && key !== 'bestMs' && key !== 'bestRespawns';

export interface CopyLike { id: string; family: string; label: string; path: string }

/** Choices of the copy filter for the chosen game (all games: every copy); empty when there is nothing to choose. */
export function copyChoices<T extends CopyLike>(copies: T[], fam: string): T[] {
  const list = copies.filter((c) => !fam || c.family === fam);
  // One copy per game is no choice; with no game picked, a choice only when some game has two.
  const perFam = new Map<string, number>();
  for (const c of list) perFam.set(c.family, (perFam.get(c.family) ?? 0) + 1);
  return [...perFam.values()].some((n) => n > 1) ? list : [];
}
