import site from './site.json';
import { gameById, byOrder, gameName, cover } from './games';
import { isPre, tmName } from '../lib/fmt';
import { webImg } from "@tm-hub/shared/extimg";
import { t, tf, type Lang } from '../i18n';
import { CATALOG_CAT_ICONS, MOD_CAT_ICONS, MOD_TYPE_ICONS, entryModType, modTypeIcon as sharedTypeIcon } from '@tm-hub/shared/modicon';

export const data = site as any;
export const mods = data.mods as any[];
/** Openplanet plugins (Trackmania 2020 and ManiaPlanet) from openplanet.dev's public list, imported by scripts/build-data.mjs. */
export const opPlugins = (data.opPlugins ?? []) as any[];
export const projects = data.projects as any[];
export const catalog = data.catalog as any[];
/** Showcase pages of mods ({ mod, showcase }), from the catalog (packages/catalog/showcases). */
export const showcases = (data.showcases ?? []) as { mod: string; showcase: unknown }[];
export const sources = data.sources as Record<string, any>;
export const servers = ((data.servers ?? []) as any[]).filter((s) => !s.sample);
export const events = ((data.events ?? []) as any[]).filter((e) => !e.sample).slice().sort((a, b) => a.start.localeCompare(b.start));
export const modById = (id: string) => mods.find((m) => m.id === id);
export const playersOnline = servers.filter((s) => !s.sample).reduce((n, s) => n + s.players, 0);
/** Servers with live player counts (ManiaPlanet master server, trackmania.io); community servers only have a reachability dot. */
export const isCommunity = (s: any) => s.source === 'community';
/** Games the hub's live list (GET /v1/servers, polled directly) covers. Static servers of these games, and community entries, are not counted again next to it. */
export const HUB_LIVE_GAMES = ['tmnf', 'tmuf', 'eswc', 'tms', 'tmo'];
const baseServers = servers.filter((s) => !s.sample && !isCommunity(s) && !HUB_LIVE_GAMES.includes(s.game));
/** Home page numbers from the build-time data (ManiaPlanet, TM2020); the hub's online servers and players are added in the browser. */
export const baseServerCount = baseServers.length;
export const basePlayers = baseServers.reduce((n, s) => n + s.players, 0);
/** Discord server directory (packages/api communities.json); null when the api data was not built. */
export const directory = ((data.communities ?? null) as any[] | null)?.length ? (data.communities as any[]) : null;
export const liveServers = servers.filter((s) => !s.sample && !isCommunity(s));

// ------------------------------------------------------------------ labels and icons (Lucide names)
// Icon mappings are shared with the launcher (packages/shared/src/modicon.ts).
const modCatIcons = MOD_CAT_ICONS;
const catalogCatIcons = CATALOG_CAT_ICONS;
const labelled = (icons: Record<string, string>, prefix: string, lang: Lang) =>
  Object.fromEntries(Object.entries(icons).map(([id, icon]) => [id, { label: t(lang, `${prefix}.${id}`), icon }])) as Record<string, { label: string; icon: string }>;
export const modCatsFor = (lang: Lang) => labelled(modCatIcons, 'modcat', lang);
export const catalogCatsFor = (lang: Lang) => labelled(catalogCatIcons, 'catcat', lang);
export type InstallKind = 'tmloader' | 'proxy' | 'gamedata' | 'openplanet' | 'manual' | 'discord';
export const installIcons: Record<InstallKind, string> = { tmloader: 'plug', proxy: 'file-cog', gamedata: 'folder-input', openplanet: 'orbit', manual: 'hand', discord: 'message-circle' };
export const installOrder: InstallKind[] = ['tmloader', 'proxy', 'gamedata', 'openplanet', 'manual', 'discord'];
export const installLabel = (lang: Lang, k: InstallKind) => t(lang, `install.${k}`);
/** Facet entries of the mod list: id, label and icon per install type. */
export const systemsFor = (lang: Lang) => Object.fromEntries(installOrder.map((k) => [k, { label: installLabel(lang, k), icon: installIcons[k] }])) as Record<string, { label: string; icon: string }>;

