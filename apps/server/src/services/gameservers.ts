// Game servers that operators register themselves (docs/hub/server-registration.md): a public form
// stores a pending entry, an admin approves it (the operator then gets an announce token), approved
// servers go into the signed index the launcher reads, and the server's own plugin (XAseco, FAST,
// ManiaControl) may announce name, players and map every few minutes with that token.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { HubIndexServer } from '@tm-hub/shared';
import type { Ctx } from '../ctx.ts';
import { HttpError, newId, notFound, nowIso } from '../util.ts';
import { QueryError, queryServer, queryTestFlags, type ServerInfo } from './tmquery.ts';

export const SERVER_GAMES = ['tmnf', 'tmuf', 'eswc', 'tms', 'tmo'] as const;
export type ServerGame = (typeof SERVER_GAMES)[number];
/** An announcement more often than this is refused (429). */
export const ANNOUNCE_MIN_GAP_MS = 4 * 60_000;
/** A server counts as online when it announced within this time. */
export const ONLINE_WINDOW_MS = 15 * 60_000;
/** Statuses that are on the list: approved by an admin, or verified by the hub's own query. */
export const LISTED = ['approved', 'verified'] as const;
export const SERVER_STATUSES = ['pending', 'verified', 'approved', 'rejected', 'removed'] as const;
/** Limits for logged-in submissions (anonymous ones share the per-address limit). */
export const MAX_PER_USER_DAY = 10;
export const MAX_PER_IP_HOUR = 5;
export const RECHECK_EVERY_MS = 6 * 3600_000;
export const REMOVE_AFTER_OFFLINE_MS = 14 * 86400_000;
/** A passed check keeps a server "online" for this long (the hub checks every 6 hours). */
export const CHECK_ONLINE_MS = 8 * 3600_000;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** "host:port" (default port 2350) of a public address. Private, loopback and reserved addresses are refused. */
export function normalizeAddress(input: string): string {
  const t = input.trim().toLowerCase();
  const m = /^([a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?)(?::(\d{1,5}))?$/.exec(t);
  if (!m) throw new HttpError(400, 'bad_address', 'That is not a valid address (use ip:port or host:port)');
  const host = m[1]!;
  const port = m[3] ? Number(m[3]) : 2350;
  if (port < 1 || port > 65535) throw new HttpError(400, 'bad_address', 'The port must be between 1 and 65535');
  const parts = host.split('.');
  const numeric = parts.every((p) => /^\d+$/.test(p));
  if (numeric) {
    const n = parts.map(Number);
    if (n.length !== 4 || n.some((x) => x > 255)) throw new HttpError(400, 'bad_address', 'That is not a valid IPv4 address');
    const [a, b] = n as [number, number, number, number];
    if (queryTestFlags.allowLocal && a === 127) return `${host}:${port}`;
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) {
      throw new HttpError(400, 'private_address', 'The address must be reachable from the internet');
    }
  } else {
    if (!host.includes('.') || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan')) {
      throw new HttpError(400, 'private_address', 'The address must be a public name or IP address');
    }
  }
  return `${host}:${port}`;
}

export interface SubmitInput {
  game: ServerGame; address: string; name?: string | null; contact?: string | null; homepage?: string | null;
  /** Logged-in submitter: the server is queried at once and listed when it answers as the chosen game. */
  userId?: string | null;
  /** "This is my server" (needs a contact). Only an announcement: ownership is proven later with claimCode/claimServer. */
  owner?: boolean;
  /** Address of the submitter; only a salted hash of it is stored. */
  ip: string;
}
export interface SubmitResult { id: string; status: 'pending' | 'verified'; reason?: 'unreachable' | 'password'; info?: PublicInfo }
export interface PublicInfo { name: string; players: number; maxPlayers: number; spectators: number; map: string | null; mode: string | null; password: boolean }

