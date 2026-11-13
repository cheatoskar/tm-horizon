// Community server registry (data/servers/*.yaml) and submitted events (data/events/*.yaml).
//
// Servers: each build tries a TCP connect to the game port (default 2350) with a short timeout.
// Nothing is sent: no game protocol, no login. A server that accepts the connection is "online";
// lastSeen is kept from build to build in the cache folder. There is no unauthenticated info
// query for the TrackMania dedicated servers that I could confirm (gamedig's "nadeo" protocol
// logs in on the XML-RPC port, which servers keep closed), so players and max players stay 0.
// Login-only entries (TMNF/TMUF/ManiaPlanet without an address) are listed with online: null.
//
// Events: approved submissions, converted to HubEvent with source "submitted"; events whose end
// lies in the past are dropped at build time.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import dns from 'node:dns/promises';
import type { GameServer, HubEvent, SourceStatus } from '../types.ts';
import type { SourceContext } from '../config.ts';
import { resolveFrom } from '../config.ts';
import type { EventEntry, ServerEntry } from '../lib/registry.ts';
import { checkEventEntry, checkServerEntry, isPrivateIp, loadEntries, parseAddress, serverJoinLink, slugId } from '../lib/registry.ts';
import { errorText, parseJoinLink } from '../lib/util.ts';

/** Result of one reachability check. */
export interface ProbeResult {
  online: boolean;
  ms: number | null;
  error?: string;
}

export type Probe = (host: string, port: number, timeoutMs: number) => Promise<ProbeResult>;

/** TCP connect, close at once. Hostnames are resolved first; private results are refused. */
export const tcpProbe: Probe = async (host, port, timeoutMs) => {
  let ip = host;
  if (!net.isIP(host)) {
    try {
      ip = (await dns.lookup(host)).address;
    } catch (e) {
      return { online: false, ms: null, error: `dns: ${errorText(e)}` };
    }
  }
  if (isPrivateIp(ip)) return { online: false, ms: null, error: `${host} resolves to a private address` };
  const started = Date.now();
  return new Promise((resolve) => {
    const socket = net.connect({ host: ip, port });
    const done = (r: ProbeResult) => {
      socket.destroy();
      resolve(r);
    };
    socket.setTimeout(timeoutMs, () => done({ online: false, ms: null, error: 'timeout' }));
    socket.once('connect', () => done({ online: true, ms: Date.now() - started }));
    socket.once('error', (e) => done({ online: false, ms: null, error: (e as NodeJS.ErrnoException).code ?? e.message }));
  });
};

export interface SeenState {
  [id: string]: { lastSeen: string | null; lastChecked: string };
}

export function communityServer(e: ServerEntry, probe: ProbeResult | null, lastSeen: string | null): GameServer {
  return {
    id: `community:${e.id}`,
    source: 'community',
    sample: false,
    game: e.game,
    title: e.title ?? null,
    name: e.name,
    nameRaw: e.name,
    description: e.description ?? null,
    login: e.login ?? null,
    players: 0,
    maxPlayers: 0,
    spectators: null,
    zone: null,
    mode: e.mode ?? null,
    private: false,
    join: serverJoinLink(e),
    club: null,
    address: e.address ?? null,
    online: probe ? probe.online : null,
    lastSeen,
    language: e.language ?? null,
    contact: e.contact ?? null,
    homepage: e.homepage ?? null,
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function buildCommunityServers(
  ctx: SourceContext,
  now: Date,
  probe: Probe = tcpProbe,
): Promise<{ servers: GameServer[]; sources: SourceStatus[] }> {
  const cfg = ctx.config.servers.community;
  if (!cfg.enabled) return { servers: [], sources: [] };
  const dir = resolveFrom(ctx.root, cfg.dir);
  const { entries, errors } = loadEntries(dir, checkServerEntry);
  for (const e of errors) ctx.warn(`community servers: ${e}`);

  const stateFile = path.join(ctx.http.dir, 'community-seen.json');
  let state: SeenState = {};
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as SeenState;
  } catch {
    // first build
  }
  const nowIso = now.toISOString();
  const offline = ctx.http.offline;
  const results = await mapLimit(entries, cfg.concurrency, async (e) => {
    if (!e.address || offline) return null;
    const a = parseAddress(e.address);
    if (!a) return null;
    return probe(a.host, a.port, cfg.timeoutMs);
  });
  const servers = entries.map((e, i) => {
    const r = results[i];
    const prev = state[e.id]?.lastSeen ?? null;
    const lastSeen = r?.online ? nowIso : prev;
    if (r) state[e.id] = { lastSeen, lastChecked: nowIso };
    return communityServer(e, r, lastSeen);
  });
  if (!offline) {
    try {
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 1));
    } catch (e) {
      ctx.warn(`community servers: could not save ${stateFile}: ${errorText(e)}`);
    }
  }
  const online = servers.filter((s) => s.online).length;
  const checked = results.filter(Boolean).length;
  ctx.log(`community servers: ${servers.length} registered, ${checked} checked, ${online} reachable`);
  return {
    servers,
    sources: [{
      id: 'servers:community',
      ok: errors.length === 0,
      count: servers.length,
      sample: false,
      ...(errors.length ? { error: `${errors.length} entries not valid: ${errors.slice(0, 3).join('; ')}` } : {}),
    }],
  };
}

/** Approved event -> HubEvent; null when it is over. */
export function submittedEvent(e: EventEntry, now: Date): HubEvent | null {
  const startMs = Date.parse(e.start);
  const endMs = startMs + e.durationMinutes * 60_000;
  if (endMs <= now.getTime()) return null;
  const join = e.join ? parseJoinLink(e.join) : null;
  // "host:port" (ESWC, Original, Sunrise join by address)
  const address = e.join && !join ? e.join : null;
  return {
    id: `submitted:${e.id}`,
    source: 'submitted',
    sample: false,
    name: e.title,
    description: e.description ?? null,
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    status: startMs <= now.getTime() ? 'active' : 'scheduled',
    location: e.join ?? null,
    join,
    community: { id: `submitted:${slugId(e.host)}`, name: e.host, invite: e.hostLink ?? null },
    interested: null,
    image: null,
    games: e.games,
    url: e.link ?? null,
    address,
  };
}

export function buildSubmittedEvents(ctx: SourceContext, now: Date): { events: HubEvent[]; sources: SourceStatus[] } {
  const dir = resolveFrom(ctx.root, ctx.config.events.submittedDir);
  const { entries, errors } = loadEntries(dir, checkEventEntry);
  for (const e of errors) ctx.warn(`submitted events: ${e}`);
  const events = entries.map((e) => submittedEvent(e, now)).filter((e): e is HubEvent => e !== null);
  return {
    events,
    sources: [{
      id: 'events:submitted',
      ok: errors.length === 0,
      count: events.length,
      sample: false,
      ...(errors.length ? { error: `${errors.length} entries not valid: ${errors.slice(0, 3).join('; ')}` } : {}),
    }],
  };
}