/** How a catalog entry gets installed, from its `installs` map, `install` text and `installSpec`. TMLoader mods always have `tmloader`. */
export function installKinds(e: any, isTml = false): InstallKind[] {
  const out = new Set<InstallKind>();
  if (isTml) out.add('tmloader');
  const vals = Object.values(e?.installs ?? {}) as string[];
  if (vals.includes('tmloader')) out.add('tmloader');
  if (vals.some((v) => String(v).startsWith('proxy:'))) out.add('proxy');
  const spec = e?.installSpec?.kind;
  if (spec === 'files') out.add('gamedata');
  if (spec === 'tmloader-product') out.add('tmloader');
  const ins = String(e?.install ?? '').toLowerCase();
  if (!out.size) {
    if (ins.startsWith('tmloader')) out.add('tmloader');
    else if (ins.startsWith('gamedata') || ins === 'skins') out.add('gamedata');
  }
  if (e?.id === 'openplanet' || (!out.size && /openplanet/i.test(`${e?.name} ${e?.install}`))) out.add('openplanet');
  if (!out.size) out.add(e?.url ? 'manual' : 'discord');
  return installOrder.filter((k) => out.has(k));
}
/** true: the launcher can install it (TMLoader mod, proxy DLL from the catalog, or a catalog installSpec). */
export const launcherCanInstall = (e: any, isTml = false) =>
  isTml || (Object.values(e?.installs ?? {}) as string[]).some((v) => v === 'tmloader' || String(v).startsWith('proxy:')) || !!e?.installSpec;

export const statusLabelFor = (lang: Lang) =>
  Object.fromEntries(['alive', 'unclear', 'dead', 'stable', 'pre', 'active', 'archived', 'community', 'expired', 'unchecked'].map((k) => [k, t(lang, `status.${k}`)])) as Record<string, string>;

export const types = [
  { id: 'mods', icon: 'puzzle' },
  { id: 'maps', icon: 'map' },
  { id: 'skins', icon: 'paint-bucket' },
  { id: 'texture-packs', icon: 'layers' },
  { id: 'tools', icon: 'wrench' },
  { id: 'projects', icon: 'folder-git-2' },
  { id: 'servers', icon: 'server' },
  { id: 'events', icon: 'calendar-days' },
  { id: 'communities', icon: 'users' },
] as const;
export const typeLabel = (lang: Lang, id: string) => t(lang, `type.${id}`);

// ------------------------------------------------------------------ discover items
export interface Chip { label: string; icon?: string; img?: string; tone?: string; title?: string }
export interface CommunityInfo { address: string | null; online: boolean | null; lastSeen: string | null; language: string | null; contact: string | null; homepage: string | null }
export interface Item {
  key: string; href: string; external: boolean; icon: string | null; glyph: string; title: string; titleHtml?: string;
  author?: string | null; desc: string; chips: Chip[]; games: string[]; cat: string; sys?: string; online?: string;
  status: string; downloads: number | null; stars: number | null; updated: string | null; version?: string | null;
  players?: number; max?: number; join?: string | null; sample?: boolean; zone?: string | null; mode?: string | null; statLabel?: string;
  /** Catalog entries without a link (the file only exists as a Discord attachment). */
  noLink?: boolean;
  /** Set for community servers (source "community"). */
  community?: CommunityInfo;
  /** Set for entries of the Discord directory (communities.json). */
  dir?: DirInfo;
  /** Directory region (Europe, North America, ...) for the region facet. */
  region?: string | null;
  /** false: archived directory entry, hidden until "Show archive" is on. */
  active?: boolean;
  /** Hand-picked picture of a catalog mod (card thumbnail). */
  image?: string | null;
  /** Mod entries: install types, id for the launcher link, and whether the launcher can install it. */
  install?: InstallKind[]; installId?: string; canInstall?: boolean;
}
export interface DirInfo { url: string; invite: string | null; alive: boolean | null; members: number | null; online: number | null }

