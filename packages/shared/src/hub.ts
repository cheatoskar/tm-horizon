// TM Horizon Hub ("Weg B"): one place where mod authors publish, and one signed index the
// launcher reads. Shapes shared by apps/server (the hub backend), apps/portal (developer portal)
// and the launcher's hub data source (apps/launcher/src/data/hubIndex.ts + src-tauri/src/hubindex.rs).
// Plain types and constants only (no enums), so Node runs this file without a compile step.
import type { GameId, IsoDateTime } from './types.ts';

// ---------------------------------------------------------------- install types

/** Folder a "files" install copies into (same values as InstallSpec.base in types.ts). */
export type HubInstallBase = 'game' | 'gamedata' | 'documents' | 'tmi-plugins' | 'tmi-scripts';

/**
 * How the launcher installs a version's file into one game. Maps 1:1 onto the launcher's
 * InstallSpec (kind, base, strip, include), so the existing installer (catalogmods.rs) does the work.
 */
export interface HubInstall {
  /** tmloader-product: the zip holds <Product>/<version>/ with description.yaml. files: copy files to `base`. */
  kind: 'tmloader-product' | 'files';
  /** Only for kind "files". */
  base?: HubInstallBase;
  /** Leading folders inside the zip to drop (0-3). */
  strip?: number;
  /** Path prefixes (after strip) to copy; empty = all files. */
  include?: string[];
}

/** Install type ids as the portal shows them (one per HubInstall kind/base pair). */
export const HUB_INSTALL_TYPES = [
  'tmloader-product',
  'files:game',
  'files:gamedata',
  'files:documents',
  'files:tmi-plugins',
  'files:tmi-scripts',
] as const;
export type HubInstallType = (typeof HUB_INSTALL_TYPES)[number];

export function installOfType(t: HubInstallType, strip = 0, include: string[] = []): HubInstall {
  if (t === 'tmloader-product') return { kind: 'tmloader-product', strip, include };
  return { kind: 'files', base: t.slice('files:'.length) as HubInstallBase, strip, include };
}
export function typeOfInstall(i: HubInstall): HubInstallType {
  return i.kind === 'tmloader-product' ? 'tmloader-product' : (`files:${i.base ?? 'game'}` as HubInstallType);
}

/** Games a hub project can target (shared GameId plus nothing else: the hub only lists games the launcher can install into). */
export const HUB_GAMES: readonly GameId[] = ['tmnf', 'tmuf', 'eswc', 'tm2-canyon', 'tm2-stadium', 'tm2-valley', 'tm2-lagoon', 'sm-storm', 'tm2020', 'turbo', 'tmo', 'tms'];

export const HUB_CATEGORIES = ['graphics', 'hud', 'tools', 'tas', 'editor', 'competition', 'vr', 'library', 'sound', 'skins', 'blocks', 'fixes', 'interface'] as const;
export type HubCategory = (typeof HUB_CATEGORIES)[number];

// ---------------------------------------------------------------- project types

/**
 * What a project is. The author picks it in the portal (form and import); it decides how the launcher
 * offers the project. Same split as the catalog (packages/catalog/types.json: category + modType),
 * plus "browser-extension". Glyphs: PROJECT_TYPE_ICONS in modicon.ts.
 */
export const HUB_PROJECT_TYPES = [
  'mod', 'skin', 'texture-pack', 'sound-pack', 'maps', 'openplanet-plugin', 'tmi-plugin', 'tool', 'tas', 'editor', 'server', 'library',
  'browser-extension', 'docs', 'community', 'event',
] as const;
export type HubProjectType = (typeof HUB_PROJECT_TYPES)[number];

/**
 * How the launcher delivers a project of this type:
 * - game: copies the version's files into the game (install types above);
 * - files: a program or library; installed like "game" when the version has an install, else downloaded or linked;
 * - browser: a browser extension. The launcher never unpacks it into a game folder; it links to the store pages
 *   (related links) and hands the version's zip to its browser add-on manager. Versions carry no installs.
 * - link: a page (docs, community, event); no files, the launcher opens the link.
 */
export type ProjectDelivery = 'game' | 'files' | 'browser' | 'link';

