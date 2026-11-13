// The UI talks only to this interface. The prototype uses PreviewBackend (static JSON from
// the scanner, launches are only described). The Tauri shell provides `window.tmHubNative`
// (src/data/native.ts on top of the Rust commands in src-tauri/src/commands.rs): it really
// starts games, downloads and installs TMLoader mods, writes TMLoader profiles, shows TMX and
// ManiaPark in an embedded webview and saves downloads into the game folders.
import snapshotJson from '../generated/snapshot.json';
import modsJson from '../generated/mods.json';
import type { ModIndex, Snapshot } from './types';
import { createNativeBackend, isTauri } from './native';
import { tr } from '../i18n';
import type { InstallSpec } from '@tm-hub/shared';

/** What the .Gbx header says about a map. Times in milliseconds; the thumbnail is an upside-down JPEG data URL. */
export interface GbxInfo {
  version: number; classId: number;
  uid: string | null; name: string | null; author: string | null; environment: string | null; mood: string | null;
  bronze: number | null; silver: number | null; gold: number | null; authorTime: number | null;
  thumbnail: string | null; comments: string | null;
}

/** A map file in the player's folders (header facts; src-tauri/src/hosting/mapfiles.rs MapMeta). */
export interface LocalMapFile {
  path: string; name: string; folder: string; author: string; environment: string;
  authorTime: number | null; validated: boolean; uid: string; hasThumb: boolean;
}

/** An installed skin or mod (src-tauri/src/skinlib.rs). Off = moved to the launcher's own folder. */
export interface SkinItem {
  path: string; name: string; kind: 'skin' | 'mod'; folder: string; dir: string; size: number; isDir: boolean;
  modified: string | null; enabled: boolean;
  /** ManiaPark asset when the launcher installed it. */
  source: { parkType: string; parkId: string; url: string; installedAt: string } | null;
}

/** Reason class of the reachability check; "ok" = reachable. */
export interface WebCheck { reason: 'ok' | 'offline' | 'dns' | 'timeout' | 'server' | 'other'; status: number | null }

/** A browser add-on installed into the embedded browser's profile (src-tauri/src/addons.rs). */
export interface AddonInstalled {
  id: string;
  version: string;
  tag: string;
  enabled: boolean;
  /** "github:<owner/repo>" or "dev:<folder>". */
  source: string;
  sha256: string;
  /** "github-digest" | "sha256sums" | "none" | "dev" */
  verified: string;
  path: string;
  permissions: string[];
  hosts: string[];
  installedAt: string;
  extId: string | null;
}
export interface AddonsInfo { supported: boolean; reason: string | null; installed: AddonInstalled[]; dev: string[] }
/** Downloaded and checked, not installed yet: what the confirm dialog shows. */
export interface AddonPlan {
  id: string; name: string; version: string; tag: string; source: string; file: string; size: number;
  sha256: string; verified: string; permissions: string[]; hosts: string[]; extra: string[]; update: boolean;
}
export interface AddonUpdate { id: string; installed: string; latest: string | null; update: boolean; error: string | null }

export interface LaunchRequest { gameId: string; profileId?: string; profileName?: string | null; join?: string | null; gameName?: string; instanceId?: string | null; /** One of the game's install folders (Installations card); default: the chosen one. */ dir?: string | null }

/** A separate installation of a game for one profile (src-tauri/src/instances.rs). */
export interface Instance {
  id: string; name: string; game: string; source: string; root: string; path: string;
  exe: string | null; launcher: string | null; userDir: string | null; linked: boolean; created: string; exists?: boolean;
  /** Forever: TMLoader profile it starts with (through its own TMLoader copy); null = without TMLoader. */
  tmlProfile?: string | null;
}
export interface InstanceCheck { game: string; source: string; root: string; files: number; bytes: number; canLink: boolean; needBytes: number; note: string | null }
export interface InstanceUsage { files: number; realBytes: number; linkedBytes: number; linkedFiles: number }
export interface InstanceCreated { instance: Instance; warnings: string[] }
export interface ActionResult { ok: boolean; message: string; command?: string | null }

