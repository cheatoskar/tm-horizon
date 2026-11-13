// Live TMNF/TMUF server list from the hub's GET /tmf/servers (native only). Used by the Servers page
// when the hub source is on (Settings > TM Horizon Hub). Off, unreachable or "tmf-disabled" on the
// hub: nothing changes, the Servers page keeps the bundled list. The request goes through a Rust
// command (the web view's CSP does not allow fetch). Hub side: apps/server/src/services/tmf.ts.
import { invoke } from '@tauri-apps/api/core';
import type { GameServer, TmfServersResponse } from '@tm-hub/shared';
import { backend } from './backend';
import { getHubSource } from './hubIndex';
import { titleOf } from './hub';

export type TmfRow = GameServer & { title_: string | null };
export interface TmfState {
  /** off: hub source off; loading; ok: list from the hub; fallback: hub did not deliver, bundled list stays. */
  state: 'off' | 'loading' | 'ok' | 'fallback';
  servers: TmfRow[];
  fetchedAt: string | null;
  /** Hub status text: ok or stale. */
  stale: boolean;
}

/** The hub asks clients not to poll faster than this (docs/tmf-master/launcher-contract.md). */
export const MIN_INTERVAL_MS = 60_000;
const GAMES = ['tmnf', 'tmuf'] as const;
const JOIN = /^tmtp:\/\/#join=[^\s"'&]{1,64}(:[^\s"'&]{0,64})?$/;

let state: TmfState = { state: 'off', servers: [], fetchedAt: null, stale: false };
let lastTry = 0;
let running: Promise<void> | null = null;
const listeners = new Set<() => void>();
const set = (s: TmfState) => { state = s; listeners.forEach((f) => f()); };
export const onTmfChange = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
export const tmfState = () => state;

/** Keeps well-formed servers of one answer (join link checked, numbers clamped). Exported for tests. */
export function usableServers(r: unknown, game: 'tmnf' | 'tmuf'): { servers: TmfRow[]; stale: boolean; fetchedAt: string | null } | null {
  const x = r as Partial<TmfServersResponse> | null;
  if (!x || x.game !== game || !Array.isArray(x.servers) || (x.status !== 'ok' && x.status !== 'stale')) return null;
  const servers = x.servers
    .filter((s): s is GameServer => !!s && typeof s.id === 'string' && typeof s.name === 'string' && s.source === 'tmf-master' && (s.join == null || JOIN.test(s.join)))
    .map((s) => ({ ...s, game, players: Math.max(0, Number(s.players) || 0), maxPlayers: Math.max(0, Number(s.maxPlayers) || 0), title_: titleOf(game) }));
  return { servers, stale: x.status === 'stale', fetchedAt: typeof x.fetchedAt === 'string' ? x.fetchedAt : null };
}

const LIVE_GAMES = ['tmnf', 'tmuf', 'eswc'] as const;
type LiveGame = (typeof LIVE_GAMES)[number];
const LOGIN = /^[A-Za-z0-9_.-]{1,64}$/;

/** Rows of the hub's own live list (GET /v1/servers, read only). Nations/United: servers that answered the hub's
 * direct query, with a join link. ESWC: every listed entry (they join by address, JoinGuide), without live data
 * (`online: null`). Rows of another game than these three are dropped. Exported for tests. */