export const PROJECT_TYPES: Record<HubProjectType, { label: string; hint: string; delivery: ProjectDelivery }> = {
  mod: { label: 'Mod', hint: 'Changes how the game plays, sounds or looks with code or new game files.', delivery: 'game' },
  skin: { label: 'Skin', hint: 'Car or block skins.', delivery: 'game' },
  'texture-pack': { label: 'Texture pack', hint: 'Replaces textures of the game (resource pack).', delivery: 'game' },
  'sound-pack': { label: 'Sound pack', hint: 'Replaces sounds or music.', delivery: 'game' },
  maps: { label: 'Maps', hint: 'Tracks or a track pack.', delivery: 'game' },
  'openplanet-plugin': { label: 'Openplanet plugin', hint: 'A plugin that runs inside Openplanet.', delivery: 'game' },
  'tmi-plugin': { label: 'TMInterface plugin', hint: 'A plugin or script for TMInterface.', delivery: 'game' },
  tool: { label: 'Tool', hint: 'A program that runs next to the game.', delivery: 'files' },
  tas: { label: 'TAS tool', hint: 'Tool-assisted runs: input tools, TAS editors, bots.', delivery: 'files' },
  editor: { label: 'Editor tool', hint: 'Map editor helpers and GBX file tools.', delivery: 'files' },
  server: { label: 'Server tool', hint: 'Dedicated servers, controllers and admin panels.', delivery: 'files' },
  library: { label: 'Library', hint: 'Code for other developers.', delivery: 'files' },
  'browser-extension': { label: 'Browser extension', hint: 'Runs in Chrome or Firefox. Players install it from a store page or the zip.', delivery: 'browser' },
  docs: { label: 'Documentation', hint: 'Guides and pages about something.', delivery: 'link' },
  community: { label: 'Community', hint: 'A Discord server, a club or a site.', delivery: 'link' },
  event: { label: 'Event', hint: 'A cup, a league or a one-off event.', delivery: 'link' },
};
export const isProjectType = (s: unknown): s is HubProjectType => typeof s === 'string' && (HUB_PROJECT_TYPES as readonly string[]).includes(s);

/** Project type of a catalog entry (catalog.json `category` + `modType`). */
export function projectTypeOfCatalog(category: string | null | undefined, modType: string | null | undefined): HubProjectType {
  if (category === 'browser-addon' || modType === 'browser-addon') return 'browser-extension';
  if (category === 'docs' || modType === 'docs') return 'docs';
  if (category === 'community' || category === 'leaderboard') return 'community';
  if (category === 'events') return 'event';
  if (category === 'exchange') return 'maps';
  if (category === 'tas-plugin') return 'tmi-plugin';
  if (category === 'servers') return 'server';
  switch (modType) {
    case 'texturepack': case 'blockskin': return 'texture-pack';
    case 'skin': return 'skin';
    case 'sound': case 'music': return 'sound-pack';
    case 'plugin': return 'openplanet-plugin';
    case 'tas': return 'tas';
    case 'editor': return 'editor';
    case 'server': return 'server';
    case 'library': case 'platform': return 'library';
    case 'utility': case 'ai': return 'tool';
  }
  if (category === 'skins') return 'skin';
  if (category === 'tool') return 'tool';
  return 'mod';
}

// ---------------------------------------------------------------- download counts

/**
 * What "Downloads" means on the hub (docs/mod-publishing.md, "What Downloads counts"):
 * - hub: installs and downloads through TM Horizon (the launcher and the portal's download button), counted by the
 *   server at most once per installation (or, without an installation id, per network address) and project and day;
 *   nothing about the person is stored.
 * - github: sum of `download_count` of the installable release files on GitHub (when a GitHub repository is a source).
 * - notCounted: sources that publish no numbers (TMLoader servers, Discord posts).
 */
export interface DownloadBreakdown {
  total: number;
  hub: number;
  /** null: the project has no GitHub source. */
  github: number | null;
  notCounted: ('tmloader' | 'discord')[];
}

// ---------------------------------------------------------------- signed index (what the launcher reads)

/** One downloadable file of a version: an immutable hub copy. */
export interface HubIndexFile {
  name: string;
  size: number;
  /** Lower-case hex SHA-256 of the file; the launcher refuses a download with another hash. */
  sha256: string;
  /** Download link (counts the download, then redirects to the cached copy). */
  url: string;
}

