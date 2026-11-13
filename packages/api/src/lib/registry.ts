// Community registry: server and event entries in data/servers/*.yaml and data/events/*.yaml.
// Entries come from the issue forms (.github/ISSUE_TEMPLATE/server.yml, event.yml, converted by
// scripts/issue-to-yaml.ts once a maintainer adds the label "approved") or from pull requests.
// Everything here is pure: validation, join links, time zones. No network.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { GameId } from '../types.ts';
import { isGameId, parseJoinLink } from './util.ts';

/** Games a community server can be registered for (TM2020 servers are club rooms, listed elsewhere). */
export const SERVER_GAMES: GameId[] = ['tmo', 'tms', 'eswc', 'tmnf', 'tmuf', 'tm2-canyon', 'tm2-stadium', 'tm2-valley', 'tm2-lagoon', 'sm-storm'];

/** Games whose clients have no join link; players join by address in the game's network menu. */
export const ADDRESS_ONLY_GAMES: GameId[] = ['tmo', 'tms', 'eswc'];

const MP_TITLES: Partial<Record<GameId, string>> = {
  'tm2-canyon': 'TMCanyon@nadeo',
  'tm2-stadium': 'TMStadium@nadeo',
  'tm2-valley': 'TMValley@nadeo',
  'tm2-lagoon': 'TMLagoon@nadeo',
  'sm-storm': 'SMStorm@nadeo',
};

export const GAME_NAMES: Record<string, GameId> = {
  'trackmania original': 'tmo',
  'trackmania sunrise': 'tms',
  'trackmania sunrise extreme': 'tms',
  'trackmania nations eswc': 'eswc',
  'trackmania nations forever': 'tmnf',
  'trackmania united forever': 'tmuf',
  'trackmania 2 canyon': 'tm2-canyon',
  'trackmania 2 stadium': 'tm2-stadium',
  'trackmania 2 valley': 'tm2-valley',
  'trackmania 2 lagoon': 'tm2-lagoon',
  'shootmania storm': 'sm-storm',
  'trackmania (2020)': 'tm2020',
  'trackmania turbo': 'turbo',
};

/** "TrackMania Nations Forever (tmnf)", "tmnf" or "TrackMania Nations Forever" -> "tmnf". */
export function gameFromLabel(s: string): GameId | null {
  const t = s.trim().toLowerCase();
  const paren = /\(([a-z0-9-]+)\)\s*$/.exec(t);
  if (paren && isGameId(paren[1])) return paren[1];
  if (isGameId(t)) return t;
  return GAME_NAMES[t] ?? null;
}

export interface ServerEntry {
  /** File name without .yaml: lowercase letters, digits and dashes. */
  id: string;
  game: GameId;
  name: string;
  /** "host:port" of the game port (default port 2350). */
  address?: string | null;
  /** Server login (TMNF/TMUF/ManiaPlanet). */
  login?: string | null;
  /** ManiaPlanet title, e.g. "TMStadium@nadeo"; default from the game. */
  title?: string | null;
  mode?: string | null;
  language?: string | null;
  description?: string | null;
  contact?: string | null;
  homepage?: string | null;
  /** Date the entry was added (YYYY-MM-DD). */
  added?: string | null;
  /** Issue the entry came from. */
  issue?: number | null;
}

export interface EventEntry {
  id: string;
  title: string;
  games: GameId[];
  /** ISO 8601 with offset or Z, e.g. "2026-11-21T19:00:00+01:00". */
  start: string;
  durationMinutes: number;
  host: string;
  /** Discord invite or website of the host community. */
  hostLink?: string | null;
  /** Join link (tmtp://, maniaplanet://) or "host:port". */
  join?: string | null;
  description?: string | null;
  link?: string | null;
  issue?: number | null;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const LOGIN_RE = /^[A-Za-z0-9_.\-]{1,40}$/;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/** Remove control characters and $-free trim; keeps the text otherwise as written. */
export function cleanText(s: unknown, max: number): string | null {
  if (s === null || s === undefined) return null;
  const t = String(s)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!t || t === '_No response_') return null;
  return t.length > max ? t.slice(0, max) : t;
}

