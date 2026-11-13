// Trackmania Exchange family, API v2 (docs: https://api2.mania.exchange, method list
// https://api.mania.exchange/api/methods). Track sites (TMNF-X, TMUF-X, TMO-X, TMS-X, TMN-X)
// use GET /api/tracks, map sites (TM2.MX, SM.MX, TMX) GET /api/maps; both need "fields=".
// Order keys from /api/meta/trackorders and /api/meta/maporders.
import type { MapEntry, MapList, SourceStatus } from '../types.ts';
import type { SourceContext, TmxSiteConfig } from '../config.ts';
import { errorText, sleep, stripFormatting } from '../lib/util.ts';

export const TRACK_ORDERS: Record<MapList, number> = { awarded: 26, latest: 2 }; // "Awarded (Most recent)", "Uploaded (Newest)"
export const MAP_ORDERS: Record<MapList, number> = { awarded: 40, latest: 6 }; // "Map Awarded (Newest)", "Uploaded (Newest)"
export const LIST_TEXT: Record<MapList, string> = {
  awarded: 'most recently awarded (tracks order1=26, maps order1=40)',
  latest: 'newest uploads (tracks order1=2, maps order1=6)',
};

const TRACK_FIELDS = ['TrackId', 'TrackName', 'Uploader.Name', 'Authors', 'Awards', 'UploadedAt', 'Environment', 'HasThumbnail'];
const MAP_FIELDS = ['MapId', 'Name', 'Uploader.Name', 'Authors', 'AwardCount', 'UploadedAt', 'TitlePack', 'HasThumbnail'];

/** Environment numbers of the TMX track sites. */
const TRACK_ENVIRONMENTS: Record<number, string> = { 1: 'Snow', 2: 'Desert', 3: 'Rally', 4: 'Island', 5: 'Coast', 6: 'Bay', 7: 'Stadium' };

interface TmxUser { UserId?: number; Name?: string }
interface TmxAuthor { User?: TmxUser; Role?: string }

export interface TmxTrack {
  TrackId: number;
  TrackName: string;
  Uploader?: TmxUser;
  Authors?: TmxAuthor[];
  Awards?: number;
  UploadedAt?: string;
  Environment?: number;
  HasThumbnail?: boolean;
}

export interface TmxMap {
  MapId: number;
  Name: string;
  Uploader?: TmxUser;
  Authors?: TmxAuthor[];
  AwardCount?: number;
  UploadedAt?: string;
  TitlePack?: string;
  HasThumbnail?: boolean;
}

export interface TmxPage<T> { More?: boolean; Results?: T[] }

export function tmxSearchUrl(site: TmxSiteConfig, list: MapList, count: number): string {
  const tracks = site.kind === 'tracks';
  const params = new URLSearchParams({
    fields: (tracks ? TRACK_FIELDS : MAP_FIELDS).join(','),
    count: String(count),
    order1: String((tracks ? TRACK_ORDERS : MAP_ORDERS)[list]),
  });
  if (site.titlepack) params.set('titlepack', site.titlepack);
  return `https://${site.host}/api/${tracks ? 'tracks' : 'maps'}?${params}`;
}

/** Exchange dates have no zone; they are UTC. */
const utc = (s: string | undefined) => (s ? new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z').toISOString() : null);
const authorOf = (a: TmxAuthor[] | undefined, u: TmxUser | undefined) => a?.[0]?.User?.Name ?? u?.Name ?? null;

export function parseTmxPage(raw: unknown, site: TmxSiteConfig, list: MapList): MapEntry[] {
  const page = raw as TmxPage<TmxTrack & TmxMap>;
  if (!page || !Array.isArray(page.Results)) throw new Error('unexpected TMX response (no "Results")');
  const base = `https://${site.host}`;
  return page.Results.map((r) => {
    if (site.kind === 'tracks') {
      const t = r as TmxTrack;
      return {
        id: `${site.site}:${t.TrackId}`,
        site: site.site,
        game: site.game,
        lists: [list],
        exchangeId: t.TrackId,
        name: stripFormatting(t.TrackName),
        nameRaw: t.TrackName,
        author: authorOf(t.Authors, t.Uploader),
        awards: t.Awards ?? 0,
        uploaded: utc(t.UploadedAt),
        environment: t.Environment ? (TRACK_ENVIRONMENTS[t.Environment] ?? null) : null,
        url: `${base}/trackshow/${t.TrackId}`,
        thumbnail: t.HasThumbnail === false ? null : `${base}/trackshow/${t.TrackId}/image/1`,
        download: `${base}/trackgbx/${t.TrackId}`,
      };
    }
    const m = r as TmxMap;
    const env = m.TitlePack?.match(/^TM(Canyon|Stadium|Valley|Lagoon)$/)?.[1] ?? (site.game === 'tm2020' ? 'Stadium' : site.game === 'sm-storm' ? 'Storm' : null);
    return {
      id: `${site.site}:${m.MapId}`,
      site: site.site,
      game: site.game,
      lists: [list],
      exchangeId: m.MapId,
      name: stripFormatting(m.Name),
      nameRaw: m.Name,
      author: authorOf(m.Authors, m.Uploader),
      awards: m.AwardCount ?? 0,
      uploaded: utc(m.UploadedAt),
      environment: env,
      url: `${base}/mapshow/${m.MapId}`,
      thumbnail: m.HasThumbnail === false ? null : `${base}/mapthumb/${m.MapId}`,
      download: `${base}/mapgbx/${m.MapId}`,
    };
  });
}

export async function buildMaps(ctx: SourceContext): Promise<{ maps: MapEntry[]; sources: SourceStatus[] }> {
  const cfg = ctx.config.tmx;
  const maps: MapEntry[] = [];
  const sources: SourceStatus[] = [];
  const lists: MapList[] = ['awarded', 'latest'];
  for (const site of cfg.sites) {
    for (const list of lists) {
      const id = `tmx:${site.game}:${list}`;
      const url = tmxSearchUrl(site, list, cfg.count);
      try {
        const { data, result } = await ctx.http.getJson<unknown>(url, { ttlMinutes: cfg.ttlMinutes });
        const got = parseTmxPage(data, site, list);
        for (const m of got) {
          const same = maps.find((x) => x.id === m.id);
          if (same) {
            if (!same.lists.includes(list)) same.lists.push(list);
          } else maps.push(m);
        }
        sources.push({ id, ok: true, count: got.length, sample: false, cached: !!result.cache });
        if (!result.cache) await sleep(cfg.delayMs);
      } catch (e) {
        ctx.warn(`tmx: ${site.host} ${site.titlepack ?? ''} ${list}: ${errorText(e)}`);
        sources.push({ id, ok: false, count: 0, sample: false, error: errorText(e) });
      }
    }
  }
  return { maps, sources };
}
