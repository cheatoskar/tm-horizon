// Data from the hub data pipeline (packages/api/dist). A copy is bundled (scanner/import-hub-api.mjs);
// the native app also fetches the configured hub URL (Settings) and replaces it with
// applyHubData() when that works.
import serversJson from '../generated/hub/servers.json';
import projectsJson from '../generated/hub/projects.json';
import modsJson from '../generated/hub/mods.json';
import eventsJson from '../generated/hub/events.json';
import communitiesJson from '../generated/hub/communities.json';
import catalogJson from '@tm-hub/catalog/catalog.json';
import type { ExchangePost } from './backend';
import { repoUrl, type IssueFields } from '@tm-hub/shared';
import { applyReleasePolicy, releaseHidden } from './releasePolicy';
import type { CatalogEntry, CommunitiesFile, EventsFile, GameServer, HubEvent, Mod as HubMod, ModsFile, Project, ProjectsFile, ServersFile } from '@tm-hub/shared';

export type { GameServer, HubEvent, HubMod, Project };

// Hub game ids -> launcher title ids.
const GAME: Record<string, string> = { eswc: 'tmn-eswc', tmo: 'tm-original', tms: 'tm-sunrise', turbo: 'tm-turbo' };
export const titleOf = (g: string | null) => (g ? GAME[g] ?? g : null);
/** Catalog-only game ids (tm1, tmsx, tmu2006) onto launcher title ids, like titleOf for the rest. */
const CATALOG_GAME: Record<string, string> = { tm1: 'tm-original', tmsx: 'tm-sunrise', tmu2006: 'tmuf' };
export const newsGameOf = (g: string): string => CATALOG_GAME[g] ?? titleOf(g) ?? g;

export let serversFile = serversJson as unknown as ServersFile;
export let projectsFile = projectsJson as unknown as ProjectsFile;
export let hubModsFile = modsJson as unknown as ModsFile;
export let eventsFile = eventsJson as unknown as EventsFile;
export let communitiesFile = communitiesJson as unknown as CommunitiesFile;
export let hubSource: 'bundled' | 'remote' = 'bundled';

const withTitles = (f: ServersFile) => f.servers.map((s) => ({ ...s, title_: titleOf(s.game) }));
export let SERVERS = withTitles(serversFile);

/** Swaps in fresh hub files (servers, projects and mods all or none; events when present). */
export function applyHubData(d: { servers: unknown; projects: unknown; mods: unknown; events?: unknown; communities?: unknown }, source: 'bundled' | 'remote' = 'remote') {
  const s = d.servers as ServersFile, p = d.projects as ProjectsFile, m = d.mods as ModsFile, e = d.events as EventsFile | undefined;
  if (!Array.isArray(s?.servers) || !Array.isArray(p?.projects) || !Array.isArray(m?.mods)) return false;
  serversFile = s; projectsFile = p; hubModsFile = m; hubSource = source;
  if (Array.isArray(e?.events)) eventsFile = e;
  const c = d.communities as CommunitiesFile | undefined;
  if (Array.isArray(c?.communities)) communitiesFile = c;
  SERVERS = withTitles(s);
  return true;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
// TMLoader product id -> GitHub project, via homepage URL or catalog id.
export function projectForMod(modId: string, homepage: string | null): Project | null {
  const byHome = homepage && projectsFile.projects.find((p) => homepage.toLowerCase().startsWith(p.url.toLowerCase()));
  if (byHome) return byHome;
  const n = norm(modId);
  return projectsFile.projects.find((p) => p.catalogIds.some((c) => norm(c) === n || norm(c).startsWith(n)) || norm(p.name) === n
    || (n === 'tmfoxr' && p.id.toLowerCase().includes('openxr')) || (n === 'twinkie' && p.id.toLowerCase().includes('twinkie'))) ?? null;
}

const normMod = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
/** Catalog override for a TMLoader mod (packages/catalog PICTURES): own homepage, no foreign project. */
export const modOverride = (id: string): { homepage?: string | null; project?: null } | undefined =>
  ((catalogJson as unknown as { pictures?: { mod: string; homepage?: string | null; project?: null }[] }).pictures ?? []).find((p) => normMod(p.mod) === normMod(id));

export const releaseDownloads = (p: Project | null) => p?.release?.assets.reduce((a, b) => a + b.downloads, 0) ?? null;

export const hubMod = (id: string): HubMod | undefined => hubModsFile.mods.find((m) => m.id === id);

export const fmtNum = (n: number) => (n >= 10000 ? Math.round(n / 1000) + 'k' : n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n));

