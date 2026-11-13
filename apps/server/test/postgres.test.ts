// The PostgreSQL dialect against pg-mem (an in-memory Postgres emulation): migrations and the main
// queries. Not a replacement for a test against a real Postgres before going live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kysely, PostgresDialect } from 'kysely';
import { newDb } from 'pg-mem';
import type { DB } from '../src/db/db.ts';
import { loadConfig } from '../src/config.ts';
import { createCtx } from '../src/ctx.ts';
import { buildApp } from '../src/app.ts';
import { loadSigningKey, verifyIndex } from '../src/index/sign.ts';
import { RFC8032_TEST1_SEED } from '../scripts/make-index-fixtures.ts';
import { tmloaderZip } from './helpers.ts';
import { createProject, searchProjects } from '../src/services/projects.ts';
import { approveVersion, ingestVersion, publishDue } from '../src/services/versions.ts';
import { upsertUser } from '../src/services/users.ts';

test('postgres dialect: migrations, ingest, publish, search, index, download counter', async () => {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: new Pool() }) });
  const dir = mkdtempSync(join(tmpdir(), 'hub-pg-'));
  const ctx = await createCtx(loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgres://mem/tmhub', STORAGE_DIR: join(dir, 'files'), HUB_DEV_LOGIN: '1' }), { db, key: loadSigningKey(RFC8032_TEST1_SEED), directMigrations: true });
  assert.equal(ctx.sqlite, false);
  const uid = await upsertUser(ctx, { provider: 'dev', providerId: 'author', username: 'dev-author', name: 'Dev Author', avatar: null });
  const p = await createProject(ctx, {
    name: 'Pg Mod', slug: 'pg-mod', summary: 'Postgres dialect test project.', description: '', categories: ['tools'], tags: ['pg'], games: ['tmnf'],
    installs: { tmnf: { kind: 'tmloader-product', strip: 0, include: [] } }, license: null, links: {}, dependencies: [], conflicts: [], tmloaderProduct: 'PgMod',
  }, { id: uid, name: 'Dev Author' });
  const v1 = await ingestVersion(ctx, { project: p, fileName: 'pg.zip', data: tmloaderZip('PgMod', '1.0.0'), meta: { version: '1.0.0', channel: 'stable', changelog: '' }, origin: 'upload', uploaderId: uid });
  assert.equal(v1.status, 'review');
  await approveVersion(ctx, v1, 'test');
  const v2 = await ingestVersion(ctx, { project: p, fileName: 'pg.zip', data: tmloaderZip('PgMod', '1.1.0'), meta: { version: '1.1.0', channel: 'stable', changelog: '' }, origin: 'upload', uploaderId: uid });
  assert.equal(v2.status, 'held');
  assert.equal(await publishDue(ctx, new Date(Date.now() + 2 * 3600_000).toISOString()), 1);
  const s = await searchProjects(ctx, { q: 'pg', game: 'tmnf', sort: 'popular' });
  assert.equal(s.total, 1);
  assert.equal(s.items[0].latest, '1.1.0');

  const app = await buildApp(ctx);
  const idx = verifyIndex((await app.inject({ method: 'GET', url: '/v1/index.json' })).json(), [ctx.key.publicKey]);
  assert.equal(idx.projects[0].versions.length, 2);
  const dl = new URL(idx.projects[0].versions[0].files[0].url).pathname;
  assert.equal((await app.inject({ method: 'GET', url: dl })).statusCode, 302);
  const row = await db.selectFrom('downloads_daily').selectAll().execute();
  assert.equal(row[0].count, 1);
  await ctx.audit('x', 'y', 'z');
  assert.ok((await db.selectFrom('audit').select('id').execute()).length > 0);
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});
