// Shapes of every file in packages/api/dist/. The launcher, the website and the pipeline
// import this file (@tm-hub/shared); packages/api/schema/*.json is generated from it (npm run schema -w @tm-hub/api).
// Plain types only (no enums), so Node can run it without a compile step.

/** Game ids shared with the catalog (packages/catalog/catalog.json). */
export type GameId =
  | 'tmo'
  | 'tms'
  | 'eswc'
  | 'tmnf'
  | 'tmuf'
  | 'tm2-canyon'
  | 'tm2-stadium'
  | 'tm2-valley'
  | 'tm2-lagoon'
  | 'sm-storm'
  | 'tm2020'
  | 'turbo';

/** ISO 8601 date-time in UTC, e.g. "2026-11-10T16:00:00.000Z". */
export type IsoDateTime = string;

/** How one source did during the build. */
export interface SourceStatus {
  /** Source id, e.g. "modloader:https://unlimiter.net/modloader/" or "tmx:tmnf". */
  id: string;
  ok: boolean;
  /** Items this source contributed. */
  count: number;
  /** true when the items are made-up sample data (no token, no public source). */
  sample: boolean;
  /** Served from the local cache instead of the network (fresh enough or the network failed). */
  cached?: boolean;
  error?: string;
}

/** Common envelope of every list file. */
export interface FileMeta {
  /** Format version of this file; bumped on breaking changes. */
  schemaVersion: 1;
  generated: IsoDateTime;
  sources: SourceStatus[];
}

// ---------------------------------------------------------------- hub.json

export interface HubFileInfo {
  /** Relative path, e.g. "mods.json". */
  path: string;
  count: number;
  /** Some or all items are sample data. */
  sample: boolean;
}

export interface HubIndex {
  schemaVersion: 1;
  name: 'tm-hub';
  generated: IsoDateTime;
  /** Build duration in milliseconds. */
  buildMs: number;
  files: {
    mods: HubFileInfo;
    projects: HubFileInfo;
    maps: HubFileInfo;
    events: HubFileInfo;
    servers: HubFileInfo;
    catalog: HubFileInfo;
    communities: HubFileInfo;
  };
  counts: {
    mods: number;
    projects: number;
    maps: number;
    events: number;
    servers: number;
    catalog: number;
    communities: number;
    /** Players on the listed servers right now (real sources only), plus the players of the ESWC master servers. */
    playersOnline: number;
  };
  warnings: string[];
}

// ---------------------------------------------------------------- mods.json

export type ModCategory = 'graphics' | 'HUD' | 'tools' | 'TAS' | 'editor' | 'competition' | 'VR' | 'library';

export interface ModDependency {
  /** TMLoader product id, e.g. "CoreMod". */
  id: string;
  /** Semver range as in the index, e.g. "^1.0.1"; null = any. */
  version: string | null;
}

export interface ModVersion {
  version: string;
  /** DLL or EXE TMLoader loads, e.g. "TMVibrantShaders.dll". */
  executable: string | null;
  dependencies: ModDependency[];
  changelog: string | null;
  download: string | null;
  /** SHA-256 the repository index states. */
  sha256Index: string | null;
  /** SHA-256 computed by downloading the file (only the newest version is downloaded). */
  sha256: string | null;
  /** Bytes, from the download. */
  size: number | null;
  /** sha256 and sha256Index both known and different. */
  hashMismatch?: boolean;
  /** TMLoader load priority, if the index sets one. */
  priority?: number;
}

export interface Mod {
  /** TMLoader product id (the key in the index; dependencies refer to it). */
  id: string;
  /** URL-safe form of id, e.g. "tm-vibrant-shaders". */
  slug: string;
  name: string;
  author: string | null;
  description: string | null;
  homepage: string | null;
  icon: string | null;
  /** "modification" or "program" (the patched game itself). */
  type: string | null;
  /** TMLoader marks the game program as external. */
  external: boolean;
  games: GameId[];
  category: ModCategory;
  /** TMLoader game the index belongs to, e.g. "TmForever". */
  loaderGame: string;
  /** Repository URLs that list this mod (TMLoader "servers"). */
  repositories: string[];
  /** Newest version first. */
  versions: ModVersion[];
  latest: string | null;
}

