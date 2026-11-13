// Sites the embedded browser can open, grouped by game in the site switcher. The host list matches
// SITES in src-tauri/src/web.rs (the native side only opens these). ManiaPark (skins and mods) has
// its own page because its downloads go into skin folders.
const TM2 = ['tm2-stadium', 'tm2-canyon', 'tm2-valley', 'tm2-lagoon'];
export const SKIN_GAMES = ['tmnf', 'tmuf', 'tm2-stadium', 'tm2-canyon', 'tm2-valley', 'tm2-lagoon', 'sm-storm', 'tm2020'];

export type SiteKind = 'maps' | 'items' | 'tas' | 'trial' | 'skins' | 'tools';
export interface Site { host: string; label: string; games: string[]; kind: SiteKind }

export const SITES: Site[] = [
  { host: 'tmnf.exchange', label: 'TMNF-X', games: ['tmnf'], kind: 'maps' },
  { host: 'tmuf.exchange', label: 'TMUF-X', games: ['tmuf'], kind: 'maps' },
  { host: 'nations.tm-exchange.com', label: 'TMN-X', games: ['tmn-eswc'], kind: 'maps' },
  { host: 'original.tm-exchange.com', label: 'TMO-X', games: ['tm-original'], kind: 'maps' },
  { host: 'sunrise.tm-exchange.com', label: 'TMS-X', games: ['tm-sunrise'], kind: 'maps' },
  { host: 'tm.mania.exchange', label: 'TM²-X', games: TM2, kind: 'maps' },
  { host: 'sm.mania.exchange', label: 'SM-X', games: ['sm-storm'], kind: 'maps' },
  { host: 'trackmania.exchange', label: 'TMX', games: ['tm2020'], kind: 'maps' },
  { host: 'item.exchange', label: 'Item Exchange', games: ['tm2020'], kind: 'items' },
  { host: 'item.mania.exchange', label: 'Item Exchange', games: [...TM2, 'sm-storm'], kind: 'items' },
  { host: 'tmtas.exchange', label: 'TMTAS Exchange', games: ['tmnf', 'tmuf', 'tm2020'], kind: 'tas' },
  { host: 'tmrpgtrial.com', label: 'TM RPG Trial', games: ['tm2020'], kind: 'trial' },
  { host: '100tmx.com', label: 'Map Inspector', games: ['tmnf', 'tmuf', 'tmn-eswc', 'tm-original', 'tm-sunrise'], kind: 'tools' },
  // gbx.tools itself is only a placeholder page; the tools live on subdomains (checked 2026-11-12).
  { host: 'explorer.gbx.tools', label: 'GBX Explorer', games: ['tmnf', 'tmuf', 'tmn-eswc', 'tm-original', 'tm-sunrise', ...TM2, 'sm-storm', 'tm2020'], kind: 'tools' },
  { host: '3d.gbx.tools', label: '3D viewer', games: ['tmnf', 'tmuf', 'tmn-eswc', 'tm-original', 'tm-sunrise', ...TM2, 'sm-storm', 'tm2020'], kind: 'tools' },
  { host: 'revalidate.gbx.tools', label: 'Revalidate', games: ['tmnf', 'tmuf', 'tmn-eswc', 'tm-original', 'tm-sunrise', ...TM2, 'sm-storm', 'tm2020'], kind: 'tools' },
  { host: 'nc.gbx.tools', label: 'Nations Converter', games: ['tmnf', 'tmuf', 'tm2020'], kind: 'tools' },
  { host: 'maniapark.com', label: 'ManiaPark', games: SKIN_GAMES, kind: 'skins' },
];

/** TAS-only sites (TMTAS Exchange, ...) show up in TAS mode only, and there they come first. */
export const tasOnly = (s: Site) => s.kind === 'tas';
export const sitesFor = (game: string, tas = false) =>
  SITES.filter((s) => s.games.includes(game) && (tas || !tasOnly(s))).sort((a, b) => (tas ? Number(tasOnly(b)) - Number(tasOnly(a)) : 0));
export const siteByHost = (host: string | undefined) => SITES.find((s) => s.host === host);
/** The listed site a page host belongs to (www. and other subdomains count), or undefined. */
export const siteOfHost = (h: string) => SITES.find((s) => h === s.host || h.endsWith('.' + s.host));

/** Groups of the site switcher: every site once, exchanges first, then tools, then community sites. */
export type SiteGroup = 'exchanges' | 'tools' | 'community';
export const SITE_GROUPS: SiteGroup[] = ['exchanges', 'tools', 'community'];
export const siteGroup = (s: Site): SiteGroup => (s.kind === 'maps' || s.kind === 'items' || s.kind === 'tas' ? 'exchanges' : s.kind === 'tools' ? 'tools' : 'community');
/** Sites of one group (TAS-only sites in TAS mode only, and first there). */
export const sitesIn = (g: SiteGroup, tas = false) =>
  SITES.filter((s) => siteGroup(s) === g && (tas || !tasOnly(s))).sort((a, b) => (tas ? Number(tasOnly(b)) - Number(tasOnly(a)) : 0));