// ------------------------------------------------------------------ community services
// Servers and events are added through GitHub issue forms of the TM Horizon repository (checked by
// hand, then built into servers.json / events.json). See packages/api/docs/integration.md.
export const HUB_REPO = repoUrl();
/** Fields for the server form; `name` also becomes the title. */
export const serverFields = (f: { name?: string; address?: string; login?: string; mode?: string } = {}): IssueFields => ({ ...f });
export const eventFields = (): IssueFields => {
  let tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* old WebView */ }
  return { timezone: tz };
};

/** Real events (Discord, trackmania.io, TMTAS, submitted), upcoming or running, soonest first. Sample entries are never shown; TAS events only in TAS mode. */
export function upcomingEvents(mode: 'play' | 'tas' = 'play'): HubEvent[] {
  const now = Date.now();
  const live = (e: HubEvent) => (e.end ? Date.parse(e.end) : Date.parse(e.start) + 3 * 3600_000) > now;
  return eventsFile.events.filter((e) => !e.sample && live(e) && (mode === 'tas' || !e.tas)).sort((a, b) => a.start.localeCompare(b.start));
}

export interface NewsItem {
  id: string; kind: 'release' | 'exchange'; title: string; text: string; date: string; url: string;
  /** Hub game ids (releases) or the launcher game id of the site (exchange posts). */
  games: string[];
  image?: string | null; author?: string | null;
  /** Releases: the project, and the pictures of the release text (checked before use, see data/news.ts). */
  projectId?: string; candidates?: string[];
  /** Exchange posts: the site, for opening it in the embedded browser. */
  site?: { game: string; host: string };
}

