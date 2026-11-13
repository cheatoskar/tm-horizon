// Login to the TM Horizon Hub (Discord or GitHub) for adding servers and claiming mods. The login runs
// in the system browser and comes back over 127.0.0.1 (src-tauri/src/hublogin.rs); the token stays in
// the Rust side and is never visible here. Native app only. The hub address is the one from
// Settings > TM Horizon Hub (data/hubIndex.ts).
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useSyncExternalStore } from 'react';
import { isNative } from './backend';
import { getHubSource } from './hubIndex';

export interface HubAccountUser { id: string; name: string; avatar: string | null; identities?: { provider: string; username: string }[] }
export interface HubLoginState {
  /** checking: first answer pending; busy: a browser login is running. */
  phase: 'checking' | 'ready' | 'busy';
  hub: string | null;
  user: HubAccountUser | null;
  reachable: boolean;
  providers: string[];
  portal: string | null;
  /** Last login error code (unreachable, denied:<x>, timeout, ...), cleared on the next try. */
  error: string | null;
}
interface RawStatus { hub: string | null; user: HubAccountUser | null; reachable: boolean; providers: string[]; portal: string | null }

let state: HubLoginState = { phase: 'checking', hub: null, user: null, reachable: false, providers: [], portal: null, error: null };
const listeners = new Set<() => void>();
const set = (s: Partial<HubLoginState>) => { state = { ...state, ...s }; listeners.forEach((f) => f()); };
const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
const snapshot = () => state;

let lastCheck = 0;
let inflight: Promise<void> | null = null;

/** Asks the hub (at most every 30 s unless forced). Quiet: no toasts, the state says what happened. */
export function refreshHubLogin(force = false): Promise<void> {
  if (!isNative || __RELEASE_PREVIEW__) { set({ phase: 'ready' }); return Promise.resolve(); }
  if (inflight) return inflight;
  if (!force && Date.now() - lastCheck < 30_000 && state.phase !== 'checking') return Promise.resolve();
  const url = getHubSource().url.trim();
  inflight = invoke<RawStatus>('hub_login_status', { hubUrl: url || null })
    .then((r) => set({ ...r, phase: state.phase === 'busy' ? 'busy' : 'ready' }))
    .catch(() => set({ phase: 'ready', reachable: false }))
    .finally(() => { lastCheck = Date.now(); inflight = null; });
  return inflight;
}

export function useHubLogin(): HubLoginState {
  const s = useSyncExternalStore(subscribe, snapshot);
  useEffect(() => { void refreshHubLogin(); }, []);
  return s;
}

/** Usable for hub actions right now. */
export const canUseHub = (s: HubLoginState) => s.reachable && !!s.user && s.phase !== 'busy';

/** Browser login; `claim` = project slug to claim through GitHub (needs an existing login). */
export async function hubLogin(provider: 'discord' | 'github', claim?: string): Promise<{ ok: true; claimed: boolean } | { ok: false; error: string }> {
  const url = state.hub ?? getHubSource().url.trim();
  if (!url || __RELEASE_PREVIEW__) return { ok: false, error: 'bad-hub' };
  set({ phase: 'busy', error: null });
  try {
    const r = await invoke<{ user: HubAccountUser; claimed: boolean }>('hub_login_start', { provider, hubUrl: url, claim: claim ?? null });
    set({ phase: 'ready', user: r.user, reachable: true, hub: url.replace(/\/+$/, '') });
    return { ok: true, claimed: r.claimed };
  } catch (e) {
    const error = String(e);
    set({ phase: 'ready', error, ...(error === 'unreachable' ? { reachable: false } : {}) });
    return { ok: false, error };
  } finally {
    void refreshHubLogin(true);
  }
}

export const cancelHubLogin = () => invoke('hub_login_cancel').catch(() => undefined);

export async function hubLogout(): Promise<void> {
  await invoke('hub_logout').catch(() => undefined);
  set({ user: null, error: null });
  void refreshHubLogin(true);
}

/** A hub API call with the login (paths under /v1/ only). Throws the Rust error code. */
export async function hubRequest<T = unknown>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  if (__RELEASE_PREVIEW__) throw 'not-logged-in';
  try {
    return await invoke<T>('hub_request', { method, path, body: body ?? null });
  } catch (e) {
    const code = String(e);
    if (code === 'login-expired' || code === 'not-logged-in') set({ user: null });
    if (code === 'unreachable') set({ reachable: false });
    throw code;
  }
}

/** Privacy text of the hub (portal page), or the draft in the repository while the hub is not known. */
export const privacyUrl = (s: HubLoginState, lang = 'de') =>
  s.portal ? s.portal.replace(/\/?$/, '/') + 'legal/datenschutz' + (lang === 'de' ? '' : '?lang=en') : 'https://github.com/cheatoskar/tm-horizon/blob/main/docs/hub/legal/datenschutz.md';
