// Discord-only catalog entries: the poster's Discord id is kept on the unclaimed project and a
// Discord login with the same id claims it. Fake Discord (no real OAuth calls).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.ts';
import { createCtx } from '../src/ctx.ts';
import { buildApp } from '../src/app.ts';
import { importCatalog } from '../src/sources/catalog-import.ts';
import { loadSigningKey } from '../src/index/sign.ts';
import { RFC8032_TEST1_SEED } from '../scripts/make-index-fixtures.ts';

const dir = mkdtempSync(join(tmpdir(), 'dclaim-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const ID = '123456789012345678';
const entry = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, category: 'mod', games: ['tmuf'], url: null, api: null, description: `${name} for TrackMania United`, maintainer: null, language: 'en',
  status: 'unclear', checked: null, launcher: null, author: 'poster', hosting: 'discord-attachment', ...extra,
});
const catalogPath = join(dir, 'catalog.json');
writeFileSync(catalogPath, JSON.stringify({ entries: [
  entry('mod-mine', 'Mine Mod', { authorDiscordId: ID }),
  entry('mod-other', 'Other Mod', { authorDiscordId: '999999999999999999' }),
  entry('mod-none', 'No Id Mod'),
  entry('mod-bad', 'Bad Id Mod', { authorDiscordId: 'not-an-id' }),
] }));

let who = ID;
const fakeFetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url === 'https://discord.com/api/oauth2/token') return json({ access_token: 'tok' });
  if (url === 'https://discord.com/api/users/@me') return json({ id: who, username: 'poster', global_name: 'Poster' });
  throw new Error('unexpected network call ' + url);
}) as typeof fetch;

async function setup() {
  const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'sqlite::memory:', STORAGE_DIR: join(dir, 'files'), DISCORD_CLIENT_ID: 'cid', DISCORD_CLIENT_SECRET: 'sec' });
  const ctx = await createCtx(cfg, { key: loadSigningKey(RFC8032_TEST1_SEED), fetch: fakeFetch });
  await importCatalog(ctx, { catalogPath, modsPath: join(dir, 'none.json') });
  const app = await buildApp(ctx, { tmf: null });
  return { ctx, app };
}
async function discordLogin(app: FastifyInstance): Promise<{ location: string }> {
  const s = await app.inject({ method: 'GET', url: '/auth/discord/start?next=/' });
  const state = new URL(String(s.headers.location)).searchParams.get('state')!;
  const cookie = s.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const r = await app.inject({ method: 'GET', url: `/auth/discord/callback?code=abc&state=${state}`, headers: { cookie } });
  assert.equal(r.statusCode, 302, r.body);
  return { location: String(r.headers.location) };
}
const row = (ctx: Awaited<ReturnType<typeof setup>>['ctx'], cid: string) => ctx.db.selectFrom('projects').selectAll().where('catalog_id', '=', cid).executeTakeFirstOrThrow();

test('import keeps a valid Discord id, ignores missing and malformed ones', async () => {
  const { ctx, app } = await setup();
  assert.equal((await row(ctx, 'mod-mine')).claim_discord_id, ID);
  assert.equal((await row(ctx, 'mod-none')).claim_discord_id, null);
  assert.equal((await row(ctx, 'mod-bad')).claim_discord_id, null);
  await app.close(); await ctx.db.destroy();
});

test('Discord login with the matching id claims the project (audit entry), others stay unclaimed', async () => {
  const { ctx, app } = await setup();
  who = ID;
  const { location } = await discordLogin(app);
  assert.match(location, /\/projects\/mine-mod\?claimed=1$/);
  const mine = await row(ctx, 'mod-mine');
  assert.equal(mine.claimed, 1);
  const owner = await ctx.db.selectFrom('members').selectAll().where('project_id', '=', mine.id).executeTakeFirstOrThrow();
  assert.equal(owner.role, 'owner');
  assert.equal((await row(ctx, 'mod-other')).claimed, 0);
  assert.equal((await row(ctx, 'mod-none')).claimed, 0);
  const audit = await ctx.db.selectFrom('audit').selectAll().where('action', '=', 'project.claim').execute();
  assert.equal(audit.length, 1);
  assert.match(audit[0]!.detail ?? '', /discord user id/);
  await app.close(); await ctx.db.destroy();
});

test('non-matching Discord id claims nothing', async () => {
  const { ctx, app } = await setup();
  who = '555555555555555555';
  const { location } = await discordLogin(app);
  assert.ok(!location.includes('claimed=1'));
  const all = await ctx.db.selectFrom('projects').select('claimed').execute();
  assert.ok(all.every((p) => p.claimed === 0));
  await app.close(); await ctx.db.destroy();
});

test('an already claimed project is untouched', async () => {
  const { ctx, app } = await setup();
  const mine = await row(ctx, 'mod-mine');
  const at = new Date().toISOString();
  await ctx.db.insertInto('users').values({ id: 'u-owner', name: 'Real Owner', avatar: null, suspended_at: null, suspension: null, strikes: 0, created_at: at }).execute();
  await ctx.db.insertInto('members').values({ project_id: mine.id, user_id: 'u-owner', role: 'owner', added_at: at }).execute();
  await ctx.db.updateTable('projects').set({ claimed: 1, author_name: 'Real Owner' }).where('id', '=', mine.id).execute();
  who = ID;
  await discordLogin(app);
  const after = await row(ctx, 'mod-mine');
  assert.equal(after.author_name, 'Real Owner');
  const owners = await ctx.db.selectFrom('members').select('user_id').where('project_id', '=', mine.id).execute();
  assert.deepEqual(owners.map((o) => o.user_id), ['u-owner']);
  await app.close(); await ctx.db.destroy();
});

test('re-import adds a Discord id to a still unclaimed project', async () => {
  const { ctx, app } = await setup();
  const p2 = join(dir, 'catalog2.json');
  writeFileSync(p2, JSON.stringify({ entries: [entry('mod-none', 'No Id Mod', { authorDiscordId: '222222222222222222' })] }));
  await importCatalog(ctx, { catalogPath: p2, modsPath: join(dir, 'none.json') });
  assert.equal((await row(ctx, 'mod-none')).claim_discord_id, '222222222222222222');
  await app.close(); await ctx.db.destroy();
});
