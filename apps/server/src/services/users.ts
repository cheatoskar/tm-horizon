// Accounts: created on the first OAuth login (Discord or GitHub), no passwords. Admin role comes
// from HUB_ADMINS ("discord:<id>,github:<id>"), never from the database.
import type { HubUser, StatementOfReasons } from '@tm-hub/shared';
import type { Ctx } from '../ctx.ts';
import type { UsersTable } from '../db/db.ts';
import { newId, nowIso, parseJson } from '../util.ts';

export type Provider = 'discord' | 'github' | 'dev';

export interface OAuthProfile {
  provider: Provider;
  providerId: string;
  username: string;
  name: string;
  avatar: string | null;
}

export async function upsertUser(ctx: Ctx, p: OAuthProfile, linkTo?: string | null): Promise<string> {
  const ident = await ctx.db.selectFrom('identities').selectAll().where('provider', '=', p.provider).where('provider_id', '=', p.providerId).executeTakeFirst();
  if (ident) {
    await ctx.db.updateTable('identities').set({ username: p.username }).where('provider', '=', p.provider).where('provider_id', '=', p.providerId).execute();
    await ctx.db.updateTable('users').set({ avatar: p.avatar }).where('id', '=', ident.user_id).execute();
    return ident.user_id;
  }
  const at = nowIso();
  let userId = linkTo ?? null;
  if (!userId) {
    userId = newId('u');
    await ctx.db.insertInto('users').values({ id: userId, name: p.name.slice(0, 64) || p.username, avatar: p.avatar, suspended_at: null, suspension: null, strikes: 0, created_at: at }).execute();
  }
  await ctx.db.insertInto('identities').values({ provider: p.provider, provider_id: p.providerId, user_id: userId, username: p.username, created_at: at }).execute();
  await ctx.audit(userId, linkTo ? 'identity.link' : 'user.create', userId, { provider: p.provider, username: p.username });
  return userId;
}

export async function isAdmin(ctx: Ctx, userId: string): Promise<boolean> {
  if (!ctx.cfg.admins.size) return false;
  const ids = await ctx.db.selectFrom('identities').select(['provider', 'provider_id']).where('user_id', '=', userId).execute();
  return ids.some((i) => ctx.cfg.admins.has(`${i.provider}:${i.provider_id}`));
}

export async function hubUser(ctx: Ctx, u: UsersTable): Promise<HubUser> {
  const [ids, keys, admin] = await Promise.all([
    ctx.db.selectFrom('identities').selectAll().where('user_id', '=', u.id).execute(),
    ctx.db.selectFrom('author_keys').selectAll().where('user_id', '=', u.id).where('revoked_at', 'is', null).execute(),
    isAdmin(ctx, u.id),
  ]);
  return {
    id: u.id, name: u.name, avatar: u.avatar, role: admin ? 'admin' : 'user', suspended: !!u.suspended_at, suspension: u.suspended_at ? suspensionOf(u) : null, created: u.created_at,
    identities: ids.map((i) => ({ provider: i.provider as Provider, providerId: i.provider_id, username: i.username })),
    keys: keys.map((k) => ({ keyId: k.key_id, publicKey: k.public_key, added: k.added_at })),
  };
}

export async function suspendUser(ctx: Ctx, userId: string, statement: StatementOfReasons, actor: string) {
  await ctx.db.updateTable('users').set((eb) => ({ suspended_at: nowIso(), suspension: JSON.stringify(statement), strikes: eb('strikes', '+', 1) })).where('id', '=', userId).execute();
  await ctx.db.deleteFrom('sessions').where('user_id', '=', userId).execute();
  await ctx.db.updateTable('tokens').set({ revoked_at: nowIso() }).where('user_id', '=', userId).where('revoked_at', 'is', null).execute();
  await ctx.audit(actor, 'user.suspend', userId, statement);
}

export async function unsuspendUser(ctx: Ctx, userId: string, actor: string) {
  await ctx.db.updateTable('users').set({ suspended_at: null }).where('id', '=', userId).execute();
  await ctx.audit(actor, 'user.unsuspend', userId);
}

export const suspensionOf = (u: UsersTable) => parseJson<StatementOfReasons | null>(u.suspension, null);
