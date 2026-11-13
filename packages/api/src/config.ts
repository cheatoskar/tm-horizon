import fs from 'node:fs';
import path from 'node:path';
import type { GameId, ModCategory } from './types.ts';
import type { Http } from './lib/http.ts';
import type { EswcMasterConfig } from './sources/eswc-master.ts';

export interface TmxSiteConfig {
  site: string;
  game: GameId;
  host: string;
  kind: 'tracks' | 'maps';
  titlepack?: string;
}

export interface DiscordGuildConfig {
  id: string;
  name: string;
  invite?: string | null;
  games?: GameId[];
}

export interface CommunitiesConfig {
  enabled: boolean;
  /** Public Google Sheet of the Discord server list (viewing link, shown as the credit link). */
  sheetUrl: string;
  /** xlsx export of the same sheet; keeps the hyperlinks. */
  exportUrl: string;
  sheetTtlHours: number;
  inviteTtlHours: number;
  /** Pause between two Discord invite requests. */
  delayMs: number;
  /** At most this many invite lookups per build (oldest first), so the first run is spread over several builds. */
  maxLookupsPerBuild: number;
}

export interface HubConfig {
  userAgent: string;
  modloader: {
    readLocalConfig: boolean;
    masterserver: string | null;
    servers: string[];
    indexTtlMinutes: number;
    hashLatestOnly: boolean;
    fileRecheckHours: number;
    overrides: Record<string, { category?: ModCategory; games?: GameId[] }>;
  };
  github: {
    repos: string[];
    ttlMinutesAnonymous: number;
    ttlMinutesToken: number;
    minRemaining: number;
  };
  tmx: { count: number; delayMs: number; ttlMinutes: number; sites: TmxSiteConfig[] };
  discord: { guilds: DiscordGuildConfig[]; ttlMinutes: number };
  servers: {
    maniaplanet: { enabled: boolean; pages: number; pageSize: number; minPlayers: number; ttlMinutes: number };
    trackmaniaIo: { enabled: boolean; pages: number; ttlMinutes: number };
    community: { enabled: boolean; dir: string; timeoutMs: number; concurrency: number };
    eswcMaster: EswcMasterConfig;
  };
  events: { submittedDir: string; live: { trackmaniaIo: { enabled: boolean; lookup: number; ttlMinutes: number }; tmtas: { enabled: boolean; ttlMinutes: number } } };
  communities: CommunitiesConfig;
  catalog: { paths: string[]; url: string | null };
}

export function loadConfig(file: string): HubConfig {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as HubConfig;
}

/** Everything a source needs: the HTTP client, the config, the environment and a warning sink. */
export interface SourceContext {
  http: Http;
  config: HubConfig;
  root: string;
  env: Record<string, string | undefined>;
  warn: (msg: string) => void;
  log: (msg: string) => void;
}

export function resolveFrom(root: string, p: string): string {
  return path.isAbsolute(p) ? p : path.join(root, p);
}