/** Catalog ids tm1 and tmsx show under Original and Sunrise; ids the site does not know (tmu2006) are ignored. */
const gameAlias: Record<string, string> = { tm1: 'tmo', tmsx: 'tms' };
export const knownGames = (ids: string[] | null | undefined) => [...new Set((ids ?? []).map((g) => gameAlias[g] ?? g))].filter((g) => !!gameById[g]);
const gameChips = (ids: string[], max = 3): Chip[] => {
  const s = knownGames(ids).sort(byOrder);
  const out: Chip[] = s.slice(0, max).map((g) => ({ label: gameName(g), img: cover(g), title: gameById[g]?.name }));
  if (s.length > max) out.push({ label: `+${s.length - max}`, title: s.slice(max).map((g) => gameById[g]?.name).join(', ') });
  return out;
};
const projectFor = (catalogId: string) => projects.find((p) => p.catalogIds?.includes(catalogId));

// ------------------------------------------------------------------ unified mod list
// TMLoader mods (mods.json) + catalog mods (Discord mod channel, proxy DLL mods, Openplanet, standalone). A catalog entry
// that is the same mod as a TMLoader one (id equal after dropping "mod-") is merged into it instead of listed twice.
const modExtras = ['openplanet', 'bingoforever', 'foreverrpc'];
/** Categories whose entries with a modType get a mod page (packages/catalog/types.json explains the types). */
const MOD_PAGE_CATS = ['mod', 'skins', 'environment', 'tas-plugin'];
export const isModEntry = (e: any) => (!!e.modType && MOD_PAGE_CATS.includes(e.category)) || modExtras.includes(e.id);
/** Shown in the Mods tab: what changes how the game works; skins and texture packs have their own tabs. */
export const inModsTab = (e: any) => ['mod', 'environment', 'tas-plugin'].includes(e.category) || modExtras.includes(e.id);
/** Texture packs and block skins (catalog modType), the Texture packs tab. */
export const isTexturePack = (e: any) => ['texturepack', 'blockskin'].includes(e.modType);
const stripMod = (id: string) => id.replace(/^mod-/, '');
export const tmlFor = (e: any) => mods.find((m) => m.id === e.id || m.id === stripMod(e.id));
/** Catalog entry behind a TMLoader mod (install types, gallery, mirrors), if there is one. */
export const entryForMod = (m: any) => catalog.find((e) => isModEntry(e) && (e.id === m.id || stripMod(e.id) === m.id));
export const catalogMods = catalog.filter((e) => isModEntry(e) && !tmlFor(e));
export const catalogModById = (id: string) => catalogMods.find((e) => e.id === id);
const entryCat = entryModType;
// Type glyphs: the shared table (packages/shared/src/modicon.ts), the same as in the launcher.
const modTypeIcons: Record<string, string> = MOD_TYPE_ICONS;
/** Chip label of a catalog mod type (the data ids are lower case words). */
export const modTypeLabel = (lang: Lang, id: string) => tf(lang, `modtype.${id}`, id);
/** Glyph of a catalog type (shared table, puzzle for unknown types). */
export const modTypeIcon = (id: string) => modTypeIcons[id] ?? sharedTypeIcon(id);
export const modTypeCatsFor = (lang: Lang) => Object.fromEntries(Object.keys(modTypeIcons).map((id) => [id, { label: modTypeLabel(lang, id), icon: modTypeIcons[id] }])) as Record<string, { label: string; icon: string }>;

const installChips = (kinds: InstallKind[], lang: Lang): Chip[] => kinds.map((k) => ({ label: installLabel(lang, k), icon: installIcons[k], tone: 'sys', title: t(lang, `install.${k}.tip`) }));
/** The mod's site image: a hand-picked banner, else the first gallery picture. */
export const entryImage = (e: any): string | null => e?.banner ?? e?.gallery?.[0] ?? null;