export interface Clip { name: string; path: string; size: number; modified: string | null; src?: string }
export interface CopyTarget { game: string; folder: string | null; here: boolean; sharedWith: string | null }
export interface OpPlugin {
  id: number; identifier: string; name: string; authors: string[]; short: string; image: string | null; games: string[];
  downloads: number; version: string; signed: boolean; signType: string; download: string | null; page: string; updated: number;
}
export interface OpStatus {
  installed: boolean; version: string | null; branch: string | null; gameDir: string | null; userDir: string; userDirFound: boolean; dllFound: boolean;
  latest: { url: string; version: string } | null; update: boolean;
}
export interface OpInstalledInfo { openplanet: boolean; dir: string | null; plugins: { file: string; identifier: string; isDir: boolean; version?: string | null }[] }
export interface WebDownload {
  url: string; path: string | null; folder: string | null; game: string; mode: string;
  kind: 'map' | 'replay' | 'skin' | 'mod' | 'file'; caught: boolean; success: boolean | null; message?: string | null;
  /** Started by a "Play in <game>" button on an exchange page. */
  play?: boolean;
}
export interface Verdict { sha256: string; signature: string; signed: boolean; firstTime: boolean; ok: boolean; needsConfirm: boolean; message: string }
export type GameSource =
  | { kind: 'download'; url: string; file: string; size: number; note: string }
  | { kind: 'stores'; stores: { label: string; url: string; sub: string }[]; note: string }
  | { kind: 'none'; note: string };
export interface FoundInstall { game: string; path: string; exe: string }
export interface NativeSettings {
  hubUrl: string; updateUrl: string; tmloaderDir: string | null; eswcUseLauncher: boolean; protocolAsked: boolean;
  extraFolders: string[]; foundInstalls: FoundInstall[]; installerHashes: Record<string, string>;
  /** "Show what I play in Discord". */
  discordPresence: boolean;
  /** "Show TAS tool in Discord" (only counts while discordPresence is on). */
  discordTas?: boolean;
  /** "Load game covers from the internet" (Steam library covers, cached); default on. */
  coverDownloads?: boolean;
  /** "normal" | "compact". */
  density?: string;
  /** Mods page layout: "tiles" (default) | "list". */
  modsView?: string;
  /** Game shown on Home at start; "" = automatic. */
  defaultGame?: string;
  /** Play on Home starts at once (otherwise the start panel opens first). */
  playFromHome?: boolean;
  /** "en" | "de" | "pl" | "fr"; empty = follow Windows. */
  language: string;
  /** "dark" | "midnight" | "light". */
  theme?: string;
  /** "orange" | "blue" | "green" | "purple" | "red" | "teal" | "game". */
  accent?: string;
  tickExe?: string | null;
  /** Install folder picked per game; Play starts it. */
  selectedInstall?: Record<string, string>;
  /** false on a fresh install until the setup wizard was finished or skipped; null = from before 0.4. */
  setupDone?: boolean | null;
}

export interface ReportFile { id: string; path: string; label: string; size: number; binary: boolean; include: boolean; preview: string }
export interface Report { game: string; summary: string; files: ReportFile[] }

export interface PackMod { id: string; version?: string | null; server?: string | null }
export interface Pack { tmhub: 'pack'; v: 1; name: string; game: string; program?: string | null; args?: string | null; mods: PackMod[]; tmvs?: string | null }
export interface ModCheck { id: string; version: string | null; server: string | null; status: 'installed' | 'download' | 'missing' | 'noHash' | 'unknownServer' | 'other'; sha256: string | null }
export interface PackCheck { pack: Pack; forever: boolean; mods: ModCheck[]; canImport: boolean; problem: string | null }

export interface TasFolder { key: 'scripts' | 'plugins' | 'states' | 'config' | 'replays'; path: string; exists: boolean; isFile: boolean }
export interface TasInfo {
  tminterface: boolean; dir: string | null; folders: TasFolder[]; plugins: string[];
  forevertas: { installed: boolean; version: string | null; exe: string | null; homepage: string };
  /** TICK, the Trackmania 2020 TAS tool. */
  tick?: { installed: boolean; version: string | null; exe: string | null; homepage: string };
}
export interface AppInfo {
  version: string; platform: string; settings: NativeSettings; tmloaderRoot: string | null; tmloaderDefault: string | null;
  embeddedProfile: string; clipsDir: string | null; dataDir: string; protocolCommand: string | null; protocolExpected: string; pendingLinks: string[]; pendingFiles?: string[];
  /** The build contains a Discord application id. */
  discordAvailable: boolean;
}
/** A news post of an Exchange site (src-tauri/src/news.rs). */
export interface ExchangePost {
  id: string; game: string; host: string; title: string; date: string; author: string | null; teaser: string; image: string | null; link: string;
  /** BBCode of the post (shortened); event posts and the date they name, if exactly one. */
  message?: string; event?: boolean; eventDate?: string | null;
}
export interface HubFiles { servers: unknown; projects: unknown; mods: unknown; events?: unknown; communities?: unknown }

