// Live server list: the hub asks every listed game server directly on its own public game port
// (TrackMania server query, no login, never a Nadeo master server) and keeps what the server answers
// publicly: name, map, mode, players, spectators, ping from the hub. Docs: docs/hub/live-servers.md.
//   - one query per server every 90 s (every 5 min while nobody is on it); failures back off to 10 min; after OFFLINE_AFTER failures in a row the
//     server shows as offline (it is never deleted or hidden because of that);
//   - the next poll time is stored in the database before the query goes out, so a restart never
//     causes extra queries;
//   - small concurrency, 3 s timeout, no second connection after a timeout (tmquery `poll`).
import type { Ctx } from '../ctx.ts';
import { LISTED, OFFLINE_AFTER, toPublicInfo, type PublicInfo } from './gameservers.ts';
import { QueryError, queryServer } from './tmquery.ts';

export const POLL_BASE_MS = 90_000;
/** Servers with nobody on them are asked less often; they go back to 90 s at the first poll that sees a player. */
export const POLL_EMPTY_MS = 5 * 60_000;
export const POLL_MAX_MS = 10 * 60_000;
export const POLL_CONCURRENCY = 5;
/** A server that must not be queried (see NEVER_QUERY in tmquery.ts) is looked at again after this long. */
const BLOCKED_RECHECK_MS = 24 * 3600_000;

/** Time to the next poll after `fail` failures in a row: 90 s, 3 min, 6 min, then 10 min. */
export const pollDelay = (fail: number): number => (fail <= 0 ? POLL_BASE_MS : Math.min(POLL_MAX_MS, POLL_BASE_MS * 2 ** fail));

export interface LiveInfo extends PublicInfo { maxSpectators: number }

export async function pollOne(ctx: Ctx, row: { id: string; game: string; address: string; name: string; status: string; source: string | null; poll_fail: number | null; offline_since: string | null }, now = Date.now()): Promise<'online' | 'offline' | 'blocked'> {
  const at = new Date(now).toISOString();
  const fail0 = row.poll_fail ?? 0;
  // Claim the slot first: even a crash during the query leaves the server at least 90 s of peace.
  await ctx.db.updateTable('game_servers').set({ next_poll_at: new Date(now + pollDelay(fail0)).toISOString() }).where('id', '=', row.id).execute();
  try {
    const r = await queryServer(row.game, row.address, { poll: true });
    const info = r.info;
    const live: LiveInfo = { ...toPublicInfo(info), maxSpectators: info.maxSpectators };
    const set: Record<string, unknown> = {
      last_check_at: at, last_ok_at: at, offline_since: null, check_info: JSON.stringify(live), live: JSON.stringify(live), ping_ms: r.pingMs, poll_fail: 0,
      next_poll_at: new Date(now + (live.players > 0 ? POLL_BASE_MS : POLL_EMPTY_MS)).toISOString(),
    };
    // Nations and United answer alike; the title pack is "Stadium" on most United servers too, so only a pack that says United is trusted (tmnf -> tmuf). The seed / submitted value otherwise stays.
    if (row.game === 'tmnf' && info.packMask && /united/i.test(info.packMask)) set.game = 'tmuf';
    if ((row.status === 'verified' || row.source === 'seed') && live.name.length >= 3) set.name = live.name;
    await ctx.db.updateTable('game_servers').set(set).where('id', '=', row.id).execute();
    return 'online';
  } catch (e) {
    if (!(e instanceof QueryError)) throw e;
    if (e.kind === 'private') {
      // Never contacted on purpose (or not a public address): no live data, no failure count.
      await ctx.db.updateTable('game_servers').set({ next_poll_at: new Date(now + BLOCKED_RECHECK_MS).toISOString() }).where('id', '=', row.id).execute();
      return 'blocked';
    }
    const fail = fail0 + 1;
    await ctx.db.updateTable('game_servers').set({
      last_check_at: at, poll_fail: fail, offline_since: row.offline_since ?? at, next_poll_at: new Date(now + pollDelay(fail)).toISOString(),
    }).where('id', '=', row.id).execute();
    return fail >= OFFLINE_AFTER ? 'offline' : 'online';
  }
}

/** Polls every listed server that is due. Returns how many were asked. */
export async function pollTick(ctx: Ctx, opts: { now?: number; concurrency?: number; limit?: number } = {}): Promise<number> {
  const now = opts.now ?? Date.now();
  const rows = await ctx.db.selectFrom('game_servers')
    .select(['id', 'game', 'address', 'name', 'status', 'source', 'poll_fail', 'offline_since'])
    .where('status', 'in', LISTED).where('address', '!=', '')
    .where((eb) => eb.or([eb('next_poll_at', 'is', null), eb('next_poll_at', '<=', new Date(now).toISOString())]))
    .orderBy('next_poll_at').limit(opts.limit ?? 60).execute();
  let i = 0;
  const worker = async () => {
    for (;;) {
      const row = rows[i++];
      if (!row) return;
      try { await pollOne(ctx, row, opts.now ?? Date.now()); } catch (e) { console.error('[hub] poll failed', row.id, (e as Error).message); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? POLL_CONCURRENCY, rows.length) }, worker));
  return rows.length;
}