export function modItems(lang: Lang = 'en'): Item[] {
  const modCats = modCatsFor(lang);
  const out: Item[] = mods.map((m) => {
    const e = entryForMod(m);
    const kinds = installKinds(e, true);
    return {
      key: m.id, href: `/mod/${m.id}/`, external: false, icon: m.icon, glyph: modCats[m.category]?.icon ?? 'puzzle', image: entryImage(e),
      title: m.name, author: m.author, desc: m.summary, games: knownGames([...(m.games ?? []), ...(e?.games ?? [])]), cat: m.category, sys: kinds.join(' '), online: m.online ?? '',
      status: isPre(m.latest ?? '') ? 'pre' : 'stable', downloads: m.downloads, stars: m.stars, updated: m.updated, version: m.latest,
      install: kinds, installId: m.id, canInstall: true,
      chips: [{ label: modCats[m.category]?.label ?? m.category, icon: modCats[m.category]?.icon }, ...installChips(kinds, lang), ...gameChips([...(m.games ?? []), ...(e?.games ?? [])])],
    };
  });
  for (const e of catalogMods.filter(inModsTab)) {
    const p = projectFor(e.id);
    const kinds = installKinds(e);
    // Catalog types that mean the same as a TMLoader category share one facet entry.
    const type = entryCat(e);
    const cat = ({ hud: 'HUD', utility: 'tools' } as Record<string, string>)[type] ?? type;
    out.push({
      key: e.id, href: `/mod/${e.id}/`, external: false, icon: p?.icon ?? e.logo ?? null, glyph: modTypeIcon(type), image: e.preview ?? entryImage(e), title: e.name.replace(/ plugin site$/, ''),
      author: e.author ?? e.maintainer ?? p?.repo?.split('/')[0] ?? null, desc: e.description ?? '', games: knownGames(e.games), cat, sys: kinds.join(' '), online: '', status: e.status === 'dead' ? 'dead' : 'stable',
      downloads: p?.downloads ?? null, stars: p?.stars ?? null, updated: p?.release?.published ?? p?.pushed ?? null, version: p?.release?.tag ?? null, statLabel: e.checked ?? undefined,
      install: kinds, installId: e.id, canInstall: launcherCanInstall(e),
      chips: [{ label: modTypeLabel(lang, type), icon: modTypeIcon(type) }, ...installChips(kinds, lang), ...gameChips(e.games ?? [])],
    });
  }
  // Openplanet plugins: listed and searchable here, installed from openplanet.dev (or the launcher's Openplanet tab).
  for (const op of opPlugins) {
    out.push({
      key: `op-${op.id}`, href: op.page, external: true, icon: op.icon ?? null, glyph: 'plug-zap', title: op.name, author: op.authors.join(', ') || null, desc: op.summary,
      games: knownGames(op.games), cat: 'plugin', sys: 'openplanet', online: '', status: 'stable', downloads: op.downloads, stars: null, updated: op.updated, version: op.version,
      install: ['openplanet'], installId: `op-${op.id}`, canInstall: false,
      chips: [{ label: t(lang, 'modtype.plugin'), icon: 'plug-zap' }, ...installChips(['openplanet'], lang), ...(op.signed ? [{ label: t(lang, 'chip.signed'), icon: 'badge-check', tone: 'sys' }] : []), ...gameChips(op.games)],
    });
  }
  return out;
}

