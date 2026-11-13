import artJson from '../generated/art.json';
import type { Title } from './types';

// blurb is a message key (i18n); family labels are the keys family.<id>.
// Static facts about every TrackMania title the hub knows. Install state comes
// from the scanner snapshot; this file never claims a game is installed.
// Art: Steam library assets (local Steam cache first, then Steam CDN), see
// scanner/fetch-art.mjs and ART-SOURCES.md. Titles without a Steam page get a
// typographic tile.
const BASE: Title[] = [
  {
    id: 'tmnf', name: 'TrackMania Nations Forever', short: 'Nations Forever', family: 'forever', year: 2008, steamAppId: 11020,
    gradient: 'linear-gradient(135deg,#0b3d2e,#0a1a2f)', modSystem: 'TMLoader',
    store: { label: 'Steam', url: 'https://store.steampowered.com/app/11020/' },
    blurb: 'blurb.tmnf',
  },
  {
    id: 'tmuf', name: 'TrackMania United Forever', short: 'United Forever', family: 'forever', year: 2008, steamAppId: 7200,
    gradient: 'linear-gradient(135deg,#3b2a12,#0f1a2c)', modSystem: 'TMLoader',
    store: { label: 'Steam', url: 'https://store.steampowered.com/app/7200/' },
    blurb: 'blurb.tmuf',
  },
  {
    id: 'tmn-eswc', name: 'TrackMania Nations ESWC', short: 'Nations ESWC', family: 'eswc', year: 2006,
    gradient: 'radial-gradient(120% 90% at 50% 0%,#3a63c9 0%,#1b2f6b 40%,#0b1330 80%,#070a16 100%)', modSystem: 'None',
    blurb: 'blurb.eswc',
  },
  {
    id: 'tm2-stadium', name: 'TrackMania² Stadium', short: 'TM² Stadium', family: 'maniaplanet', year: 2013, steamAppId: 232910,
    gradient: 'linear-gradient(135deg,#1e5a3a,#0c1726)', modSystem: 'Openplanet', titleId: 'TMStadium@nadeo',
    store: { label: 'Steam', url: 'https://store.steampowered.com/app/232910/' },
    blurb: 'blurb.mp',
  },
  {
    id: 'tm2-canyon', name: 'TrackMania² Canyon', short: 'TM² Canyon', family: 'maniaplanet', year: 2011, steamAppId: 228760,
    gradient: 'linear-gradient(135deg,#b5532c,#140c0a)', modSystem: 'Openplanet', titleId: 'TMCanyon@nadeo',
    store: { label: 'Steam', url: 'https://store.steampowered.com/app/228760/' },
    blurb: 'blurb.mp',
  },
  {
    id: 'tm2-valley', name: 'TrackMania² Valley', short: 'TM² Valley', family: 'maniaplanet', year: 2013, steamAppId: 243360,
    gradient: 'linear-gradient(135deg,#3f7d3a,#0a140f)', modSystem: 'Openplanet', titleId: 'TMValley@nadeo',
    store: { label: 'Steam', url: 'https://store.steampowered.com/app/243360/' },
    blurb: 'blurb.mp',
  },
  {
    id: 'tm2-lagoon', name: 'TrackMania² Lagoon', short: 'TM² Lagoon', family: 'maniaplanet', year: 2017, steamAppId: 600720,
    gradient: 'linear-gradient(135deg,#1f86b8,#071420)', modSystem: 'Openplanet', titleId: 'TMLagoon@nadeo',
    store: { label: 'Steam', url: 'https://store.steampowered.com/app/600720/' },
    blurb: 'blurb.mp',
  },
  {
    id: 'sm-storm', name: 'ShootMania Storm', short: 'SM Storm', family: 'maniaplanet', year: 2013, steamAppId: 229870,
    gradient: 'linear-gradient(135deg,#5b2ea6,#0b0816)', modSystem: 'Openplanet', titleId: 'SMStorm@nadeo',
    store: { label: 'Steam', url: 'https://store.steampowered.com/app/229870/' },
    blurb: 'blurb.mp',
  },
  {
    id: 'tm2020', name: 'Trackmania', short: 'Trackmania', family: 'tm2020', year: 2020, steamAppId: 2225070,
    gradient: 'linear-gradient(135deg,#0f8f86,#060b14)', modSystem: 'Openplanet',
    store: { label: 'Steam', url: 'https://store.steampowered.com/app/2225070/' },
    blurb: 'blurb.tm2020',
  },
  {
    id: 'tm-turbo', name: 'Trackmania Turbo', short: 'Turbo', family: 'turbo', year: 2016, steamAppId: 375900,
    gradient: 'linear-gradient(135deg,#f5b700,#1a0f00)', modSystem: 'None',
    store: { label: 'Steam', url: 'https://store.steampowered.com/app/375900/' },
    blurb: 'blurb.turbo',
  },
  {
    id: 'tm-sunrise', name: 'TrackMania Sunrise', short: 'Sunrise', family: 'legacy', year: 2005,
    gradient: 'radial-gradient(120% 100% at 80% 0%,#ffcf5a 0%,#ff7a2f 30%,#7a1f3a 70%,#1a0812 100%)', modSystem: 'None',
    blurb: 'blurb.sunrise',
  },
  {
    id: 'tm-original', name: 'TrackMania Original', short: 'Original', family: 'legacy', year: 2005,
    gradient: 'radial-gradient(120% 100% at 20% 0%,#9ad0ff 0%,#3a76c4 35%,#16264d 75%,#080c18 100%)', modSystem: 'None',
    blurb: 'blurb.original',
  },
  {
    id: 'tm-2003', name: 'TrackMania (2003)', short: 'TrackMania 2003', family: 'classic', year: 2003,
    gradient: 'radial-gradient(120% 100% at 30% 0%,#e8c45a 0%,#a8642a 35%,#3a1f12 75%,#0d0806 100%)', modSystem: 'None',
    blurb: 'blurb.tm2003',
  },
  {
    id: 'tm-wii', name: 'TrackMania Wii', short: 'TM Wii', family: 'console', year: 2010,
    gradient: 'radial-gradient(120% 100% at 50% 0%,#bfe4ff 0%,#3b8fd6 35%,#12305a 75%,#060c18 100%)', modSystem: 'None',
    blurb: 'blurb.tmWii', console: { platform: 'wii', emulator: 'dolphin' },
  },
  {
    id: 'tm-ds', name: 'TrackMania DS', short: 'TM DS', family: 'console', year: 2008,
    gradient: 'radial-gradient(120% 100% at 50% 0%,#ffd27a 0%,#d6522e 35%,#4a1410 75%,#120606 100%)', modSystem: 'None',
    blurb: 'blurb.tmDs', console: { platform: 'ds', emulator: 'melonds' },
  },
  {
    id: 'tm-turbo-ds', name: 'TrackMania Turbo (DS)', short: 'Turbo DS', family: 'console', year: 2010,
    gradient: 'radial-gradient(120% 100% at 50% 0%,#c6f27a 0%,#3aa64a 35%,#123a1c 75%,#050f08 100%)', modSystem: 'None',
    blurb: 'blurb.tmTurboDs', console: { platform: 'ds', emulator: 'melonds' },
  },
];

