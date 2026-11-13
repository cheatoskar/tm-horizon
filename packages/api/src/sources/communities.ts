// Discord server directory: the community's public Google Sheet (kept by mx_eyebo / Mania Exchange),
// read through its xlsx export (which keeps the hyperlinks), plus one public invite lookup per server:
//   GET https://discord.com/api/v10/invites/<code>?with_counts=true   (no token)
// gives the server name, member and online counts; HTTP 404 means the invite expired.
// Lookups are sequential, delayMs apart, 429 waits for Retry-After, and every answer is kept for
// inviteTtlHours in <cache>/discord-invites.json. A failing sheet becomes a warning and an empty list.
import fs from 'node:fs';
import path from 'node:path';
import type { Community, SourceStatus } from '../types.ts';
import type { SourceContext } from '../config.ts';
import { errorText, sleep, slug } from '../lib/util.ts';
import { parseXlsx } from '../lib/xlsx.ts';
import type { XlsxSheet } from '../lib/xlsx.ts';

export const COMMUNITIES_CREDIT = { text: 'List by mx_eyebo / Mania Exchange' };
export const COMMUNITIES_SUGGEST = 'To add a server, contact mx_eyebo on Discord.';

/** A directory row before the Discord lookup. */
export type DirectoryEntry = Omit<Community, 'alive' | 'members' | 'online' | 'guildName' | 'icon'>;

// ------------------------------------------------------------------ sheet layout

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** "Checked on 2025-12-08" or "(checked on December 8, 2025)" -> "2025-12-08". */
export function parseCheckedDate(text: string): string | null {
  const iso = /checked on\s+(\d{4})-(\d{2})-(\d{2})/i.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const long = /checked on\s+([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})/i.exec(text);
  if (long) {
    const month = MONTHS.indexOf(long[1].toLowerCase()) + 1;
    if (month > 0) return `${long[3]}-${String(month).padStart(2, '0')}-${long[2].padStart(2, '0')}`;
  }
  return null;
}

/** First line of a cell, whitespace collapsed. */
const firstLine = (text: string): string => (text.split('\n')[0] ?? '').replace(/\s+/g, ' ').trim();

/** Sections that sit below a larger region in the same column of "Countries & Regions". */
const REGION_OF: Record<string, string> = { Canada: 'North America', USA: 'North America', Australia: 'Asia / Oceania' };

/** discord.gg/<code>, discord.com/invite/<code>, discordapp.com/invite/<code> -> code. */
export function inviteCode(url: string): string | null {
  const m = /^https?:\/\/(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/i.exec(url.trim());
  return m ? m[1] : null;
}

/**
 * Walk one sheet. Layout (as of 2026-11): columns hold one group each, the group name sits in a
 * header row (row 4 on "Active Servers", row 1 on "The Archive") and applies to every column up to
 * the next header, so a group can span a spacer column. A cell without a link that contains
 * "Checked on <date>" starts a sub-section for its column; a cell with a hyperlink is a server.
 * Cells without a link and without that phrase (entries whose link was removed) are ignored.
 */
export function parseDirectorySheet(sheet: XlsxSheet): DirectoryEntry[] {
  const archive = /archive/i.test(sheet.name);
  const headerRow = archive ? 1 : 4;
  const groups = sheet.cells
    .filter((c) => c.row === headerRow && !c.link && firstLine(c.text))
    .map((c) => ({ col: c.col, name: firstLine(c.text), checked: parseCheckedDate(c.text) }));
  const groupAt = (col: number) => groups.filter((g) => g.col <= col).at(-1);

  const section = new Map<number, { name: string; checked: string | null }>();
  const out: DirectoryEntry[] = [];
  for (const c of sheet.cells) {
    if (c.row <= headerRow) continue;
    const g = groupAt(c.col);
    if (!g) continue;
    if (!c.link) {
      if (/checked on/i.test(c.text)) section.set(c.col, { name: firstLine(c.text), checked: parseCheckedDate(c.text) });
      continue;
    }
    if (!/^https?:\/\//i.test(c.link)) continue;
    const name = firstLine(c.text);
    if (!name) continue;
    const sec = section.get(c.col) ?? { name: g.name, checked: g.checked };
    const url = c.link.trim();
    out.push({
      id: '',
      name,
      url,
      invite: inviteCode(url),
      group: g.name,
      section: sec.name,
      region: g.name === 'Countries & Regions' ? (REGION_OF[sec.name] ?? sec.name) : null,
      active: !archive,
      checked: sec.checked,
      source: 'directory',
    });
  }
  return out;
}

/** Parse every sheet of the workbook and give each entry a unique id. */
export function parseDirectory(xlsx: Buffer): DirectoryEntry[] {
  const entries = parseXlsx(xlsx).flatMap(parseDirectorySheet);
  const used = new Set<string>();
  for (const e of entries) {
    const base = `dir:${slug(e.name) || 'server'}`;
    let id = base;
    if (used.has(id)) id = `${base}-${slug(e.section)}`;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    e.id = id;
  }
  return entries;
}

// ------------------------------------------------------------------ Discord invite lookup

export interface InviteInfo {
  /** Time of the lookup (ms since epoch). */
  t: number;
  /** false = HTTP 404 (expired or unknown invite). */
  alive: boolean;
  guildName: string | null;
  /** Server icon on Discord's CDN (from guild.id + guild.icon); null when the server has none. */
  icon?: string | null;
  members: number | null;
  online: number | null;
}

/** Discord's CDN URL for a server icon (64 px), only for plain ids and hashes. */
export function iconUrl(id: unknown, hash: unknown): string | null {
  if (typeof id !== 'string' || typeof hash !== 'string' || !/^\d{5,25}$/.test(id) || !/^(a_)?[0-9a-f]{32}$/.test(hash)) return null;
  return `https://cdn.discordapp.com/icons/${id}/${hash}.png?size=64`;
}

/** Interpret Discord's answer to GET /invites/<code>?with_counts=true. Null: neither valid nor expired. */
export function parseInviteResponse(status: number, body: string, now: number): InviteInfo | null {
  if (status === 404) return { t: now, alive: false, guildName: null, icon: null, members: null, online: null };
  if (status !== 200) return null;
  let j: { guild?: { name?: unknown; id?: unknown; icon?: unknown }; approximate_member_count?: unknown; approximate_presence_count?: unknown };
  try {
    j = JSON.parse(body);
  } catch {
    return null;
  }
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    t: now,
    alive: true,
    guildName: typeof j.guild?.name === 'string' ? j.guild.name : null,
    icon: iconUrl(j.guild?.id, j.guild?.icon),
    members: num(j.approximate_member_count),
    online: num(j.approximate_presence_count),
  };
}

type InviteCache = Record<string, InviteInfo>;

function readInviteCache(file: string): InviteCache {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as InviteCache;
  } catch {
    return {};
  }
}