export interface ModsFile extends FileMeta {
  mods: Mod[];
}

// ---------------------------------------------------------------- projects.json

export interface ReleaseAsset {
  name: string;
  size: number;
  download: string;
  downloads: number;
  contentType: string | null;
}

export interface ProjectRelease {
  tag: string;
  name: string | null;
  published: IsoDateTime | null;
  prerelease: boolean;
  url: string;
  /** Release notes (Markdown), shortened to a few thousand characters. */
  notes: string | null;
  assets: ReleaseAsset[];
}

export interface Project {
  /** "owner/repo" as GitHub spells it. */
  id: string;
  name: string;
  description: string | null;
  url: string;
  homepage: string | null;
  stars: number;
  forks: number;
  openIssues: number;
  language: string | null;
  license: string | null;
  topics: string[];
  archived: boolean;
  pushed: IsoDateTime | null;
  /** Newest non-draft release (prereleases count when there is no stable one). */
  release: ProjectRelease | null;
  /** Catalog entry ids pointing at this repository. */
  catalogIds: string[];
  games: GameId[];
}

export interface ProjectsFile extends FileMeta {
  projects: Project[];
}

// ---------------------------------------------------------------- maps.json

/** Which list a map came from. */
export type MapList = 'awarded' | 'latest';

export interface MapEntry {
  /** "<site>:<id>", e.g. "tmnf-x:3726386". */
  id: string;
  site: string;
  game: GameId;
  /** Lists the map is in (a map can be both recently awarded and new). */
  lists: MapList[];
  /** Exchange id of the map/track. */
  exchangeId: number;
  /** Name without $-formatting codes. */
  name: string;
  /** Name as stored, may contain $-formatting codes. */
  nameRaw: string;
  author: string | null;
  awards: number;
  uploaded: IsoDateTime | null;
  environment: string | null;
  /** Map page on the exchange. */
  url: string;
  thumbnail: string | null;
  download: string;
}

export interface MapsFile extends FileMeta {
  /** The order of each list per site. */
  lists: Record<MapList, string>;
  maps: MapEntry[];
}

// ---------------------------------------------------------------- events.json

export interface HubEvent {
  /** "discord:<guild>:<event>", "submitted:<file id>" or "sample:<n>". */
  id: string;
  /** "discord": Discord scheduled event; "submitted": approved through the event issue form (data/events/); "trackmania.io": TM2020 competition; "tmtas": TMTAS exchange event. */
  source: 'discord' | 'submitted' | 'trackmania.io' | 'tmtas' | 'sample';
  /** TAS event: the launcher shows it in TAS mode only. */
  tas?: boolean;
  sample: boolean;
  name: string;
  description: string | null;
  start: IsoDateTime;
  end: IsoDateTime | null;
  /** "scheduled" | "active" | "completed" | "canceled". */
  status: string;
  /** Free-text location (external events), e.g. a URL or a tmtp:// link. */
  location: string | null;
  /** Parsed game join link from the location, if any. */
  join: JoinLink | null;
  /** Community hosting the event: the Discord server, or the host named in a submitted event. */
  community: { id: string; name: string; invite: string | null } | null;
  interested: number | null;
  image: string | null;
  games: GameId[];
  /** Link to the event (Discord event URL, the submitted link, or the sample's page). */
  url: string | null;
  /** Server address "host:port" when the game has no join link (ESWC, Original, Sunrise). */
  address?: string | null;
}

export interface JoinLink {
  /** Link as written, e.g. "tmtp://#join=myserver". */
  raw: string;
  scheme: 'tmtp' | 'maniaplanet' | 'trackmania';
  /** "join", "spectate", "addfavourite", ... */
  action: string;
  /** Server login (Forever, ManiaPlanet) or address. */
  target: string;
  /** ManiaPlanet title id after "@", e.g. "TMStadium@nadeo". */
  title: string | null;
  /** Server password from "join=login:password", if present. */
  password?: string | null;
}

export interface EventsFile extends FileMeta {
  events: HubEvent[];
}

// ---------------------------------------------------------------- servers.json

