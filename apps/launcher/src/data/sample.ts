// SAMPLE DATA. Everything in this file is made up for the prototype and is shown
// with a "Sample" badge in the UI. Real sources are listed next to each block.
import type { Profile } from './types';

// Profiles for games without TMLoader (real ones come from TMLoader's database).
export const SAMPLE_PROFILES: Profile[] = [
  { id: 's:tm2-online', game: 'tm2-stadium', name: 'Online clean', mods: [], real: false },
  { id: 's:tm2-photos', game: 'tm2-stadium', name: 'Photos', mods: [{ id: 'TM Vibrant Shaders', version: null }], real: false },
  { id: 's:canyon-default', game: 'tm2-canyon', name: 'Default', mods: [], real: false },
  { id: 's:tm20-online', game: 'tm2020', name: 'Online clean', mods: [], real: false },
  { id: 's:tm20-training', game: 'tm2020', name: 'Training', mods: [{ id: 'op:split-speeds', version: null }, { id: 'op:ultimate-medals', version: null }], real: false },
  { id: 's:eswc-default', game: 'tmn-eswc', name: 'Default', mods: [], real: false },
];

// Openplanet plugins (real source: openplanet.dev plugin list; not fetched here).
export const SAMPLE_OP_PLUGINS = [
  { id: 'op:split-speeds', name: 'Split Speeds', author: 'sample', on: true, version: '1.6.0' },
  { id: 'op:ultimate-medals', name: 'Ultimate Medals', author: 'sample', on: true, version: '2.4.1' },
  { id: 'op:camera-tools', name: 'Camera Tools', author: 'sample', on: false, version: '0.9.2' },
  { id: 'op:map-info', name: 'Map Info', author: 'sample', on: true, version: '1.3.0' },
];

// Live and upcoming community events. Later: Discord scheduled events (bot) + TMX.
export interface HubEvent {
  id: string; name: string; game: string; host: string; startsInMin: number; live: boolean;
  players?: number; maxPlayers?: number; server: string; profile: string; join: string | null; art: string;
}
export const SAMPLE_EVENTS: HubEvent[] = [
  { id: 'e1', name: 'Sunday Stadium Cup', game: 'tmnf', host: 'Forever Racing League', startsInMin: 0, live: true, players: 48, maxPlayers: 64, server: 'frl_cup', profile: 'tml:default', join: 'tmtp://#join=frl_cup', art: 'news-2' },
  { id: 'e2', name: 'Night Lights Showcase', game: 'tmuf', host: 'Vibrant Shaders', startsInMin: 95, live: false, server: 'tmvs_night', profile: 'tml:default', join: 'tmtp://#join=tmvs_night', art: 'news-4' },
  { id: 'e3', name: 'ESWC Throwback', game: 'tmn-eswc', host: 'Old School TM', startsInMin: 26 * 60, live: false, server: '85.214.10.7:2350', profile: 's:eswc-default', join: 'tmtp:///#join=85.214.10.7:2350', art: 'news-3' },
  { id: 'e4', name: 'Stadium² Relay', game: 'tm2-stadium', host: 'TM² Stadium Club', startsInMin: 3 * 60 + 20, live: false, server: 'tm2_relay', profile: 's:tm2-online', join: 'maniaplanet://#join=tm2_relay@TMStadium@nadeo', art: 'news-1' },
];

export const SAMPLE_FRIENDS = [
  { name: 'Mirage', status: 'In United Forever', detail: 'Island Speed', state: 'game' as const },
  { name: 'kaz', status: 'In Nations Forever', detail: 'Sunday Stadium Cup', state: 'game' as const },
  { name: 'Lumen', status: 'Online', detail: 'Browsing mods', state: 'online' as const },
  { name: 'NoBrake', status: 'In Trackmania', detail: 'Track of the Day', state: 'game' as const },
  { name: 'pix', status: 'Online', detail: '', state: 'online' as const },
  { name: 'Tarmac', status: 'Away', detail: '12 min', state: 'away' as const },
  { name: 'orbit', status: 'Offline', detail: '2 d ago', state: 'offline' as const },
  { name: 'Veloce', status: 'Offline', detail: '5 d ago', state: 'offline' as const },
];

export const SAMPLE_NEWS = [
  { id: 'n1', tag: 'Mod update', title: 'TM Vibrant Shaders 1.4.2', text: 'Video export rebuilt, HDR10 and sound.', art: 'news-4', game: 'tmuf' },
  { id: 'n2', tag: 'Map pack', title: 'Aurora Stadium pack', text: '12 night maps for Nations.', art: 'news-2', game: 'tmnf' },
  { id: 'n3', tag: 'Community', title: 'Dirt cup is back', text: 'Signups open until Friday.', art: 'news-3', game: 'tmnf' },
];

