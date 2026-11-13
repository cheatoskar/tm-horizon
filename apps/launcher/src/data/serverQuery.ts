// Live status of known game servers, asked directly with the game's own server query (no hub, no
// login). Rust side: src-tauri/src/serverquery.rs (query, list of known servers, rate limits).
// Native app only; in the browser preview nothing is queried.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { backend } from './backend';

export type QGame = 'tmnf' | 'tmuf' | 'tmo' | 'tms' | 'eswc';
/** Order of the game chips and of the polls. */
export const QGAMES: QGame[] = ['tmnf', 'tmuf', 'eswc', 'tms', 'tmo'];
export const isQGame = (g: string): g is QGame => (QGAMES as string[]).includes(g);
/** Launcher game ids (hub.game) of the registry's games. */
export const LAUNCHER_ID: Record<QGame, string> = { tmnf: 'tmnf', tmuf: 'tmuf', eswc: 'tmn-eswc', tms: 'tm-sunrise', tmo: 'tm-original' };
/** Registry game of a launcher game id, null for games without a server query. */
export const qGameOf = (id: string): QGame | null => QGAMES.find((g) => LAUNCHER_ID[g] === id) ?? null;
/** Games that join by `tmtp://#join=<login>`. The others only get the address copied. */
export const JOIN_GAMES: QGame[] = ['tmnf', 'tmuf'];

export interface QMap { nameRaw: string; name: string; goldMs: number; copper: number; environment: string; mood: string }
export interface QPlayer { nameRaw: string; name: string; ladderRank: number }
export interface QInfo {
  gameTag: number; reportedAddress: string; hostLogin: string;
  password: boolean; spectatorPassword: boolean;
  players: number; maxPlayers: number; spectators: number; maxSpectators: number; ladderMode: number;
  nameRaw: string; name: string; commentRaw: string; comment: string; packMask: string | null;
  playerList: QPlayer[];
  modeId: number | null; mode: string | null; limit: number | null; limitKind: 'ms' | 'laps' | 'points' | null;
  nbMaps: number; maps: QMap[];
}
export interface QRow {
  game: QGame; address: string; state: 'ok' | 'offline' | 'pending';
  info: QInfo | null; pingMs: number | null; checkedAt: number;
  error: string | null; errorText: string | null; cached: boolean; pausedUntil: number;
}
export interface RegEntry { game: QGame; address: string; name: string | null; source: 'seed' | 'user' | 'community'; suggested?: boolean }
export interface Registry { enabled: boolean; servers: RegEntry[] }

export const rowKey = (game: string, address: string) => `${game}|${address}`;
/** Same rule as the hub list (data/tmfServers.ts): only a plain login goes into a join link. */
const LOGIN = /^[A-Za-z0-9_.\-]{1,64}$/;
export const joinLink = (r: QRow): string | null =>
  r.info && JOIN_GAMES.includes(r.game) && LOGIN.test(r.info.hostLogin) ? `tmtp://#join=${r.info.hostLogin}` : null;

export interface QState { registry: Registry | null; rows: Record<string, QRow>; loading: boolean; lastRun: number }
let state: QState = { registry: null, rows: {}, loading: false, lastRun: 0 };
const listeners = new Set<() => void>();
const set = (s: Partial<QState>) => { state = { ...state, ...s }; listeners.forEach((f) => f()); };
export const onQueryChange = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
export const queryState = () => state;
const native = () => backend.kind === 'native';

export async function loadRegistry(): Promise<Registry | null> {
  if (!native()) return null;
  try {
    const registry = await invoke<Registry>('server_registry');
    set({ registry });
    return registry;
  } catch { return state.registry; }
}

// One poll at a time (two overlapping polls would ask the same servers twice).
let chain: Promise<unknown> = Promise.resolve();
let diskLoaded = false;

/** Asks the known servers of these games, all at once: the list first shows the last good answers from
 * disk (previous runs), then each server's row as soon as it answers (event `server-status-row`), so a
 * dead server never holds up the others. The Rust side keeps the 30 s gap per server and the 10 minute
 * pause for dead ones. */
export function refreshStatus(games: QGame[], force = false): Promise<void> {
  if (!native()) return Promise.resolve();
  const job = chain.then(async () => {
    set({ loading: true });
    try {
      if (!state.registry) await loadRegistry();
      if (!state.registry?.enabled) { set({ rows: {} }); return; }
      if (!diskLoaded) {
        diskLoaded = true;
        const old = await invoke<QRow[]>('server_status_cached', { games: QGAMES }).catch(() => [] as QRow[]);
        const rows = { ...state.rows };
        for (const r of old) if (!rows[rowKey(r.game, r.address)]) rows[rowKey(r.game, r.address)] = r;
        set({ rows });
      }
      const stop = await listen<QRow>('server-status-row', (e) => {
        const r = e.payload;
        if (r && games.includes(r.game)) set({ rows: { ...state.rows, [rowKey(r.game, r.address)]: r } });
      }).catch(() => null);
      try {
        const got = await invoke<QRow[]>('server_status_all', { games, force }).catch(() => [] as QRow[]);
        const rows = { ...state.rows };
        for (const r of got) {
          // "pending" = another poll is still asking; keep what we have.
          if (r.state === 'pending' && rows[rowKey(r.game, r.address)]) continue;
          rows[rowKey(r.game, r.address)] = r;
        }
        set({ rows, lastRun: Date.now() });
      } finally { stop?.(); }
    } finally { set({ loading: false }); }
  });
  chain = job.catch(() => undefined);
  return job.catch(() => undefined);
}

export async function addServer(game: QGame, input: string, name: string): Promise<{ ok: true } | { ok: false; code: string }> {
  try {
    await invoke('server_registry_add', { game, input, name: name.trim() || null });
    await loadRegistry();
    return { ok: true };
  } catch (e) { return { ok: false, code: String(e) }; }
}

export async function removeServer(game: QGame, address: string): Promise<void> {
  await invoke('server_registry_remove', { game, address }).catch(() => undefined);
  const rows = { ...state.rows };
  delete rows[rowKey(game, address)];
  set({ rows });
  await loadRegistry();
}

/** The hub's approved servers (signed index), shown as "Community". Called by data/hubIndex.ts. */
export async function setCommunityServers(list: { game: string; address: string; name: string; suggested?: boolean }[]): Promise<void> {
  if (!native()) return;
  try {
    await invoke('server_registry_set_community', { servers: list.filter((s) => isQGame(s.game)) });
    await loadRegistry();
  } catch { /* old registry stays */ }
}

export const exportServers = () => invoke<string>('server_registry_export');

export async function importServers(json: string): Promise<{ added: number; skipped: number } | { error: string }> {
  try {
    const r = await invoke<{ added: number; skipped: number }>('server_registry_import', { json });
    await loadRegistry();
    return r;
  } catch (e) { return { error: String(e) }; }
}

export async function resetSeeds(): Promise<void> {
  await invoke('server_registry_reset_seeds').catch(() => undefined);
  await loadRegistry();
}

export async function setQueryEnabled(enabled: boolean): Promise<void> {
  await invoke('server_query_enable', { enabled }).catch(() => undefined);
  await loadRegistry();
  if (enabled) void refreshStatus(QGAMES, true);
  else set({ rows: {} });
}

/** Time limit in ms as m:ss (0 = no limit). */
export function fmtMs(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
