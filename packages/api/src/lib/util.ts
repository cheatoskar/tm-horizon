import type { GameId, JoinLink } from '../types.ts';

/** Remove TrackMania/ManiaPlanet $-formatting codes ($fff, $o, $l[url]...). "$$" stays a dollar sign. */
export function stripFormatting(raw: string): string {
  return raw
    .replace(/\$\$/g, '\u0000')
    .replace(/\$[lhp](\[[^\]]*\])?/gi, '')
    .replace(/\$[0-9a-f]{1,3}/gi, '')
    .replace(/\$./g, '')
    .replace(/\$$/, '')
    .replace(/\u0000/g, '$')
    .trim();
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/%/g, ' percent')
    .replace(/\+/g, ' plus')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Compare version strings like "1.4.3-rc.2", "2.12.0-compat", "1.0.3-v7". Newer sorts higher. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const clean = v.replace(/^v/i, '');
    const dash = clean.indexOf('-');
    const core = dash < 0 ? clean : clean.slice(0, dash);
    const pre = dash < 0 ? '' : clean.slice(dash + 1);
    return { nums: core.split('.').map((n) => parseInt(n, 10) || 0), pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre.localeCompare(y.pre, 'en', { numeric: true });
}

const JOIN_RE = /\b(tmtp|maniaplanet|trackmania):\/\/[^\s<>"')\]]+/i;

/**
 * Parse a game join link found anywhere in a text:
 *   tmtp://#join=serverlogin            (TrackMania Forever)
 *   tmtp://#join=serverlogin:password
 *   tmtp://#join=1.2.3.4:2350           (address and port)
 *   maniaplanet://#join=login@TMStadium@nadeo
 */
export function parseJoinLink(text: string | null | undefined): JoinLink | null {
  if (!text) return null;
  const m = JOIN_RE.exec(text);
  if (!m) return null;
  const raw = m[0].replace(/[.,;]+$/, '');
  const scheme = m[1].toLowerCase() as JoinLink['scheme'];
  const rest = raw.slice(raw.indexOf('://') + 3).replace(/^\/*/, '');
  const hash = /^#?([a-z]+)=(.+)$/i.exec(rest);
  if (!hash) return { raw, scheme, action: 'open', target: decodeURIComponent(rest.replace(/^#/, '')), title: null };
  const action = hash[1].toLowerCase();
  let target = decodeURIComponent(hash[2]);
  let title: string | null = null;
  let password: string | null = null;
  if (scheme === 'maniaplanet' || scheme === 'trackmania') {
    const at = target.indexOf('@');
    if (at > 0) {
      title = target.slice(at + 1);
      target = target.slice(0, at);
    }
  }
  if (!/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(target) && !/^\[[0-9a-f:]+\]:\d+$/i.test(target)) {
    const colon = target.indexOf(':');
    if (colon > 0) {
      password = target.slice(colon + 1);
      target = target.slice(0, colon);
    }
  }
  const link: JoinLink = { raw, scheme, action, target, title };
  if (password !== null) link.password = password;
  return link;
}

/** ManiaPlanet title id -> game id (null for custom titles). */
export function gameFromTitle(title: string | null | undefined): GameId | null {
  if (!title) return null;
  const t = title.toLowerCase();
  if (t.startsWith('tmcanyon@')) return 'tm2-canyon';
  if (t.startsWith('tmstadium@')) return 'tm2-stadium';
  if (t.startsWith('tmvalley@')) return 'tm2-valley';
  if (t.startsWith('tmlagoon@')) return 'tm2-lagoon';
  if (t.startsWith('smstorm')) return 'sm-storm';
  if (t === 'tmcanyon') return 'tm2-canyon';
  if (t === 'tmstadium') return 'tm2-stadium';
  if (t === 'tmvalley') return 'tm2-valley';
  if (t === 'tmlagoon') return 'tm2-lagoon';
  return null;
}

export function shorten(s: string | null | undefined, max: number): string | null {
  if (!s) return null;
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…';
}

export const GAME_IDS: GameId[] = [
  'tmo', 'tms', 'eswc', 'tmnf', 'tmuf', 'tm2-canyon', 'tm2-stadium', 'tm2-valley', 'tm2-lagoon', 'sm-storm', 'tm2020', 'turbo',
];

export function isGameId(s: unknown): s is GameId {
  return typeof s === 'string' && (GAME_IDS as string[]).includes(s);
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const sleep = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms));