type ArtEntry = { files: Record<string, { path: string; source: string }> };
const ART = (artJson as unknown as { titles: Record<string, ArtEntry> }).titles;

export const TITLES: Title[] = BASE.map((t) => {
  const a = ART[t.id]?.files;
  if (!a) return t;
  // Public build: no box covers (preview-only art, ART_CREDITS.md); GameArt falls back to the gradient tile.
  if (__PUBLIC_BUILD__) return { ...t, art: { hero: a.hero?.path, logo: a.logo?.path } };
  return { ...t, art: { cover: a.cover?.path, hero: a.hero?.path, logo: a.logo?.path } };
});

// Hand-picked categories for the mod browser facets (TMLoader indexes have none).
export const MOD_CATEGORIES: Record<string, string[]> = {
  TmForever: ['Game'],
  CoreMod: ['Library', 'Fixes'],
  TMUnlimiter: ['Editor'],
  TMInterface: ['TAS', 'Tools'],
  'Competition Patch': ['Competitive', 'Fixes'],
  CenterSpeed: ['HUD'],
  'TM Vibrant Shaders': ['Graphics', 'Video'],
  KimMod: ['Tools'],
  '100% TMX + Bingo': ['Community', 'HUD'],
  TMFOXR: ['VR', 'Graphics'],
  Twinkie: ['HUD', 'Tools'],
};
