import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { backend, isNative, type ActionResult, type Instance, type Pack, type WebDownload } from './data/backend';
import { tr } from './i18n';
import { applyHubData, CATALOG, linkIntent } from './data/hub';
import { hubInstallLink, onHubIndexChange } from './data/hubIndex';
import { applyGameAccent, clearGameAccent } from './ui/accent';
import { buildGames, buildMods, buildProfiles, profileGameKey, tmloaderCommand } from './data/model';
import type { GameView, ModIndex, Profile, Snapshot } from './data/types';

export type Route = { page: string; arg?: string };

function parseHash(): Route {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  const [page, ...rest] = h.split('/');
  return { page: page || 'home', arg: rest.length ? rest.join('/') : undefined };
}

/** open_map's answers in the player's language: the map was handed to the game, saved under Downloaded, or the
 * game starts and the map waits under Downloaded (ESWC and Sunrise have no /file switch). */
export function mapResult(r: ActionResult): ActionResult {
  if (!r.ok) return r;
  if (r.message === 'Map loaded in the game.') return { ...r, message: tr('play.mapLoaded') };
  if (r.message.startsWith('Map saved: ')) return { ...r, message: tr('play.mapSaved', { path: r.message.slice('Map saved: '.length) }) };
  if (/^Starting\./.test(r.message)) return { ...r, message: tr('play.mapInDownloaded') };
  return r;
}

/** Start errors of a file Windows Defender holds (src-tauri/src/defender.rs). */
export const DEFENDER_MARK = 'DEFENDER_BLOCK:';
export const DEFENDER_HISTORY = 'windowsdefender://threathistory';

export function go(page: string, arg?: string) {
  location.hash = '/' + page + (arg ? '/' + encodeURIComponent(arg) : '');
}

export interface ToastAction { label: string; run: () => void; primary?: boolean }
export interface Toast { id: number; message: string; command?: string | null; ok?: boolean; actions?: ToastAction[]; sticky?: boolean }
export interface Confirm { title: string; text: ReactNode; ok: string; cancel?: string; onOk: () => void; onCancel?: () => void; /** Header picture (the Get sheet: game art). */ art?: string | null; sheet?: boolean }
export type Dialog =
  | { kind: 'report'; gameId: string }
  | { kind: 'export'; profileId: string }
  | { kind: 'import'; pack?: Pack | null }
  | { kind: 'install'; modId: string };

/** TAS tools are offline only (TMX rules): profiles with TMInterface on. */
export const isTasProfile = (p: Profile | null | undefined) => !!p?.mods.some((m) => m.id === 'TMInterface');

/** Play mode or TAS mode. TAS mode is a focus, not a smaller launcher: every page stays, Home becomes
 * the TAS tools page, Forever uses profiles with TMInterface, server joins are blocked and the accent
 * turns cyan. Play mode shows no TAS UI and never offers a Forever profile with TMInterface. */
export type LaunchStep = 'starting' | 'tmloader' | 'waiting' | 'running';
/** Small per-viewer preferences in the browser preview (the app keeps them in settings.json). */
export const loadPref = (k: string): string => { try { return localStorage.getItem(k) ?? ''; } catch { return ''; } };
export const savePref = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
export type HubMode = 'play' | 'tas';
/** Whether a profile belongs to the current mode (only Forever profiles are split by mode). */
export const profileFits = (p: Profile, mode: HubMode) => p.game !== 'forever' || (mode === 'tas' ? isTasProfile(p) : !isTasProfile(p));
/** Theme and accent colour: settings.json in the app, localStorage in the browser preview. */
export interface Look { theme: 'dark' | 'midnight' | 'light'; accent: string; density: 'normal' | 'compact'; /** Mods page: cards or compact rows. */ modsView: 'tiles' | 'list' }
export const ACCENTS = ['orange', 'blue', 'green', 'purple', 'red', 'teal', 'game'] as const;
const loadLook = (): Look => {
  const s = backend.info?.().settings;
  let theme = s?.theme, accent = s?.accent, density = s?.density, modsView = s?.modsView;
  if (!s) { try { theme = localStorage.getItem('tmhub.theme') ?? undefined; accent = localStorage.getItem('tmhub.accent') ?? undefined; density = localStorage.getItem('tmhub.density') ?? undefined; modsView = localStorage.getItem('tmhub.modsView') ?? undefined; } catch { /* no storage */ } }
  return {
    theme: theme === 'light' || theme === 'midnight' ? theme : 'dark',
    accent: ACCENTS.includes(accent as (typeof ACCENTS)[number]) ? accent! : 'orange',
    density: density === 'compact' ? 'compact' : 'normal',
    modsView: modsView === 'list' ? 'list' : 'tiles',
  };
};
const loadMode = (): HubMode => { try { return localStorage.getItem('tmhub.mode') === 'tas' ? 'tas' : 'play'; } catch { return 'play'; } };