/** Salted hash of a submitter's address (the salt is created once and kept in the database); raw addresses are never stored or logged. */
export async function ipHash(ctx: Ctx, ip: string): Promise<string> {
  let row = await ctx.db.selectFrom('kv').select('value').where('key', '=', 'servers.ip_salt').executeTakeFirst();
  if (!row) {
    await ctx.db.insertInto('kv').values({ key: 'servers.ip_salt', value: randomBytes(24).toString('base64url') }).onConflict((oc) => oc.column('key').doNothing()).execute();
    row = await ctx.db.selectFrom('kv').select('value').where('key', '=', 'servers.ip_salt').executeTakeFirstOrThrow();
  }
  return createHmac('sha256', row.value).update(ip).digest('hex').slice(0, 32);
}

const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
export const toPublicInfo = (i: ServerInfo): PublicInfo => ({ name: clean(i.name).slice(0, 80), players: i.players, maxPlayers: i.maxPlayers, spectators: i.spectators, map: i.currentMap ? clean(i.currentMap).slice(0, 40) : null, mode: i.mode, password: i.password });

/** Live answer of a server for the "Check" button (logged-in users only; one connection, 3 s). */
export async function checkServer(game: ServerGame, addressInput: string): Promise<{ address: string; info: PublicInfo }> {
  const address = normalizeAddress(addressInput);
  try {
    return { address, info: toPublicInfo((await queryServer(game, address)).info) };
  } catch (e) {
    if (!(e instanceof QueryError)) throw e;
    throw queryHttpError(e);
  }
}

function queryHttpError(e: QueryError): HttpError {
  if (e.kind === 'private') return new HttpError(400, 'private_address', 'The address must be reachable from the internet');
  if (e.kind === 'port') return new HttpError(400, 'bad_port', 'The game port must be between 1024 and 65535');
  if (e.kind === 'dns') return new HttpError(400, 'bad_address', 'That name does not resolve');
  if (e.kind === 'busy') return new HttpError(503, 'busy', 'Too many checks right now, try again in a minute', { retryAfterSeconds: 60 });
  return new HttpError(422, 'no_answer', `The server did not answer as a TrackMania server (${e.kind})`);
}