export function slugId(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
}

/** True for addresses a build must never probe: private, loopback, link-local, multicast, reserved, CGNAT. */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (net.isIPv6(ip)) {
    const t = ip.toLowerCase();
    if (t.startsWith('::ffff:')) return isPrivateIp(t.slice(7));
    return t === '::' || t === '::1' || /^f[cd]/.test(t) || /^fe[89ab]/.test(t) || t.startsWith('ff');
  }
  return true;
}

export interface Address {
  host: string;
  port: number;
}

/** "1.2.3.4:2350", "tm.example.org:2350", "[2001:db8::1]:2350", or a host without port (-> defaultPort). */
export function parseAddress(s: string, defaultPort = 2350): Address | null {
  const t = s.trim();
  let host: string;
  let port = defaultPort;
  const v6 = /^\[([0-9a-f:.]+)\](?::(\d+))?$/i.exec(t);
  if (v6) {
    host = v6[1];
    if (v6[2]) port = Number(v6[2]);
    if (!net.isIPv6(host)) return null;
  } else {
    const m = /^([^:\s/]+)(?::(\d+))?$/.exec(t);
    if (!m) return null;
    host = m[1].toLowerCase();
    if (m[2]) port = Number(m[2]);
    if (!net.isIPv4(host) && !HOST_RE.test(host)) return null;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

export function formatAddress(a: Address): string {
  return net.isIPv6(a.host) ? `[${a.host}]:${a.port}` : `${a.host}:${a.port}`;
}

function httpsUrl(s: string | null): string | null {
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Discord invite / https link, or a short handle like "name" or "@name". */
function contactValue(s: string | null): string | null | undefined {
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return httpsUrl(s) ?? undefined;
  return /^@?[A-Za-z0-9_.]{2,32}(#\d{4})?$/.test(s) ? s : undefined;
}

export interface Checked<T> {
  entry: T | null;
  errors: string[];
}

/** Validate and normalise one server entry (from YAML or from an issue form). */
export function checkServerEntry(raw: unknown): Checked<ServerEntry> {
  const errors: string[] = [];
  const r = (raw ?? {}) as Record<string, unknown>;
  const id = cleanText(r.id, 64) ?? '';
  if (!ID_RE.test(id)) errors.push(`id "${id}": lowercase letters, digits and dashes, 3 to 64 characters`);
  const game = typeof r.game === 'string' ? gameFromLabel(r.game) : null;
  if (!game || !SERVER_GAMES.includes(game)) errors.push(`game "${String(r.game)}": one of ${SERVER_GAMES.join(', ')}`);
  const name = cleanText(r.name, 80);
  if (!name) errors.push('name is missing');
  const addressText = cleanText(r.address, 300);
  const loginText = cleanText(r.login, 60);
  let address: string | null = null;
  if (addressText) {
    const a = parseAddress(addressText);
    if (!a) errors.push(`address "${addressText}": write host:port, e.g. 203.0.113.7:2350`);
    else if (net.isIP(a.host) && isPrivateIp(a.host)) errors.push(`address "${addressText}": private or reserved address, not reachable from the internet`);
    else address = formatAddress(a);
  }
  let login: string | null = null;
  if (loginText) {
    if (!LOGIN_RE.test(loginText)) errors.push(`login "${loginText}": letters, digits, _ . - only`);
    else login = loginText;
  }
  if (!address && !login) errors.push('give an address (host:port) or a server login');
  if (game && ADDRESS_ONLY_GAMES.includes(game) && !address) errors.push(`${game}: players join by address, so the address is required`);
  const title = cleanText(r.title, 60);
  if (title && !/^[A-Za-z0-9_]+@[A-Za-z0-9_]+$/.test(title)) errors.push(`title "${title}": e.g. TMStadium@nadeo`);
  const contact = contactValue(cleanText(r.contact, 120));
  if (contact === undefined) errors.push('contact: a Discord invite link or a Discord user name');
  const homepageText = cleanText(r.homepage, 300);
  const homepage = httpsUrl(homepageText);
  if (homepageText && !homepage) errors.push(`homepage "${homepageText}": not a web link`);
  const language = cleanText(r.language, 20)?.toLowerCase() ?? null;
  if (language && !/^[a-z]{2,3}(-[a-z]{2})?$|^multi$/.test(language)) errors.push(`language "${language}": a code like en, de, fr or "multi"`);
  const added = cleanText(r.added, 10);
  if (added && !/^\d{4}-\d{2}-\d{2}$/.test(added)) errors.push(`added "${added}": YYYY-MM-DD`);
  const issue = r.issue === undefined || r.issue === null ? null : Number(r.issue);
  if (issue !== null && !Number.isInteger(issue)) errors.push('issue: a number');
  if (errors.length) return { entry: null, errors };
  const entry: ServerEntry = { id, game: game!, name: name! };
  if (address) entry.address = address;
  if (login) entry.login = login;
  if (title) entry.title = title;
  const mode = cleanText(r.mode, 40);
  if (mode) entry.mode = mode;
  if (language) entry.language = language;
  const description = cleanText(r.description, 500);
  if (description) entry.description = description;
  if (contact) entry.contact = contact;
  if (homepage) entry.homepage = homepage;
  if (added) entry.added = added;
  if (issue !== null) entry.issue = issue;
  return { entry, errors };
}

/** Join link for a registered server, or null when the game only joins by address. */
export function serverJoinLink(e: ServerEntry): string | null {
  if (e.game === 'tmnf' || e.game === 'tmuf') {
    if (e.login) return `tmtp://#join=${e.login}`;
    if (e.address) return `tmtp://#join=${e.address}`;
    return null;
  }
  const title = e.title ?? MP_TITLES[e.game];
  if (title && e.login) return `maniaplanet://#join=${e.login}@${title}`;
  return null;
}

/** Offset in minutes of an IANA zone at a UTC instant (Europe/Berlin in winter -> 60). */
function zoneOffsetMinutes(zone: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const v = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute'), v('second'));
  return Math.round((asUtc - utcMs) / 60000);
}

/**
 * Local date + time + zone -> ISO string with offset.
 * zone: IANA name ("Europe/Berlin"), "UTC", "UTC+2", "UTC-05:30", "+01:00" or "Z".
 * Returns null for anything that does not parse.
 */
export function zonedTimeToIso(date: string, time: string, zone: string): string | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  const t = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!d || !t) return null;
  const [y, mo, da, h, mi] = [Number(d[1]), Number(d[2]), Number(d[3]), Number(t[1]), Number(t[2])];
  if (mo < 1 || mo > 12 || da < 1 || da > 31 || h > 23 || mi > 59) return null;
  const wall = Date.UTC(y, mo - 1, da, h, mi);
  if (new Date(wall).getUTCDate() !== da) return null;
  const z = zone.trim();
  let offset: number;
  const fixed = /^(?:UTC|GMT)?\s*([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(z);
  if (/^(utc|gmt|z)$/i.test(z)) offset = 0;
  else if (fixed) offset = (fixed[1] === '-' ? -1 : 1) * (Number(fixed[2]) * 60 + Number(fixed[3] ?? 0));
  else {
    try {
      // two passes: the offset at the guessed instant, then at the corrected one (DST edges)
      offset = zoneOffsetMinutes(z, wall);
      offset = zoneOffsetMinutes(z, wall - offset * 60000);
    } catch {
      return null;
    }
  }
  if (Math.abs(offset) > 14 * 60) return null;
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d[1]}-${d[2]}-${d[3]}T${pad(h)}:${pad(mi)}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function checkEventEntry(raw: unknown): Checked<EventEntry> {
  const errors: string[] = [];
  const r = (raw ?? {}) as Record<string, unknown>;
  const id = cleanText(r.id, 64) ?? '';
  if (!ID_RE.test(id)) errors.push(`id "${id}": lowercase letters, digits and dashes, 3 to 64 characters`);
  const title = cleanText(r.title, 100);
  if (!title) errors.push('title is missing');
  const gamesRaw = Array.isArray(r.games) ? r.games : typeof r.games === 'string' ? r.games.split(/[,\n]/) : [];
  const games: GameId[] = [];
  for (const g of gamesRaw) {
    const id2 = gameFromLabel(String(g));
    if (id2 && !games.includes(id2)) games.push(id2);
    else if (!id2 && String(g).trim()) errors.push(`game "${String(g).trim()}" unknown`);
  }
  if (!games.length) errors.push('at least one game');
  const start = cleanText(r.start instanceof Date ? r.start.toISOString() : r.start, 40);
  if (!start || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(start) || Number.isNaN(Date.parse(start))) {
    errors.push(`start "${start ?? ''}": ISO 8601 with offset, e.g. 2026-11-21T19:00:00+01:00`);
  }
  const duration = Number(r.durationMinutes);
  if (!Number.isInteger(duration) || duration < 5 || duration > 14 * 24 * 60) errors.push('durationMinutes: whole minutes, 5 to 20160');
  const host = cleanText(r.host, 80);
  if (!host) errors.push('host community is missing');
  const hostLinkText = cleanText(r.hostLink, 300);
  const hostLink = httpsUrl(hostLinkText);
  if (hostLinkText && !hostLink) errors.push(`hostLink "${hostLinkText}": not a web link`);
  const joinText = cleanText(r.join, 300);
  let join: string | null = null;
  if (joinText) {
    const link = parseJoinLink(joinText);
    const addr = link ? null : parseAddress(joinText);
    if (link && link.raw === joinText) join = link.raw;
    else if (addr && !(net.isIP(addr.host) && isPrivateIp(addr.host))) join = formatAddress(addr);
    else errors.push(`join "${joinText}": a tmtp:// or maniaplanet:// link, or host:port`);
  }
  const linkText = cleanText(r.link, 300);
  const link = httpsUrl(linkText);
  if (linkText && !link) errors.push(`link "${linkText}": not a web link`);
  const issue = r.issue === undefined || r.issue === null ? null : Number(r.issue);
  if (issue !== null && !Number.isInteger(issue)) errors.push('issue: a number');
  if (errors.length) return { entry: null, errors };
  const entry: EventEntry = { id, title: title!, games, start: start!, durationMinutes: duration, host: host! };
  if (hostLink) entry.hostLink = hostLink;
  if (join) entry.join = join;
  const description = cleanText(r.description, 2000);
  if (description) entry.description = description;
  if (link) entry.link = link;
  if (issue !== null) entry.issue = issue;
  return { entry, errors };
}

export interface LoadedEntries<T> {
  entries: T[];
  /** "file: problem" for every file that did not validate. */
  errors: string[];
}

/** Read every *.yaml in dir and validate it; the id must equal the file name. */
export function loadEntries<T extends { id: string }>(dir: string, check: (raw: unknown) => Checked<T>): LoadedEntries<T> {
  const entries: T[] = [];
  const errors: string[] = [];
  if (!fs.existsSync(dir)) return { entries, errors };
  for (const file of fs.readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f)).sort()) {
    let raw: unknown;
    try {
      raw = parseYaml(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch (e) {
      errors.push(`${file}: YAML: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const { entry, errors: errs } = check(raw);
    const stem = file.replace(/\.ya?ml$/i, '');
    if (!entry) errors.push(...errs.map((x) => `${file}: ${x}`));
    else if (entry.id !== stem) errors.push(`${file}: id "${entry.id}" must equal the file name`);
    else entries.push(entry);
  }
  return { entries, errors };
}

/** YAML text for an entry, with a header comment. */
export function entryToYaml(entry: ServerEntry | EventEntry, header: string): string {
  return `# ${header}\n` + stringifyYaml(entry, { lineWidth: 0 });
}
