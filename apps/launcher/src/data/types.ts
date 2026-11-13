// Shapes of the generated JSON (scanner/scan.mjs, scanner/fetch-mods.mjs) and of
// the derived view model the UI works with.

export interface InstallInfo {
  source: string;
  path: string;
  exe?: string;
  launcher?: string | null;
  launch?: string | null;
  modified?: string | null;
  note?: string | null;
  steamAppId?: number | null;
  /** Console games: the player's dump file the emulator (exe) starts. */
  rom?: string | null;
  extraArgs?: string[];
}

export interface TmlVersion {
  version: string;
  installed: boolean;
  executable: string | null;
  dependencies: { id: string; version: string | null }[];
  changelog: string | null;
}

export interface TmlProduct {
  id: string;
  name: string;
  author: string | null;
  type: string | null;
  homepage: string | null;
  description: string | null;
  icon_link: string | null;
  external: boolean;
  install: string | null;
  versions: TmlVersion[];
}

export interface TmlProfile {
  name: string;
  program: { id: string; version?: string } | null;
  args: string | null;
  mods: { id: string; version: string | null }[];
  modified: string | null;
}

export interface RecentFile { name: string; modified: string | null }

export interface Snapshot {
  scannedAt: string;
  platform?: string;
  documents?: string | null;
  games: {
    tmnf: { installs: InstallInfo[] };
    tmuf: { installs: InstallInfo[] };
    'tmn-eswc': { installs: InstallInfo[]; unsupported: InstallInfo[] };
    maniaplanet: { installs: InstallInfo[]; titlePacks: string[]; ubisoftStub: boolean };
    tm2020: { installs: InstallInfo[] };
    'tm-turbo': { installs: InstallInfo[] };
    'tm-original': { installs: InstallInfo[] };
    'tm-sunrise': { installs: InstallInfo[] };
    // Newer scans only (older cached snapshots and the preview data lack them).
    'tm-2003'?: { installs: InstallInfo[] };
    'tm-ds'?: { installs: InstallInfo[] };
    'tm-turbo-ds'?: { installs: InstallInfo[] };
    'tm-wii'?: { installs: InstallInfo[] };
  };
  steamLibraries: { path: string; exists: boolean; appCount: number }[];
  epic: string[];
  tmloader: {
    installed: boolean;
    /** TMLoader.exe is there but never started (no config.yaml yet). */
    firstRun?: boolean;
    root?: string | null;
    sandbox?: boolean;
    exe?: string | null;
    version?: string | null;
    servers?: string[];
    masterserver?: string | null;
    defaultProfiles?: Record<string, string>;
    products?: Record<string, TmlProduct>;
    profiles?: TmlProfile[];
  };
  openplanet: Record<'tm2020' | 'maniaplanet', { installed: boolean; path?: string | null; plugins?: string[] }>;
  recent: Record<'forever' | 'maniaplanet' | 'tm2020', { replays: RecentFile[]; maps: RecentFile[] }>;
}

export interface RemoteVersion {
  version: string;
  executable: string | null;
  dependencies: { id: string; version: string | null }[];
  changelog: string | null;
  download: string | null;
  sha256?: string | null;
  size?: number | null;
  updated?: string | null;
}

export interface RemoteProduct {
  id: string;
  name: string;
  author: string | null;
  type: string | null;
  description: string | null;
  homepage: string | null;
  icon_link: string | null;
  icon: string | null;
  external: boolean;
  servers: string[];
  versions: RemoteVersion[];
  localOnly?: boolean;
}

export interface ModIndex {
  fetchedAt: string;
  servers: { server: string; ok: boolean; count?: number; error?: string }[];
  products: Record<string, RemoteProduct>;
}

/** classic = the first TrackMania (2003); console = DS/Wii games through an emulator. */
export type Family = 'forever' | 'eswc' | 'maniaplanet' | 'tm2020' | 'turbo' | 'legacy' | 'classic' | 'console';
export type ModSystem = 'TMLoader' | 'Openplanet' | 'None';

export interface Title {
  id: string;
  name: string;
  short: string;
  family: Family;
  year: number;
  steamAppId?: number;
  art?: { cover?: string; hero?: string; logo?: string }; // filled from generated/art.json
  gradient: string; // placeholder look when no art
  modSystem: ModSystem;
  titleId?: string; // ManiaPlanet title pack id
  store?: { label: string; url: string };
  blurb: string; // i18n key
  /** Console games: the platform and its emulator. */
  console?: { platform: 'ds' | 'wii'; emulator: 'melonds' | 'dolphin' };
}

export interface GameView extends Title {
  installed: boolean;
  install?: InstallInfo;
  launchCommand?: string;
  unsupported?: InstallInfo;
  note?: string;
}

export interface Profile {
  id: string;
  game: string; // title id or "forever" for all Forever titles
  name: string;
  mods: { id: string; version: string | null }[];
  args?: string | null;
  real: boolean; // from TMLoader on this machine
  programVersion?: string | null;
  /** Id of the profile's separate installation (own game folder, src-tauri/src/instances.rs). */
  instance?: string | null;
}