export function liveRows(r: unknown): TmfRow[] | null {
  if (!Array.isArray(r)) return null;
  const out: TmfRow[] = [];
  for (const x of r as Record<string, unknown>[]) {
    if (!x || typeof x.name !== 'string' || !x.name.trim()) continue;
    const game = (x.game === 'tmn-eswc' ? 'eswc' : x.game) as LiveGame;
    if (!LIVE_GAMES.includes(game)) continue;
    const eswc = game === 'eswc';
    if (!eswc && x.state !== 'online') continue;
    const login = typeof x.login === 'string' && LOGIN.test(x.login) ? x.login : null;
    const address = typeof x.address === 'string' && x.address ? x.address : null;
    const num = (v: unknown) => Math.max(0, Number(v) || 0);
    out.push({
      id: `hub-poll:${game}:${login ?? address ?? x.name}`, source: 'hub-poll', sample: false, game, title: null,
      name: x.name, nameRaw: x.name, description: null, login,
      players: eswc ? 0 : num(x.players), maxPlayers: eswc ? 0 : num(x.maxPlayers), spectators: eswc || x.spectators == null ? null : num(x.spectators),
      zone: typeof x.country === 'string' ? x.country : null, mode: !eswc && typeof x.mode === 'string' ? x.mode : null,
      private: x.password === true, join: !eswc && login ? `tmtp://#join=${login}` : null, club: null,
      address, online: eswc ? null : true, lastSeen: typeof x.lastSeen === 'string' ? x.lastSeen : null,
      homepage: typeof x.homepage === 'string' ? x.homepage : null, title_: titleOf(game),
    });
  }
  return out;
}

/** Servers of the hub's live list for a launcher game: United Forever also shows Nations servers (United joins
 * them), Nations only its own, ESWC its entries. Biggest first. */
export function liveFor(rows: TmfRow[], game: string): TmfRow[] {
  const games = game === 'tmuf' ? ['tmuf', 'tmnf'] : game === 'tmnf' ? ['tmnf'] : game === 'tmn-eswc' ? ['eswc'] : [];
  return rows.filter((s) => s.game && games.includes(s.game) && !s.private).sort((a, b) => b.players - a.players || a.name.localeCompare(b.name));
}

/** Fetches the lists (at most once a minute). Never rejects. Launcher Preview: the hub's read-only live list
 * from the production hub (pinned in the backend); otherwise the hub source's /tmf/servers. */
export function refreshTmfServers(force = false): Promise<void> {
  const s = getHubSource();
  if (__RELEASE_PREVIEW__ && backend.kind === 'native') return refreshLive(force);
  if (backend.kind !== 'native' || !s.enabled || !s.url) {
    if (state.state !== 'off') set({ state: 'off', servers: [], fetchedAt: null, stale: false });
    return Promise.resolve();
  }
  if (running) return running;
  if (!force && Date.now() - lastTry < MIN_INTERVAL_MS) return Promise.resolve();
  lastTry = Date.now();
  if (state.state === 'off') set({ ...state, state: 'loading' });
  running = (async () => {
    const parts = await Promise.all(GAMES.map((g) => invoke<unknown>('hub_tmf_servers', { url: s.url, game: g }).then((r) => usableServers(r, g), () => null)));
    const ok = parts.filter((p): p is NonNullable<typeof p> => !!p);
    if (!ok.length) { set({ state: 'fallback', servers: [], fetchedAt: null, stale: false }); return; }
    const dates = ok.map((p) => p.fetchedAt).filter((d): d is string => !!d).sort();
    set({ state: 'ok', servers: ok.flatMap((p) => p.servers), fetchedAt: dates[0] ?? null, stale: ok.some((p) => p.stale) });
  })().finally(() => { running = null; });
  return running;
}

function refreshLive(force: boolean): Promise<void> {
  if (running) return running;
  if (!force && Date.now() - lastTry < MIN_INTERVAL_MS) return Promise.resolve();
  lastTry = Date.now();
  if (state.state === 'off') set({ ...state, state: 'loading' });
  running = (async () => {
    const parts = await Promise.all(LIVE_GAMES.map((g) => invoke<unknown>('hub_live_servers', { url: 'production', game: g }).then(liveRows, () => null)));
    const ok = parts.filter((p): p is TmfRow[] => !!p);
    if (!ok.length) { set({ state: 'fallback', servers: [], fetchedAt: null, stale: false }); return; }
    const seen = new Set<string>();
    const servers = ok.flat().filter((x) => !seen.has(x.id) && !!seen.add(x.id));
    set({ state: 'ok', servers, fetchedAt: new Date().toISOString(), stale: false });
  })().finally(() => { running = null; });
  return running;
}