export function catalogItem(e: any, lang: Lang = 'en'): Item {
  const p = projectFor(e.id);
  const catalogCats = catalogCatsFor(lang);
  const c = catalogCats[e.category] ?? { label: e.category, icon: 'link' };
  const modEntry = isModEntry(e);
  const tml = modEntry ? tmlFor(e) : null;
  const pageId = tml?.id ?? e.id;
  const kinds = modEntry ? installKinds(e, !!tml) : [];
  const noLink = !modEntry && !e.url;
  return {
    key: e.id, href: modEntry ? `/mod/${pageId}/` : e.url ?? '', external: !noLink && !modEntry, noLink, icon: p?.icon ?? tml?.icon ?? e.logo ?? null, image: e.preview ?? entryImage(e), glyph: c.icon, title: e.name, author: e.maintainer ?? e.author ?? null, desc: e.description ?? '',
    games: knownGames(e.games), cat: e.category, status: e.status, downloads: p?.downloads ?? null, stars: p?.stars ?? null, sys: kinds.join(' ') || undefined,
    updated: p?.release?.published ?? null, version: p?.release?.tag ?? null, statLabel: e.checked,
    install: kinds, installId: pageId, canInstall: modEntry && launcherCanInstall(e, !!tml),
    chips: [
      { label: c.label, icon: c.icon },
      ...installChips(kinds, lang),
      ...(!modEntry && noLink ? [{ label: t(lang, 'chip.discordOnly'), icon: 'message-circle', tone: 'sys' }] : []),
      ...(e.api ? [{ label: 'API', icon: 'code', tone: 'sys' }] : []),
      ...gameChips(e.games ?? []),
    ],
  };
}

export function projectItems(lang: Lang = 'en'): Item[] {
  const catalogCats = catalogCatsFor(lang);
  return projects.map((p) => ({
    key: p.id, href: p.url, external: true, icon: p.icon, glyph: 'folder-git-2', title: p.name, author: p.repo.split('/')[0], desc: p.description ?? '',
    games: knownGames(p.games), cat: p.category ?? 'tool', status: p.archived ? 'archived' : 'active', downloads: p.downloads, stars: p.stars,
    updated: p.release?.published ?? p.pushed, version: p.release?.tag ?? null,
    chips: [
      { label: catalogCats[p.category]?.label ?? t(lang, 'chip.project'), icon: catalogCats[p.category]?.icon ?? 'folder-git-2' },
      ...(p.language ? [{ label: p.language, icon: 'code', tone: 'sys' }] : []),
      ...(p.license ? [{ label: p.license, icon: 'scale' }] : []),
      ...gameChips(p.games ?? [], 2),
    ],
  }));
}