export async function submitServer(ctx: Ctx, input: SubmitInput): Promise<SubmitResult> {
  const address = normalizeAddress(input.address);
  const hash = await ipHash(ctx, input.ip);
  const now = Date.now();
  const count = async (col: 'submitter_hash' | 'submitter_id', val: string, since: number) =>
    Number((await ctx.db.selectFrom('game_servers').select((eb) => eb.fn.countAll<number>().as('n')).where(col, '=', val).where('created_at', '>', new Date(now - since).toISOString()).executeTakeFirstOrThrow()).n);
  if ((await count('submitter_hash', hash, 3600_000)) >= MAX_PER_IP_HOUR) throw new HttpError(429, 'limit', `At most ${MAX_PER_IP_HOUR} submissions per hour from one address`, { retryAfterSeconds: 3600 });
  if (input.userId && (await count('submitter_id', input.userId, 86400_000)) >= MAX_PER_USER_DAY) throw new HttpError(429, 'limit', `At most ${MAX_PER_USER_DAY} submissions per day per account`, { retryAfterSeconds: 86400 });
  const owner = !!input.owner;
  const contact = (input.contact ?? '').trim();
  if ((owner || !input.userId) && !contact) throw new HttpError(400, 'contact_needed', 'A contact is required');
  const dup = await ctx.db.selectFrom('game_servers').select(['id', 'status']).where('game', '=', input.game).where('address', '=', address).where('status', 'in', ['pending', 'approved', 'verified']).executeTakeFirst();
  if (dup && dup.status !== 'pending') throw new HttpError(409, 'exists', 'This server is already listed');
  if (dup && !input.userId) throw new HttpError(409, 'exists', 'This server is already waiting for review');

  // Logged-in: ask the server. Only an invalid target is an error; anything else leaves the entry pending for an admin.
  let info: ServerInfo | null = null;
  let reason: SubmitResult['reason'];
  if (input.userId) {
    try {
      info = (await queryServer(input.game, address)).info;
    } catch (e) {
      if (!(e instanceof QueryError)) throw e;
      if (['private', 'port', 'busy'].includes(e.kind)) throw queryHttpError(e);
      reason = 'unreachable';
    }
    // A server with a password is listed only after the operator proved ownership (claim), so it waits.
    if (info?.password) reason = 'password';
  }
  const verified = !!input.userId && !!info && reason === undefined;
  const pub = info ? toPublicInfo(info) : null;
  const at = nowIso();
  const serverName = pub && pub.name.length >= 3 ? pub.name : null;
  const formName = input.name?.trim() || null;
  const name = (verified ? serverName ?? formName : formName ?? serverName) ?? address;
  if (dup) {
    // an earlier pending entry of the same server: a passed check settles it
    if (!verified) throw new HttpError(409, 'exists', 'This server is already waiting for review');
    await ctx.db.updateTable('game_servers').set({ status: 'verified', name: name.slice(0, 80), owner: 0, verified_at: at, last_check_at: at, last_ok_at: at, offline_since: null, check_info: JSON.stringify(pub), submitter_id: input.userId ?? null, decided_at: at, note: null }).where('id', '=', dup.id).execute();
    await ctx.audit(input.userId ?? 'anonymous', 'server.autoverify', dup.id);
    return { id: dup.id, status: 'verified', info: pub ?? undefined };
  }
  const id = newId('gs');
  await ctx.db.insertInto('game_servers').values({
    id, game: input.game, address, name: name.slice(0, 80), contact, homepage: input.homepage || null, status: verified ? 'verified' : 'pending', token_hash: null,
    note: reason === 'password' ? 'password-protected: needs the owner' : reason === 'unreachable' ? 'no answer to the game query' : null,
    created_at: at, decided_at: verified ? at : null, announced_at: null, announce: null,
    submitter_id: input.userId ?? null, submitter_hash: hash, owner: 0, claim_code: null, claim_user: null, claim_expires: null, verified_at: verified ? at : null,
    last_check_at: input.userId ? at : null, last_ok_at: info ? at : null, offline_since: null, check_info: pub ? JSON.stringify(pub) : null,
  }).execute();
  if (verified) await ctx.audit(input.userId!, 'server.autoverify', id);
  else await ctx.notify({ kind: 'server', text: `New game server to review: ${name} (${input.game} ${address})${reason ? ` [${reason}]` : ''}`, url: `${ctx.cfg.HUB_PORTAL_URL}admin` });
  return { id, status: verified ? 'verified' : 'pending', reason: input.userId && !verified ? reason : undefined, info: pub ?? undefined };
}

const newToken = () => 'tmhs_' + randomBytes(24).toString('base64url');

/** Approves (or, when already approved, issues a new token). Returns the token once; only its hash is kept. `owner`: the operator is known (contact checked by the admin). */
export async function approveServer(ctx: Ctx, id: string, actor: string, opts: { owner?: boolean } = {}): Promise<{ token: string }> {
  const row = await ctx.db.selectFrom('game_servers').select(['id', 'status']).where('id', '=', id).executeTakeFirst();
  if (!row) throw notFound('Server not found');
  if (row.status === 'rejected' || row.status === 'removed') throw new HttpError(409, 'closed', 'This entry was closed; restore it first or ask the operator to submit again');
  const token = newToken();
  await ctx.db.updateTable('game_servers').set({ status: 'approved', token_hash: sha(token), decided_at: nowIso(), note: null, ...(opts.owner ? { owner: 1 } : {}) }).where('id', '=', id).execute();
  await ctx.audit(actor, row.status === 'approved' ? 'server.token' : 'server.approve', id);
  return { token };
}