/** Release notes as a short plain teaser (Markdown marks, links and headings dropped). */
function notesTeaser(md: string | null | undefined): string {
  if (!md) return '';
  let s = md.replace(/```[\s\S]*?```/g, ' ');
  // Auto-generated GitHub sections: contributors and the compare link carry no news.
  s = s.replace(/^[\s*_#>]*(new contributors|full changelog)\b[\s\S]*$/im, '');
  s = s.replace(/^[\s*_#>-]*what'?s changed[\s*_:]*$/gim, ' ');
  // GitHub alert markers ("> [!NOTE]") are layout, not text.
  s = s.replace(/\[!(note|tip|important|warning|caution)\]/gi, ' ');
  const t = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ').replace(/\bhttps?:\/\/\S+/gi, ' ').replace(/\bby @[\w-]+ in\b/g, ' ')
    .replace(/^\s*(#+|[-*>]|\d+\.)\s*/gm, '').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
  return t.length > 240 ? t.slice(0, 240).replace(/\s+\S*$/, '') + '...' : t;
}

/** Picture URLs in a release body, in order: Markdown pictures, <img> tags and GitHub attachment links. */
export function bodyImages(md: string | null | undefined): string[] {
  if (!md) return [];
  const found: [number, string][] = [];
  const add = (at: number, u: string) => {
    u = u.trim().replace(/&amp;/g, '&');
    if (/^https:\/\//i.test(u) && !/shields\.io|badgen|badge\.svg|\/badge|codecov|travis-ci|\.svg(\?|$)/i.test(u)) found.push([at, u]);
  };
  for (const m of md.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)/g)) add(m.index!, m[1]);
  for (const m of md.matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi)) add(m.index!, m[1]);
  for (const m of md.matchAll(/https:\/\/github\.com\/user-attachments\/assets\/[0-9a-f-]+/gi)) add(m.index!, m[0]);
  found.sort((a, b) => a[0] - b[0]);
  return [...new Set(found.map((f) => f[1]))];
}

/** The hub mod belonging to a project (by homepage or catalog id): its icon is the last-resort news picture. */
export function modIconOfProject(p: Project): string | null {
  const ids = p.catalogIds.map(norm);
  const m = hubModsFile.mods.find((x) => ids.includes(norm(x.id)) || (x.homepage && x.homepage.toLowerCase().startsWith(p.url.toLowerCase())));
  return m?.icon && /^https:\/\//.test(m.icon) ? m.icon : null;
}

/** Games a release belongs to: the project's own list plus the games of its catalog entries and of the hub mod
 * (TMLoader mod or catalog mod) it ships, as launcher title ids. */
function releaseGames(p: Project): string[] {
  const ids = p.catalogIds.map(norm);
  const fromCatalog = CATALOG.filter((c) => p.catalogIds.includes(c.id)).flatMap((c) => c.games as string[]);
  const fromMods = hubModsFile.mods.filter((m) => ids.includes(norm(m.id)) || (m.homepage && m.homepage.toLowerCase().startsWith(p.url.toLowerCase()))).flatMap((m) => m.games as string[]);
  return [...new Set([...(p.games ?? []), ...fromCatalog, ...fromMods].map(newsGameOf))];
}

/** News from real data: the newest GitHub releases of the projects in the hub data (mods and tools). */
export function latestNews(n = 4): NewsItem[] {
  return projectsFile.projects
    .filter((p) => p.release?.published && !p.archived)
    .sort((a, b) => b.release!.published!.localeCompare(a.release!.published!))
    .slice(0, n)
    .map((p) => ({
      id: p.id, kind: 'release' as const, title: `${p.name} ${p.release!.tag}`,
      text: notesTeaser(p.release!.notes) || p.description || '', date: p.release!.published!,
      url: p.release!.url ?? p.url, games: releaseGames(p), projectId: p.id, candidates: bodyImages(p.release!.notes),
    }));
}

/** Exchange posts as news items (the native side returns them, see src-tauri/src/news.rs). */
export function exchangeNewsItems(posts: ExchangePost[]): NewsItem[] {
  return posts.map((p) => ({
    id: p.id, kind: 'exchange' as const, title: p.title, text: p.teaser, date: p.date, url: p.link,
    games: [p.game], image: p.image, author: p.author, site: { game: p.game, host: p.host },
  }));
}

/** Releases and Exchange posts together, newest first. */
export function mergeNews(releases: NewsItem[], exchange: NewsItem[]): NewsItem[] {
  return [...releases, ...exchange].sort((a, b) => b.date.localeCompare(a.date));
}

/** Games that join by address (no join link). */
export const ADDRESS_GAMES = ['eswc', 'tmo', 'tms'];

// ------------------------------------------------------------------ catalog (bundled)
export const CATALOG = applyReleasePolicy((catalogJson as unknown as { entries: CatalogEntry[] }).entries);
/** Set by a tmhub://install/<catalog id> link: the catalog mod page opens its install dialog once. */
export const linkIntent: { install: string | null } = { install: null };
/** A game page's "All mods for <game>": the Mods page opens with this game's filter set (read once). */
export const modsIntent: { game: string | null } = { game: null };
/** Curated collections (Graphics, QoL, TAS, ...) from the catalog; ids are catalog entry ids or TMLoader product ids. */
export const COLLECTIONS = ((catalogJson as unknown as { collections?: { id: string; name: string; description?: string; entries: string[] }[] }).collections ?? [])
  .map((c) => ({ ...c, entries: c.entries.filter((id) => !releaseHidden(id)) }));

/** Where a mod's author takes bug reports: GitHub issues, else the catalog or index homepage. */
export function reportPage(modId: string, homepage: string | null): string | null {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  const cat = CATALOG.find((c) => norm(c.name) === norm(modId) || norm(c.id) === norm(modId));
  const urls = [homepage, cat?.url ?? null, ...(cat?.urls ?? [])].filter((u): u is string => !!u && /^https:\/\//i.test(u));
  const gh = urls.map((u) => /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)/i.exec(u)).find(Boolean);
  if (gh) return `https://github.com/${gh[1]}/${gh[2].replace(/\.git$/, '')}/issues`;
  const pages = /^https:\/\/([\w-]+)\.github\.io\/([\w.-]+)/i.exec(urls[0] ?? '');
  if (pages) return `https://github.com/${pages[1]}/${pages[2]}/issues`;
  return urls[0] ?? null;
}
