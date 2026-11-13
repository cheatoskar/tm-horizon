// window.tmHubNative for the Tauri shell: every method is a Rust command
// (src-tauri/src/commands.rs); pushes from Rust arrive as Tauri events.
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  ActionResult, AppInfo, Clip, ExchangePost, FoundInstall, GameSource, HubBackend, HubFiles, LaunchRequest, NativeEvent, NativeSettings, Pack, PackCheck, Report, TasInfo, Verdict, WebDownload, ProxyScan, EswcPlan, EswcBackup, CatalogPlan, CatalogBackup, InstallRecord, UpdateInfo,
  GbxInfo, LocalMapFile, SkinItem, Instance, InstanceCheck, InstanceCreated, InstanceUsage, AddonsInfo, AddonPlan, AddonInstalled, AddonUpdate, HorizonApi, MoreProject, GbxOpenInfo, GbxAssocStatus } from './backend';
import type { ModIndex, Snapshot } from './types';

export const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

interface ModInstallResult { ok: boolean; message: string; enabled: boolean }

export function createNativeBackend(bundledIndex: ModIndex): HubBackend {
  let info: AppInfo;
  let snap: Snapshot;
  let index: ModIndex = bundledIndex;
  const subs = new Set<(e: NativeEvent) => void>();
  const emit = (e: NativeEvent) => subs.forEach((f) => f(e));
  // Bundled icons (public/mod-icons) first, the server's icon link otherwise.
  const bundledIcon = Object.fromEntries(Object.values(bundledIndex.products).map((p) => [p.id, p.icon]));
  const withIcons = (ix: ModIndex): ModIndex => {
    for (const p of Object.values(ix.products)) p.icon = bundledIcon[p.id] ?? p.icon_link ?? null;
    return ix;
  };
  const setSnap = (s: Snapshot) => { snap = s; emit({ type: 'snapshot', snapshot: s }); return s; };
  const res = (r: { ok: boolean; message: string; command?: string | null }): ActionResult => r;
  const err = (e: unknown): ActionResult => ({ ok: false, message: String(e) });
  let webChain: Promise<unknown> = Promise.resolve();
  const webQueue = <T,>(f: () => Promise<T>): Promise<T> => {
    const next = webChain.then(f, f);
    webChain = next.catch(() => undefined);
    return next;
  };

  const backend: HubBackend = {
    kind: 'native',
    async init() {
      // Stale-while-revalidate: show the last scan result at once, scan again in the background.
      const [i, cachedSnap] = await Promise.all([invoke<AppInfo>('app_info'), invoke<Snapshot | null>('cached_snapshot').catch(() => null)]);
      info = i;
      if (cachedSnap) {
        snap = cachedSnap;
        invoke<Snapshot>('scan').then(setSnap).catch(() => { /* keep the cached result */ });
      } else {
        snap = await invoke<Snapshot>('scan');
      }
      const cached = await invoke<ModIndex | null>('mod_index_cached');
      if (cached) index = withIcons(cached);
      const hub = await invoke<HubFiles | null>('hub_data_cached');
      if (hub) queueMicrotask(() => emit({ type: 'hubData', data: hub }));
      const on = <T,>(name: string, f: (p: T) => void) => listen<T>(name, (e) => f(e.payload));
      on<{ url: string; loading: boolean }>('web-page', (p) => emit({ type: 'webPage', ...p }));
      on<WebDownload>('web-download', (info) => emit({ type: 'webDownload', info }));
      on<WebDownload>('web-download-done', (info) => emit({ type: 'webDownloadDone', info }));
      on<string>('web-external', (url) => emit({ type: 'webExternal', url }));
      on<string[]>('deep-link', (links) => emit({ type: 'deepLink', links }));
      on<string[]>('open-gbx', (paths) => emit({ type: 'openGbx', paths }));
      on<{ installed: boolean; code: number | null }>('tmloader-setup-done', (p) => emit({ type: 'tmloaderSetupDone', ...p }));
      on<{ game: string; installed: boolean; version: string | null; code: number | null }>('openplanet-setup-done', (p) => emit({ type: 'openplanetSetupDone', ...p }));
      on<{ dir: string; dirs: number; found?: number }>('drive-scan', (p) => emit({ type: 'driveScan', ...p }));
      on<{ found: FoundInstall[]; cancelled: boolean; seconds: number }>('drive-scan-done', async (p) => {
        emit({ type: 'driveScanDone', ...p });
        setSnap(await invoke<Snapshot>('scan'));
      });
      on<{ game: string; received: number; total: number | null }>('game-download', (p) => emit({ type: 'gameDownload', ...p }));
      on<{ game: string; code: number | null; error: string | null; snapshot: Snapshot }>('game-setup-done', (p) => {
        setSnap(p.snapshot);
        emit({ type: 'gameSetupDone', game: p.game, code: p.code, error: p.error });
      });
      on<{ mod: string; version: string; step: string }>('mod-progress', (p) => emit({ type: 'modProgress', ...p }));
      // Fresh data in the background; the UI updates when it arrives.
      backend.refreshIndex!();
      invoke<HubFiles>('hub_data_refresh').then((data) => emit({ type: 'hubData', data })).catch(() => { /* bundled/cached copy stays */ });
    },
    async refreshIndex() {
      try {
        const ix = await invoke<ModIndex>('mod_index_refresh');
        if (ix.servers.some((s) => s.ok)) { index = withIcons(ix); emit({ type: 'modIndex', index }); }
      } catch { /* keep the cached index */ }
    },
    info: () => info,
    on(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
    snapshot: () => snap,
    modIndex: () => index,
    async launch(req: LaunchRequest) {
      try {
        return res(await invoke('launch_game', { gameId: req.gameId, profile: req.profileName ?? null, join: req.join ?? null, gameName: req.gameName ?? null, instance: req.instanceId ?? null, dir: req.dir ?? null }));
      } catch (e) { return err(e); }
    },
    async installMod(modId, version, profileName, enable = true) {
      try {
        const r = await invoke<ModInstallResult>('install_mod', { modId, version, profile: profileName || null, enable });
        setSnap(await invoke<Snapshot>('tml_snapshot'));
        return { ok: r.ok, message: r.message };
      } catch (e) { return err(e); }
    },
    async openExternal(url) {
      try { return res(await invoke('open_external', { url })); } catch (e) { return err(e); }
    },
    prewarmLaunch(gameId) { invoke('launch_prewarm', { gameId }).catch(() => {}); },
    perfLog(what, ms) { invoke('perf_log', { what, ms: Math.max(0, Math.round(ms)) }).catch(() => {}); },
    async isRunning(gameId) { try { return await invoke<boolean>('game_running', { gameId }); } catch { return false; } },
    async rescan() { return setSnap(await invoke<Snapshot>('scan')); },
    openManiaPlanet: (dir: string) => invoke<void>('open_maniaplanet', { dir }),
    async setProfileMod(profile, modId, on) {
      try {
        const r = res(await invoke('set_profile_mod', { profile, modId, on }));
        if (r.ok) setSnap(await invoke<Snapshot>('tml_snapshot'));
        return r;
      } catch (e) { return err(e); }
    },
    async openMap(gameId, profileName, path) {
      try { return res(await invoke('open_map', { gameId, profile: profileName, path })); } catch (e) { return err(e); }
    },
    launchPreview: (gameId, profileName, instanceId) => invoke<string | null>('launch_preview', { gameId, profile: profileName, instance: instanceId ?? null }),
    instances: {
      list: () => invoke<Instance[]>('instance_list'),
      check: (game) => invoke<InstanceCheck>('instance_check', { game }),
      create: (name, game, allowCopy) => invoke<InstanceCreated>('instance_create', { name, game, allowCopy }),
      duplicate: (id, name, allowCopy) => invoke<InstanceCreated>('instance_duplicate', { id, name, allowCopy }),
      remove: (id) => invoke<void>('instance_delete', { id }),
      usage: (id) => invoke<InstanceUsage>('instance_usage', { id }),
      setTmlProfile: (id, profile) => invoke<Instance>('instance_set_tml_profile', { id, profile }),
    },
    async gbxInfo(path) { return invoke<GbxInfo>('gbx_info', { path }); },
    async gbxPick() { return invoke<string | null>('gbx_pick'); },
    async mapBytes(path) { return invoke<ArrayBuffer>('map_inspect_bytes', { path }); },
    async mapFind(family, uid) { return invoke<string | null>('map_inspect_find', { family, uid }); },
    async mapList(game) { return invoke<LocalMapFile[]>('map_inspect_list', { game }); },
    skins: {
      installed: (game) => invoke<SkinItem[]>('skins_installed', { game }),
      preview: (game, path) => invoke<string | null>('skins_preview', { game, path }),
      setEnabled: (game, path, enabled) => invoke<void>('skins_set_enabled', { game, path, enabled }),
      remove: (game, path) => invoke<void>('skins_remove', { game, path }),
    },
    async reveal(path) {
      try { return res(await invoke('reveal_path', { path })); } catch (e) { return err(e); }
    },
    async clips() {
      const r = await invoke<{ dir: string | null; clips: Clip[] }>('list_clips');
      return { dir: r.dir, clips: r.clips.map((c) => ({ ...c, src: convertFileSrc(c.path) })) };
    },
    exchangeNews: (force) => invoke<ExchangePost[]>('exchange_news', { force: !!force }),
    horizonNews: (force) => invoke<ExchangePost[]>('horizon_news', { force: !!force }),
    exchangeNewsOlder: (current, done) => invoke<{ posts: ExchangePost[]; more: Record<string, boolean> }>('exchange_news_older', { current, done }),
    addons: {
      list: () => invoke<AddonsInfo>('addons_list'),
      prepare: (id, dev) => invoke<AddonPlan>('addons_prepare', { id, dev: !!dev }),
      apply: (id) => invoke<AddonInstalled[]>('addons_apply', { id }),
      setEnabled: (id, enabled) => invoke<AddonInstalled[]>('addons_set_enabled', { id, enabled }),
      remove: (id) => invoke<AddonInstalled[]>('addons_remove', { id }),
      check: () => invoke<AddonUpdate[]>('addons_check'),
    },
    // One at a time: a hide from the page being left must not land after the next page's show.
    web: {
      show: (mode, game, r, url, site) => webQueue(() => invoke<string>('web_show', { mode, game, site: site ?? null, url: url ?? null, x: r.left, y: r.top, w: r.width, h: r.height })),
      bounds: (r) => webQueue(() => invoke('web_bounds', { x: r.left, y: r.top, w: r.width, h: r.height })),
      hide: () => webQueue(() => invoke('web_hide')),
      tipShow: (label, x, y, w, dark) => invoke('web_tip_show', { label, x, y, w, dark }),
      tipHide: () => invoke('web_tip_hide'),
      nav: (action) => webQueue(() => invoke('web_nav', { action })),
      navigate: (url) => webQueue(() => invoke('web_navigate', { url })),
      clear: () => webQueue(() => invoke('web_clear')),
      follow: (game, site) => invoke('web_follow', { game, site }),
      check: (mode, url) => invoke('web_check', { mode, url }),
      icon: (host) => invoke<string>('site_icon', { host }),
      targets: (path, kind, games) => invoke('download_targets', { path, kind, games }),
      copy: (path, kind, games) => invoke('download_copy', { path, kind, games }),
    },
    eswcMods: {
      prepare: (modId) => invoke<EswcPlan>('eswc_mod_prepare', { modId }),
      async apply(modId) { try { return res(await invoke('eswc_mod_apply', { modId })); } catch (e) { return err(e); } },
      async remove(modId) { try { return res(await invoke('eswc_mod_remove', { modId })); } catch (e) { return err(e); } },
      backups: () => invoke<EswcBackup[]>('eswc_backups'),
      async restore(id) { try { return res(await invoke('eswc_restore', { id })); } catch (e) { return err(e); } },
    },
    horizon: ((): HorizonApi => {
      const act = async (cmd: string, args: Record<string, unknown>) => { try { return res(await invoke(cmd, args)); } catch (e) { return err(e); } };
      const w = (x: { game: string; dir?: string | null; profile?: string | null }) => ({ game: x.game, dir: x.dir ?? null, profile: x.profile ?? null });
      return {
        updates: () => invoke('horizon_updates'),
        source: () => invoke('horizon_source'),
        setSource: (path) => invoke('horizon_source_set', { path }),
        pickSource: () => invoke('horizon_source_pick'),
        targets: (game) => invoke('horizon_targets', { game }),
        status: (game, dir) => invoke('horizon_status', { game, dir }),
        prepare: (game, dir) => invoke('horizon_prepare', { game, dir }),
        apply: (game, dir) => act('horizon_apply', { game, dir }),
        remove: (game, dir, restorePrevious) => act('horizon_remove', { game, dir, restorePrevious }),
        restore: (game, dir, id) => act('horizon_restore', { game, dir, id }),
        migrateAutosave: (game, dir) => act('horizon_migrate_autosave', { game, dir }),
        pluginInstall: (x, id) => act('horizon_plugin_install', { ...w(x), id }),
        pluginRemove: (x, id) => act('horizon_plugin_remove', { ...w(x), id }),
        pluginEnable: (x, id, on) => invoke('horizon_plugin_enable', { ...w(x), id, on }),
        log: (x) => invoke('horizon_log', w(x)),
        play: (x, safe, gameName) => act('horizon_play', { ...w(x), safe, gameName: gameName ?? null }),
        tmlStatus: (game, profile) => invoke('horizon_tml_status', { game, profile }),
        tmlPrepare: () => invoke('horizon_tml_prepare'),
        async tmlApply(profiles) { const r = await act('horizon_tml_apply', { profiles }); setSnap(await invoke<Snapshot>('tml_snapshot')); return r; },
        async tmlRemove() { const r = await act('horizon_tml_remove', {}); setSnap(await invoke<Snapshot>('tml_snapshot')); return r; },
        async tmlSetProfile(profile, on) { const r = await act('horizon_tml_set_profile', { profile, on }); setSnap(await invoke<Snapshot>('tml_snapshot')); return r; },
        catalog: () => invoke('horizon_catalog'),
      };
    })(),
    modUpdates: {
      installs: () => invoke<InstallRecord[]>('mod_installs'),
      check: (useHub) => invoke<UpdateInfo[]>('mod_updates_check', { useHub: !!useHub }),
      async update(entryId, game, spec) { try { return res(await invoke('mod_update', { entryId, game, spec: spec ?? null })); } catch (e) { return err(e); } },
      async rollback(entryId, game) { try { return res(await invoke('mod_rollback', { entryId, game })); } catch (e) { return err(e); } },
      async setAuto(entryId, game, on) { try { return res(await invoke('mod_set_auto', { entryId, game, on })); } catch (e) { return err(e); } },
    },
    tmloaderSetup: {
      download: () => invoke<{ path: string; url: string; size: number; sha256: string }>('tmloader_setup_download'),
      run: (path) => invoke<void>('tmloader_setup_run', { path }),
    },
    catalogMods: {
      prepare: (spec, entryId, game, dir) => invoke<CatalogPlan>('catalog_mod_prepare', { spec, entryId, game, dir: dir ?? null }),
      async apply(entryId, game) { try { return res(await invoke('catalog_mod_apply', { entryId, game })); } catch (e) { return err(e); } },
      backups: () => invoke<CatalogBackup[]>('catalog_mod_backups'),
      async restore(id) { try { return res(await invoke('catalog_mod_restore', { id })); } catch (e) { return err(e); } },
    },
    async proxyMods(game) { return invoke<ProxyScan>('proxy_mods', { game }); },
    async moreProjects(game) { return invoke<MoreProject[]>('more_projects', { game }); },
    gbxOpen: {
      info: (path) => invoke<GbxOpenInfo>('gbx_open_info', { path }),
      async openIn(path, game, dir, instance) { try { return res(await invoke('gbx_open_in', { path, game, dir, instance })); } catch (e) { return err(e); } },
      takePending: () => invoke<string[]>('take_pending_files'),
      assocStatus: () => invoke<GbxAssocStatus | null>('gbx_assoc_status'),
      assocSet: (on) => invoke<GbxAssocStatus>('gbx_assoc_set', { on }),
    },
    async openGameFolder(game, kind) { try { return res(await invoke('open_game_folder', { game, kind })); } catch (e) { return err(e); } },
    image: async (url) => convertFileSrc(await invoke<string>('cached_image', { url })),
    gallery: (repoUrl) => invoke<string[]>('mod_gallery', { repoUrl }),
    readme: (repoUrl) => invoke<string>('mod_readme', { repoUrl }),
    releases: (repoUrl) => invoke('mod_releases', { repoUrl }),
    openplanet: {
      catalog: (force) => invoke('op_catalog', { force: !!force }),
      installed: (game) => invoke('op_installed', { game }),
      async install(game, id) { try { return res(await invoke('op_install', { game, id })); } catch (e) { return err(e); } },
      async remove(game, identifier) { try { return res(await invoke('op_remove', { game, identifier })); } catch (e) { return err(e); } },
      status: (game, online) => invoke('openplanet_status', { game, online: !!online }),
      setupDownload: (game) => invoke('openplanet_setup_download', { game }),
      setupRun: (game, path) => invoke('openplanet_setup_run', { game, path }),
    },
    async saveSettings(patch) {
      const s = await invoke<NativeSettings>('save_settings', { patch });
      info = { ...info, settings: s };
      return s;
    },
    async setSelectedInstall(game, dir) {
      await invoke('set_selected_install', { gameId: game, dir });
      const sel = { ...(info.settings.selectedInstall ?? {}) };
      if (dir) sel[game] = dir; else delete sel[game];
      info = { ...info, settings: { ...info.settings, selectedInstall: sel } };
      window.dispatchEvent(new CustomEvent('tmh-selected-install'));
    },
    protocol: {
      register: async () => { const r = res(await invoke('protocol_register')); info = await invoke<AppInfo>('app_info'); return r; },
      unregister: async () => { const r = res(await invoke('protocol_unregister')); info = await invoke<AppInfo>('app_info'); return r; },
    },
    async addFolder() {
      const r = await invoke<{ added: boolean; games?: string[]; path?: string; message?: string }>('add_folder');
      if (r.added) { info = await invoke<AppInfo>('app_info'); setSnap(await invoke<Snapshot>('scan')); }
      return r;
    },
    async removeFolder(path) {
      const s = await invoke<NativeSettings>('remove_folder', { path });
      info = { ...info, settings: s };
      setSnap(await invoke<Snapshot>('scan'));
      return s;
    },
    scanDrives: () => invoke('scan_drives'),
    cancelDriveScan: () => invoke('cancel_drive_scan'),
    gameSource: (game) => invoke<GameSource>('game_source', { game }),
    gameDownload: (game) => invoke<Verdict>('game_download', { game }),
    gameRunSetup: (game, confirmed) => invoke('game_run_setup', { game, confirmed: confirmed ?? null }),
    checkUpdate: () => invoke('check_update'),
    window: (action) => invoke('win', { action }),
    report: {
      collect: (gameId, gameName, profile) => invoke<Report>('report_collect', { gameId, gameName, profile }),
      save: (gameId, gameName, profile, selected, target) => invoke<string>('report_save', { gameId, gameName, profile, selected, target }),
    },
    packs: {
      encode: (pack) => invoke<string>('pack_encode', { pack }),
      decode: (text) => invoke<Pack>('pack_decode', { text }),
      check: (pack) => invoke<PackCheck>('pack_check', { pack }),
      async import(pack) {
        const r = res(await invoke('pack_import', { pack }));
        setSnap(await invoke<Snapshot>('tml_snapshot'));
        return r;
      },
      list: () => invoke<Pack[]>('packs_list'),
      remove: (name) => invoke('pack_remove', { name }),
      saveFile: (pack) => invoke<string | null>('pack_save_file', { pack }),
      openFile: () => invoke<Pack | null>('pack_open_file'),
    },
    modServers: () => invoke<Record<string, string[]>>('mod_servers'),
    async profileCreate(name, mods, copy) {
      try {
        const r = res(await invoke('profile_create', { name, mods, versions: copy?.versions ?? null, programVersion: copy?.programVersion ?? null, args: copy?.args ?? null }));
        setSnap(await invoke<Snapshot>('tml_snapshot'));
        return r;
      } catch (e) { return err(e); }
    },
    async profileDelete(name) {
      try {
        const r = res(await invoke('profile_delete', { name }));
        setSnap(await invoke<Snapshot>('tml_snapshot'));
        return r;
      } catch (e) { return err(e); }
    },
    async setProfileModVersion(profile, modId, version) {
      try {
        const r = res(await invoke('set_profile_mod_version', { profile, modId, version }));
        if (r.ok) setSnap(await invoke<Snapshot>('tml_snapshot'));
        return r;
      } catch (e) { return err(e); }
    },
    tas: {
      info: () => invoke<TasInfo>('tas_info'),
      async open(key) { try { return res(await invoke('tas_open', { key })); } catch (e) { return err(e); } },
      async startForeverTas() { try { return res(await invoke('forevertas_start')); } catch (e) { return err(e); } },
      async startTick() { try { return res(await invoke('tick_start')); } catch (e) { return err(e); } },
      async locateTick() { try { return res(await invoke('tick_locate')); } catch (e) { return err(e); } },
    },
  };
  return backend;
}
