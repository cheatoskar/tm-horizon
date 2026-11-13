// Every title. Art: gameArt() below (IGDB and Steam through our /ext-img proxy, our own covers, or local preview files).
import { igdbCoverPath } from '@tm-hub/shared/covers';
export type ModSystem = 'TMLoader' | 'Openplanet' | 'none';
export interface Game {
  id: string;
  name: string;
  short: string;
  year: string;
  family: string;
  steam?: number;
  modSystem: ModSystem;
  price: string;
  get: string;
  exchange: { label: string; url: string } | null;
  stores: { label: string; url: string }[];
  note: string;
  envs: string;
}

const steamStore = (id: number) => ({ label: 'Steam', url: `https://store.steampowered.com/app/${id}/` });

export const games: Game[] = [
  { id: 'tmnf', name: 'TrackMania Nations Forever', short: 'TMNF', year: '2008', family: 'Forever', steam: 11020, modSystem: 'TMLoader', price: 'Free',
    get: 'Free on Steam and the official site.', exchange: { label: 'TMNF-X', url: 'https://tmnf.exchange/' },
    stores: [steamStore(11020), { label: 'Official site', url: 'https://www.trackmaniaforever.com/' }],
    note: 'Stadium only, and still the busiest Forever game: TMNF-X, TMInterface, TMUnlimiter and most TMLoader mods.', envs: 'Stadium' },
  { id: 'tmuf', name: 'TrackMania United Forever', short: 'TMUF', year: '2008', family: 'Forever', steam: 7200, modSystem: 'TMLoader', price: 'Paid',
    get: 'Steam or the official site. Upgrade from Nations Forever is possible.', exchange: { label: 'TMUF-X', url: 'https://tmuf.exchange/' },
    stores: [steamStore(7200), { label: 'Official site', url: 'https://www.trackmaniaforever.com/' }],
    note: 'All seven environments. Runs the same TMLoader mods as Nations Forever.', envs: 'Stadium, Island, Bay, Coast, Desert, Rally, Snow' },
  { id: 'tm2-stadium', name: 'TrackMania² Stadium', short: 'TM² Stadium', year: '2013', family: 'ManiaPlanet', steam: 232910, modSystem: 'Openplanet', price: 'Paid',
    get: 'Steam or the ManiaPlanet launcher.', exchange: { label: 'TM²X', url: 'https://tm.mania.exchange/' },
    stores: [steamStore(232910), { label: 'ManiaPlanet', url: 'https://www.maniaplanet.com/' }],
    note: 'Stadium on ManiaPlanet. Plugins through Openplanet; TM Vibrant Shaders runs here with its own setup.', envs: 'Stadium' },
  { id: 'tm2-canyon', name: 'TrackMania² Canyon', short: 'TM² Canyon', year: '2011', family: 'ManiaPlanet', steam: 228760, modSystem: 'Openplanet', price: 'Paid',
    get: 'Steam or the ManiaPlanet launcher.', exchange: { label: 'TM²X', url: 'https://tm.mania.exchange/' },
    stores: [steamStore(228760), { label: 'ManiaPlanet', url: 'https://www.maniaplanet.com/' }],
    note: 'The first ManiaPlanet title: drifts, long jumps, sunset canyons.', envs: 'Canyon' },
  { id: 'tm2-valley', name: 'TrackMania² Valley', short: 'TM² Valley', year: '2013', family: 'ManiaPlanet', steam: 243360, modSystem: 'Openplanet', price: 'Paid',
    get: 'Steam or the ManiaPlanet launcher.', exchange: { label: 'TM²X', url: 'https://tm.mania.exchange/' },
    stores: [steamStore(243360), { label: 'ManiaPlanet', url: 'https://www.maniaplanet.com/' }],
    note: 'Rally car through countryside, forests and towns.', envs: 'Valley' },
  { id: 'tm2-lagoon', name: 'TrackMania² Lagoon', short: 'TM² Lagoon', year: '2017', family: 'ManiaPlanet', steam: 600720, modSystem: 'Openplanet', price: 'Paid',
    get: 'Steam or the ManiaPlanet launcher.', exchange: { label: 'TM²X', url: 'https://tm.mania.exchange/' },
    stores: [steamStore(600720), { label: 'ManiaPlanet', url: 'https://www.maniaplanet.com/' }],
    note: 'Tropical island, wall-ride roads and loops.', envs: 'Lagoon' },
  { id: 'sm-storm', name: 'ShootMania Storm', short: 'SM Storm', year: '2013', family: 'ManiaPlanet', steam: 229870, modSystem: 'Openplanet', price: 'Paid',
    get: 'Steam or the ManiaPlanet launcher.', exchange: { label: 'SMX', url: 'https://sm.mania.exchange/' },
    stores: [steamStore(229870), { label: 'ManiaPlanet', url: 'https://www.maniaplanet.com/' }],
    note: 'The shooter on ManiaPlanet. Shares title packs and server tools with TrackMania².', envs: 'Storm' },
  { id: 'turbo', name: 'Trackmania Turbo', short: 'Turbo', year: '2016', family: 'Turbo', steam: 375900, modSystem: 'none', price: 'Paid',
    get: 'Steam and Ubisoft Store.', exchange: null,
    stores: [steamStore(375900)],
    note: 'Four environments, split screen, no mod system. Maps are shared inside the game.', envs: 'Canyon Grand Drift, Valley Down & Dirty, Lagoon Rollercoaster, International Stadium' },
  { id: 'tm2020', name: 'Trackmania', short: 'TM 2020', year: '2020', family: 'Trackmania', steam: 2225070, modSystem: 'Openplanet', price: 'Free to play',
    get: 'Free starter access; club access is paid. Ubisoft Connect, Steam, Epic.', exchange: { label: 'TMX', url: 'https://trackmania.exchange/' },
    stores: [steamStore(2225070), { label: 'Official site', url: 'https://www.trackmania.com/' }],
    note: 'The current game. Plugins through Openplanet (openplanet.dev).', envs: 'Stadium, with snow, rally and desert cars' },
  { id: 'eswc', name: 'TrackMania Nations ESWC', short: 'ESWC', year: '2006', family: 'First generation', modSystem: 'none', price: 'Was free',
    get: 'Was a free download, not sold any more. Archives only.', exchange: { label: 'TMN-X', url: 'https://nations.tm-exchange.com/' },
    stores: [],
    note: 'The free predecessor of Nations Forever, made for the Electronic Sports World Cup.', envs: 'Stadium' },
  { id: 'tms', name: 'TrackMania Sunrise', short: 'Sunrise', year: '2005', family: 'First generation', modSystem: 'none', price: 'Not sold',
    get: 'Not sold any more. Old retail discs and archives only.', exchange: { label: 'TMS-X', url: 'https://sunrise.tm-exchange.com/' },
    stores: [],
    note: 'Island, Bay and Coast; brought the platform and crazy modes.', envs: 'Island, Bay, Coast' },
  { id: 'tmo', name: 'TrackMania Original', short: 'Original', year: '2003', family: 'First generation', modSystem: 'none', price: 'Not sold',
    get: 'Not sold any more. Old retail discs and archives only.', exchange: { label: 'TMO-X', url: 'https://original.tm-exchange.com/' },
    stores: [],
    note: 'Where it started: Desert, Rally and Snow.', envs: 'Desert, Rally, Snow' },
  { id: 'tm-ds', name: 'TrackMania DS', short: 'TM DS', year: '2008', family: 'Consoles', modSystem: 'none', price: 'Not sold',
    get: 'Not sold any more. Bring your own copy; it runs in an emulator (melonDS) through TM Horizon.', exchange: null,
    stores: [],
    note: 'The Nintendo DS game. No mods; TM Horizon starts it in melonDS from your own cartridge copy.', envs: '-' },
  { id: 'tm-turbo-ds', name: 'TrackMania Turbo (DS)', short: 'Turbo DS', year: '2010', family: 'Consoles', modSystem: 'none', price: 'Not sold',
    get: 'Not sold any more. Bring your own copy; it runs in an emulator (melonDS) through TM Horizon.', exchange: null,
    stores: [],
    note: 'The second Nintendo DS game. No mods; TM Horizon starts it in melonDS from your own cartridge copy.', envs: '-' },
  { id: 'tm-wii', name: 'TrackMania Wii', short: 'TM Wii', year: '2010', family: 'Consoles', modSystem: 'none', price: 'Not sold',
    get: 'Not sold any more. Bring your own copy; it runs in an emulator (Dolphin) through TM Horizon.', exchange: null,
    stores: [],
    note: 'The Wii game (Build to Race). No mods; TM Horizon starts it in Dolphin from your own disc copy.', envs: '-' },
];