const prettyMode = (m: string | null) => (m ? m.replace(/^TM_/, '').replace(/_Online$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ') : null);
export function serverItems(lang: Lang = 'en'): Item[] {
  return servers.map((s0) => {
    const s = { ...s0, mode: prettyMode(s0.mode) };
    const g = s.game as string | null;
    const known = !!g && !!gameById[g];
    const zone = (s.zone ?? '').split('|').filter((z: string) => z && z !== 'World');
    const community = isCommunity(s);
    return {
      key: s.id ?? s.login, href: s.join ?? '#', external: true, icon: known ? cover(g) : null, glyph: 'server',
      title: s.name, titleHtml: s.nameRaw ? tmName(s.nameRaw) : undefined, author: s.title && !s.title.endsWith('@nadeo') ? s.title.split('@')[0] : null,
      desc: zone.slice(0, 3).join(' / '), games: known ? [g!] : [], cat: s.mode || 'Other', status: community ? 'community' : s.players > 0 ? 'active' : 'empty',
      downloads: null, stars: null, updated: null, players: s.players, max: s.max, join: s.join, sample: s.sample, zone: zone.join(' / '), mode: s.mode,
      community: community ? { address: s.address ?? null, online: s.online ?? null, lastSeen: s.lastSeen ?? null, language: s.language ?? null, contact: s.contact ?? null, homepage: s.homepage ?? null } : undefined,
      chips: [
        ...(community ? [{ label: t(lang, 'chip.community'), icon: 'users', tone: 'sys' }] : []),
        ...(s.mode ? [{ label: s.mode, icon: 'flag' }] : []),
        ...(known ? gameChips([g!]) : [{ label: t(lang, 'chip.titlePack'), icon: 'package' }]),
        ...(community && s.language ? [{ label: String(s.language).toUpperCase(), icon: 'languages' }] : []),
      ],
    };
  });
}

// ------------------------------------------------------------------ Discord directory (Communities tab)
const dirGroups: Record<string, { id: string; icon: string }> = {
  'Official': { id: 'official', icon: 'badge-check' }, 'Countries & Regions': { id: 'countries', icon: 'globe' }, 'Communities': { id: 'communities', icon: 'users' },
  'Teams': { id: 'teams', icon: 'shield' }, 'People': { id: 'people', icon: 'user' }, 'Creators': { id: 'creators', icon: 'palette' },
  'Events': { id: 'events', icon: 'trophy' }, 'Projects': { id: 'projects', icon: 'puzzle' },
};
const dirRegions: Record<string, string> = { 'Europe': 'europe', 'North America': 'north-america', 'South America': 'south-america', 'Asia / Oceania': 'asia-oceania', 'Middle East / Africa': 'middle-east-africa' };
const dirSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
/** Group facet: the sheet's column groups; archived entries share one value ("archive"). */
export const dirGroupId = (c: any) => (c.active === false ? 'archive' : dirGroups[c.group]?.id ?? dirSlug(c.group));
export function dirGroupsFor(lang: Lang) {
  const out: Record<string, { label: string; icon: string }> = {};
  for (const [name, g] of Object.entries(dirGroups)) out[g.id] = { label: tf(lang, `commgroup.${g.id}`, name), icon: g.icon };
  out.archive = { label: t(lang, 'commgroup.archive'), icon: 'archive' };
  return out;
}
export function dirRegionsFor(lang: Lang) {
  const out: Record<string, { label: string; icon: string }> = {};
  for (const [name, id] of Object.entries(dirRegions)) out[id] = { label: tf(lang, `commregion.${id}`, name), icon: 'map-pin' };
  return out;
}
const httpUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : '');

export function communityItems(lang: Lang = 'en'): Item[] {
  if (!directory) return catalog.filter((e) => e.category === 'community').map((e) => catalogItem(e, lang));
  const groups = dirGroupsFor(lang);
  return directory.filter((c) => httpUrl(c.url)).map((c) => {
    const g = groups[dirGroupId(c)];
    const state = c.alive === true ? 'alive' : c.alive === false ? 'expired' : 'unchecked';
    const sameName = !c.guildName || c.guildName.trim().toLowerCase() === c.name.trim().toLowerCase();
    const where = c.section && c.section !== c.group && c.section !== c.region ? c.section : '';
    return {
      key: c.id, href: c.url, external: true, icon: c.icon ?? null, glyph: g.icon, title: c.name, author: null,
      desc: sameName ? '' : c.guildName, games: [], cat: dirGroupId(c), status: state, downloads: null, stars: null, updated: null,
      region: c.region ? dirRegions[c.region] ?? dirSlug(c.region) : null, active: c.active !== false,
      dir: { url: c.url, invite: c.invite, alive: c.alive, members: c.members, online: c.online },
      statLabel: c.checked ?? undefined,
      chips: [
        { label: c.active === false ? `${t(lang, 'commgroup.archive')}: ${tf(lang, `commgroup.${dirSlug(c.group)}`, c.group)}` : g.label, icon: g.icon },
        ...(c.region ? [{ label: tf(lang, `commregion.${dirRegions[c.region] ?? dirSlug(c.region)}`, c.region), icon: 'map-pin' }] : []),
        ...(where ? [{ label: where, tone: 'sys' }] : []),
      ],
    } satisfies Item;
  });
}


/** Tool types (catalog modType of category tool) for the Tools tab facet. */
export const TOOL_TYPES: Record<string, { icon: string }> = { tas: { icon: 'timer' }, editor: { icon: 'pencil-ruler' }, library: { icon: 'code' }, server: { icon: 'server' }, utility: { icon: 'wrench' } };
export const toolTypesFor = (lang: Lang) => Object.fromEntries(Object.entries(TOOL_TYPES).map(([id, v]) => [id, { label: t(lang, `tooltype.${id}`), icon: v.icon }])) as Record<string, { label: string; icon: string }>;

export function itemsFor(type: string, lang: Lang = 'en'): Item[] {
  const ci = (e: any) => catalogItem(e, lang);
  switch (type) {
    case 'mods': return modItems(lang);
    case 'projects': return projectItems(lang);
    case 'servers': return serverItems(lang);
    case 'tools': return catalog.filter((e) => e.category === 'tool').map((e) => ({ ...ci(e), cat: e.modType ?? 'utility', glyph: TOOL_TYPES[e.modType]?.icon ?? 'wrench' }));
    case 'skins': return catalog.filter((e) => e.category === 'skins' && !isTexturePack(e)).map((e) => ({ ...ci(e), cat: e.modType ?? e.category }));
    case 'texture-packs': return catalog.filter(isTexturePack).map((e) => ({ ...ci(e), cat: e.modType }));
    case 'communities': return communityItems(lang);
    case 'events': return catalog.filter((e) => e.category === 'events').map(ci);
    default: return [];
  }
}

// ------------------------------------------------------------------ README of the GitHub repository (fetched by scripts/build-data.mjs into src/data/readmes/)
import fs from 'node:fs';
export const ghRepoOf = (u: string | null | undefined): string | null => { const m = String(u || '').match(/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?]|$)/i); return m ? `${m[1]}/${m[2]}` : null; };
export function readmeFor(repo: string | null | undefined): string | null {
  if (!repo) return null;
  try { return fs.readFileSync(`src/data/readmes/${repo.replace('/', '__')}.md`, 'utf8') || null; } catch { return null; }
}

