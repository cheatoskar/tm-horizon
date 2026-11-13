// Official game covers from IGDB's image CDN: one source with one shape (3:4 box art) for every game.
// Picked and checked by hand (HTTP 200, image opened) on 2026-11-11. The CDN answers with png/jpeg
// content types whatever the extension says, so callers sniff the bytes instead of trusting ".webp".
// Order of use: IGDB cover, else Steam's library cover (600x900), else TM Horizon's own designed cover.
// Launcher: fetched once through the picture cache (cached_image) and kept offline.
// Website: never hotlinked; served same-origin through /ext-img/igdb/<image>.<ext> (apps/web/deploy/ext-img.conf).

export const IGDB_IMAGE_BASE = 'https://images.igdb.com/igdb/image/upload/';

/** IGDB image per game: `<size>/<image id>.<ext>` below IGDB_IMAGE_BASE. Keys are the website's game ids. */
export const IGDB_COVERS: Record<string, string> = {
  tmnf: 't_original/co1pa6.webp',
  tmuf: 't_original/co6kbb.webp',
  'tm2-stadium': 't_original/co6k7z.webp',
  'tm2-canyon': 't_original/co6k81.webp',
  'tm2-valley': 't_original/co6k82.webp',
  'tm2-lagoon': 't_original/co23ge.webp',
  turbo: 't_original/co1z4h.webp',
  tm2020: 't_original/cobh9g.webp',
  eswc: 't_original/co49ph.webp',
  tmo: 't_original/co6k83.webp', // TrackMania Original (2005)
  tms: 't_original/co1v1p.webp',
  // Launcher-only entries (not on the website yet). TrackMania Wii comes from GameTDB (GAMETDB_COVERS);
  // ShootMania Storm has no checked IGDB id yet and uses TM Horizon's own cover.
  'tm-2003': 't_cover_big_2x/co4vfw.jpg', // the first TrackMania (2003)
  'tm-united-2006': 't_cover_big_2x/co6kba.jpg', // TrackMania United (2006, not Forever): hint card on the TMUF page
  'tm-ds': 't_cover_big_2x/co3ggt.jpg', // TrackMania DS
  'tm-turbo-ds': 't_cover_big_2x/co3uxx.jpg', // TrackMania Turbo: Build to Race (DS, 2010)
};

/** Launcher game ids that differ from the website's. */
const LAUNCHER_TO_SITE: Record<string, string> = { 'tmn-eswc': 'eswc', 'tm-sunrise': 'tms', 'tm-original': 'tmo', 'tm-turbo': 'turbo' };

/** The IGDB path of a game (`t_original/co1pa6.webp`), by launcher or website id; null when there is none. */
export function igdbCoverPath(game: string): string | null {
  return IGDB_COVERS[LAUNCHER_TO_SITE[game] ?? game] ?? null;
}

/** Full IGDB URL of a game's cover (launcher, cached once), or null. */
export function igdbCoverUrl(game: string): string | null {
  const p = igdbCoverPath(game);
  return p ? IGDB_IMAGE_BASE + p : null;
}

/** Covers from GameTDB (art.gametdb.com) for console games IGDB has no checked cover for. Launcher only:
 * fetched once through the picture cache and kept (never hotlinked); credited "Cover: GameTDB" in Settings.
 * TrackMania Wii PAL (R6RPHH), checked 2026-11-12. */
export const GAMETDB_COVERS: Record<string, string> = {
  'tm-wii': 'https://art.gametdb.com/wii/cover/EN/R6RPHH.png',
};

/** The game's official cover URL: IGDB, else GameTDB; null when there is none. */
export function coverUrl(game: string): string | null {
  return igdbCoverUrl(game) ?? GAMETDB_COVERS[game] ?? null;
}

/** Where a wide crop of the IGDB cover sits (CSS object-position y in %, for a tile about twice as wide as
 * high, e.g. the launcher dashboard's game strip): the title logo, or for Trackmania (2020) the car, as its
 * cover has only a plain word as logo. Picked by eye on the covers above; games without an entry use 32. */
export const IGDB_COVER_FOCUS: Record<string, number> = {
  tmnf: 4,
  tmuf: 2,
  eswc: 27,
  'tm2-stadium': 2,
  'tm2-canyon': 9,
  tm2020: 66,
  tms: 4,
  tmo: 42,
};

/** object-position y (%) of a wide crop of the game's IGDB cover, by launcher or website id. */
export function igdbCoverFocus(game: string): number {
  return IGDB_COVER_FOCUS[LAUNCHER_TO_SITE[game] ?? game] ?? 32;
}
