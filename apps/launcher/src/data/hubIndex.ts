// TM Horizon Hub data source (native only): the signed index checked by src-tauri/src/hubindex.rs
// becomes catalog entries of the Mods page. Everything here is opt-in (Settings > TM Horizon Hub,
// off by default). Entries are merged into the exported CATALOG array in place; turning the source
// off puts the bundled entries back. Contract: packages/shared/src/hub.ts.
import { invoke } from '@tauri-apps/api/core';
import type { CatalogEntry } from '@tm-hub/shared';
import type { HubIndexPayload, HubIndexVersion } from '@tm-hub/shared/hub';
import { backend } from './backend';
import { CATALOG, titleOf } from './hub';
import { catalogFromIndex, claimedFrom, entryOf, setClaimed, setTitleOf, specOf } from './hubMerge';
import { applyReleasePolicy } from './releasePolicy';
import { setCommunityServers } from './serverQuery';

setTitleOf((g) => titleOf(g) as string);
export { entryOf, mergeEntry, specOf } from './hubMerge';

// ------------------------------------------------------------------ setting

export interface HubSourceSetting { enabled: boolean; url: string }
const KEY = 'tmhub.hubSource';
export const HUB_URL_PLACEHOLDER = 'https://hub.…';

let memory: HubSourceSetting | null = null;
export function getHubSource(): HubSourceSetting {
  // Launcher Preview: the hub source does not exist (no hub requests at all).
  if (__RELEASE_PREVIEW__) return { enabled: false, url: '' };
  if (memory) return memory;
  try {
    const j = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return { enabled: j.enabled === true, url: typeof j.url === 'string' ? j.url : '' };
  } catch { return { enabled: false, url: '' }; }
}
export function setHubSource(s: HubSourceSetting) {
  memory = s; // also the fallback when storage is blocked: the choice then lasts until restart
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* see above */ }
}
/** Where the index comes from: the user's opt-in setting, or in the Launcher Preview the production hub pinned
 * in the backend (hubindex.rs PRODUCTION_HUB; the url here is only a marker, the backend ignores it). */
const source = (): HubSourceSetting => (__RELEASE_PREVIEW__ ? { enabled: true, url: 'production' } : getHubSource());

// ------------------------------------------------------------------ status + change events

interface RawResult { payload: HubIndexPayload; keyId: string; seq: number; stale: boolean; fetchedAt: string; source: 'cache' | 'network'; warnings: string[] }
export interface HubStatus {
  state: 'off' | 'loading' | 'ok' | 'error';
  keyId?: string; seq?: number; fetchedAt?: string; stale?: boolean; projects?: number; origin?: 'cache' | 'network';
  error?: string; warnings: string[];
}
let status: HubStatus = { state: 'off', warnings: [] };
let payload: HubIndexPayload | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());
const setStatus = (s: HubStatus) => { status = s; emit(); };
/** For useSyncExternalStore and for the app state (which bumps its catalog version on a change). */
export const onHubIndexChange = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
export const hubStatus = () => status;
export const hubPayload = () => payload;

// ------------------------------------------------------------------ mapping to catalog entries

/** Bundled entries replaced by hub entries (null: the hub entry was appended). */
const replaced = new Map<string, { at: number; entry: CatalogEntry } | null>();
const applied = new Set<string>();

/** The bundled catalog as it was before the first index was applied (restored when the index goes away). */
let bundled: CatalogEntry[] | null = null;

function revertEntries() {
  setClaimed(new Map());
  if (bundled) CATALOG.splice(0, CATALOG.length, ...bundled);
  bundled = null;
  applied.clear();
  replaced.clear();
}

/** Puts a hub entry into CATALOG (replacing the entry with the same id) and remembers what it replaced. */
function put(e: CatalogEntry) {
  const i = CATALOG.findIndex((c) => c.id === e.id);
  if (!bundled) bundled = CATALOG.slice();
  if (!applied.has(e.id)) replaced.set(e.id, i >= 0 ? { at: i, entry: CATALOG[i] } : null);
  if (i >= 0) CATALOG[i] = e; else CATALOG.push(e);
  applied.add(e.id);
}

/** A valid index with at least one project is the list: entries it does not name disappear, the bundled
 * catalog only fills fields for the ids it names. An empty index leaves the bundled catalog as it is. */
function applyEntries(pl: HubIndexPayload) {
  revertEntries();
  const base = CATALOG.slice();
  const list = catalogFromIndex(pl, base, applyReleasePolicy);
  if (!list) return;
  setClaimed(claimedFrom(pl, base));
  bundled = base;
  CATALOG.splice(0, CATALOG.length, ...list);
  const byId = new Map(base.map((e) => [e.id, e]));
  for (const x of CATALOG) { applied.add(x.id); replaced.set(x.id, byId.has(x.id) ? { at: 0, entry: byId.get(x.id)! } : null); }
}

