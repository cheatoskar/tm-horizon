// Mods from TrackMania ModLoader (TMLoader) repositories.
// A repository serves <server>/index.json:
//   { "api": 1, "game": "TmForever", "products": { "<id>": { name, author, type, description,
//     icon_link, homepage, external?, versions: { "<version>": { executable, dependencies: [{id, version?}],
//     download_link, hash_sha256, changelog, priority? } } } } }
// The masterserver serves { "api": 1, "servers": [...], "versions": {...TMLoader itself...} }.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import type { GameId, Mod, ModCategory, ModVersion, SourceStatus } from '../types.ts';
import type { SourceContext } from '../config.ts';
import { compareVersions, errorText, slug } from '../lib/util.ts';

export interface TmlIndexVersion {
  executable?: string;
  dependencies?: { id: string; version?: string }[];
  download_link?: string;
  hash_sha256?: string;
  changelog?: string;
  priority?: number;
}

export interface TmlIndexProduct {
  name?: string;
  author?: string;
  type?: string;
  description?: string;
  icon_link?: string;
  homepage?: string;
  external?: boolean;
  versions?: Record<string, TmlIndexVersion>;
}

export interface TmlIndex {
  api?: number;
  game?: string;
  products?: Record<string, TmlIndexProduct>;
  servers?: string[];
}

const LOADER_GAMES: Record<string, GameId[]> = {
  TmForever: ['tmnf', 'tmuf'],
  ManiaPlanet: ['tm2-canyon', 'tm2-stadium', 'tm2-valley', 'tm2-lagoon'],
  Trackmania: ['tm2020'],
};

const CATEGORY_RULES: [ModCategory, RegExp][] = [
  ['VR', /\b(vr|openxr|virtual reality|headset)\b/],
  ['TAS', /\b(tas|tool[- ]assisted|tminterface|bruteforce|input scripts?)\b/],
  ['competition', /\b(competition|anti-?cheat|tournament|league|ranked)\b/],
  ['editor', /\b(editor|unlimiter|mapping|block placement)\b/],
  ['graphics', /\b(shaders?|lighting|graphics?|render(ing)?|reshade|weather|textures?|visuals?)\b/],
  ['HUD', /\b(hud|speedometer|overlay|gauges?|dashboard|minimap|splits?)\b/],
  ['library', /\b(required by other mods|library|framework|coremod)\b/],
];

/** Category from type, id, name and description; the first matching rule wins, else "tools". */
export function deriveCategory(id: string, p: TmlIndexProduct): ModCategory {
  if (p.type === 'program') return 'library';
  const text = `${id} ${p.name ?? ''} ${p.description ?? ''}`.toLowerCase();
  for (const [cat, re] of CATEGORY_RULES) if (re.test(text)) return cat;
  return 'tools';
}

/** Turn one repository index into mods (without download hashes). */
export function parseModIndex(raw: unknown, server: string): Mod[] {
  const index = raw as TmlIndex;
  if (!index || typeof index !== 'object' || !index.products || typeof index.products !== 'object') {
    throw new Error('not a TMLoader repository index (no "products")');
  }
  const loaderGame = index.game ?? 'TmForever';
  const mods: Mod[] = [];
  for (const [id, p] of Object.entries(index.products)) {
    const versions: ModVersion[] = Object.entries(p.versions ?? {}).map(([version, v]) => {
      const mv: ModVersion = {
        version,
        executable: v.executable ?? null,
        dependencies: (v.dependencies ?? []).map((d) => ({ id: d.id, version: d.version ?? null })),
        changelog: v.changelog?.trim() || null,
        download: v.download_link ?? null,
        sha256Index: v.hash_sha256?.toLowerCase() ?? null,
        sha256: null,
        size: null,
      };
      if (typeof v.priority === 'number') mv.priority = v.priority;
      return mv;
    });
    versions.sort((a, b) => compareVersions(b.version, a.version));
    mods.push({
      id,
      slug: slug(id),
      name: p.name?.trim() || id,
      author: p.author?.trim() || null,
      description: p.description?.trim() || null,
      homepage: p.homepage || null,
      icon: p.icon_link || null,
      type: p.type ?? null,
      external: p.external === true,
      games: [...(LOADER_GAMES[loaderGame] ?? [])],
      category: deriveCategory(id, p),
      loaderGame,
      repositories: [server],
      versions,
      latest: versions[0]?.version ?? null,
    });
  }
  return mods;
}