/** TMLoader profile name to start with, or null for "No mods" / sample profiles. */
export const tmlName = (p: Profile | null | undefined) => (p && p.real && p.id.startsWith('tml:') ? p.name : null);

function useHub() {
  const [snapshot, setSnapshot] = useState<Snapshot>(() => backend.snapshot());
  const [index, setIndex] = useState<ModIndex>(() => backend.modIndex());
  const [hubVersion, setHubVersion] = useState(0);
  const games = useMemo(() => buildGames(snapshot), [snapshot]);
  const mods = useMemo(() => (hubVersion >= 0 ? buildMods(snapshot, index) : []), [snapshot, index, hubVersion]);
  const [profiles, setProfiles] = useState<Profile[]>(() => buildProfiles(snapshot));
  const [route, setRoute] = useState<Route>(parseHash);
  const [selectedGame, setSelectedGame] = useState<string>(() => {
    const p = new URLSearchParams(location.search).get('game');
    if (p) return p;
    const inst = buildGames(backend.snapshot()).filter((g) => g.installed);
    const def = backend.info?.().settings.defaultGame || loadPref('tmhub.defaultGame');
    if (def && inst.some((g) => g.id === def)) return def;
    return inst.some((g) => g.id === 'tmuf') ? 'tmuf' : inst[0]?.id ?? 'tmuf';
  });
  const [mode, setModeState] = useState<HubMode>(loadMode);
  const [look, setLookState] = useState<Look>(loadLook);
  /** Applied at once; saved in the background. */
  const setLook = useCallback((patch: Partial<Look>) => {
    setLookState((l) => ({ ...l, ...patch }));
    if (isNative && backend.saveSettings) backend.saveSettings(patch).catch(() => {});
    else try { Object.entries(patch).forEach(([k, v]) => localStorage.setItem('tmhub.' + k, String(v))); } catch { /* no storage */ }
  }, []);
  const setMode = useCallback((m: HubMode) => {
    setModeState(m);
    try { localStorage.setItem('tmhub.mode', m); } catch { /* preview without storage */ }
    go(m === 'tas' ? 'tashome' : 'home');
  }, []);
  // "Offline only" is shown once per launcher start, before the first TAS launch.
  const tasAck = useRef(false);
  /** Opens a map a "Play in <game>" button downloaded (set below, once profiles are known). */
  const autoPlay = useRef<((info: WebDownload) => void) | null>(null);
  const [activeProfile, setActiveProfile] = useState<Record<string, string>>(() => {
    const def = snapshot.tmloader.defaultProfiles?.TmForever;
    return { forever: def ? 'tml:' + def : '', 'tm2-stadium': 's:tm2-photos', tm2020: 's:tm20-training', 'tm2-canyon': 's:canyon-default', 'tmn-eswc': 's:eswc-default' };
  });
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [downloads, setDownloads] = useState<WebDownload[]>([]);
  const [webUrl, setWebUrl] = useState<string>('');
  const [webLoading, setWebLoading] = useState(false);
  const [pendingWeb, setPendingWeb] = useState<{ mode: 'maps' | 'skins' | 'tas'; game: string; url: string } | null>(null);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [driveScan, setDriveScan] = useState<{ running: boolean; dir?: string; dirs?: number; found?: number; result?: string } | null>(null);

  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback((r: ActionResult | Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random();
    const t: Toast = { id, ...(r as Omit<Toast, 'id'>) };
    setToasts((list) => [...list.slice(-2), t]);
    if (!t.sticky) setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), t.actions?.length ? 12000 : t.ok === false ? 9000 : 5200);
  }, []);

  // Separate installations: each one is a profile of its own ("inst:<id>") that starts its folder.
  const [instances, setInstances] = useState<Instance[]>([]);
  const reloadInstances = useCallback(async () => {
    if (!backend.instances) return;
    try { setInstances(await backend.instances.list()); } catch { /* keep the last list */ }
  }, []);
  useEffect(() => { void reloadInstances(); }, [reloadInstances]);

  // Keep real TMLoader profiles in sync with the snapshot, keep sample and unsaved ones.
  useEffect(() => {
    const inst: Profile[] = instances.map((i) => ({ id: 'inst:' + i.id, game: profileGameKey(i.game), name: i.name, mods: [], real: true, instance: i.id }));
    setProfiles((list) => [...buildProfiles(snapshot), ...inst, ...list.filter((p) => p.id.startsWith('new:'))]);
  }, [snapshot, instances]);

  const handleLinks = useCallback((links: string[]) => {
    // tmhub://mod/<id>, tmhub://install/<id>, tmhub://game/<id>, tmhub://maps/<game>?url=..., tmhub://skins/<game>?url=...,
    // tmhub://pack/<data> (a shared profile: shown for checking, nothing is installed without a click)
    for (const raw of links) {
      if (/^tmhub:(\/\/)?pack\//i.test(raw)) {
        backend.packs?.decode(raw).then((pack) => { go('profiles'); setDialog({ kind: 'import', pack }); })
          .catch((e) => toast({ message: String(e), ok: false }));
        continue;
      }
      let u: URL;
      try { u = new URL(raw); } catch { continue; }
      if (/^tmhub:(\/\/)?install\?/i.test(raw)) { const r = hubInstallLink(u); if ('id' in r) { linkIntent.install = r.id; go('mods', r.id); } else toast({ message: r.error, ok: false }); continue; }
      const parts = (u.host + u.pathname).split('/').filter(Boolean).map(decodeURIComponent);
      const [what, arg] = parts;
      if ((what === 'mod' || what === 'install') && arg) {
        // ESWC Autosave writes dinput8.dll: it installs only through its dialog on its mod page (never automatically).
        if (arg === 'mod-eswc-autosave') { go('mods', arg); continue; }
        if (what === 'install' && CATALOG.some((c) => c.id === arg)) linkIntent.install = arg;
        go('mods', arg);
        if (what === 'install') toast({ message: tr('links.install', { id: arg }) });
      } else if (what === 'game' && arg) go('game', arg);
      else if ((what === 'maps' || what === 'skins') && arg) {
        const url = u.searchParams.get('url');
        if (url) setPendingWeb({ mode: what, game: arg, url });
        go(what, arg);
      } else toast({ message: tr('links.unknown', { link: raw }), ok: false });
    }
  }, [toast]);

  useEffect(() => onHubIndexChange(() => setHubVersion((v) => v + 1)), []); // hub index applied: Mods page rebuilds
  useEffect(() => {
    if (!backend.on) return;
    const off = backend.on((e) => {
      switch (e.type) {
        case 'snapshot': setSnapshot(e.snapshot); break;
        case 'modIndex': setIndex(e.index); break;
        case 'hubData': if (applyHubData(e.data)) setHubVersion((v) => v + 1); break;
        case 'webPage': setWebUrl(e.url); setWebLoading(e.loading); break;
        case 'webDownload': if (e.info.caught) setDownloads((d) => [{ ...e.info, success: null }, ...d.filter((x) => x.path !== e.info.path)].slice(0, 6)); break;
        case 'webDownloadDone':
          setDownloads((d) => {
            const known = d.some((x) => x.path === e.info.path);
            if (!known && !e.info.caught) return d;
            return known ? d.map((x) => (x.path === e.info.path ? { ...x, success: e.info.success } : x)) : [e.info, ...d].slice(0, 6);
          });
          // "Play in <game>" button on an exchange page: open the saved map in the game.
          if (e.info.play && e.info.caught && e.info.success && e.info.path && e.info.kind === 'map') autoPlay.current?.(e.info);
          if (!e.info.caught && e.info.success && e.info.path) toast({ message: tr('web.savedTo', { folder: e.info.folder }), actions: [{ label: tr('common.show'), run: () => backend.reveal?.(e.info.path!) }] });
          break;
        // A page in the embedded browser wants to open another site or start a game: ask first.
        case 'webExternal':
          toast({
            message: /^https?:/i.test(e.url) ? tr('web.openSite', { host: (() => { try { return new URL(e.url).host; } catch { return e.url; } })() }) : tr('web.openGame'),
            command: e.url, sticky: true,
            actions: [{ label: tr('common.open'), primary: true, run: () => { backend.openExternal(e.url).then((r) => { if (!r.ok) toast(r); }); } }],
          });
          break;
        case 'deepLink': handleLinks(e.links); break;
        case 'driveScan': setDriveScan({ running: true, dir: e.dir, dirs: e.dirs, found: e.found }); break;
        case 'driveScanDone':
          setDriveScan({ running: false, result: e.cancelled ? tr('scan.cancelled') : tr('scan.result', { n: e.found.length, s: e.seconds }) });
          toast({ message: e.cancelled ? tr('scan.cancelledToast') : tr('scan.doneToast', { n: e.found.length }) });
          break;
        case 'gameDownload':
          setBusy((b) => ({ ...b, [e.game]: e.total ? `${Math.round((e.received / e.total) * 100)} %` : `${Math.round(e.received / 1e6)} MB` }));
          break;
        case 'gameSetupDone':
          setBusy((b) => { const n = { ...b }; delete n[e.game]; return n; });
          toast({ message: e.error ? tr('setup.failed', { error: e.error }) : tr('setup.closed'), ok: !e.error });
          break;
        case 'modProgress': setBusy((b) => ({ ...b, ['mod:' + e.mod]: e.step })); break;
      }
    });
    const pending = backend.info?.().pendingLinks ?? [];
    if (pending.length) handleLinks(pending);
    return off;
  }, [handleLinks, toast]);

  // Forever: play mode never lists a profile with TMInterface, TAS mode lists only those.
  const profilesFor = useCallback((gameId: string) => profiles.filter((p) => p.game === profileGameKey(gameId) && profileFits(p, mode)), [profiles, mode]);
  const activeKey = useCallback((gameKey: string) => (mode === 'tas' ? gameKey + ':tas' : gameKey), [mode]);
  const profileFor = useCallback((gameId: string) => {
    const list = profilesFor(gameId);
    const id = activeProfile[activeKey(profileGameKey(gameId))];
    return list.find((p) => p.id === id) ?? list[0] ?? null;
  }, [profilesFor, activeProfile, activeKey]);
  /** Remembers the chosen profile per game, separately for play and TAS mode. */
  const selectProfile = useCallback((gameKey: string, id: string) => {
    setActiveProfile((a) => ({ ...a, [activeKey(gameKey)]: id }));
  }, [activeKey]);

  const game = useCallback((id: string) => games.find((g) => g.id === id)!, [games]);
  autoPlay.current = (info: WebDownload) => {
    const g = games.find((x) => x.id === info.game);
    if (!g?.installed || !backend.openMap || !info.path) return;
    void backend.openMap(info.game, g.family === 'forever' ? tmlName(profileFor(info.game)) : null, info.path)
      // ESWC and Sunrise have no /file switch: the game starts, the map waits under Downloaded.
      .then((r) => toast(mapResult(r)));
  };

  // Theme and accent live on <html>, so dialogs, menus and the page background follow too.
  const lookCover = games.find((g) => g.id === selectedGame)?.art?.cover;
  useEffect(() => {
    const r = document.documentElement;
    r.dataset.theme = look.theme;
    // index.html's start screen reads this before any script runs (settings.json is not readable that early).
    try { localStorage.setItem('tmhub.splashTheme', look.theme); } catch { /* no storage */ }
    r.dataset.accent = look.accent;
    r.dataset.density = look.density;
    if (look.accent === 'game') applyGameAccent(lookCover); else clearGameAccent();
  }, [look, lookCover]);

  // Launch state per game: shown on the Play button right after the click.
  const [launching, setLaunching] = useState<Record<string, LaunchStep>>({});
  const setLaunch = useCallback((id: string, step: LaunchStep | null) => setLaunching((m) => {
    const n = { ...m };
    if (step) n[id] = step; else delete n[id];
    return n;
  }), []);

  const commandFor = useCallback((g: GameView, profile: Profile | null) => {
    const inst = profile?.instance ? instances.find((i) => i.id === profile.instance) : null;
    if (inst?.exe) return `"${inst.path}\\${inst.exe}"`;
    if (g.family === 'forever' && tmlName(profile) && snapshot.tmloader.installed) return tmloaderCommand(snapshot, profile!.name);
    return g.launchCommand ?? '';
  }, [snapshot, instances]);

  // The one play action of the launcher. `via` replaces the start call itself (Horizon Client card: start with
  // its profile or in safe mode); the checks, the button state, the error toast and the process watch stay the same.
  const play = useCallback(async (gameId: string, join?: string | null, force = false, dir: string | null = null, via?: () => Promise<ActionResult>) => {
    const g = game(gameId);
    const p = profileFor(gameId);
    if (!g.installed) { toast({ message: tr('play.notInstalled', { game: g.name }) }); return; }
    if (mode === 'tas') {
      // TAS mode: never join a server; say "offline only" once before the first launch.
      if (join) { toast({ message: tr('tas.noJoin') }); return; }
      if (!force && !tasAck.current) {
        setConfirm({
          title: tr('tas.offlineTitle'), ok: tr('tas.offlineOk'), cancel: tr('common.cancel'),
          text: tr('tas.offlineText'),
          onOk: () => { tasAck.current = true; play(gameId, null, true, dir, via); },
        });
        return;
      }
    }
    if (join && !force && isTasProfile(p)) {
      // TMX rules: TAS tools offline only. Ask before joining a server with TMInterface on.
      setConfirm({
        title: tr('tas.joinTitle'), ok: tr('tas.joinAnyway'), cancel: tr('common.cancel'),
        text: tr('tas.joinText', { profile: p!.name }),
        onOk: () => { play(gameId, join, true, dir, via); },
      });
      return;
    }
    if (launching[gameId] && launching[gameId] !== 'running') return; // starting: the button shows it, no double launch
    if (launching[gameId] === 'running' && !force) {
      // Already running: a second copy only when the user really wants one.
      setConfirm({
        title: tr('play.againTitle', { game: g.name }), ok: tr('play.againOk'), cancel: tr('common.cancel'),
        text: tr('play.againText'),
        onOk: () => { play(gameId, join, true, dir, via); },
      });
      return;
    }
    let cmd = commandFor(g, p);
    if (join) cmd += `\n${join}`;
    const t0 = performance.now();
    const viaTml = g.family === 'forever' && !!tmlName(p);
    setLaunch(gameId, viaTml ? 'tmloader' : 'starting');
    let r: ActionResult;
    try {
      r = via ? await via() : await backend.launch({ gameId, profileId: p?.id, profileName: g.family === 'forever' ? tmlName(p) : null, join, gameName: g.name, instanceId: dir ? null : p?.instance ?? null, dir }, cmd);
    } catch (e) {
      r = { ok: false, message: String(e) };
    }
    backend.perfLog?.('play-click-to-spawn', performance.now() - t0);
    if (!r.ok && r.message.startsWith(DEFENDER_MARK)) {
      // Windows Defender holds the file (backend: defender.rs). We never add exclusions: the player allows it.
      setLaunch(gameId, null);
      toast({ ok: false, sticky: true, message: tr('defender.blocks', { file: r.message.slice(DEFENDER_MARK.length) }) + ' ' + tr('defender.allow'),
        actions: [{ label: tr('defender.open'), primary: true, run: () => void backend.openExternal(DEFENDER_HISTORY) }] });
      return;
    }
    if (!r.ok) { setLaunch(gameId, null); toast({ ...r, ok: false, message: tr('play.failed', { game: g.name, error: r.message }) }); return; }
    if (!backend.isRunning) { setLaunch(gameId, null); toast(r); return; }
    setLaunch(gameId, 'waiting');
    // Watch for the game's process (up to 90 s), then show "Running" while it lives.
    for (let i = 0; i < 90; i++) {
      await new Promise((res) => setTimeout(res, 1000));
      if (await backend.isRunning(gameId)) {
        backend.perfLog?.('play-click-to-process', performance.now() - t0);
        setLaunch(gameId, 'running');
        for (;;) {
          await new Promise((res) => setTimeout(res, 3000));
          if (!(await backend.isRunning(gameId))) break;
        }
        break;
      }
    }
    setLaunch(gameId, null);
  }, [game, profileFor, commandFor, toast, mode, launching]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateProfile = useCallback((id: string, fn: (p: Profile) => Profile | null) => {
    setProfiles((list) => list.flatMap((p) => {
      if (p.id !== id) return [p];
      const n = fn(p);
      return n ? [n] : [];
    }));
  }, []);

  // Mod switches: the switch shows the new state at once and stays locked until its write is done.
  // One write per profile at a time; switches clicked meanwhile wait in a queue. Only errors toast.
  const [pendingMods, setPendingMods] = useState<Record<string, boolean>>({});
  const queue = useRef(new Map<string, { profile: string; mod: string; on: boolean }>());
  const busyProfiles = useRef(new Set<string>());
  const modPending = useCallback((profileId: string, modId: string): boolean | undefined => pendingMods[profileId + '|' + modId], [pendingMods]);
  const runQueue = useCallback(async (profileId: string, name: string) => {
    if (busyProfiles.current.has(profileId)) return;
    busyProfiles.current.add(profileId);
    try {
      for (;;) {
        const next = [...queue.current.entries()].find(([, v]) => v.profile === profileId);
        if (!next) break;
        const [key, job] = next;
        queue.current.delete(key);
        const t0 = performance.now();
        const r = await backend.setProfileMod!(name, job.mod, job.on);
        console.info(`[toggle] ${job.mod} ${job.on ? 'on' : 'off'} in "${name}": ${Math.round(performance.now() - t0)} ms`);
        if (!r.ok) toast(r);
        setPendingMods((m) => { const n = { ...m }; delete n[key]; return n; });
      }
    } finally {
      busyProfiles.current.delete(profileId);
    }
  }, [toast]);

  const toggleMod = useCallback(async (profileId: string, modId: string) => {
    const p = profiles.find((x) => x.id === profileId);
    if (!p) return;
    const key = profileId + '|' + modId;
    if (key in pendingMods) return; // still writing this switch: further clicks are ignored
    const on = !p.mods.some((m) => m.id === modId);
    if (isNative && backend.setProfileMod && tmlName(p)) {
      // Real TMLoader profile: written to its yaml (backup first, refused while TMLoader or the game runs).
      setPendingMods((m) => ({ ...m, [key]: on }));
      queue.current.set(key, { profile: profileId, mod: modId, on });
      runQueue(profileId, p.name);
      return;
    }
    updateProfile(profileId, (x) => ({
      ...x,
      mods: on ? [...x.mods, { id: modId, version: null }] : x.mods.filter((m) => m.id !== modId),
    }));
  }, [profiles, updateProfile, pendingMods, runQueue]);

  return {
    snapshot, index, games, mods, profiles, setProfiles, route, selectedGame, setSelectedGame,
    activeProfile, setActiveProfile, selectProfile, mode, setMode, look, setLook, toasts, toast, dismiss, profilesFor, profileFor, game, commandFor, play,
    updateProfile, toggleMod, modPending, launching, confirm, setConfirm, dialog, setDialog, downloads, setDownloads, webUrl, webLoading, pendingWeb, setPendingWeb,
    busy, setBusy, driveScan, setDriveScan, hubVersion, instances, reloadInstances,
  };
}

export type Hub = ReturnType<typeof useHub>;
const Ctx = createContext<Hub | null>(null);
export function HubProvider({ children }: { children: ReactNode }) {
  const hub = useHub();
  return <Ctx.Provider value={hub}>{children}</Ctx.Provider>;
}
export function useHubState(): Hub {
  const v = useContext(Ctx);
  if (!v) throw new Error('no hub');
  return v;
}