/** Look up one invite; waits and retries on 429. Returns null when Discord does not give a usable answer. */
async function lookupInvite(ctx: SourceContext, code: string, now: () => number): Promise<InviteInfo | null> {
  const url = `https://discord.com/api/v10/invites/${encodeURIComponent(code)}?with_counts=true`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await ctx.http.getStatus(url);
    if (res.status === 429) {
      let wait = res.retryAfterSec;
      if (wait === null) {
        try {
          wait = Number((JSON.parse(res.body) as { retry_after?: number }).retry_after);
        } catch {
          wait = NaN;
        }
      }
      if (!Number.isFinite(wait) || (wait as number) > 120) return null;
      await sleep(Math.max(1, wait as number) * 1000 + 250);
      continue;
    }
    return parseInviteResponse(res.status, res.body, now());
  }
  return null;
}

// ------------------------------------------------------------------ build

export async function buildCommunities(
  ctx: SourceContext,
  nowDate: Date,
): Promise<{ communities: Community[]; sources: SourceStatus[] }> {
  const cfg = ctx.config.communities;
  if (!cfg?.enabled) return { communities: [], sources: [] };
  const sources: SourceStatus[] = [];
  let entries: DirectoryEntry[];
  try {
    const { bytes, result } = await ctx.http.getBytes(cfg.exportUrl, { ttlMinutes: cfg.sheetTtlHours * 60, timeoutMs: 60_000 });
    entries = parseDirectory(bytes);
    if (!entries.length) throw new Error('the sheet export contained no links (layout changed?)');
    sources.push({ id: 'directory', ok: true, count: entries.length, sample: false, cached: !!result.cache });
  } catch (e) {
    ctx.warn(`communities: ${errorText(e)}`);
    return { communities: [], sources: [{ id: 'directory', ok: false, count: 0, sample: false, error: errorText(e) }] };
  }

  const cacheFile = path.join(ctx.http.dir, 'discord-invites.json');
  const cache = readInviteCache(cacheFile);
  const ttl = cfg.inviteTtlHours * 3_600_000;
  const offline = ctx.http.offline;
  const codes = [...new Set(entries.map((e) => e.invite).filter((c): c is string => !!c))];
  // Oldest answers first (never looked up = 0), at most maxLookupsPerBuild.
  const due = offline ? [] : codes.filter((c) => !cache[c] || nowDate.getTime() - cache[c].t >= ttl).sort((a, b) => (cache[a]?.t ?? 0) - (cache[b]?.t ?? 0));
  const todo = due.slice(0, cfg.maxLookupsPerBuild);
  let looked = 0;
  let failed = 0;
  let errorsInRow = 0;
  for (const code of todo) {
    if (looked + failed > 0) await sleep(cfg.delayMs);
    try {
      const info = await lookupInvite(ctx, code, () => Date.now());
      if (info) {
        cache[code] = info;
        looked++;
        errorsInRow = 0;
      } else {
        failed++;
        errorsInRow++;
      }
    } catch (e) {
      failed++;
      errorsInRow++;
      if (errorsInRow === 1) ctx.warn(`communities: Discord invite lookup failed (${errorText(e)})`);
    }
    if (errorsInRow >= 5) {
      ctx.warn('communities: five invite lookups in a row failed or were rate limited; using cached answers for the rest');
      break;
    }
  }
  if (looked > 0) fs.writeFileSync(cacheFile, JSON.stringify(cache));
  const stale = codes.filter((c) => !cache[c]).length;
  sources.push({
    id: 'discord-invites',
    ok: failed === 0,
    count: codes.length - stale,
    sample: false,
    cached: looked === 0,
    ...(failed || stale || due.length > todo.length
      ? { error: `${looked} looked up, ${failed} failed, ${stale} without an answer, ${Math.max(0, due.length - todo.length)} waiting for the next build` }
      : {}),
  });

  const communities: Community[] = entries.map((e) => {
    const info = e.invite ? cache[e.invite] : undefined;
    return {
      ...e,
      alive: info ? info.alive : null,
      members: info?.members ?? null,
      online: info?.online ?? null,
      guildName: info?.guildName ?? null,
      icon: info?.icon ?? null,
    };
  });
  return { communities, sources };
}