export interface GameServer {
  /** "<source>:<login or id>". */
  id: string;
  /**
   * "community": registered by its owner (data/servers/), reachability checked by the build;
   * "tmf-master": TrackMania Forever master server list (needs TMF_LOGIN/TMF_PASSWORD).
   * "hub-poll": the hub's live list, servers asked directly on their game port (GET /v1/servers).
   */
  source: 'maniaplanet' | 'trackmania.io' | 'community' | 'tmf-master' | 'hub-poll' | 'sample';
  sample: boolean;
  game: GameId | null;
  /** ManiaPlanet title id, e.g. "TMStadium@nadeo" or a custom title. */
  title: string | null;
  name: string;
  nameRaw: string;
  description: string | null;
  login: string | null;
  players: number;
  maxPlayers: number;
  spectators: number | null;
  /** "World|Europe|France" (ManiaPlanet) or a region like "eu-west" (TM2020). */
  zone: string | null;
  mode: string | null;
  private: boolean;
  /** Link that starts the game and joins, when the source gives enough to build one. */
  join: string | null;
  /** Club or page the server belongs to (TM2020 club rooms). */
  club: { id: number; name: string } | null;
  /** "host:port" of the game port (community servers; ESWC, Original and Sunrise join by address). */
  address?: string | null;
  /** Community servers: game port answered a TCP connect in this build (null = not checked, e.g. login only). */
  online?: boolean | null;
  /** Community servers: last build in which the game port answered. */
  lastSeen?: IsoDateTime | null;
  /** Community servers: language of the server, e.g. "en", "de", "multi". */
  language?: string | null;
  /** Community servers: Discord invite or handle the owner chose to publish. */
  contact?: string | null;
  /** Community servers: website of the server or its community. */
  homepage?: string | null;
  /** TMF master server: maximum spectators. */
  maxSpectators?: number | null;
  /** TMF master server: environments the server runs ("Stadium", "Snow", ...), from its pack mask. */
  environments?: string[] | null;
  /** TMF master server: ladder limits of the server (points). */
  ladder?: { min: number; max: number } | null;
  /** TMF master server: a spectator password is set. */
  privateForSpectators?: boolean | null;
}

/** GET /tmf/servers?game=tmnf|tmuf on the hub backend (packages/tmf-master). */
export interface TmfServersResponse {
  game: 'tmnf' | 'tmuf';
  /** "ok": fresh list; "stale": last good list, the latest poll failed; "disabled": switched off; "unavailable": no list yet. */
  status: 'ok' | 'stale' | 'disabled' | 'unavailable';
  /** When the list was fetched from the master server (null = never). */
  fetchedAt: IsoDateTime | null;
  /** Earliest time the next poll runs (null = no poll planned). */
  nextPollAt: IsoDateTime | null;
  /** Short error text of the latest failed poll (no secrets). */
  error: string | null;
  /** Servers with source "tmf-master", join = "tmtp://#join=<login>". */
  servers: GameServer[];
}

/** One ESWC master server ("room") from getservers.php, with its counters. */
export interface MasterServerInfo {
  /** "eswc-master:<name>". */
  id: string;
  game: GameId;
  name: string;
  /** "Beginner" | "Normal" | "Expert" (ladder level of the room), null when unknown. */
  level: string | null;
  /** Players online on this master server. */
  players: number;
  /** Game servers registered on this master server. */
  servers: number;
  buddies: number;
  /** Master server address as given ("host" or "ip"), and its port. */
  address: string;
  port: number;
}

export interface ServersFile extends FileMeta {
  servers: GameServer[];
  /** Sources that need a secret or have no public list, with what is needed. */
  notAvailable: { game: GameId | 'forever'; reason: string }[];
  /** ESWC master servers with their player and server counts (getservers.php); empty when that source is off. */
  masterServers: MasterServerInfo[];
}

// ---------------------------------------------------------------- catalog.json

export type CatalogCategory =
  | 'exchange'
  | 'mod'
  | 'tool'
  | 'skins'
  | 'leaderboard'
  /** TMInterface plugins/scripts and other TAS tools; shown in TAS mode only. */
  | 'tas-plugin'
  | 'browser-addon'
  | 'servers'
  | 'community'
  | 'docs'
  /** Community environments (e.g. TrackMania Highlands). */
  | 'environment'
  | 'events';

