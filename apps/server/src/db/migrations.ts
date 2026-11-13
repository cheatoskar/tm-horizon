// Schema migrations, written with Kysely's schema builder so they run on SQLite and PostgreSQL.
// Add new migrations at the end; never edit one that has shipped.
import { Migrator, sql, type Kysely, type Migration } from 'kysely';
import type { Db } from './db.ts';

export const migrationsFor = (sqlite: boolean): Record<string, Migration> => ({
  '0001-initial': {
    async up(db: Kysely<unknown>) {
      await db.schema.createTable('users')
        .addColumn('id', 'text', (c) => c.primaryKey()).addColumn('name', 'text', (c) => c.notNull()).addColumn('avatar', 'text')
        .addColumn('suspended_at', 'text').addColumn('suspension', 'text').addColumn('strikes', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('created_at', 'text', (c) => c.notNull()).execute();
      await db.schema.createTable('identities')
        .addColumn('provider', 'text', (c) => c.notNull()).addColumn('provider_id', 'text', (c) => c.notNull())
        .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade')).addColumn('username', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull()).addPrimaryKeyConstraint('identities_pk', ['provider', 'provider_id']).execute();
      await db.schema.createTable('sessions')
        .addColumn('id_hash', 'text', (c) => c.primaryKey()).addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
        .addColumn('csrf', 'text', (c) => c.notNull()).addColumn('created_at', 'text', (c) => c.notNull()).addColumn('expires_at', 'text', (c) => c.notNull())
        .addColumn('last_seen', 'text', (c) => c.notNull()).execute();
      await db.schema.createTable('author_keys')
        .addColumn('key_id', 'text', (c) => c.primaryKey()).addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
        .addColumn('public_key', 'text', (c) => c.notNull()).addColumn('added_at', 'text', (c) => c.notNull()).addColumn('revoked_at', 'text').execute();
      await db.schema.createTable('projects')
        .addColumn('id', 'text', (c) => c.primaryKey()).addColumn('slug', 'text', (c) => c.notNull().unique()).addColumn('name', 'text', (c) => c.notNull())
        .addColumn('summary', 'text', (c) => c.notNull()).addColumn('description', 'text', (c) => c.notNull())
        .addColumn('categories', 'text', (c) => c.notNull()).addColumn('tags', 'text', (c) => c.notNull()).addColumn('games', 'text', (c) => c.notNull())
        .addColumn('installs', 'text', (c) => c.notNull()).addColumn('license', 'text').addColumn('links', 'text', (c) => c.notNull())
        .addColumn('dependencies', 'text', (c) => c.notNull()).addColumn('conflicts', 'text', (c) => c.notNull())
        .addColumn('author_name', 'text', (c) => c.notNull()).addColumn('claimed', 'integer', (c) => c.notNull()).addColumn('catalog_id', 'text')
        .addColumn('state', 'text', (c) => c.notNull()).addColumn('removal', 'text').addColumn('icon_id', 'text').addColumn('banner_id', 'text')
        .addColumn('downloads', 'integer', (c) => c.notNull().defaultTo(0)).addColumn('search_text', 'text', (c) => c.notNull())
        .addColumn('owner_changed_at', 'text').addColumn('tmloader_product', 'text').addColumn('source_url', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull()).addColumn('updated_at', 'text', (c) => c.notNull()).execute();
      await db.schema.createTable('members')
        .addColumn('project_id', 'text', (c) => c.notNull().references('projects.id').onDelete('cascade'))
        .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade')).addColumn('role', 'text', (c) => c.notNull())
        .addColumn('added_at', 'text', (c) => c.notNull()).addPrimaryKeyConstraint('members_pk', ['project_id', 'user_id']).execute();
      await db.schema.createTable('images')
        .addColumn('id', 'text', (c) => c.primaryKey()).addColumn('project_id', 'text', (c) => c.notNull().references('projects.id').onDelete('cascade'))
        .addColumn('kind', 'text', (c) => c.notNull()).addColumn('storage_key', 'text', (c) => c.notNull())
        .addColumn('width', 'integer', (c) => c.notNull()).addColumn('height', 'integer', (c) => c.notNull()).addColumn('ord', 'integer', (c) => c.notNull())
        .addColumn('caption', 'text').addColumn('created_at', 'text', (c) => c.notNull()).execute();
      await db.schema.createTable('versions')
        .addColumn('id', 'text', (c) => c.primaryKey()).addColumn('project_id', 'text', (c) => c.notNull().references('projects.id').onDelete('cascade'))
        .addColumn('version', 'text', (c) => c.notNull()).addColumn('channel', 'text', (c) => c.notNull()).addColumn('changelog', 'text', (c) => c.notNull())
        .addColumn('games', 'text', (c) => c.notNull()).addColumn('installs', 'text', (c) => c.notNull()).addColumn('status', 'text', (c) => c.notNull())
        .addColumn('publish_at', 'text').addColumn('published_at', 'text').addColumn('origin', 'text', (c) => c.notNull()).addColumn('uploader_id', 'text')
        .addColumn('signature', 'text').addColumn('verified', 'integer', (c) => c.notNull().defaultTo(0)).addColumn('report', 'text').addColumn('decision', 'text')
        .addColumn('file_name', 'text', (c) => c.notNull()).addColumn('file_size', 'integer', (c) => c.notNull()).addColumn('file_sha256', 'text', (c) => c.notNull())
        .addColumn('storage_key', 'text', (c) => c.notNull()).addColumn('downloads', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('created_at', 'text', (c) => c.notNull()).addUniqueConstraint('versions_project_version', ['project_id', 'version']).execute();
      await db.schema.createIndex('versions_status').on('versions').columns(['status', 'publish_at']).execute();
      await db.schema.createTable('sources')
        .addColumn('id', 'text', (c) => c.primaryKey()).addColumn('project_id', 'text', (c) => c.notNull().references('projects.id').onDelete('cascade'))
        .addColumn('kind', 'text', (c) => c.notNull()).addColumn('target', 'text', (c) => c.notNull()).addColumn('product', 'text').addColumn('asset_pattern', 'text')
        .addColumn('etag', 'text').addColumn('last_check', 'text').addColumn('next_check', 'text').addColumn('last_error', 'text')
        .addColumn('imported', 'integer', (c) => c.notNull().defaultTo(0)).addColumn('needs_choice', 'text').addColumn('webhook', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('quiet_checks', 'integer', (c) => c.notNull().defaultTo(0)).addColumn('created_at', 'text', (c) => c.notNull()).execute();
      await db.schema.createTable('source_seen')
        .addColumn('source_id', 'text', (c) => c.notNull().references('sources.id').onDelete('cascade')).addColumn('ref', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull()).addColumn('at', 'text', (c) => c.notNull()).addPrimaryKeyConstraint('source_seen_pk', ['source_id', 'ref']).execute();
      await db.schema.createTable('tokens')
        .addColumn('id', 'text', (c) => c.primaryKey()).addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
        .addColumn('name', 'text', (c) => c.notNull()).addColumn('hash', 'text', (c) => c.notNull().unique()).addColumn('scopes', 'text', (c) => c.notNull())
        .addColumn('projects', 'text').addColumn('created_at', 'text', (c) => c.notNull()).addColumn('last_used', 'text').addColumn('expires_at', 'text').addColumn('revoked_at', 'text').execute();
      await db.schema.createTable('claims')
        .addColumn('id', 'text', (c) => c.primaryKey()).addColumn('project_id', 'text', (c) => c.notNull().references('projects.id').onDelete('cascade'))
        .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade')).addColumn('method', 'text', (c) => c.notNull())
        .addColumn('detail', 'text', (c) => c.notNull()).addColumn('status', 'text', (c) => c.notNull()).addColumn('created_at', 'text', (c) => c.notNull()).addColumn('decided_at', 'text').execute();
      await db.schema.createTable('reports')
        .addColumn('id', 'text', (c) => c.primaryKey()).addColumn('project_id', 'text', (c) => c.notNull().references('projects.id').onDelete('cascade'))
        .addColumn('version_id', 'text').addColumn('reason', 'text', (c) => c.notNull()).addColumn('explanation', 'text', (c) => c.notNull())
        .addColumn('location', 'text', (c) => c.notNull()).addColumn('name', 'text').addColumn('email', 'text').addColumn('status', 'text', (c) => c.notNull())
        .addColumn('resolution', 'text').addColumn('created_at', 'text', (c) => c.notNull()).addColumn('resolved_at', 'text').execute();
      await db.schema.createTable('downloads_daily')
        .addColumn('project_id', 'text', (c) => c.notNull()).addColumn('version_id', 'text', (c) => c.notNull()).addColumn('day', 'text', (c) => c.notNull())
        .addColumn('count', 'integer', (c) => c.notNull()).addPrimaryKeyConstraint('downloads_daily_pk', ['version_id', 'day']).execute();
      await db.schema.createTable('revocations')
        .addColumn('version_id', 'text', (c) => c.primaryKey()).addColumn('project_slug', 'text', (c) => c.notNull()).addColumn('version', 'text', (c) => c.notNull())
        .addColumn('sha256', 'text', (c) => c.notNull()).addColumn('reason', 'text', (c) => c.notNull()).addColumn('revoked_at', 'text', (c) => c.notNull()).execute();
      await db.schema.createTable('audit')
        .addColumn('id', 'integer', (c) => (sqlite ? c.primaryKey().autoIncrement() : c.primaryKey().generatedByDefaultAsIdentity())).addColumn('at', 'text', (c) => c.notNull())
        .addColumn('actor', 'text', (c) => c.notNull()).addColumn('action', 'text', (c) => c.notNull()).addColumn('target', 'text', (c) => c.notNull())
        .addColumn('detail', 'text').execute();
      await db.schema.createTable('kv').addColumn('key', 'text', (c) => c.primaryKey()).addColumn('value', 'text', (c) => c.notNull()).execute();
    },
  },
  // Showcase page of a project (packages/shared/src/showcase.ts): the cleaned JSON, and where it came from ('repo' or 'portal').
  '0004-showcase': {
    async up(db: Kysely<unknown>) {
      await db.schema.alterTable('projects').addColumn('showcase', 'text').execute();
      await db.schema.alterTable('projects').addColumn('showcase_from', 'text').execute();
    },
  },
  // Game servers registered by their operators (docs/hub/server-registration.md).
  '0003-game-servers': {
    async up(db: Kysely<unknown>) {
      await db.schema.createTable('game_servers')
        .addColumn('id', 'text', (c) => c.primaryKey()).addColumn('game', 'text', (c) => c.notNull()).addColumn('address', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull()).addColumn('contact', 'text', (c) => c.notNull()).addColumn('homepage', 'text')
        .addColumn('status', 'text', (c) => c.notNull()).addColumn('token_hash', 'text').addColumn('note', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull()).addColumn('decided_at', 'text').addColumn('announced_at', 'text').addColumn('announce', 'text').execute();
      await db.schema.createIndex('game_servers_status').on('game_servers').columns(['status', 'game']).execute();
      await db.schema.createIndex('game_servers_token').on('game_servers').column('token_hash').execute();
    },
  },
  // Project type (hub.ts HUB_PROJECT_TYPES; null = chosen before the type existed) and the GitHub release download sum of the project's GitHub sources.
  '0005-project-type-downloads': {
    async up(db: Kysely<unknown>) {
      await db.schema.alterTable('projects').addColumn('type', 'text').execute();
      await db.schema.alterTable('projects').addColumn('github_downloads', 'integer', (c) => c.notNull().defaultTo(0)).execute();
      await db.schema.alterTable('projects').addColumn('github_downloads_at', 'text').execute();
    },
  },
  // Discord id of the poster of a Discord-only catalog entry: logging in with that Discord account claims the project.
  '0002-claim-discord-id': {
    async up(db: Kysely<unknown>) {
      await db.schema.alterTable('projects').addColumn('claim_discord_id', 'text').execute();
      await db.schema.createIndex('projects_claim_discord').on('projects').column('claim_discord_id').execute();
    },
  },
  // Automatic verification of game servers (docs/hub/server-registration.md): who submitted, the hashed submitter address, owner claim, last check.
  '0005-server-verify': {
    async up(db: Kysely<unknown>) {
      for (const [col, type] of [['submitter_id', 'text'], ['submitter_hash', 'text'], ['owner', 'integer'], ['verified_at', 'text'], ['last_check_at', 'text'], ['last_ok_at', 'text'], ['offline_since', 'text'], ['check_info', 'text']] as const) {
        await db.schema.alterTable('game_servers').addColumn(col, type).execute();
      }
      await db.schema.createIndex('game_servers_submitter').on('game_servers').columns(['submitter_id', 'created_at']).execute();
      await db.schema.createIndex('game_servers_submitter_hash').on('game_servers').columns(['submitter_hash', 'created_at']).execute();
    },
  },
  // Ownership proof for game servers: a short code in the server name or comment (docs/hub/server-registration.md).
  '0006-server-claim': {
    async up(db: Kysely<unknown>) {
      for (const col of ['claim_code', 'claim_user', 'claim_expires']) await db.schema.alterTable('game_servers').addColumn(col, 'text').execute();
    },
  },
  // GitHub discovery (services/discover-github.ts): TrackMania repositories found by search, waiting for an admin.
  '0007-discovered': {
    async up(db: Kysely<unknown>) {
      await db.schema.createTable('discovered')
        .addColumn('repo', 'text', (c) => c.primaryKey()).addColumn('full_name', 'text', (c) => c.notNull()).addColumn('owner', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull()).addColumn('description', 'text').addColumn('html_url', 'text', (c) => c.notNull()).addColumn('homepage', 'text')
        .addColumn('language', 'text').addColumn('topics', 'text', (c) => c.notNull()).addColumn('matched_topics', 'text', (c) => c.notNull())
        .addColumn('stars', 'integer', (c) => c.notNull().defaultTo(0)).addColumn('forks', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('is_fork', 'integer', (c) => c.notNull().defaultTo(0)).addColumn('archived', 'integer', (c) => c.notNull().defaultTo(0)).addColumn('license', 'text')
        .addColumn('pushed_at', 'text').addColumn('created_gh', 'text').addColumn('score', 'integer', (c) => c.notNull().defaultTo(0)).addColumn('games', 'text', (c) => c.notNull())
        .addColumn('has_readme', 'integer').addColumn('has_releases', 'integer').addColumn('state', 'text', (c) => c.notNull()).addColumn('note', 'text').addColumn('project_slug', 'text')
        .addColumn('first_seen', 'text', (c) => c.notNull()).addColumn('last_seen', 'text', (c) => c.notNull()).addColumn('decided_at', 'text').addColumn('decided_by', 'text').execute();
      await db.schema.createIndex('discovered_state').on('discovered').columns(['state', 'score']).execute();
    },
  },
});

export async function migrate(db: Db, sqlite: boolean, opts: { direct?: boolean } = {}): Promise<void> {
  // direct: run every migration's up() without the Migrator bookkeeping (tests on pg-mem, which lacks the catalog queries Kysely uses).
  if (opts.direct) { for (const m of Object.values(migrationsFor(sqlite))) await m.up(db as never); return; }
  const m = new Migrator({ db, provider: { getMigrations: async () => migrationsFor(sqlite) } });
  const { error, results } = await m.migrateToLatest();
  for (const r of results ?? []) if (r.status === 'Error') console.error(`migration ${r.migrationName} failed`);
  if (error) throw error;
  if (sqlite) await sql`PRAGMA foreign_keys = ON`.execute(db);
}