function apply(r: RawResult) {
  payload = r.payload;
  applyEntries(r.payload);
  void setCommunityServers(r.payload.servers ?? []);
  setStatus({ state: 'ok', keyId: r.keyId, seq: r.seq, fetchedAt: r.fetchedAt, stale: r.stale, projects: r.payload.projects.length, origin: r.source, warnings: r.warnings });
}

// ------------------------------------------------------------------ loading

const native = () => backend.kind === 'native';
const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T | null> => Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);

/** Cached index only (fast), then a background refresh. Never rejects, never waits for the network. */
export async function bootHubIndex(): Promise<void> {
  const s = source();
  if (!native() || !s.enabled) return;
  try {
    const c = await withTimeout(invoke<RawResult | null>('hub_index_cached'), 1500);
    if (c) apply(c);
  } catch (e) { setStatus({ ...status, state: 'error', error: String(e) }); }
  if (s.url) void refreshHubIndex();
  // Launcher Preview: the index is the remote catalog; look for a newer one every 6 hours.
  if (__RELEASE_PREVIEW__) setInterval(() => { void refreshHubIndex(); }, 6 * 3600_000);
}

/** Downloads, verifies and applies the index of the configured hub. */
export async function refreshHubIndex(): Promise<HubStatus> {
  const s = source();
  if (!native() || !s.enabled) { disableHubIndex(); return status; }
  if (!s.url) { setStatus({ ...status, state: 'error', error: 'no-url' }); return status; }
  const before = status;
  setStatus({ ...before, state: 'loading' });
  try {
    apply(await invoke<RawResult>('hub_index_refresh', { url: s.url }));
  } catch (e) {
    setStatus({ ...before, state: 'error', error: String(e) });
  }
  return status;
}

/** Puts the bundled catalog entries back. */
export function disableHubIndex() {
  revertEntries();
  void setCommunityServers([]);
  payload = null;
  setStatus({ state: 'off', warnings: [] });
}

// ------------------------------------------------------------------ revocations

export interface RevokedInstall { record: import('./backend').InstallRecord; reason: string; version: string }
/** Installed mods whose download hash the hub has revoked. */
export async function revokedInstalls(): Promise<RevokedInstall[]> {
  if (!payload || !backend.modUpdates) return [];
  try {
    const recs = await backend.modUpdates.installs();
    const out: RevokedInstall[] = [];
    for (const r of recs) {
      const rev = payload.revoked.find((x) => r.sha256 && x.sha256.toLowerCase() === r.sha256.toLowerCase());
      if (rev) out.push({ record: r, reason: rev.reason, version: rev.version });
    }
    return out;
  } catch { return []; }
}

// ------------------------------------------------------------------ deep link

const MSG: Record<string, Record<string, string>> = {
  en: { off: 'The TM Horizon Hub source is off. Turn it on in Settings.', unknown: 'Unknown hub project: {x}', version: 'Unknown or revoked version: {x}', none: 'No verified download for this version.' },
  de: { off: 'Die Hub-Quelle ist aus. In den Einstellungen einschalten.', unknown: 'Unbekanntes Hub-Projekt: {x}', version: 'Unbekannte oder gesperrte Version: {x}', none: 'Kein geprüfter Download für diese Version.' },
  pl: { off: 'Źródło Hub jest wyłączone. Włącz je w ustawieniach.', unknown: 'Nieznany projekt: {x}', version: 'Nieznana lub cofnięta wersja: {x}', none: 'Brak zweryfikowanego pliku dla tej wersji.' },
  fr: { off: 'La source Hub est désactivée. Activez-la dans les réglages.', unknown: 'Projet inconnu : {x}', version: 'Version inconnue ou révoquée : {x}', none: 'Aucun téléchargement vérifié pour cette version.' },
};
export const hubLang = () => { const l = document.documentElement.lang; return l in MSG ? l : 'en'; };
const m = (k: string, x = '') => MSG[hubLang()][k].replace('{x}', x);

/** tmhub://install?project=<slug>&version=<version>. Returns the catalog entry id to open, or an error text. */
export function hubInstallLink(u: URL): { id: string } | { error: string } {
  if (!payload) return { error: m('off') };
  const slug = u.searchParams.get('project') ?? '';
  const ver = u.searchParams.get('version');
  const p = payload.projects.find((x) => x.slug === slug);
  if (!p) return { error: m('unknown', slug) };
  let v: HubIndexVersion | null | undefined = null;
  if (ver) {
    v = p.versions.find((x) => x.version === ver);
    if (!v || payload.revoked.some((r) => r.project === slug && r.version === ver)) return { error: m('version', ver) };
    if (!specOf(payload, v)) return { error: m('none') };
  }
  const e = entryOf(payload, p, v);
  put(e);
  emit();
  return { id: e.id };
}