/** Things the native side tells the UI without being asked. */
export type NativeEvent =
  | { type: 'tmloaderSetupDone'; installed: boolean; code: number | null }
  | { type: 'openplanetSetupDone'; game: string; installed: boolean; version: string | null; code: number | null }
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'modIndex'; index: ModIndex }
  | { type: 'hubData'; data: HubFiles }
  | { type: 'webPage'; url: string; loading: boolean }
  | { type: 'webDownload'; info: WebDownload }
  | { type: 'webDownloadDone'; info: WebDownload }
  | { type: 'webExternal'; url: string }
  | { type: 'deepLink'; links: string[] }
  | { type: 'openGbx'; paths: string[] }
  | { type: 'driveScan'; dir: string; dirs: number; found?: number }
  | { type: 'driveScanDone'; found: FoundInstall[]; cancelled: boolean; seconds: number }
  | { type: 'gameDownload'; game: string; received: number; total: number | null }
  | { type: 'gameSetupDone'; game: string; code: number | null; error: string | null }
  | { type: 'modProgress'; mod: string; version: string; step: string };

/** The .Gbx open dialog (gbxopen.rs) and the per-user file association (fileassoc.rs). */
export interface GbxDetected { kind: 'map' | 'replay'; uid: string | null; name: string | null; author: string | null; env: string | null; timeMs: number | null; exever: string | null; games: string[]; thumbnail: string | null }
export interface GbxChoice { game: string; label: string; dir: string; instance: string | null; main: boolean }
export interface GbxOpenInfo { path: string; file: string; detected: GbxDetected; choices: GbxChoice[] }
export interface GbxAssocHandler { progid: string; command: string | null; program: string | null; name: string | null }
export interface GbxAssocStatus { on: boolean; current: GbxAssocHandler | null; userChoice: string | null; userChoiceOurs: boolean }

/** One link-only project from the hub's GitHub list (moreprojects.rs). */
export interface MoreProject { name: string; summary: string | null; link: string; repo: string | null; kind: string | null; stars: number | null }