/** Extra game ids only catalog entries use: TrackMania (2003, "TM 1.0"), Sunrise eXtreme, United (2006). */
export type CatalogGameId = GameId | 'tm1' | 'tmsx' | 'tmu2006';

/** How the launcher installs a catalog mod's file (verified against the real download). */
export interface InstallSpec {
  /** files: copy files to a base folder; tmloader-product: the zip holds <Product>/<version>/ with description.yaml. */
  kind: 'files' | 'tmloader-product';
  download: {
    /** "owner/repo": the latest release's asset. */
    github?: string;
    /** Case-insensitive glob ("*" only) for the asset name; default the first .zip, then .dll. */
    asset?: string;
    /** https direct link (Google Drive usercontent link or a Yandex Disk public link are fine). */
    url?: string;
  };
  /** game = next to the game exe, gamedata = <game>\GameData, documents = Documents\TrackMania, tmi-plugins / tmi-scripts = Documents\TMInterface\Plugins / \Scripts (tmnf, tmuf). */
  base?: 'game' | 'gamedata' | 'documents' | 'tmi-plugins' | 'tmi-scripts';
  /** Leading folders inside the zip to drop. */
  strip?: number;
  /** Path prefixes (after strip) to copy; default all files. */
  include?: string[];
  /** Launcher game ids it installs into. */
  games: string[];
  requires?: string[];
  /** Short reason or limit shown in the UI. */
  note?: string;
  /** Known SHA-256 of the download; the installer refuses another file (hub copies always set it). */
  sha256?: string;
  /** Version of the download when the source knows it (hub copies); recorded instead of "latest". */
  version?: string;
  /** Files never installed into a StarForce game (signed hub index; set on versions with the hub-allowed dinput8.dll). */
  starForceBlocked?: string[];
}

export interface CatalogEntry {
  id: string;
  name: string;
  category: CatalogCategory;
  games: CatalogGameId[];
  /** null: the file only exists as a Discord attachment (hosting "discord-attachment") or not known yet (hosting "pending"). */
  url: string | null;
  api: string | null;
  description: string | null;
  maintainer: string | null;
  language: string | null;
  status: 'alive' | 'dead' | 'unclear';
  checked: string | null;
  /** What the launcher can do with it. */
  launcher: string | null;
  archive: string | null;
  /** "owner/repo" when url or api is a GitHub repository (see projects.json). */
  github: string | null;
  /** Mods from the community Discord's mod channel and a few others: author as posted. */
  author?: string | null;
  /** Discord user id of the poster (mod channel export), when known: lets the hub claim the project for that account at login. */
  authorDiscordId?: string | null;
  /** interface, sound, block, skin, texturepack, blockskin, standalone, fix, music, vehicle, medals, utility, graphics, hud. */
  modType?: string | null;
  /** How it is installed: "tmloader", "gamedata: <target path>", "skins", "unlimiter-required", "manual", or a sentence. */
  install?: string | null;
  /** Per game how it gets installed: 'tmloader' or 'proxy:<dll>' (a DLL next to the game's exe, e.g. proxy:d3d11.dll). */
  installs?: Record<string, string>;
  /** What the launcher can install itself; null: not installable (see downloadNote). */
  installSpec?: InstallSpec | null;
  /** Why there is no installSpec ("download only via the Discord post", ...). */
  downloadNote?: string | null;
  /** Other mods or tools it needs. */
  requires?: string[];
  /** github, own-site, maniapark, archive.org, google-drive, yandex, discord-attachment. */
  hosting?: string | null;
  /** Mirrors and companion links. */
  urls?: string[];
  /** Picture URLs (https) shown as a gallery. */
  gallery?: string[];
  /** A hand-picked first picture (card banner and mod-page hero), overrides the automatic choice. */
  banner?: string;
  note?: string | null;
  /** Category "browser-addon": how the launcher's embedded browser can get it. */
  addon?: BrowserAddonSpec;
  /** Related links (companion page, docs, Discord, source, website). Old `url`/`urls` keep working. */
  links?: import('./links.ts').RelatedLink[];
}

