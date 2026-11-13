// Real event sources without a secret:
//  - Trackmania (2020) competitions as mirrored by trackmania.io (public, descriptive User-Agent):
//      GET https://trackmania.io/api/competitions/0   newest competitions (by creation), then
//      GET https://trackmania.io/api/comp/{id}        start/end dates, rounds
//    The list has no dates, so the newest few are looked up one by one; only upcoming or running ones are kept.
//    Cup of the Day has no public endpoint (Nadeo Live Services need an account), so it is not listed.
//  - TMTAS exchange events (TAS competitions): the events page data of the SvelteKit site,
//      GET https://tmtas.exchange/events/__data.json   (devalue-encoded; liveEvents / upcomingEvents / pastEvents)
//    Marked tas: true, the launcher shows them in TAS mode only.
// ManiaPlanet / ShootMania: no public event source is known.
import type { GameId, HubEvent, SourceStatus } from '../types.ts';
import type { SourceContext } from '../config.ts';
import { errorText, shorten, stripFormatting } from '../lib/util.ts';

/** Generic client name, as trackmania.io asks for a descriptive one. */
const UA = { 'User-Agent': 'TM-Horizon-hub-data (+https://tm-horizon.com)' };
const iso = (sec: number) => new Date(sec * 1000).toISOString();

interface TmioCompetitionSummary { competitionid: number; name: string; clubid: number }
interface TmioCompetition {
  id: number; name: string; description?: string; clubname?: string; clubid?: number;
  startdate: number; enddate: number; logourl?: string; websiteurl?: string; streamurl?: string; numplayers?: number;
}

export function parseTmioCompetitionList(raw: unknown): TmioCompetitionSummary[] {
  const l = (raw as { competitions?: TmioCompetitionSummary[] })?.competitions;
  if (!Array.isArray(l)) throw new Error('unexpected trackmania.io response (no "competitions")');
  return l.filter((c) => Number.isInteger(c.competitionid));
}

export function tmioCompetitionEvent(raw: unknown, now: Date): HubEvent | null {
  const c = raw as TmioCompetition;
  if (!c || !Number.isInteger(c.id) || !c.startdate || !c.enddate) return null;
  if (c.enddate * 1000 <= now.getTime()) return null;
  const site = c.websiteurl && /^https:\/\//i.test(c.websiteurl) ? c.websiteurl : null;
  return {
    id: `trackmania.io:${c.id}`,
    source: 'trackmania.io',
    sample: false,
    name: stripFormatting(c.name),
    description: shorten(c.description?.trim(), 2000),
    start: iso(c.startdate),
    end: iso(c.enddate),
    status: c.startdate * 1000 <= now.getTime() ? 'active' : 'scheduled',
    location: null,
    join: null,
    community: c.clubname ? { id: String(c.clubid ?? ''), name: stripFormatting(c.clubname), invite: null } : null,
    interested: typeof c.numplayers === 'number' ? c.numplayers : null,
    image: null,
    games: ['tm2020'],
    url: site ?? `https://trackmania.io/#/competition/${c.id}`,
  };
}

/** Decode SvelteKit's "devalue" format (flat array, values are indices). Only plain JSON types are supported. */
export function devalueDecode(table: unknown[]): unknown {
  const memo = new Map<number, unknown>();
  const get = (i: number): unknown => {
    if (i < 0) return undefined;
    if (memo.has(i)) return memo.get(i);
    const v = table[i];
    if (Array.isArray(v)) {
      if (typeof v[0] === 'string') throw new Error(`devalue type "${v[0]}" not supported`);
      const out: unknown[] = [];
      memo.set(i, out);
      for (const x of v) out.push(get(x as number));
      return out;
    }
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      memo.set(i, out);
      for (const [k, x] of Object.entries(v)) out[k] = get(x as number);
      return out;
    }
    memo.set(i, v);
    return v;
  };
  return get(0);
}

interface TmtasEvent {
  id: number; name: string; description?: string | null; start_time: number; end_time: number;
  category_name?: string | null; track_name?: string | null; event_type?: string;
}

export function parseTmtasEvents(raw: unknown, now: Date): HubEvent[] {
  const nodes = (raw as { nodes?: { type?: string; data?: unknown[] }[] })?.nodes;
  const node = nodes?.find((n) => n?.type === 'data' && Array.isArray(n.data) && JSON.stringify(n.data[0] ?? {}).includes('liveEvents'));
  if (!node?.data) throw new Error('unexpected tmtas.exchange response (no liveEvents)');
  const root = devalueDecode(node.data) as { liveEvents?: TmtasEvent[]; upcomingEvents?: TmtasEvent[] };
  const list = [...(root.liveEvents ?? []), ...(root.upcomingEvents ?? [])];
  const games: GameId[] = [];
  return list
    .filter((e) => Number.isInteger(e.id) && e.end_time * 1000 > now.getTime())
    .map((e) => ({
      id: `tmtas:${e.id}`,
      source: 'tmtas' as const,
      sample: false,
      tas: true,
      name: e.name,
      description: shorten(e.description?.trim(), 2000),
      start: iso(e.start_time),
      end: iso(e.end_time),
      status: e.start_time * 1000 <= now.getTime() ? 'active' : 'scheduled',
      location: null,
      join: null,
      community: { id: 'tmtas', name: e.category_name || 'TMTAS Exchange', invite: null },
      interested: null,
      image: null,
      games,
      url: `https://tmtas.exchange/events/${e.id}`,
    }));
}

export async function buildLiveEvents(ctx: SourceContext, now: Date): Promise<{ events: HubEvent[]; sources: SourceStatus[] }> {
  const cfg = ctx.config.events.live;
  const events: HubEvent[] = [];
  const sources: SourceStatus[] = [];
  if (cfg.trackmaniaIo.enabled) {
    const got: HubEvent[] = [];
    try {
      const { data, result } = await ctx.http.getJson<unknown>('https://trackmania.io/api/competitions/0', { ttlMinutes: cfg.trackmaniaIo.ttlMinutes, headers: UA });
      for (const c of parseTmioCompetitionList(data).slice(0, cfg.trackmaniaIo.lookup)) {
        const { data: d } = await ctx.http.getJson<unknown>(`https://trackmania.io/api/comp/${c.competitionid}`, { ttlMinutes: cfg.trackmaniaIo.ttlMinutes * 6, headers: UA });
        const e = tmioCompetitionEvent(d, now);
        if (e) got.push(e);
      }
      events.push(...got);
      sources.push({ id: 'events:trackmania.io', ok: true, count: got.length, sample: false, cached: !!result.cache });
    } catch (e) {
      ctx.warn(`events: trackmania.io: ${errorText(e)}`);
      events.push(...got);
      sources.push({ id: 'events:trackmania.io', ok: false, count: got.length, sample: false, error: errorText(e) });
    }
  }
  if (cfg.tmtas.enabled) {
    try {
      const { data, result } = await ctx.http.getJson<unknown>('https://tmtas.exchange/events/__data.json', { ttlMinutes: cfg.tmtas.ttlMinutes, headers: UA });
      const got = parseTmtasEvents(data, now);
      events.push(...got);
      sources.push({ id: 'events:tmtas', ok: true, count: got.length, sample: false, cached: !!result.cache });
    } catch (e) {
      ctx.warn(`events: tmtas.exchange: ${errorText(e)}`);
      sources.push({ id: 'events:tmtas', ok: false, count: 0, sample: false, error: errorText(e) });
    }
  }
  return { events, sources };
}