export interface HubBackend {
  readonly kind: 'preview' | 'native';
  /** Loads the snapshot and mod index before the first render (native only). */
  init?(): Promise<void>;
  snapshot(): Snapshot;
  modIndex(): ModIndex;
  launch(req: LaunchRequest, command: string): Promise<ActionResult>;
  installMod(modId: string, version: string, profileName: string, enable?: boolean): Promise<ActionResult>;
  openExternal(url: string): Promise<ActionResult>;
  rescan(): Promise<Snapshot>;
  /** Starts ManiaPlanet without a title; resolves when it closes. Native only. */
  openManiaPlanet?(dir: string): Promise<void>;
  // Native extras (absent in the preview).
  info?(): AppInfo;
  on?(fn: (e: NativeEvent) => void): () => void;
  setProfileMod?(profile: string, modId: string, on: boolean): Promise<ActionResult>;
  openMap?(gameId: string, profileName: string | null, path: string): Promise<ActionResult>;
  launchPreview?(gameId: string, profileName: string | null, instanceId?: string | null): Promise<string | null>;
  /** Separate installations per profile (hard-linked game folders). Errors are thrown as strings. */
  instances?: {
    list(): Promise<Instance[]>;
    check(game: string): Promise<InstanceCheck>;
    /** Throws "needs-copy: ..." when hard links are not possible and allowCopy is false. */
    create(name: string, game: string, allowCopy: boolean): Promise<InstanceCreated>;
    duplicate(id: string, name: string, allowCopy: boolean): Promise<InstanceCreated>;
    remove(id: string): Promise<void>;
    usage(id: string): Promise<InstanceUsage>;
    setTmlProfile?(id: string, profile: string | null): Promise<Instance>;
  };
  reveal?(path: string): Promise<ActionResult>;
  /** Header of a local .Gbx map (src-tauri/src/gbx.rs); gbxPick opens the file dialog (null = cancelled). */
  gbxInfo?(path: string): Promise<GbxInfo>;
  gbxPick?(): Promise<string | null>;
  /** Map details (src-tauri/src/mapinspect.rs): the bytes of a local map, its file by UID (null = not in the
   * map folders), the player's maps of a game (header facts). */
  mapBytes?(path: string): Promise<ArrayBuffer>;
  mapFind?(family: string, uid: string): Promise<string | null>;
  mapList?(game: string): Promise<LocalMapFile[]>;
  /** Installed skins and mods per game (src-tauri/src/skinlib.rs). */
  skins?: {
    installed(game: string): Promise<SkinItem[]>;
    preview(game: string, path: string): Promise<string | null>;
    setEnabled(game: string, path: string, enabled: boolean): Promise<void>;
    remove(game: string, path: string): Promise<void>;
  };
  clips?(): Promise<{ dir: string | null; clips: Clip[] }>;
  /** News posts of the Exchange sites (cached for an hour on the native side). */
  exchangeNews?(force?: boolean): Promise<ExchangePost[]>;
  /** TM Horizon's own announcements (GitHub releases of cheatoskar/tm-horizon marked as news; src-tauri/src/ownnews.rs). */
  horizonNews?(force?: boolean): Promise<ExchangePost[]>;
  /** Next page of every Exchange site (sites in `done` skipped), merged with `current` without duplicates. */
  exchangeNewsOlder?(current: ExchangePost[], done: string[]): Promise<{ posts: ExchangePost[]; more: Record<string, boolean> }>;
  web?: {
    show(mode: 'maps' | 'skins' | 'tas', game: string, rect: DOMRect, url?: string, site?: string): Promise<string>;
    bounds(rect: DOMRect): Promise<void>;
    hide(): Promise<void>;
    /** A label over the embedded page, in a native tooltip window (x: left edge, y: vertical centre, window pixels). */
    tipShow(label: string, x: number, y: number, w: number, dark: boolean): Promise<void>;
    tipHide(): Promise<void>;
    nav(action: 'back' | 'forward' | 'reload'): Promise<void>;
    navigate(url: string): Promise<void>;
    clear(): Promise<void>;
    /** The view went to another listed site by itself: keep game and site in step without reloading. */
    follow(game: string, site: string): Promise<void>;
    /** Quick reachability check of a page (about 6 s at most). */
    check(mode: 'maps' | 'skins' | 'tas', url: string): Promise<WebCheck>;
    /** Site icon as a data: URL (fetched once, cached). */
    icon(host: string): Promise<string>;
    /** "Install into" dialog: target folders per game, and copying a caught download there. */
    targets(path: string, kind: string, games: string[]): Promise<CopyTarget[]>;
    copy(path: string, kind: string, games: string[]): Promise<[string, string][]>;
  };
  /** Browser add-ons for the embedded browser (curated catalog ids only; Windows / WebView2). */
  addons?: {
    list(): Promise<AddonsInfo>;
    prepare(id: string, dev?: boolean): Promise<AddonPlan>;
    apply(id: string): Promise<AddonInstalled[]>;
    setEnabled(id: string, enabled: boolean): Promise<AddonInstalled[]>;
    remove(id: string): Promise<AddonInstalled[]>;
    check(): Promise<AddonUpdate[]>;
  };
  /** Writes a timing (ms) to the app's timings.log. */
  perfLog?(what: string, ms: number): void;
  /** Reads the game's exe and loader DLLs ahead of a start (virus scan before the click). */
  prewarmLaunch?(gameId: string): void;
  /** Is the game's process running? */
  isRunning?(gameId: string): Promise<boolean>;
  /** ESWC proxy-DLL mods: prepare (download + plan), apply after the user's OK, remove, backups. */
  eswcMods?: {
    prepare(modId: string): Promise<EswcPlan>;
    apply(modId: string): Promise<ActionResult>;
    remove(modId: string): Promise<ActionResult>;
    backups(): Promise<EswcBackup[]>;
    restore(id: string): Promise<ActionResult>;
  };
  /** Horizon Host (in-game menu + plugins): src-tauri/src/horizoncmds.rs. */
  horizon?: HorizonApi;
  /** Catalog mods with an installSpec: prepare (download + plan), apply after the user's OK, backups. */
  /** Mods installed by TM Horizon outside TMLoader's index: records, update checks, update, rollback. */
  modUpdates?: {
    installs(): Promise<InstallRecord[]>;
    /** useHub: compare hub projects with the verified hub index (the hub source is on). */
    check(useHub?: boolean): Promise<UpdateInfo[]>;
    /** spec: the hub's current install spec (new file); else the recorded one is used. */
    update(entryId: string, game: string, spec?: InstallSpec | null): Promise<ActionResult>;
    rollback(entryId: string, game: string): Promise<ActionResult>;
    setAuto(entryId: string, game: string, on: boolean): Promise<ActionResult>;
  };
  /** Guided TMLoader setup: the official installer from Tomashu's site, started after the user agreed. */
  tmloaderSetup?: {
    download(): Promise<{ path: string; url: string; size: number; sha256: string }>;
    run(path: string): Promise<void>;
  };
  catalogMods?: {
    /** `dir`: one of the game's other install folders (copy picker); default the one Play starts. */
    prepare(spec: InstallSpec, entryId: string, game: string, dir?: string | null): Promise<CatalogPlan>;
    apply(entryId: string, game: string): Promise<ActionResult>;
    backups(): Promise<CatalogBackup[]>;
    restore(id: string): Promise<ActionResult>;
  };
  /** Proxy-DLL mods found next to the game's exe (read-only). */
  proxyMods?(game: string): Promise<ProxyScan>;
  /** Link-only GitHub projects the hub lists for a game ("More projects"; empty when the hub list is not public). */
  moreProjects?(game: string): Promise<MoreProject[]>;
  gbxOpen?: {
    info(path: string): Promise<GbxOpenInfo>;
    openIn(path: string, game: string, dir: string, instance: string | null): Promise<ActionResult>;
    takePending(): Promise<string[]>;
    assocStatus(): Promise<GbxAssocStatus | null>;
    assocSet(on: boolean): Promise<GbxAssocStatus>;
  };
  /** Opens a game's replay or map folder. */
  openGameFolder?(game: string, kind: 'replays' | 'maps'): Promise<ActionResult>;
  /** A remote picture as a local, cached copy (asset URL). */
  image?(url: string): Promise<string>;
  /** Screenshot URLs of a GitHub-hosted mod (docs/images and README). */
  gallery?(repoUrl: string): Promise<string[]>;
  /** README (Markdown, links made absolute) of a GitHub-hosted mod. */
  readme?(repoUrl: string): Promise<string>;
  /** Newest GitHub releases of a mod's repository. */
  releases?(repoUrl: string): Promise<RepoRelease[]>;
  openplanet?: {
    catalog(force?: boolean): Promise<OpPlugin[]>;
    installed(game: string): Promise<OpInstalledInfo>;
    install(game: string, id: number): Promise<ActionResult>;
    /** Removes an installed plugin's .op (never a plugin folder). */
    remove?(game: string, identifier: string): Promise<ActionResult>;
    /** Openplanet itself for a game: detection, version, newest version on openplanet.dev (online). */
    status?(game: string, online?: boolean): Promise<OpStatus>;
    /** Guided install: the official installer from openplanet.dev, started visibly after the user agreed. */
    setupDownload?(game: string): Promise<{ path: string; url: string; version: string; size: number; sha256: string }>;
    setupRun?(game: string, path: string): Promise<void>;
  };
  saveSettings?(patch: Partial<Pick<NativeSettings, 'hubUrl' | 'updateUrl' | 'eswcUseLauncher' | 'protocolAsked' | 'discordPresence' | 'discordTas' | 'coverDownloads' | 'language' | 'theme' | 'accent' | 'density' | 'modsView' | 'defaultGame' | 'playFromHome' | 'setupDone'>>): Promise<NativeSettings>;
  /** Which install folder of a game Play starts (null = the first one). */
  setSelectedInstall?(game: string, dir: string | null): Promise<void>;
  protocol?: { register(): Promise<ActionResult>; unregister(): Promise<ActionResult> };
  addFolder?(): Promise<{ added: boolean; games?: string[]; path?: string; message?: string }>;
  removeFolder?(path: string): Promise<NativeSettings>;
  scanDrives?(): Promise<void>;
  cancelDriveScan?(): Promise<void>;
  gameSource?(game: string): Promise<GameSource>;
  gameDownload?(game: string): Promise<Verdict>;
  gameRunSetup?(game: string, confirmed?: boolean): Promise<void>;
  checkUpdate?(): Promise<{ current: string; latest: string; newer: boolean; url: string | null; notes: string | null }>;
  window?(action: 'minimize' | 'toggle-maximize' | 'close'): Promise<void>;
  refreshIndex?(): Promise<void>;
  report?: {
    collect(gameId: string, gameName: string, profile: string | null): Promise<Report>;
    save(gameId: string, gameName: string, profile: string | null, selected: string[], target: 'desktop' | 'downloads'): Promise<string>;
  };
  packs?: {
    encode(pack: Pack): Promise<string>;
    decode(text: string): Promise<Pack>;
    check(pack: Pack): Promise<PackCheck>;
    import(pack: Pack): Promise<ActionResult>;
    list(): Promise<Pack[]>;
    remove(name: string): Promise<void>;
    saveFile(pack: Pack): Promise<string | null>;
    openFile(): Promise<Pack | null>;
  };
  modServers?(): Promise<Record<string, string[]>>;
  /** New TMLoader profile; `copy` keeps pinned versions, program version and start arguments of a duplicated profile. */
  profileCreate?(name: string, mods: string[], copy?: { versions: (string | null)[]; programVersion?: string | null; args?: string | null }): Promise<ActionResult>;
  /** Deletes a TMLoader profile (a backup is kept; never TMLoader's default). */
  profileDelete?(name: string): Promise<ActionResult>;
  setProfileModVersion?(profile: string, modId: string, version: string | null): Promise<ActionResult>;
  tas?: { info(): Promise<TasInfo>; open(key: string): Promise<ActionResult>; startForeverTas(): Promise<ActionResult>; startTick(): Promise<ActionResult>; locateTick(): Promise<ActionResult> };
}