export interface HubAuthorKey {
  /** First 16 hex chars of SHA-256 over the raw 32-byte public key. */
  keyId: string;
  /** Raw 32-byte Ed25519 public key, base64. */
  publicKey: string;
}

/** Author signature over `tmhub-author-v1\n<project slug>\n<version>\n<sha256>` (UTF-8), Ed25519, base64. */
export interface HubAuthorSignature {
  keyId: string;
  sig: string;
}

export interface HubIndexVersion {
  /** Stable id ("v_..."). */
  id: string;
  version: string;
  channel: 'stable' | 'beta';
  published: IsoDateTime;
  /** Markdown, shortened to 4000 chars. */
  changelog: string | null;
  /** How it installs into each game it supports. */
  installs: Partial<Record<GameId, HubInstall>>;
  /** Primary file first. */
  files: HubIndexFile[];
  authorSignature: HubAuthorSignature | null;
  /** The hub checked authorSignature against one of the project's author keys at upload. */
  verified: boolean;
}

export interface HubDependency {
  /** Hub project slug, or a TMLoader product id when `tmloader` is true. */
  id: string;
  /** Semver range, null = any. */
  version: string | null;
  tmloader?: boolean;
}

export interface HubIndexProject {
  /** Stable id ("p_..."). */
  id: string;
  /** URL name, never changes after creation. */
  slug: string;
  name: string;
  summary: string;
  /** Display name of the author (credited original author for unclaimed projects). */
  author: string;
  /** false: imported from the catalog or crawled, not claimed by its author yet. */
  claimed: boolean;
  /** Catalog entry id this project replaces in the launcher (imported projects). */
  catalogId: string | null;
  /** What the project is (added later; older launchers ignore it). "browser-extension": never installed into a game, see ProjectDelivery. */
  type?: HubProjectType;
  icon: string | null;
  banner: string | null;
  gallery: string[];
  categories: HubCategory[];
  tags: string[];
  games: GameId[];
  license: string | null;
  links: { homepage?: string; source?: string; issues?: string; discord?: string; related?: import('./links.ts').RelatedLink[] };
  dependencies: HubDependency[];
  conflicts: HubDependency[];
  /** Showcase page of the mod (packages/shared/src/showcase.ts), cleaned; omitted when the project has none. */
  showcase?: import('./showcase.ts').Showcase;
  authorKeys: HubAuthorKey[];
  /** Total downloads (TM Horizon + GitHub release files), see DownloadBreakdown. */
  downloads: number;
  /** The parts of `downloads` (added later). */
  downloadsBy?: { hub: number; github: number };
  updated: IsoDateTime;
  /** Newest first; only published, not revoked versions. */
  versions: HubIndexVersion[];
}

/** A version the launcher must not install, and offers to remove when it is installed. */
export interface HubRevocation {
  project: string;
  version: string;
  sha256: string;
  reason: string;
  revoked: IsoDateTime;
}

/** A game server its operator registered and an admin approved (queried directly by the launcher, see docs/design/server-query.md). */
export interface HubIndexServer {
  game: 'tmnf' | 'tmuf' | 'eswc' | 'tms' | 'tmo';
  /** "host:port" of the game port. */
  address: string;
  name: string;
  homepage: string | null;
  /** Listed by a community member and checked by the hub, but the operator has not proven ownership. Absent = false (older launchers ignore it). */
  suggested?: boolean;
}

export interface HubIndexPayload {
  format: 'tmhub-index';
  schemaVersion: 1;
  /** Public base URL of the hub, e.g. "https://hub.example.org/". */
  hub: string;
  generated: IsoDateTime;
  /** Increases with every index build; the launcher refuses an index older than its last good one. */
  seq: number;
  /** After this the launcher shows the data as stale (it keeps using it). */
  expires: IsoDateTime;
  projects: HubIndexProject[];
  /** Approved game servers (added later; older launchers ignore it). */
  servers?: HubIndexServer[];
  revoked: HubRevocation[];
}

/**
 * What /v1/index.json serves. `payload` is the base64 of the UTF-8 JSON of a HubIndexPayload;
 * `sig` is Ed25519 over the bytes of HUB_INDEX_SIG_PREFIX followed by the decoded payload bytes.
 */
