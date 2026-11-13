// Hub index -> catalog entries, without Tauri or bundled data (unit-tested in hubMerge.test.ts with a saved
// copy of the production index). hubIndex.ts applies the result to CATALOG.
import type { CatalogEntry, InstallSpec } from '@tm-hub/shared';
import type { HubIndexPayload, HubIndexProject, HubIndexVersion } from '@tm-hub/shared/hub';

/** Fields the production index carries beyond packages/shared/src/hub.ts (2026-11-12). */
type ProjectExtra = { catalogEntry?: CatalogEntry; catalogOnly?: boolean; type?: string };
type PayloadExtra = { withdrawn?: string[] };
let titleOf: (g: string) => string = (g) => g;
/** Game ids of install specs (launcher title ids); set by hubIndex.ts. */
export function setTitleOf(f: (g: string) => string) { titleOf = f; }

const SHA = /^[0-9a-f]{64}$/;
const abs = (u: string | null | undefined, base: string) => { if (!u) return null; try { return new URL(u, base).href; } catch { return null; } };
const entryId = (p: HubIndexProject) => p.catalogId ?? 'hub-' + p.slug;

function isRevokedSha(pl: HubIndexPayload, sha: string) { return pl.revoked.some((r) => r.sha256.toLowerCase() === sha); }

/** Install spec of one version: its primary file, the first game's install and every game with the same install. Null when it cannot be installed safely. */
export function specOf(pl: HubIndexPayload, v: HubIndexVersion): InstallSpec | null {
  const file = v.files?.[0];
  const sha = file?.sha256?.toLowerCase();
  if (!file || !sha || !SHA.test(sha) || isRevokedSha(pl, sha)) return null;
  const url = abs(file.url, pl.hub);
  if (!url) return null;
  const games = Object.keys(v.installs ?? {});
  if (!games.length) return null;
  const first = v.installs[games[0] as keyof typeof v.installs]!;
  const same = games.filter((g) => JSON.stringify(v.installs[g as keyof typeof v.installs]) === JSON.stringify(first));
  const spec: InstallSpec = {
    kind: first.kind, download: { url }, games: same.map((g) => titleOf(g)), sha256: sha, version: v.version,
    requires: first.kind === 'tmloader-product' ? ['TMLoader'] : [],
  };
  if (first.kind === 'files') spec.base = first.base ?? 'game';
  if (first.strip) spec.strip = first.strip;
  if (first.include?.length) spec.include = first.include;
  // The author's own loader (dinput8.dll, allowed by the hub): the files that must never go into a StarForce game.
  const sfb = (v as HubIndexVersion & { starForceBlocked?: unknown }).starForceBlocked;
  if (Array.isArray(sfb) && sfb.length) spec.starForceBlocked = sfb.filter((x): x is string => typeof x === 'string').slice(0, 20);
  return spec;
}

const usable = (pl: HubIndexPayload, v: HubIndexVersion) => specOf(pl, v) !== null;
function pickVersion(pl: HubIndexPayload, p: HubIndexProject): HubIndexVersion | null {
  return p.versions.find((v) => v.channel === 'stable' && usable(pl, v)) ?? p.versions.find((v) => v.channel === 'beta' && usable(pl, v)) ?? null;
}

export function entryOf(pl: HubIndexPayload, p: HubIndexProject, version?: HubIndexVersion | null): CatalogEntry {
  const v = (p as HubIndexProject & ProjectExtra).type === 'browser-extension' ? null : version ?? pickVersion(pl, p);
  const spec = v ? specOf(pl, v) : null;
  const page = abs(`p/${p.slug}`, pl.hub);
  const gallery = p.gallery.map((g) => abs(g, pl.hub)).filter((g): g is string => !!g);
  const banner = abs(p.banner, pl.hub);
  return {
    id: entryId(p), name: p.name, category: 'mod', games: p.games,
    url: p.links.homepage ?? p.links.source ?? page, api: null, description: p.summary || null,
    maintainer: p.author, language: null, status: 'alive', checked: pl.generated.slice(0, 10),
    launcher: spec ? 'install from TM Horizon Hub' : 'open page', archive: null, github: null,
    author: p.author, installSpec: spec, hosting: 'tmhub', requires: p.dependencies.filter((d) => !d.tmloader).map((d) => d.id),
    gallery: banner ? [banner, ...gallery.filter((g) => g !== banner)] : gallery, ...(banner ? { banner } : {}),
    downloadNote: spec ? null : 'No verified download in the hub index',
  };
}