export const CLAIM_TTL_MS = 30 * 60_000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => 'hz-' + Array.from(randomBytes(4), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
const CLAIMABLE = ['pending', 'verified', 'approved'];

/**
 * Ownership proof, step 1: a short code (valid 30 minutes) the operator puts into the server name or the server
 * comment. Anyone logged in may ask for one for any listed or pending server; the code only works if it shows up in
 * what the game port answers, so only someone who controls the server can use it. Asking again within the time gives
 * the same code to the same person, a different person replaces it.
 */
export async function claimCode(ctx: Ctx, id: string, userId: string): Promise<{ code: string; expiresAt: string; where: string }> {
  const row = await ctx.db.selectFrom('game_servers').select(['id', 'status', 'claim_code', 'claim_user', 'claim_expires']).where('id', '=', id).executeTakeFirst();
  if (!row || !CLAIMABLE.includes(row.status)) throw notFound('Server not found');
  const now = Date.now();
  if (row.claim_code && row.claim_user === userId && row.claim_expires && Date.parse(row.claim_expires) > now) return { code: row.claim_code, expiresAt: row.claim_expires, where: 'name or comment' };
  const code = newCode();
  const expiresAt = new Date(now + CLAIM_TTL_MS).toISOString();
  await ctx.db.updateTable('game_servers').set({ claim_code: code, claim_user: userId, claim_expires: expiresAt }).where('id', '=', id).execute();
  return { code, expiresAt, where: 'name or comment' };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Ownership proof, step 2: the hub asks the game port once. If the code is in the server name or comment, the caller
 * becomes the owner (no longer "suggested"), gets a new announce token (shown once) and the code is used up. The
 * stored name has the code stripped. Wrong code: 422 and the code stays valid until it expires. A pending entry
 * (also one with a password) becomes verified, because the server just answered.
 */
export async function claimServer(ctx: Ctx, id: string, userId: string): Promise<{ token: string; status: string; name: string }> {
  const row = await ctx.db.selectFrom('game_servers').selectAll().where('id', '=', id).executeTakeFirst();
  if (!row || !CLAIMABLE.includes(row.status)) throw notFound('Server not found');
  if (!row.claim_code || row.claim_user !== userId) throw new HttpError(400, 'no_code', 'Ask for a code first');
  if (!row.claim_expires || Date.parse(row.claim_expires) <= Date.now()) throw new HttpError(400, 'code_expired', 'The code expired; ask for a new one');
  let info: ServerInfo;
  try {
    info = (await queryServer(row.game, row.address)).info;
  } catch (e) {
    if (!(e instanceof QueryError)) throw e;
    throw queryHttpError(e);
  }
  const code = row.claim_code;
  const re = new RegExp(escapeRe(code), 'i');
  if (!re.test(info.name) && !re.test(info.comment)) throw new HttpError(422, 'code_not_found', 'The code is not in the server name or comment');
  const strip = (s: string) => clean(s.replace(new RegExp(escapeRe(code), 'gi'), ' '));
  const pub = toPublicInfo({ ...info, name: strip(info.name) });
  const at = nowIso();
  const token = newToken();
  const set: Record<string, unknown> = {
    owner: 1, submitter_id: userId, token_hash: sha(token), claim_code: null, claim_user: null, claim_expires: null,
    last_check_at: at, last_ok_at: at, offline_since: null, check_info: JSON.stringify(pub),
  };
  let status = row.status;
  if (row.status === 'pending') { status = 'verified'; Object.assign(set, { status, verified_at: at, decided_at: at, note: null }); }
  // the name comes from the server, without the code (an admin-approved name stays)
  if (row.status !== 'approved' && pub.name.length >= 3) set.name = pub.name;
  await ctx.db.updateTable('game_servers').set(set).where('id', '=', id).execute();
  await ctx.audit(userId, 'server.claim', id);
  return { token, status, name: (set.name as string | undefined) ?? row.name };
}

export async function closeServer(ctx: Ctx, id: string, status: 'rejected' | 'removed', note: string, actor: string): Promise<void> {
  const r = await ctx.db.updateTable('game_servers').set({ status, token_hash: null, decided_at: nowIso(), note }).where('id', '=', id).where('status', 'in', ['pending', 'approved', 'verified']).executeTakeFirst();
  if (!Number(r.numUpdatedRows)) throw notFound('Server not found or already closed');
  await ctx.audit(actor, 'server.' + status, id, { note });
}

/** Brings a removed or rejected entry back: where it was before an automatic removal, else verified (when it passed a check once) or pending. */
export async function restoreServer(ctx: Ctx, id: string, actor: string): Promise<{ status: string }> {
  const row = await ctx.db.selectFrom('game_servers').select(['id', 'status', 'note', 'verified_at', 'token_hash']).where('id', '=', id).executeTakeFirst();
  if (!row || (row.status !== 'removed' && row.status !== 'rejected')) throw notFound('Server not found or not closed');
  const prev = /^auto:offline:(approved|verified)$/.exec(row.note ?? '')?.[1];
  const status = prev ?? (row.verified_at ? 'verified' : 'pending');
  await ctx.db.updateTable('game_servers').set({ status, note: null, offline_since: null, decided_at: nowIso() }).where('id', '=', id).execute();
  await ctx.audit(actor, 'server.restore', id, { status });
  return { status };
}

export interface Announce { name: string; players: number; maxPlayers: number; spectators?: number; map?: string | null; mode?: string | null; version?: string | null }

/** Stores an announcement of a listed server. Throws 401 for unknown tokens and 429 when announced too soon. */
export async function announce(ctx: Ctx, token: string, a: Announce): Promise<{ ok: true; nextInSeconds: number }> {
  const hash = sha(token);
  const row = await ctx.db.selectFrom('game_servers').select(['id', 'token_hash', 'announced_at']).where('token_hash', '=', hash).where('status', 'in', LISTED).executeTakeFirst();
  // Compare again in constant time (the lookup already matched; this keeps timing uniform for near misses).
  if (!row?.token_hash || !timingSafeEqual(Buffer.from(row.token_hash), Buffer.from(hash))) throw new HttpError(401, 'bad_token', 'Unknown or revoked token');
  const last = row.announced_at ? Date.parse(row.announced_at) : 0;
  const wait = last + ANNOUNCE_MIN_GAP_MS - Date.now();
  if (wait > 0) throw new HttpError(429, 'too_soon', `Announce at most every ${ANNOUNCE_MIN_GAP_MS / 60000} minutes`, { retryAfterSeconds: Math.ceil(wait / 1000) });
  await ctx.db.updateTable('game_servers').set({ announced_at: nowIso(), announce: JSON.stringify(a) }).where('id', '=', row.id).execute();
  return { ok: true, nextInSeconds: ANNOUNCE_MIN_GAP_MS / 1000 };
}

export async function approvedServers(ctx: Ctx): Promise<HubIndexServer[]> {
  const rows = await ctx.db.selectFrom('game_servers').select(['game', 'address', 'name', 'homepage', 'status', 'owner']).where('status', 'in', LISTED).orderBy('created_at').execute();
  return rows.map((r) => ({ game: r.game as ServerGame, address: r.address, name: r.name, homepage: r.homepage, ...(r.status === 'verified' && !r.owner ? { suggested: true } : {}) }));
}

export interface PublicServer extends HubIndexServer {
  online: boolean; announcedAt: string | null; players: number | null; maxPlayers: number | null; map: string | null;
  /** Listed by a community member, not (yet) claimed by the operator. */
  suggested: boolean;
}

export async function publicServers(ctx: Ctx): Promise<PublicServer[]> {
  const rows = await ctx.db.selectFrom('game_servers').selectAll().where('status', 'in', LISTED).orderBy('created_at').execute();
  return rows.map((r) => {
    const a = r.announce ? (JSON.parse(r.announce) as Announce) : null;
    const announced = !!r.announced_at && Date.now() - Date.parse(r.announced_at) < ONLINE_WINDOW_MS;
    const checked = !announced && !r.offline_since && !!r.last_ok_at && Date.now() - Date.parse(r.last_ok_at) < CHECK_ONLINE_MS;
    const c = checked && r.check_info ? (JSON.parse(r.check_info) as PublicInfo) : null;
    const live = announced && a ? { players: a.players, maxPlayers: a.maxPlayers, map: a.map ?? null } : c ? { players: c.players, maxPlayers: c.maxPlayers, map: c.map } : null;
    return {
      game: r.game as ServerGame, address: r.address, name: r.name, homepage: r.homepage, online: announced || checked, announcedAt: r.announced_at,
      players: live?.players ?? null, maxPlayers: live?.maxPlayers ?? null, map: live?.map ?? null,
      suggested: r.status === 'verified' && !r.owner,
    };
  });
}

// ---- re-check job

/** Asks one listed server again. A pass clears "offline" and (for verified entries) refreshes the name; a failure starts the offline clock. */
export async function recheckServer(ctx: Ctx, id: string, opts: { wait?: boolean } = {}): Promise<'online' | 'offline' | 'skipped'> {
  const row = await ctx.db.selectFrom('game_servers').select(['id', 'game', 'address', 'status', 'offline_since', 'name']).where('id', '=', id).executeTakeFirst();
  if (!row) throw notFound('Server not found');
  const at = nowIso();
  try {
    const pub = toPublicInfo((await queryServer(row.game, row.address, opts)).info);
    const set: Record<string, unknown> = { last_check_at: at, last_ok_at: at, offline_since: null, check_info: JSON.stringify(pub) };
    if (row.status === 'verified' && pub.name.length >= 3) set.name = pub.name;
    await ctx.db.updateTable('game_servers').set(set).where('id', '=', id).execute();
    return 'online';
  } catch (e) {
    if (e instanceof QueryError && e.kind === 'busy') return 'skipped';
    if (!(e instanceof QueryError)) throw e;
    await ctx.db.updateTable('game_servers').set({ last_check_at: at, offline_since: row.offline_since ?? at }).where('id', '=', id).execute();
    return 'offline';
  }
}

/** All listed servers one after another (the global query cap spaces them out), then removal of the long-offline ones. Returns the ids removed. */
export async function recheckAll(ctx: Ctx): Promise<{ checked: number; removed: string[] }> {
  const rows = await ctx.db.selectFrom('game_servers').select('id').where('status', 'in', LISTED).orderBy('last_check_at').execute();
  for (const r of rows) await recheckServer(ctx, r.id, { wait: true });
  return { checked: rows.length, removed: await removeLongOffline(ctx) };
}

/** Soft removal: status removed with a note that says where it was; an admin can restore it. */
export async function removeLongOffline(ctx: Ctx, now = Date.now()): Promise<string[]> {
  const cutoff = new Date(now - REMOVE_AFTER_OFFLINE_MS).toISOString();
  const rows = await ctx.db.selectFrom('game_servers').select(['id', 'status']).where('status', 'in', LISTED).where('offline_since', '<', cutoff).execute();
  for (const r of rows) {
    await ctx.db.updateTable('game_servers').set({ status: 'removed', note: `auto:offline:${r.status}`, decided_at: nowIso() }).where('id', '=', r.id).execute();
    await ctx.audit('system', 'server.auto_remove', r.id);
  }
  return rows.map((r) => r.id);
}

/** Called by the hub's one-minute tick: runs the re-check every 6 hours (the time of the last run is kept in the database). Returns true when it ran (names or removals may have changed, so the index is rebuilt). */
export async function recheckDue(ctx: Ctx, now = Date.now()): Promise<boolean> {
  const k = await ctx.db.selectFrom('kv').select('value').where('key', '=', 'servers.recheck_at').executeTakeFirst();
  if (k && now - Number(k.value) < RECHECK_EVERY_MS) return false;
  await ctx.db.deleteFrom('kv').where('key', '=', 'servers.recheck_at').execute();
  await ctx.db.insertInto('kv').values({ key: 'servers.recheck_at', value: String(now) }).execute();
  await recheckAll(ctx);
  return true;
}
