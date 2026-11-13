import { MOD_CATEGORIES, TITLES } from './catalog';
import { hubMod, modOverride, projectForMod, releaseDownloads, type Project } from './hub';
import type { GameView, ModIndex, Profile, RemoteProduct, Snapshot, TmlProduct } from './types';
import { ago } from '../i18n';
import bundledMods from '../generated/mods.json';
import { claimedDisplay } from './hubMerge';

/** Icons shipped with the app (public/mod-icons), also for mods no server lists any more. */
const BUNDLED_ICONS: Record<string, string | null | undefined> = Object.fromEntries(Object.values((bundledMods as unknown as ModIndex).products).map((p) => [p.id, p.icon]));

/** Semver-style compare: "v" prefix ignored, 1-4 number parts ("1.2" = "1.2.0"), a pre-release
 * ("1.4.3-beta.2") is older than its release and compared by dot parts (numbers numerically),
 * build metadata ("+abc") ignored. Negative when a < b. */
export function cmpVersion(a: string, b: string): number {
  const parse = (v: string) => {
    const s = v.trim().replace(/^v/i, '').split('+')[0];
    const dash = s.search(/[-\s]/);
    const core = (dash < 0 ? s : s.slice(0, dash)).split('.').map((x) => Number.parseInt(x, 10) || 0);
    const pre = dash < 0 ? [] : s.slice(dash + 1).trim().split('.').filter(Boolean);
    while (core.length < 4) core.push(0);
    return { core, pre };
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 4; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  if (!x.pre.length || !y.pre.length) return (x.pre.length ? -1 : 0) + (y.pre.length ? 1 : 0);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) { if (Number(p) !== Number(q)) return Number(p) - Number(q); }
    else if (pn !== qn) return pn ? -1 : 1;
    else if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

const q = (s: string) => (s.includes(' ') ? `"${s}"` : s);

export function tmloaderCommand(snap: Snapshot, profile: string) {
  // Same arguments TMLoader's own "shortcut on desktop" writes: run <game> "<profile>".
  const exe = snap.tmloader.exe || '%LOCALAPPDATA%\\TMLoader\\TMLoader.exe';
  return `${q(exe)} run TmForever "${profile}"`;
}

export function buildGames(snap: Snapshot): GameView[] {
  const g = snap.games;
  return TITLES.map((t): GameView => {
    switch (t.family) {
      case 'forever': {
        const inst = (t.id === 'tmnf' ? g.tmnf : g.tmuf).installs[0];
        return { ...t, installed: !!inst, install: inst, launchCommand: inst ? q(inst.exe!) : undefined };
      }
      case 'eswc': {
        const inst = g['tmn-eswc'].installs[0];
        return {
          ...t, installed: !!inst, install: inst, launchCommand: inst ? q(inst.exe!) : undefined,
          unsupported: g['tmn-eswc'].unsupported[0],
        };
      }
      case 'maniaplanet': {
        const mp = g.maniaplanet.installs[0];
        const hasPack = g.maniaplanet.titlePacks.some((p) => p.toLowerCase() === t.titleId!.toLowerCase());
        const installed = !!mp && hasPack;
        return {
          ...t, installed, install: mp,
          launchCommand: mp ? `${q(mp.exe!)} /title=${t.titleId}` : undefined,
          note: mp && !hasPack ? 'library.mpPackMissing' : undefined,
        };
      }
      case 'tm2020': {
        const inst = g.tm2020.installs[0];
        return { ...t, installed: !!inst, install: inst, launchCommand: inst?.launch || (inst ? q(inst.exe!) : undefined) };
      }
      case 'console': {
        const inst = (g[t.id as 'tm-ds'] ?? { installs: [] }).installs[0];
        return { ...t, installed: !!inst, install: inst, launchCommand: inst?.exe ? [q(inst.exe), ...(inst.extraArgs ?? []).map(q)].join(' ') : undefined, note: inst ? undefined : 'console.libraryNote' };
      }
      case 'classic':
      case 'turbo':
      case 'legacy': {
        const inst = (g[t.id as 'tm-turbo' | 'tm-original' | 'tm-sunrise' | 'tm-2003']?.installs ?? [])[0];
        return { ...t, installed: !!inst, install: inst, launchCommand: inst?.launch || (inst?.exe ? q(inst.exe) : undefined) };
      }
    }
  });
}

export function buildProfiles(snap: Snapshot): Profile[] {
  const real: Profile[] = (snap.tmloader.profiles || []).map((p) => ({
    id: 'tml:' + p.name,
    game: 'forever',
    name: p.name,
    mods: p.mods,
    args: p.args,
    real: true,
    programVersion: p.program?.version ?? null,
  }));
  // Put TMLoader's default profile first.
  const def = snap.tmloader.defaultProfiles?.TmForever;
  real.sort((a, b) => (a.name === def ? -1 : b.name === def ? 1 : a.name.localeCompare(b.name)));
  // Start Forever without TMLoader: the plain TmForever.exe (or Steam).
  const plain: Profile = { id: 'nomods', game: 'forever', name: 'No mods', mods: [], real: true };
  // Games without TMLoader start with one real, empty profile each (their mods are not per profile).
  const others: Profile[] = ['tmn-eswc', 'tm2-stadium', 'tm2-canyon', 'tm2020'].map((g) => ({ id: 'd:' + g, game: g, name: 'Default', mods: [], real: true }));
  return [...real, plain, ...others];
}

export const profileGameKey = (gameId: string) =>
  gameId === 'tmnf' || gameId === 'tmuf' ? 'forever' : gameId;

export interface ModView {
  id: string;
  name: string;
  author: string | null;
  description: string | null;
  homepage: string | null;
  gallery?: string[]; // https picture URLs when the hub/catalog entry has them
  icon: string | null;
  type: string | null;
  latest: string | null;
  installedVersions: string[];
  installedLatest: string | null;
  updateAvailable: boolean;
  source: string; // repository host or "Local database"
  remote?: RemoteProduct;
  local?: TmlProduct;
  games: string[];
  categories: string[];
  versionCount: number;
  size: number | null;
  updated: string | null;
  project: Project | null; // GitHub repo (stars, release downloads) from the hub API
  stars: number | null;
  downloads: number | null;
  sha256: string | null; // computed by the hub API by downloading the latest zip
  hashOk: boolean | null;
}

const host = (u: string) => { try { return new URL(u).host; } catch { return u; } };

export function buildMods(snap: Snapshot, index: ModIndex): ModView[] {
  const local = snap.tmloader.products || {};
  const ids = new Set([...Object.keys(index.products), ...Object.keys(local)]);
  const out: ModView[] = [];
  for (const id of ids) {
    const r = index.products[id];
    const l = local[id];
    const installedVersions = (l?.versions || []).filter((v) => v.installed).map((v) => v.version).sort((a, b) => cmpVersion(b, a));
    const latest = r?.versions[0]?.version ?? null;
    const installedLatest = installedVersions[0] ?? null;
    // TmForever is the game itself and runs on TMNF and TMUF; TMFOXR is United only.
    const games = id === 'TMFOXR' ? ['tmuf'] : ['tmnf', 'tmuf'];
    // A project its author claimed on the hub shows the hub's name, tagline and icon (the TMLoader folder stays the id).
    const own = id === 'Horizon Host' ? undefined : claimedDisplay(r?.name ?? l?.name ?? id) ?? claimedDisplay(id);
    out.push({
      id,
      // TM Horizon's own TMLoader product keeps its folder name "Horizon Host"; older installs also carry that
      // display name. Shown as "Horizon Client" with the client's logo, like on the website.
      name: id === 'Horizon Host' ? 'Horizon Client' : own?.name ?? r?.name ?? l?.name ?? id,
      author: r?.author ?? l?.author ?? null,
      description: id === 'Horizon Host' ? (r?.description ?? l?.description ?? '').replace(/^In-game mod host of TM Horizon/i, 'In-game client of TM Horizon') || null : own?.summary ?? r?.description ?? l?.description ?? null,
      icon: id === 'Horizon Host' ? '/module-icons/saturn/horizon-client.png' : own?.icon ?? r?.icon ?? BUNDLED_ICONS[id] ?? l?.icon_link ?? null,
      type: r?.type ?? l?.type ?? null,
      latest,
      installedVersions,
      installedLatest,
      updateAvailable: !!(latest && installedLatest && cmpVersion(latest, installedLatest) > 0),
      source: r && r.servers.length && !r.localOnly ? host(r.servers[0]) : 'Local database',
      remote: r,
      local: l,
      games,
      categories: MOD_CATEGORIES[id] ?? ['Tools'],
      versionCount: new Set([...(r?.versions.map((v) => v.version) || []), ...(l?.versions.map((v) => v.version) || [])]).size,
      size: r?.versions[0]?.size ?? hubMod(id)?.versions[0]?.size ?? null,
      updated: r?.versions[0]?.updated ?? null,
      ...(() => {
        // Catalog override (packages/catalog PICTURES): own homepage, no project of a foreign repository
        // (TM Clips' index homepage is the TMVS repository; its stars and link are not TM Clips').
        const o = modOverride(id);
        const homepage = o && 'homepage' in o ? o.homepage ?? null : r?.homepage ?? l?.homepage ?? null;
        const project = o && 'project' in o && o.project === null ? null : projectForMod(id, homepage);
        const hv = hubMod(id)?.versions[0];
        return {
          homepage,
          project,
          stars: project?.stars ?? null,
          downloads: releaseDownloads(project),
          sha256: hv?.sha256 ?? null,
          hashOk: hv?.sha256 ? !hv.hashMismatch : null,
        };
      })(),
    });
  }
  // Programs first, CoreMod (a library every mod pulls in) last.
  const rank = (m: ModView) => (m.type === 'program' ? 0 : m.id === 'CoreMod' ? 2 : 1);
  // Relevance: most downloaded GitHub release first (where known), then by name.
  return out.sort((a, b) => rank(a) - rank(b) || (b.downloads ?? -1) - (a.downloads ?? -1) || a.name.localeCompare(b.name));
}

export function changelogFor(m: ModView, version: string): string | null {
  return m.remote?.versions.find((v) => v.version === version)?.changelog
    ?? m.local?.versions.find((v) => v.version === version)?.changelog
    ?? null;
}

export function allVersions(m: ModView): string[] {
  const s = new Set<string>([...(m.remote?.versions.map((v) => v.version) || []), ...(m.local?.versions.map((v) => v.version) || [])]);
  return [...s].sort((a, b) => cmpVersion(b, a));
}

export function fmtSize(n: number | null): string {
  if (!n) return '-';
  if (n > 1e9) return (n / 1e9).toFixed(1) + ' GB';
  return n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.round(n / 1e3) + ' KB';
}

/** "3 h ago" in the UI language (Intl.RelativeTimeFormat). */
export const timeAgo = (iso: string | null | undefined): string => ago(iso);