// ------------------------------------------------------------------ pictures from a mod's GitHub README
// For mods whose showcase has no pictures of its own (or wrong ones): the README's pictures in README order, only
// those the image proxy allows (GitHub attachments, raw.githubusercontent.com). Badges and video thumbnails
// (shields.io, img.youtube.com) are not on the allowlist and drop out. Used for the ids in README_PICTURE_MODS.
export const README_PICTURE_MODS = new Set(['tmfoxr', 'twinkie']);
/** Of those, the ones whose first wide README picture also becomes the showcase's hero picture (TMFOXR's are settings screens with text, so only the gallery). */
export const README_HERO_MODS = new Set(['twinkie']);
export function readmePictures(repo: string | null | undefined): { url: string; width: number | null }[] {
  const md = readmeFor(repo);
  if (!md) return [];
  const found: { at: number; url: string; width: number | null }[] = [];
  for (const m of md.matchAll(/!\[[^\]]*\]\((https:\/\/[^)\s]+)[^)]*\)/g)) found.push({ at: m.index ?? 0, url: m[1]!, width: null });
  for (const m of md.matchAll(/<img\b[^>]*>/gi)) {
    const src = /\bsrc="(https:\/\/[^"]+)"/i.exec(m[0])?.[1];
    const w = /\bwidth="(\d+)"/i.exec(m[0])?.[1];
    if (src) found.push({ at: m.index ?? 0, url: src, width: w ? Number(w) : null });
  }
  const seen = new Set<string>();
  return found.sort((a, b) => a.at - b.at).filter((f) => {
    if (!webImg(f.url) || seen.has(f.url)) return false;
    seen.add(f.url);
    return true;
  });
}
/** The showcase with the README pictures: hero picture (first wide one) and a Screenshots gallery after the features block. */
export function withReadmePictures<T extends { blocks: any[] }>(showcase: T, pics: { url: string; width: number | null }[], galleryTitle: string, hero = true): T {
  if (!pics.length) return showcase;
  const blocks = showcase.blocks.filter((b) => b.type !== 'gallery').map((b) => ({ ...b }));
  const heroBlock = blocks.find((b) => b.type === 'hero');
  const wide = pics.find((p) => p.width === null || p.width >= 800);
  if (heroBlock && hero && wide) heroBlock.image = wide.url;
  const at = blocks.findIndex((b) => b.type === 'features');
  blocks.splice(at >= 0 ? at + 1 : Math.min(1, blocks.length), 0, { type: 'gallery', title: galleryTitle, images: pics.map((p) => ({ url: p.url })) });
  return { ...showcase, blocks };
}