class PreviewBackend implements HubBackend {
  readonly kind = 'preview' as const;
  snapshot() { return snapshotJson as unknown as Snapshot; }
  modIndex() { return modsJson as unknown as ModIndex; }
  async launch(_req: LaunchRequest, command: string) {
    return { ok: true, message: tr('common.previewNothing'), command };
  }
  async installMod(modId: string, version: string, profileName: string) {
    return { ok: true, message: tr('common.previewAdded', { mod: modId, version, profile: profileName }) };
  }
  async openExternal(url: string) {
    return { ok: true, message: tr('common.previewOpen'), command: url };
  }
  async rescan() { return this.snapshot(); }
}

declare global { interface Window { tmHubNative?: HubBackend } }

if (!window.tmHubNative && isTauri()) window.tmHubNative = createNativeBackend(modsJson as unknown as ModIndex);

export const backend: HubBackend = window.tmHubNative ?? new PreviewBackend();
export const isNative = backend.kind === 'native';

export interface ProxyMod { id: string; file: string; version: string | null; files: string[]; backups: string[] }
export interface ProxyScan { mods: ProxyMod[]; unknown: string[] }
export interface RepoRelease {
  tag: string; name: string; date: string; prerelease: boolean; url: string; notes: string;
  assets: { name: string; size: number; url: string }[];
}