/** Merge mods from several repositories (mirrors list the same product). The first repository's text wins. */
export function mergeMods(lists: Mod[][], overrides: Record<string, { category?: ModCategory; games?: GameId[] }> = {}): Mod[] {
  const byId = new Map<string, Mod>();
  for (const list of lists) {
    for (const mod of list) {
      const have = byId.get(mod.id);
      if (!have) {
        byId.set(mod.id, structuredClone(mod));
        continue;
      }
      for (const r of mod.repositories) if (!have.repositories.includes(r)) have.repositories.push(r);
      for (const v of mod.versions) if (!have.versions.some((h) => h.version === v.version)) have.versions.push(v);
      have.versions.sort((a, b) => compareVersions(b.version, a.version));
      have.latest = have.versions[0]?.version ?? null;
    }
  }
  for (const mod of byId.values()) {
    const o = overrides[mod.id];
    if (o?.category) mod.category = o.category;
    if (o?.games) mod.games = [...o.games];
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}

/** Repository URLs from TMLoader's config.yaml (read only). */
export function readLocalServers(env: Record<string, string | undefined>): string[] {
  const base = env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  const file = path.join(base, 'TMLoader', 'config.yaml');
  if (!fs.existsSync(file)) return [];
  const cfg = YAML.parse(fs.readFileSync(file, 'utf8')) as { servers?: unknown };
  return Array.isArray(cfg?.servers) ? cfg.servers.filter((s): s is string => typeof s === 'string') : [];
}

const normalise = (u: string) => (u.endsWith('/') ? u : u + '/');

export async function buildMods(ctx: SourceContext): Promise<{ mods: Mod[]; sources: SourceStatus[] }> {
  const cfg = ctx.config.modloader;
  const sources: SourceStatus[] = [];
  const servers: string[] = [];
  const add = (list: string[]) => {
    for (const s of list) if (!servers.includes(normalise(s))) servers.push(normalise(s));
  };
  add(cfg.servers);
  if (cfg.readLocalConfig) {
    try {
      add(readLocalServers(ctx.env));
    } catch (e) {
      ctx.warn(`modloader: local TMLoader config.yaml unreadable: ${errorText(e)}`);
    }
  }
  if (cfg.masterserver) {
    const url = normalise(cfg.masterserver) + 'index.json';
    try {
      const { data, result } = await ctx.http.getJson<TmlIndex>(url, { ttlMinutes: cfg.indexTtlMinutes });
      add(Array.isArray(data.servers) ? data.servers : []);
      sources.push({ id: 'modloader-master:' + cfg.masterserver, ok: true, count: data.servers?.length ?? 0, sample: false, cached: !!result.cache });
    } catch (e) {
      ctx.warn(`modloader: masterserver failed: ${errorText(e)}`);
      sources.push({ id: 'modloader-master:' + cfg.masterserver, ok: false, count: 0, sample: false, error: errorText(e) });
    }
  }

  const lists: Mod[][] = [];
  for (const server of servers) {
    const url = server + 'index.json';
    try {
      const { data, result } = await ctx.http.getJson<unknown>(url, { ttlMinutes: cfg.indexTtlMinutes });
      const mods = parseModIndex(data, server);
      lists.push(mods);
      sources.push({ id: 'modloader:' + server, ok: true, count: mods.length, sample: false, cached: !!result.cache });
      if (result.cache === 'stale') ctx.warn(`modloader: ${server} unreachable, used the cached index`);
    } catch (e) {
      ctx.warn(`modloader: ${server} failed: ${errorText(e)}`);
      sources.push({ id: 'modloader:' + server, ok: false, count: 0, sample: false, error: errorText(e) });
    }
  }
  const mods = mergeMods(lists, cfg.overrides);

  // Hash downloads: newest version only by default, each URL once (cached by URL + ETag/Last-Modified).
  for (const mod of mods) {
    const targets = cfg.hashLatestOnly ? mod.versions.slice(0, 1) : mod.versions;
    for (const v of targets) {
      if (!v.download) continue;
      try {
        const h = await ctx.http.hashFile(v.download, cfg.fileRecheckHours);
        v.sha256 = h.sha256;
        v.size = h.size;
        if (v.sha256Index && v.sha256Index !== h.sha256) {
          v.hashMismatch = true;
          ctx.warn(`modloader: ${mod.id} ${v.version}: downloaded SHA-256 differs from the index`);
        }
      } catch (e) {
        ctx.warn(`modloader: ${mod.id} ${v.version}: download failed: ${errorText(e)}`);
      }
    }
  }
  return { mods, sources };
}
