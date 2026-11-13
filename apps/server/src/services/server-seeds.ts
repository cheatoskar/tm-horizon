// Seed list of public game servers (seeds/server-seeds.json, from the owner's list of 2026-11-12): imported as
// approved entries without an owner or token, matched by login, so running it again changes nothing but names and
// countries. Entries without an address (Nations ESWC servers known by login only) are listed as "address unknown":
// name, login and country, no live data. Docs: docs/hub/live-servers.md.
import { readFileSync } from 'node:fs';
import type { Ctx } from '../ctx.ts';
import { newId, nowIso } from '../util.ts';

export interface SeedServer { game: 'tmnf' | 'tmuf' | 'eswc'; address: string; login: string; name: string; country: string | null }
export interface SeedFile { date: string; servers: SeedServer[] }

export const loadSeedFile = (path: string): SeedFile => JSON.parse(readFileSync(path, 'utf8')) as SeedFile;

export async function importServerSeeds(ctx: Ctx, seed: SeedFile): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  for (const s of seed.servers) {
    const existing = await ctx.db.selectFrom('game_servers').select(['id', 'status', 'source']).where('login', '=', s.login).where('game', 'in', s.game === 'eswc' ? ['eswc'] : ['tmnf', 'tmuf']).executeTakeFirst();
    if (existing) {
      // An entry somebody else already runs (submitted, claimed, removed by an admin) is left alone; only the seeds' own rows are refreshed.
      if (existing.source !== 'seed') continue;
      await ctx.db.updateTable('game_servers').set({ address: s.address, country: s.country, game: s.game }).where('id', '=', existing.id).execute();
      updated++;
      continue;
    }
    const at = nowIso();
    await ctx.db.insertInto('game_servers').values({
      id: newId('gs'), game: s.game, address: s.address, name: s.name, contact: 'seed', homepage: null, status: 'approved', token_hash: null, note: `seed:${seed.date}`,
      created_at: at, decided_at: at, announced_at: null, announce: null,
      submitter_id: null, submitter_hash: null, owner: 0, verified_at: null, last_check_at: null, last_ok_at: null, offline_since: null, check_info: null,
      claim_code: null, claim_user: null, claim_expires: null,
      login: s.login, country: s.country, zone: null, live: null, ping_ms: null, poll_fail: 0, next_poll_at: null, source: 'seed',
    }).execute();
    created++;
  }
  return { created, updated };
}
