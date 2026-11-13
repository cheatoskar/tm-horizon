// Live game servers from sources that need no secret:
//  - ManiaPlanet (TM2 Canyon/Stadium/Valley/Lagoon, ShootMania, custom titles):
//      GET https://www.maniaplanet.com/webservices/servers/online?length=100&offset=0
//      (public, sorted by player count; no login needed)
//  - Trackmania (2020) club rooms as mirrored by trackmania.io:
//      GET https://trackmania.io/api/rooms/{page}   (undocumented, public; 50 rooms per page)
// Plus the community registry (data/servers/, community.ts), the TMNF/TMUF master server
// (tmf-master.ts, needs a login) and the ESWC master server counters (eswc-master.ts).
// No made-up servers: when nothing real is listed the launcher shows an empty state.
import type { GameServer, ServersFile, SourceStatus } from '../types.ts';
import type { SourceContext } from '../config.ts';
import { errorText, gameFromTitle, stripFormatting } from '../lib/util.ts';
import { buildCommunityServers } from './community.ts';
import type { Probe } from './community.ts';
import { buildEswcMaster } from './eswc-master.ts';
import type { EswcFetch } from './eswc-master.ts';

export interface MpServer {
  name: string;
  description?: string;
  login: string;
  title: string;
  player_count: number;
  player_max: number;
  spectator_count?: number;
  zone?: string;
  is_private?: boolean;
  script_name?: string;
  environment?: string;
}

export interface TmioRoom {
  id: number;
  clubid: number;
  clubname: string;
  name: string;
  nadeo: boolean;
  login: string;
  playercount: number;
  playermax: number;
  region?: string;
  script?: string;
}

export function parseManiaPlanetServers(raw: unknown): GameServer[] {
  if (!Array.isArray(raw)) throw new Error('unexpected ManiaPlanet response (not an array)');
  return (raw as MpServer[]).map((s) => ({
    id: `maniaplanet:${s.login}`,
    source: 'maniaplanet' as const,
    sample: false,
    game: gameFromTitle(s.title),
    title: s.title || null,
    name: stripFormatting(s.name),
    nameRaw: s.name,
    description: s.description ? stripFormatting(s.description) : null,
    login: s.login,
    players: s.player_count,
    maxPlayers: s.player_max,
    spectators: s.spectator_count ?? null,
    zone: s.zone ?? null,
    mode: s.script_name || null,
    private: !!s.is_private,
    join: s.login && s.title ? `maniaplanet://#join=${s.login}@${s.title}` : null,
    club: null,
  }));
}

export function parseTmioRooms(raw: unknown): GameServer[] {
  const page = raw as { rooms?: TmioRoom[] };
  if (!page || !Array.isArray(page.rooms)) throw new Error('unexpected trackmania.io response (no "rooms")');
  return page.rooms.map((r) => ({
    id: `trackmania.io:${r.id}`,
    source: 'trackmania.io' as const,
    sample: false,
    game: 'tm2020' as const,
    title: null,
    name: stripFormatting(r.name),
    nameRaw: r.name,
    description: null,
    login: r.login || null,
    players: r.playercount,
    maxPlayers: r.playermax,
    spectators: null,
    zone: r.region || null,
    mode: r.script ? r.script.replace(/^.*\//, '').replace(/\.Script\.txt$/i, '') : null,
    private: false,
    join: null,
    club: { id: r.clubid, name: stripFormatting(r.clubname) },
  }));
}

export const NOT_AVAILABLE: ServersFile['notAvailable'] = [
  {
    game: 'forever',
    reason:
      'TrackMania Nations/United Forever: the live master server list comes from the hub backend (packages/tmf-master, docs/tmf-master). Registered community servers are listed with source "community".',
  },
  {
    game: 'eswc',
    reason:
      'TrackMania Nations ESWC: getservers.php gives only the master servers with player and server counts (masterServers); the game server list itself comes over the game protocol after a login. Registered community servers are listed.',
  },
  {
    game: 'tmo',
    reason: 'TrackMania Original: no online service known to work; registered community servers (join by address) only.',
  },
  {
    game: 'tms',
    reason: 'TrackMania Sunrise: no online service known to work; registered community servers (join by address) only.',
  },
  {
    game: 'tm2020',
    reason:
      'Trackmania (2020) club rooms come from trackmania.io (undocumented, ask its maintainer before going public). First-hand data from Nadeo Live Services (https://webservices.openplanet.dev/live/clubs) needs a Ubisoft or dedicated-server account token.',
  },
];

export interface ServerTestHooks {
  probe?: Probe;
  eswcFetch?: EswcFetch;
}

export async function buildServers(
  ctx: SourceContext,
  now: Date = new Date(),
  hooks: ServerTestHooks = {},
): Promise<{ servers: GameServer[]; sources: SourceStatus[]; notAvailable: ServersFile['notAvailable']; masterServers: ServersFile['masterServers'] }> {
  const cfg = ctx.config.servers;
  const servers: GameServer[] = [];
  const sources: SourceStatus[] = [];

  if (cfg.maniaplanet.enabled) {
    let got: GameServer[] = [];
    let cached = false;
    try {
      for (let page = 0; page < cfg.maniaplanet.pages; page++) {
        const url = `https://www.maniaplanet.com/webservices/servers/online?length=${cfg.maniaplanet.pageSize}&offset=${page * cfg.maniaplanet.pageSize}`;
        const { data, result } = await ctx.http.getJson<unknown>(url, { ttlMinutes: cfg.maniaplanet.ttlMinutes });
        cached ||= !!result.cache;
        const list = parseManiaPlanetServers(data);
        got.push(...list);
        if (list.length < cfg.maniaplanet.pageSize || list.some((s) => s.players === 0)) break;
      }
      got = got.filter((s) => s.players >= cfg.maniaplanet.minPlayers);
      servers.push(...got);
      sources.push({ id: 'servers:maniaplanet', ok: true, count: got.length, sample: false, cached });
    } catch (e) {
      ctx.warn(`servers: ManiaPlanet: ${errorText(e)}`);
      sources.push({ id: 'servers:maniaplanet', ok: false, count: got.length, sample: false, error: errorText(e) });
      servers.push(...got);
    }
  }

  if (cfg.trackmaniaIo.enabled) {
    const got: GameServer[] = [];
    let cached = false;
    try {
      for (let page = 0; page < cfg.trackmaniaIo.pages; page++) {
        const { data, result } = await ctx.http.getJson<unknown>(`https://trackmania.io/api/rooms/${page}`, { ttlMinutes: cfg.trackmaniaIo.ttlMinutes });
        cached ||= !!result.cache;
        got.push(...parseTmioRooms(data));
      }
      servers.push(...got);
      sources.push({ id: 'servers:trackmania.io', ok: true, count: got.length, sample: false, cached });
    } catch (e) {
      ctx.warn(`servers: trackmania.io: ${errorText(e)}`);
      sources.push({ id: 'servers:trackmania.io', ok: false, count: got.length, sample: false, error: errorText(e) });
      servers.push(...got);
    }
  }

  // The TMNF/TMUF master server list is served live by the hub backend (packages/tmf-master,
  // GET /tmf/servers); the static build lists the registered community servers only.
  const [community, eswc] = await Promise.all([
    buildCommunityServers(ctx, now, hooks.probe),
    buildEswcMaster(ctx, hooks.eswcFetch),
  ]);
  servers.push(...community.servers);
  sources.push(...community.sources, ...eswc.sources);

  return { servers, sources, notAvailable: NOT_AVAILABLE, masterServers: eswc.masterServers };
}