// Discord communities. Later: a curated list or an invite directory.
export const SAMPLE_COMMUNITIES = [
  { name: 'Forever Racing League', game: 'tmnf', lang: 'EN', members: 4210, online: 386, text: 'Weekly cups and a league for Nations Forever.', color: '#ff8a3d' },
  { name: 'Old School TM', game: 'tmn-eswc', lang: 'EN', members: 870, online: 54, text: 'ESWC, Sunrise and Original. Patches and help.', color: '#7aa2ff' },
  { name: 'Vibrant Shaders', game: 'tmuf', lang: 'EN/DE', members: 1320, online: 140, text: 'Shader presets, photos and bug reports.', color: '#4fd1c5' },
  { name: 'TAS Workshop', game: 'tmnf', lang: 'EN', members: 2290, online: 210, text: 'TMInterface scripts, routes and tools.', color: '#c084fc' },
  { name: 'TM² Stadium Club', game: 'tm2-stadium', lang: 'EN', members: 1640, online: 92, text: 'Relay nights and map reviews for Stadium².', color: '#34d399' },
  { name: 'Canyon Drift Crew', game: 'tm2-canyon', lang: 'FR', members: 580, online: 31, text: 'Drift maps and a monthly cup.', color: '#f59e0b' },
  { name: 'Storm Arena', game: 'sm-storm', lang: 'EN', members: 940, online: 48, text: 'Elite and Royal pickups.', color: '#f472b6' },
  { name: 'Trackmania Deutsch', game: 'tm2020', lang: 'DE', members: 6120, online: 712, text: 'Deutschsprachige Community für alle Teile.', color: '#60a5fa' },
  { name: 'Map Makers Guild', game: 'tmuf', lang: 'EN', members: 3080, online: 260, text: 'Editor help, block tricks and feedback.', color: '#a3e635' },
];

export const SAMPLE_SKINS = [
  { id: 'sk1', name: 'Red Comet', author: 'Lumen', game: 'tmnf', kind: 'Car skin', size: '1.8 MB', art: 'skin-1', installed: true },
  { id: 'sk2', name: 'Pearl', author: 'pix', game: 'tmuf', kind: 'Car skin', size: '2.4 MB', art: 'skin-2', installed: false },
  { id: 'sk3', name: 'Silver Arrow', author: 'Veloce', game: 'tmuf', kind: 'Car skin', size: '2.1 MB', art: 'skin-3', installed: false },
  { id: 'sk4', name: 'Golden Hour', author: 'Mirage', game: 'tmn-eswc', kind: 'Car skin', size: '0.9 MB', art: 'skin-4', installed: false },
];
export const SAMPLE_PACKS = [
  { id: 'pk1', name: 'Clean Dirt', author: 'Tarmac', game: 'tmuf', kind: 'Texture pack', size: '38 MB', art: 'pack-1', installed: false },
  { id: 'pk2', name: 'Sand & Sun', author: 'kaz', game: 'tmnf', kind: 'Texture pack', size: '24 MB', art: 'pack-2', installed: true },
  { id: 'pk3', name: 'Neon Borders', author: 'orbit', game: 'tmnf', kind: 'Resource pack', size: '12 MB', art: 'pack-3', installed: false },
  { id: 'pk4', name: 'Storm Sky', author: 'NoBrake', game: 'tmuf', kind: 'Sky pack', size: '56 MB', art: 'pack-4', installed: false },
];

/** Installed skins and mods for the browser preview of the Skins page's "Installed" view (pages/SkinLibrary.tsx). */
export const SAMPLE_INSTALLED_SKINS: import('./backend').SkinItem[] = [
  ['Pearl Racer.zip', 'skin', 'CarCommon', 2_412_000, true, 'skin', 'q1'],
  ['Neon Stripes.zip', 'skin', 'CarCommon', 1_804_000, true, null, null],
  ['Old Livery', 'skin', 'CarCommon', 3_120_000, false, null, null],
  ['Clean Stadium.zip', 'mod', 'Stadium', 48_200_000, true, 'mod', 'q2'],
  ['Coast Summer.zip', 'mod', 'Coast', 31_900_000, false, 'mod', 'q3'],
].map(([name, kind, folder, size, enabled, parkType, parkId]) => ({
  path: `C:/sample/Skins/${folder}/${name}`, name: name as string, kind: kind as 'skin' | 'mod', folder: folder as string, dir: `C:/sample/Skins/${folder}`,
  size: size as number, isDir: !(name as string).endsWith('.zip'), modified: '2026-11-02T18:20:00Z', enabled: enabled as boolean,
  source: parkType ? { parkType: parkType as string, parkId: parkId as string, url: `https://maniapark.com/${parkType}/${parkId}/download`, installedAt: '2026-11-02T18:20:00Z' } : null,
}));