export const gameById: Record<string, Game> = Object.fromEntries(games.map((g) => [g.id, g]));
export const gameName = (id: string) => gameById[id]?.short ?? id;
// ------------------------------------------------------------------ game art
// Visitors' browsers never load pictures from third parties (their IP would go to Valve/IGDB without
// consent). Official art is referenced same-origin as /ext-img/...; nginx on our server fetches it from
// an allowlist (images.igdb.com, cdn.cloudflare.steamstatic.com) and caches it (apps/web/deploy/ext-img.conf).
// Order: own screenshot cover (public/img/covers-own, apps/launcher/tools/make-own-covers.py) > IGDB cover
// (one 3:4 source for every game, packages/shared/src/covers.ts) > Steam > our designed SVG covers.
// Where /ext-img is not served (astro dev, a plain static preview) the pictures fall back to our own covers
// in the browser (src/layouts/Layout.astro). Local preview builds may still use fetched files in
// public/img/games (scripts/fetch-game-art.py); the public build never does.
import fs from 'node:fs';
export const PUBLIC_BUILD = process.env.TMHUB_PUBLIC_BUILD === '1';
type ArtKind = 'cover' | 'hero' | 'logo' | 'header';
const STEAM_FILE: Record<ArtKind, string> = { cover: 'library_600x900.jpg', hero: 'library_hero.jpg', logo: 'logo.png', header: 'header.jpg' };
/** Pixel size of each kind (Steam library asset sizes; our covers use the same). IGDB covers are 3:4 (600x800). */
export const ART_SIZE: Record<ArtKind, { w: number; h: number }> = { cover: { w: 600, h: 900 }, hero: { w: 1920, h: 620 }, logo: { w: 640, h: 360 }, header: { w: 460, h: 215 } };
const exists = (f: string) => { try { return fs.existsSync(f); } catch { return false; } };
const localFile = (id: string, kind: ArtKind) => {
  if (PUBLIC_BUILD) return null;
  const f = `${id}-${kind}.webp`;
  return exists(`public/img/games/${f}`) ? `/img/games/${f}` : null;
};
/** Own screenshot cover/hero (my own work), when composed into public/img/covers-own. */
const ownShot = (id: string, kind: ArtKind) => (kind === 'cover' || kind === 'hero') && exists(`public/img/covers-own/${id}-${kind}.jpg`) ? `/img/covers-own/${id}-${kind}.jpg` : null;
const ownArt = (id: string, kind: ArtKind) => (kind === 'logo' ? null : `/img/covers/${id}-${kind === 'cover' ? 'cover' : 'hero'}.svg`);
/** Same-origin proxy paths (nginx allowlist): /ext-img/igdb/<image>.<ext> and /ext-img/steam/<appid>/<file>. */
const igdbArt = (id: string) => { const p = igdbCoverPath(id); return p && /^t_[a-z0-9_]+\/[a-z0-9]+\.(webp|jpg|png)$/.test(p) ? `/ext-img/igdb/${p.slice(p.indexOf('/') + 1)}` : null; };
const steamArt = (appId: number, kind: ArtKind) => `/ext-img/steam/${appId}/${STEAM_FILE[kind]}`;
/** Picture of a game: own screenshot > local preview file > IGDB (covers) > Steam > our own cover. Logos exist only for Steam titles. */
export function gameArt(id: string, kind: ArtKind): string | null {
  const g = gameById[id];
  if (!g) return null;
  const own = ownShot(id, kind);
  if (own) return own;
  const local = localFile(id, kind);
  if (local) return local;
  if (kind === 'cover') { const i = igdbArt(id); if (i) return i; }
  if (g.steam) return steamArt(g.steam, kind);
  return ownArt(id, kind);
}
export const hasSteamArt = (id: string) => !!gameById[id]?.steam;
/** Our own design is the cover (no official one): pages show it as it is instead of blurring a box scan. */
export const isOwnCover = (id: string) => !!gameById[id] && !!gameArt(id, 'cover')?.startsWith('/img/covers');
export const cover = (id: string) => gameArt(id, 'cover') ?? '/img/covers/eswc-cover.svg';
export const hero = (id: string) => gameArt(id, 'hero');
export const logo = (id: string) => (hasSteamArt(id) ? gameArt(id, 'logo') : null);
export const header = (id: string) => gameArt(id, 'header');
/** Release order, used for chips and facets. */
export const gameOrder = ['tmo', 'tms', 'eswc', 'tmnf', 'tmuf', 'tm2-canyon', 'tm2-stadium', 'tm2-valley', 'tm2-lagoon', 'sm-storm', 'tm-ds', 'tm-turbo-ds', 'tm-wii', 'turbo', 'tm2020'];
export const byOrder = (a: string, b: string) => gameOrder.indexOf(a) - gameOrder.indexOf(b);