// ---- Horizon Host (src-tauri/src/horizonhost.rs)
export interface HhSource { kind: 'dev' | 'github'; path: string | null; version: string | null; tmlVersion: string | null; error: string | null }
export interface HhTarget { dir: string; label: string; kind: 'install' | 'instance'; instanceId: string | null; hostInstalled: string | null }
export interface HhBackup { id: string; created: string; reason: string; dir: string; files: string[] }
export interface HhPlugin { id: string; name: string; description: string | null; games: string[]; online: string | null; installed: string | null; available: string | null; enabled: boolean; compatible: boolean; /** Switching applies at the next game start (plugin.json startup_only). */ startupOnly?: boolean; /** icon.png as a data URL (hosts that ship one). */ icon?: string | null }
export interface HhExe { name: string; sha256: string; known: string | null }
export interface HhStatus {
  game: string; dir: string; hostRoot: string; installed: string | null; loader: 'horizon' | 'missing' | 'other' | 'none'; loaderOwner: string | null;
  exe: HhExe | null; source: HhSource; update: boolean; previous: HhBackup | null; previousOwner: string | null; chained: string | null; customPlugins: boolean; /** Client 0.3.0+: modules switch while the game runs. */ runtimeModules?: boolean; autosavePresent: boolean; autosaveMigrated: boolean;
  plugins: HhPlugin[]; backups: HhBackup[]; hasLog: boolean;
}
export interface HhPlanFile { path: string; action: 'new' | 'replace' | 'same' | 'keep' | 'chain' | 'chain-replace' }
export interface HhPlan { game: string; dir: string; version: string; installed: string | null; files: HhPlanFile[]; chains: string | null; autosavePresent: boolean; exeKnown: string | null; warnings: string[]; backupRoot: string }
export interface HhTmlPlan { version: string; folder: string; files: HhPlanFile[]; installed: string[] }
export interface HhTmlStatus { tmloader: boolean; installed: string[]; source: HhSource; update: boolean; profilesOn: string[]; profiles: string[]; plugins: HhPlugin[]; hostRoot: string | null; hasLog: boolean; /** Client 0.3.0+: modules switch while the game runs. */ runtimeModules?: boolean }
export interface HhLog { name: string; path: string; modified: string | null; size: number; text: string; cut: boolean }
export interface HhPluginMeta { id: string; name: string; version: string | null; description: string | null; games: string[]; online: string | null }
export interface HhCatalog { source: HhSource; plugins: HhPluginMeta[]; targets: { game: string; dir: string; label: string; hostInstalled: string | null; plugins: HhPlugin[] }[] }
/** Where a plugin goes: a legacy folder (dir) or a TMLoader profile (Forever). */
export interface HhWhere { game: string; dir?: string | null; profile?: string | null }
/** An installed Horizon Host and the newest version of its source (local build folder or GitHub). */
export interface HostUpdate { game: string; dir: string; label: string; installed: string; latest: string | null; update: boolean; source: 'dev' | 'github'; error: string | null }
export interface HorizonApi {
  /** Installed Horizon Hosts against the source's newest version; nothing is installed. */
  updates?(): Promise<HostUpdate[]>;
  source(): Promise<HhSource>;
  setSource(path: string | null): Promise<HhSource>;
  pickSource(): Promise<HhSource | null>;
  targets(game: string): Promise<HhTarget[]>;
  status(game: string, dir: string): Promise<HhStatus>;
  prepare(game: string, dir: string): Promise<HhPlan>;
  apply(game: string, dir: string): Promise<ActionResult>;
  remove(game: string, dir: string, restorePrevious: boolean): Promise<ActionResult>;
  restore(game: string, dir: string, id: string): Promise<ActionResult>;
  migrateAutosave(game: string, dir: string): Promise<ActionResult>;
  pluginInstall(w: HhWhere, id: string): Promise<ActionResult>;
  pluginRemove(w: HhWhere, id: string): Promise<ActionResult>;
  pluginEnable(w: HhWhere, id: string, on: boolean): Promise<string[]>;
  log(w: HhWhere): Promise<HhLog | null>;
  play(w: HhWhere, safe: boolean, gameName?: string): Promise<ActionResult>;
  tmlStatus(game: string, profile: string | null): Promise<HhTmlStatus>;
  tmlPrepare(): Promise<HhTmlPlan>;
  tmlApply(profiles: string[]): Promise<ActionResult>;
  tmlRemove(): Promise<ActionResult>;
  tmlSetProfile(profile: string, on: boolean): Promise<ActionResult>;
  catalog(): Promise<HhCatalog>;
}

export interface EswcPlanFile { name: string; action: 'new' | 'replace' | 'keep' | 'same' | 'remove' }
export interface EswcPlan { modId: string; version: string; installed: string | null; files: EswcPlanFile[]; conflicts: string[]; touchesDinput8: boolean; backupRoot: string }
export type { InstallSpec } from '@tm-hub/shared';
export interface CatalogPlan { entryId: string; version: string; game: string; root: string; files: { path: string; action: 'new' | 'replace' | 'same' }[]; requires: string[]; warnings: string[]; backupRoot: string }
export interface CatalogBackup { id: string; created: string; reason: string; files: string[] }
export interface EswcBackup { id: string; created: string; reason: string; files: string[] }

export interface InstallRecord { entryId: string; game: string; kind: string; source: string; version: string; asset: string; sha256: string; files: string[]; root: string; installedAt: string; backupId: string | null; autoUpdate: boolean }
export interface UpdateInfo { entryId: string; game: string; installed: string; latest: string | null; update: boolean; autoUpdate: boolean; error: string | null; via?: 'hub'; revoked?: string }