export interface SignedHubIndex {
  format: 'tmhub-signed-index';
  v: 1;
  alg: 'ed25519';
  keyId: string;
  payload: string;
  sig: string;
}

export const HUB_INDEX_SIG_PREFIX = 'tmhub-index-v1\n';
export const HUB_AUTHOR_SIG_PREFIX = 'tmhub-author-v1\n';
export const authorSigMessage = (slug: string, version: string, sha256: string) => `${HUB_AUTHOR_SIG_PREFIX}${slug}\n${version}\n${sha256.toLowerCase()}`;

// ---------------------------------------------------------------- checks

export type CheckSeverity = 'info' | 'warn' | 'flag' | 'reject';

export interface CheckFinding {
  /** Machine id, e.g. "zip.path-traversal", "pe.new-executable", "diff.dll-renamed", "vt.malicious". */
  code: string;
  severity: CheckSeverity;
  message: string;
  /** File inside the upload the finding is about. */
  path?: string;
}

export interface PeInfo {
  path: string;
  machine: 'x86' | 'x64' | 'arm64' | 'other';
  dll: boolean;
  imports: { dll: string; functions: string[] }[];
  exports: string[];
}

export interface CheckReport {
  /** clean: no flag/reject finding; flagged: needs review; rejected: refused, nothing published. */
  verdict: 'clean' | 'flagged' | 'rejected';
  findings: CheckFinding[];
  files: { path: string; size: number; sha256: string }[];
  pe: PeInfo[];
  virusTotal: { status: 'off' | 'clean' | 'malicious' | 'suspicious' | 'unknown' | 'queued' | 'error'; positives?: number; link?: string } | null;
  checkedAt: IsoDateTime;
}

// ---------------------------------------------------------------- API objects (portal <-> server)

export type HubRole = 'user' | 'admin';

export interface HubUser {
  id: string;
  name: string;
  avatar: string | null;
  role: HubRole;
  /** Linked logins, e.g. [{provider: 'discord', providerId: '123', username: 'name'}]. */
  identities: { provider: 'discord' | 'github' | 'dev'; providerId: string; username: string }[];
  suspended: boolean;
  /** Statement of reasons of the suspension (only for the account itself and admins). */
  suspension?: StatementOfReasons | null;
  /** Ed25519 author keys of this user. */
  keys: (HubAuthorKey & { added: IsoDateTime })[];
  created: IsoDateTime;
}

export type ProjectRole = 'owner' | 'maintainer' | 'uploader';

export type VersionStatus =
  /** Checks still running (or VirusTotal queued). */
  | 'checking'
  /** Clean update of a known project, goes live at publishAt unless cancelled. */
  | 'held'
  /** New project or flagged update: an admin decides. */
  | 'review'
  | 'published'
  | 'rejected'
  /** Author cancelled during the hold. */
  | 'cancelled'
  | 'revoked';

export interface HubSource {
  id: string;
  kind: 'github' | 'tmloader';
  /** "owner/repo" or the TMLoader server URL (ends with /). */
  target: string;
  /** TMLoader: product id inside the server's index. GitHub: unused. */
  product: string | null;
  /** Glob for the release asset; null = detected automatically. */
  assetPattern: string | null;
  lastCheck: IsoDateTime | null;
  nextCheck: IsoDateTime | null;
  lastError: string | null;
  /** Release tags / version ids already copied into the hub. */
  imported: number;
  /** A crawled release needs the author's choice (several matching assets). */
  needsChoice: { tag: string; assets: string[] } | null;
  webhook: boolean;
}

export interface ProjectInput {
  name: string;
  slug: string;
  /** What the project is. Required when a project is created; null only on projects from before the choice existed. */
  type?: HubProjectType | null;
  summary: string;
  description: string;
  categories: HubCategory[];
  tags: string[];
  games: GameId[];
  /** Default install per game, used for new versions. */
  installs: Partial<Record<GameId, HubInstall>>;
  license: string | null;
  links: { homepage?: string; source?: string; issues?: string; discord?: string; related?: import('./links.ts').RelatedLink[] };
  dependencies: HubDependency[];
  conflicts: HubDependency[];
  /** TMLoader product id for "tmloader-product" installs (DLL-only uploads and TMLoader server zips are wrapped into <Product>/<version>/). */
  tmloaderProduct?: string | null;
}