/** A browser add-on for the launcher's embedded browser (catalog category "browser-addon"). */
export interface BrowserAddonSpec {
  /** github: installed from the author's GitHub release; store: only the store or source page is offered. */
  install: 'github' | 'store';
  github?: string;
  /** Glob of the release asset with the unpacked Chromium build. */
  asset?: string;
  /** SPDX id as stated by the source. */
  licence: string;
  /** OSI licence or the author's own release: the launcher may download it. */
  redistribution: boolean;
  manifestVersion: number | null;
  browsers: string[];
  /** Reviewed permissions and host patterns; more in the real manifest is shown as a warning. */
  permissions: string[];
  hosts: string[];
  permissionsSummary: string;
  stores: { chrome?: string; edge?: string; firefox?: string };
  icon?: string;
  /** Runs in the embedded browser (Chromium/WebView2, Manifest V3). */
  compatible: boolean;
  /** A local build may be installed (TMHUB_ADDON_DEV). */
  devInstall?: boolean;
  note?: string;
}

/** A hand-picked group of mods shown as a chip at the top of the launcher's Mods page. */
export interface CatalogCollection {
  id: string;
  name: string;
  description?: string;
  /** Catalog entry ids and TMLoader product ids. */
  entries: string[];
}

/** Picture override for a mod whose homepage is another project's repository. */
export interface CatalogPictures {
  /** TMLoader product name or catalog id. */
  mod: string;
  /** GitHub repository for README and pictures; null = none (do not use the homepage). */
  repo?: string | null;
  banner?: string;
  gallery?: string[];
  note?: string;
}

/** Related links for a TMLoader product (by product name) that has no catalog entry of its own. */
export interface CatalogModLinks {
  /** TMLoader product name or catalog id. */
  mod: string;
  links: import('./links.ts').RelatedLink[];
}

export interface CatalogFile extends FileMeta {
  /** Related links of TMLoader products. */
  modLinks?: CatalogModLinks[];
  /** Curated collections (Graphics, QoL, TAS, ...). */
  collections?: CatalogCollection[];
  /** Picture overrides (mods whose homepage shows another project). */
  pictures?: CatalogPictures[];
  /** "updated" field of the source catalog. */
  catalogUpdated: string | null;
  entries: CatalogEntry[];
}

// ---------------------------------------------------------------- communities.json

/** One Discord server of the community directory (a public Google Sheet kept by mx_eyebo / Mania Exchange). */
export interface Community {
  /** Stable id: slug of the name ("dir:" prefix), numbered when two entries share a name. */
  id: string;
  name: string;
  /** Link as written in the sheet (Discord invite or website). */
  url: string;
  /** Invite code when url is a Discord invite (discord.gg/<code>, discord.com/invite/<code>), else null. */
  invite: string | null;
  /** Column group of the sheet: "Official", "Countries & Regions", "Communities", "Teams", "People", "Creators", "Events", "Projects"; archive: "Retired/Completed/OnHiatus", "Inactive Servers". */
  group: string;
  /** Sub-section below the group, e.g. "Europe", "Track Styles", "Competitive". */
  section: string;
  /** Only for group "Countries & Regions": Europe, North America, Asia / Oceania, Middle East / Africa, South America. */
  region: string | null;
  /** false for entries of the sheet "The Archive". */
  active: boolean;
  /** Discord answered for the invite: true = valid, false = expired or unknown invite (HTTP 404), null = not checked (no invite, offline, rate limited). */
  alive: boolean | null;
  /** approximate_member_count of the invite lookup; null when unknown. */
  members: number | null;
  /** approximate_presence_count (members online); null when unknown. */
  online: number | null;
  /** Server name as Discord reports it (the sheet's name can differ). */
  guildName: string | null;
  /** Server icon on Discord's CDN, 64 px; null when the server has none or it was not looked up yet. */
  icon: string | null;
  /** "Checked on" date of the sheet's section (YYYY-MM-DD), the list maintainer's last check; null if not given. */
  checked: string | null;
  source: 'directory';
}

export interface CommunitiesFile extends FileMeta {
  /** Who keeps the list; show it next to the entries. */
  credit: { text: string; url: string };
  /** How to get a server listed. */
  suggest: string;
  communities: Community[];
}