const filled = <T,>(v: T | null | undefined): v is T => v != null && v !== '' && !(Array.isArray(v) && v.length === 0);

/** A hub entry over the bundled entry with the same id: the hub's values win where it has them; the bundled
 * entry fills the rest (category, install spec when the hub has no verified file, gallery, notes). */
export function mergeEntry(hub: CatalogEntry, base: CatalogEntry | undefined): CatalogEntry {
  if (!base) return hub;
  const out: CatalogEntry = { ...base };
  for (const k of ['name', 'games', 'url', 'description', 'maintainer', 'author', 'gallery', 'banner', 'requires'] as const) {
    const v = (hub as unknown as Record<string, unknown>)[k];
    if (filled(v)) (out as unknown as Record<string, unknown>)[k] = v;
  }
  if (hub.installSpec) {
    out.installSpec = hub.installSpec; out.launcher = hub.launcher; out.hosting = hub.hosting; out.downloadNote = null;
  }
  return out;
}

/** The catalog the index stands for: one entry per project (withdrawn ids left out), each over the bundled entry
 * with its id, else over the index's own catalogEntry; `policy` applies the licence rules. Null when the index
 * has no projects (then the bundled catalog stays). */
export function catalogFromIndex(pl: HubIndexPayload, bundled: CatalogEntry[], policy: (l: CatalogEntry[]) => CatalogEntry[]): CatalogEntry[] | null {
  if (!pl.projects.length) return null;
  const withdrawn = new Set((pl as HubIndexPayload & PayloadExtra).withdrawn ?? []);
  const byId = new Map(bundled.map((e) => [e.id, e]));
  const list: CatalogEntry[] = [];
  for (const p of pl.projects) {
    const h = entryOf(pl, p);
    if (withdrawn.has(h.id) || list.some((x) => x.id === h.id)) continue;
    const m = mergeEntry(h, byId.get(h.id) ?? (p as HubIndexProject & ProjectExtra).catalogEntry);
    list.push({ ...m, games: [...new Set(m.games)] });
  }
  return policy(list);
}

// ------------------------------------------------------------------ claimed projects: their own name wins

export interface ClaimedDisplay { name: string; summary: string | null; icon: string | null }
const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
let claimed = new Map<string, ClaimedDisplay>();

/** Display data of the projects their authors claimed on the hub (name, tagline, icon), found by the TMLoader
 * product name they install as (`tmloaderProduct`, else the bundled catalog entry's name, which is the product
 * folder name for TMLoader mods). The product folder stays the install target; only what is shown changes. */
export function claimedFrom(pl: HubIndexPayload, bundled: CatalogEntry[]): Map<string, ClaimedDisplay> {
  const byId = new Map(bundled.map((e) => [e.id, e]));
  const out = new Map<string, ClaimedDisplay>();
  for (const p of pl.projects as (HubIndexProject & ProjectExtra & { claimed?: boolean; icon?: string | null; tmloaderProduct?: string | null })[]) {
    if (!p.claimed || !p.name) continue;
    const icon = p.icon ? abs(p.icon, pl.hub) : null;
    const d: ClaimedDisplay = { name: p.name, summary: p.summary || null, icon };
    for (const k of [p.tmloaderProduct, p.catalogId ? byId.get(p.catalogId)?.name : null, p.catalogEntry?.name]) if (k) out.set(normName(k), d);
  }
  return out;
}
export function setClaimed(m: Map<string, ClaimedDisplay>) { claimed = m; }
/** The claimed project's display data for a TMLoader product (by its name), if any. */
export const claimedDisplay = (product: string): ClaimedDisplay | undefined => claimed.get(normName(product));