export interface HubImage {
  id: string;
  url: string;
  kind: 'icon' | 'banner' | 'gallery';
  width: number;
  height: number;
  order: number;
  caption: string | null;
}

export interface HubProject extends ProjectInput {
  id: string;
  author: string;
  claimed: boolean;
  /** Unclaimed and a Discord account is known to be the author: logging in with it claims the project (the id itself is never published). */
  discordClaimable?: boolean;
  catalogId: string | null;
  /** removed: taken down (statement of reasons in `removal`). */
  state: 'draft' | 'review' | 'listed' | 'removed';
  removal: StatementOfReasons | null;
  icon: HubImage | null;
  banner: HubImage | null;
  gallery: HubImage[];
  /** Showcase page (cleaned), or null. showcaseFrom: 'repo' = read from the repository (showcase.json / plugin.json), 'portal' = written in the editor, 'catalog' = the catalog's seed (packages/catalog/showcases). */
  showcase: import('./showcase.ts').Showcase | null;
  showcaseFrom: 'repo' | 'portal' | 'catalog' | null;
  team: { user: Pick<HubUser, 'id' | 'name' | 'avatar'>; role: ProjectRole }[];
  sources: HubSource[];
  /** Total downloads (downloadStats.total). */
  downloads: number;
  downloadStats: DownloadBreakdown;
  /** A showcase from the catalog seeds (packages/catalog/showcases) exists for this project; the Showcase tab offers it. */
  catalogShowcase: boolean;
  created: IsoDateTime;
  updated: IsoDateTime;
  /** Role of the requesting user, null for visitors. */
  myRole: ProjectRole | null;
  latest: string | null;
}

export interface HubVersion {
  id: string;
  projectId: string;
  version: string;
  channel: 'stable' | 'beta';
  changelog: string;
  games: GameId[];
  installs: Partial<Record<GameId, HubInstall>>;
  status: VersionStatus;
  /** held: when it goes live. */
  publishAt: IsoDateTime | null;
  published: IsoDateTime | null;
  files: HubIndexFile[];
  report: CheckReport | null;
  /** Where it came from: upload, api-token, github:<owner/repo>@<tag>, tmloader:<url>. */
  origin: string;
  uploader: Pick<HubUser, 'id' | 'name'> | null;
  authorSignature: HubAuthorSignature | null;
  verified: boolean;
  decision: StatementOfReasons | null;
  downloads: number;
  created: IsoDateTime;
}

/** DSA Art. 17 statement of reasons, stored with every removal, rejection and suspension. */
export interface StatementOfReasons {
  decision: 'reject-version' | 'remove-project' | 'revoke-version' | 'suspend-account' | 'restrict-visibility';
  /** Facts and circumstances the decision is based on. */
  facts: string;
  /** Terms clause, e.g. "Nutzungsbedingungen § 4 (Schadsoftware)", or the law. */
  ground: string;
  groundType: 'terms' | 'law';
  /** Detected or decided by automated means. */
  automated: boolean;
  /** How to appeal (internal complaint, court). */
  redress: string;
  decidedAt: IsoDateTime;
  decidedBy: string;
}

