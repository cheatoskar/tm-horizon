// One query layer (Kysely) for both databases: SQLite through Node's built-in node:sqlite for local
// development and tests (no native module to build), PostgreSQL (pg) in production.
// JSON values are stored as text in both, timestamps as ISO 8601 strings, booleans as 0/1.
import { DatabaseSync } from 'node:sqlite';
import { Kysely, PostgresDialect, SqliteDialect, type Generated, type SqliteDatabase, type SqliteStatement } from 'kysely';

export interface UsersTable { id: string; name: string; avatar: string | null; suspended_at: string | null; suspension: string | null; strikes: number; created_at: string }
export interface IdentitiesTable { provider: string; provider_id: string; user_id: string; username: string; created_at: string }
export interface SessionsTable { id_hash: string; user_id: string; csrf: string; created_at: string; expires_at: string; last_seen: string }
export interface AuthorKeysTable { key_id: string; user_id: string; public_key: string; added_at: string; revoked_at: string | null }
export interface ProjectsTable {
  id: string; slug: string; name: string; summary: string; description: string; categories: string; tags: string; games: string; installs: string;
  license: string | null; links: string; dependencies: string; conflicts: string; author_name: string; claimed: number; catalog_id: string | null;
  state: string; removal: string | null; icon_id: string | null; banner_id: string | null; downloads: number; search_text: string;
  owner_changed_at: string | null; tmloader_product: string | null; source_url: string | null; claim_discord_id: string | null; showcase: string | null; showcase_from: string | null; created_at: string; updated_at: string;
  /** Catalog entry (packages/catalog, release policy applied) of an imported project; the index carries it while the project is unclaimed. */
  catalog_entry: string | null;
  /** hub.ts HubProjectType; null on projects from before the choice. */
  type: string | null; github_downloads: number; github_downloads_at: string | null;
}
export interface MembersTable { project_id: string; user_id: string; role: string; added_at: string }
export interface ImagesTable { id: string; project_id: string; kind: string; storage_key: string; width: number; height: number; ord: number; caption: string | null; created_at: string }
export interface VersionsTable {
  id: string; project_id: string; version: string; channel: string; changelog: string; games: string; installs: string; status: string;
  publish_at: string | null; published_at: string | null; origin: string; uploader_id: string | null; signature: string | null; verified: number;
  report: string | null; decision: string | null; file_name: string; file_size: number; file_sha256: string; storage_key: string; downloads: number; created_at: string;
  /** Further files of the same version (browser add-ons: one per browser), JSON ExtraFile[]; null = only the main file. */
  extra_files?: string | null;
}
export interface ExtraFile { name: string; size: number; sha256: string; storage_key: string; label: string | null }
export interface SourcesTable {
  id: string; project_id: string; kind: string; target: string; product: string | null; asset_pattern: string | null; etag: string | null;
  last_check: string | null; next_check: string | null; last_error: string | null; imported: number; needs_choice: string | null;
  webhook: number; quiet_checks: number; created_at: string;
}
export interface SourceSeenTable { source_id: string; ref: string; status: string; at: string }
export interface TokensTable { id: string; user_id: string; name: string; hash: string; scopes: string; projects: string | null; created_at: string; last_used: string | null; expires_at: string | null; revoked_at: string | null }
export interface ClaimsTable { id: string; project_id: string; user_id: string; method: string; detail: string; status: string; created_at: string; decided_at: string | null }
export interface ReportsTable {
  id: string; project_id: string; version_id: string | null; reason: string; explanation: string; location: string; name: string | null; email: string | null;
  status: string; resolution: string | null; created_at: string; resolved_at: string | null;
}
export interface DownloadsDailyTable { project_id: string; version_id: string; day: string; count: number }
export interface RevocationsTable { version_id: string; project_slug: string; version: string; sha256: string; reason: string; revoked_at: string }
export interface AuditTable { id: Generated<number>; at: string; actor: string; action: string; target: string; detail: string | null }
export interface GameServersTable {
  id: string; game: string; address: string; name: string; contact: string; homepage: string | null; status: string; token_hash: string | null;
  note: string | null; created_at: string; decided_at: string | null; announced_at: string | null; announce: string | null;
  /** Automatic verification: user who submitted, salted hash of the submitter's address, 1 = the submitter says it is their server, last answers of the game port. */
  submitter_id: string | null; submitter_hash: string | null; owner: number | null; verified_at: string | null; last_check_at: string | null; last_ok_at: string | null; offline_since: string | null; check_info: string | null;
  /** Ownership proof in progress: the code the operator puts into the server name or comment, who asked for it, until when. */
  claim_code: string | null; claim_user: string | null; claim_expires: string | null;
  /** Live list: server login (tmtp://#join=<login>), country, last public answer of the game port (JSON), ping from the hub, failures in a row, next poll, 'seed' for the imported list. */
  login: string | null; country: string | null; zone: string | null; live: string | null; ping_ms: number | null; poll_fail: number | null; next_poll_at: string | null; source: string | null;
}
/** TrackMania repositories found on GitHub (services/discover-github.ts). Public repository metadata only. state: new | accepted | hidden | ignored | known | skipped. */
export interface DiscoveredTable {
  repo: string; full_name: string; owner: string; name: string; description: string | null; html_url: string; homepage: string | null; language: string | null;
  topics: string; matched_topics: string; stars: number; forks: number; is_fork: number; archived: number; license: string | null; pushed_at: string | null; created_gh: string | null;
  score: number; games: string; has_readme: number | null; has_releases: number | null; state: string; note: string | null; project_slug: string | null;
  first_seen: string; last_seen: string; decided_at: string | null; decided_by: string | null;
}
export interface KvTable { key: string; value: string }

export interface DB {
  users: UsersTable; identities: IdentitiesTable; sessions: SessionsTable; author_keys: AuthorKeysTable; projects: ProjectsTable; members: MembersTable;
  images: ImagesTable; versions: VersionsTable; sources: SourcesTable; source_seen: SourceSeenTable; tokens: TokensTable; claims: ClaimsTable;
  reports: ReportsTable; downloads_daily: DownloadsDailyTable; revocations: RevocationsTable; audit: AuditTable; kv: KvTable; game_servers: GameServersTable; discovered: DiscoveredTable;
}

export type Db = Kysely<DB>;

/** node:sqlite -> the small interface Kysely's SqliteDialect expects. */
function nodeSqlite(file: string): SqliteDatabase {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const conv = (ps: ReadonlyArray<unknown>) => ps.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p instanceof Date ? p.toISOString() : p)) as never[];
  return {
    close: () => db.close(),
    prepare(sql: string): SqliteStatement {
      const st = db.prepare(sql);
      return {
        reader: st.columns().length > 0,
        all: (ps) => st.all(...conv(ps)),
        run: (ps) => {
          const r = st.run(...conv(ps));
          return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
        },
        iterate: (ps) => st.iterate(...conv(ps)) as IterableIterator<unknown>,
      };
    },
  };
}

export function openDb(url: string): Db {
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    // Loaded only when used, so development needs no running Postgres.
    return new Kysely<DB>({ dialect: new PostgresDialect({ pool: async () => {
      const { default: pg } = await import('pg');
      return new pg.Pool({ connectionString: url, max: 10 });
    } }) });
  }
  const file = url.replace(/^sqlite:/, '') || ':memory:';
  return new Kysely<DB>({ dialect: new SqliteDialect({ database: nodeSqlite(file) }) });
}

export const isPostgres = (url: string) => /^postgres(ql)?:\/\//.test(url);
