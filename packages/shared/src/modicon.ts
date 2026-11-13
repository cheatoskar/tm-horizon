// Default mod icons, shared by the website (components/Thumb.astro) and the launcher (ui/GenIcon.tsx):
// a mod without its own logo gets a generated tile = gradient from a fixed colour pair (picked by a hash
// of the mod id), speed stripes and a Lucide glyph for its type or category. One source, so a mod looks
// the same on the website and in the launcher. Glyph names are Lucide's kebab-case names.

/** FNV-1a over the seed (the mod or entry id). */
export const iconHash = (s: string): number => {
  let h = 2166136261;
  for (const c of String(s ?? 'x')) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
};
/** Two colours for a generated icon, from a fixed set that sits well on the asphalt theme. */
export const ICON_PAIRS: readonly (readonly [string, string])[] = [
  ['#ff7a2f', '#c2361b'], ['#3fb6ff', '#2457d6'], ['#9b6bff', '#5b2fd6'], ['#2fd39a', '#0f8a6b'],
  ['#ffc53d', '#e0751a'], ['#ff5c8a', '#b0245a'], ['#5ee0e6', '#1c7fa6'], ['#c4e04a', '#5a9a1c'],
];
export const iconPair = (seed: string) => ICON_PAIRS[iconHash(seed) % ICON_PAIRS.length];
/** Angle of the speed stripes (20..50 degrees). */
export const iconAngle = (seed: string) => 20 + (iconHash(seed) % 4) * 10;

/** Hub mod categories (packages/api mods.json `category`). */
export const MOD_CAT_ICONS: Record<string, string> = {
  graphics: 'palette', HUD: 'gauge', tools: 'wrench', TAS: 'timer', editor: 'pencil-ruler', competition: 'trophy', VR: 'glasses',
  library: 'package', platform: 'boxes', presence: 'radio', gameplay: 'flag',
};
/** Catalog categories (catalog.json `category`). */
export const CATALOG_CAT_ICONS: Record<string, string> = {
  exchange: 'map', mod: 'puzzle', tool: 'wrench', skins: 'paint-bucket', leaderboard: 'medal', servers: 'server',
  community: 'users', docs: 'book-open', events: 'calendar-days',
};
/** Catalog mod types (catalog.json `modType`; the Openplanet entry counts as "platform"). */
export const MOD_TYPE_ICONS: Record<string, string> = {
  interface: 'layout-dashboard', sound: 'volume-2', block: 'box', skin: 'paint-bucket', texturepack: 'layers', blockskin: 'paint-bucket', standalone: 'package',
  fix: 'wrench', music: 'music', vehicle: 'car', medals: 'medal', utility: 'wrench', graphics: 'palette', hud: 'gauge', platform: 'boxes', mod: 'puzzle',
  // Types from the 2026-11-11 reclassification (packages/catalog/types.json).
  tas: 'timer', editor: 'pencil-ruler', server: 'server', library: 'package', plugin: 'plug-zap', docs: 'book-open', ai: 'bot', environment: 'mountain', gameplay: 'flag',
};
/** Hub project types (hub.ts HUB_PROJECT_TYPES), shown next to the type choice in the portal. Not part of ICON_GLYPHS. */
export const PROJECT_TYPE_ICONS: Record<string, string> = {
  mod: 'puzzle', skin: 'paint-bucket', 'texture-pack': 'layers', 'sound-pack': 'volume-2', maps: 'map', 'openplanet-plugin': 'plug-zap', 'tmi-plugin': 'braces',
  tool: 'wrench', tas: 'timer', editor: 'pencil-ruler', server: 'server', library: 'package', 'browser-extension': 'globe', docs: 'book-open', community: 'users', event: 'calendar-days', content: 'layers',
};
export const modTypeIcon = (id: string) => MOD_TYPE_ICONS[id] ?? 'puzzle';
/** Type of a catalog mod entry for its icon: the Openplanet loader is a platform, else its modType. */
export const entryModType = (e: { id: string; modType?: string | null }) => (e.id === 'openplanet' ? 'platform' : e.modType ?? 'mod');

/** Every glyph name the mappings above use (the launcher imports exactly these from lucide-react). */
export const ICON_GLYPHS = [...new Set([...Object.values(MOD_CAT_ICONS), ...Object.values(CATALOG_CAT_ICONS), ...Object.values(MOD_TYPE_ICONS)])];