export const REPORT_REASONS = ['malware', 'copyright', 'stolen-mod', 'illegal', 'cheat-online', 'personal-data', 'spam', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

/** DSA Art. 16 notice ("Inhalt melden"). */
export interface ContentReportInput {
  projectSlug: string;
  versionId?: string | null;
  reason: ReportReason;
  /** Why the content is illegal or against the terms (Art. 16(2)(a)). */
  explanation: string;
  /** Exact location (Art. 16(2)(b)); filled with the project/version URL by the form. */
  location: string;
  /** Name and e-mail of the notifier (Art. 16(2)(c)); optional, needed for a reply. */
  name?: string | null;
  email?: string | null;
  /** "I believe in good faith that the information is accurate and complete" (Art. 16(2)(d)). */
  goodFaith: true;
}

export interface ContentReport extends ContentReportInput {
  id: string;
  status: 'open' | 'actioned' | 'dismissed';
  created: IsoDateTime;
  resolution: string | null;
}

export interface ReviewItem {
  kind: 'version' | 'claim' | 'report';
  id: string;
  created: IsoDateTime;
  project: Pick<HubProject, 'id' | 'slug' | 'name' | 'claimed'>;
  version?: HubVersion;
  claim?: ClaimRequest;
  report?: ContentReport;
}

export interface ClaimRequest {
  id: string;
  projectId: string;
  user: Pick<HubUser, 'id' | 'name'>;
  method: 'github' | 'tmloader-token' | 'manual';
  /** tmloader-token: the token to put into <server>/tmhub-claim.txt. manual: the user's message. */
  detail: string;
  status: 'pending' | 'approved' | 'rejected';
  created: IsoDateTime;
}

export interface ApiTokenInfo {
  id: string;
  name: string;
  /** "versions:write" (upload versions), "projects:read". */
  scopes: string[];
  /** null = every project the user may upload to. */
  projects: string[] | null;
  created: IsoDateTime;
  lastUsed: IsoDateTime | null;
  expires: IsoDateTime | null;
  revoked: boolean;
  /** Only in the response that creates it. */
  token?: string;
}

export interface DownloadStats {
  /** One row per day and version. */
  days: { day: string; version: string; count: number }[];
  /** All TM Horizon downloads of the project (not only the range). */
  total: number;
  breakdown: DownloadBreakdown;
}

export interface SearchQuery {
  q?: string;
  game?: GameId;
  category?: HubCategory;
  tag?: string;
  install?: HubInstallType;
  sort?: 'popular' | 'updated' | 'new' | 'name';
  page?: number;
  limit?: number;
}

export interface SearchResult {
  total: number;
  page: number;
  items: (Pick<HubProject, 'id' | 'slug' | 'name' | 'summary' | 'author' | 'claimed' | 'categories' | 'tags' | 'games' | 'downloads' | 'updated' | 'latest'> & { icon: string | null })[];
}

/** Error body of every non-2xx answer. */
export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
}

// ---------------------------------------------------------------- "paste a URL" import

/** What the hub found behind a GitHub repository or TMLoader server URL (POST /v1/sources/preview). */
export interface SourcePreview {
  kind: 'github' | 'tmloader';
  /** "owner/repo" or the TMLoader server base URL. */
  target: string;
  /** TMLoader servers with several products: the author picks one (then preview again with `product`). */
  products: { id: string; name: string; versions: number }[];
  product: string | null;
  name: string;
  slug: string;
  summary: string;
  /** README (GitHub) with image links made absolute. */
  description: string;
  author: string;
  license: string | null;
  links: { homepage?: string; source?: string; issues?: string; discord?: string; related?: import('./links.ts').RelatedLink[] };
  /** Pictures found (README, release files, docs/images), at most 12. */
  images: string[];
  /** Where each picture of `images` was found (same order). */
  imageFrom: ('readme' | 'release' | 'docs')[];
  /** Project type the hub guesses (catalog entry, topics, file layout); the author confirms it. null = no guess. */
  type: HubProjectType | null;
  typeReason: string;
  /** Catalog entry about this repository, and its seed showcase (packages/catalog/showcases) if it has one. */
  catalog: { id: string; name: string } | null;
  catalogShowcase: import('./showcase.ts').Showcase | null;
  /** Release files with size and GitHub download count (same order as `assets`). */
  assetInfo: { name: string; size: number; downloads: number }[];
  /** Sum of GitHub download counts of the installable release files; null for TMLoader servers. */
  githubDownloads: number | null;
  latest: { version: string; tag: string; published: string | null; prerelease: boolean } | null;
  /** Installable release files of the newest release; `asset` is the one the hub would take. */
  assets: string[];
  asset: string | null;
  /** Install type guessed from the file layout; null = the author picks. */
  install: HubInstall | null;
  installReason: string;
  /** A hub project already watches this source. */
  /** A hub project about this source; viaRepo: found by the repository link (a catalog project to claim), not by a watched source. */
  existing: { slug: string; claimed: boolean; viaRepo?: boolean } | null;
  /** The repository's showcase.json (or plugin.json "showcase"), cleaned; null when there is none. */
  showcase: import('./showcase.ts').Showcase | null;
  /** Things the author should know (archived repository, no release yet, several files fit). */
  warnings: string[];
}
