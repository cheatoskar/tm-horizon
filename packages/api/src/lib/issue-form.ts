// GitHub issue form bodies -> registry entries. An issue form renders each field as
//   ### <label>\n\n<value>\n\n   (empty fields: "_No response_")
// The labels are read from the template itself, so renaming a label cannot break the mapping.
import { parse as parseYaml } from 'yaml';
import type { Checked, EventEntry, ServerEntry } from './registry.ts';
import { checkEventEntry, checkServerEntry, cleanText, gameFromLabel, slugId, zonedTimeToIso } from './registry.ts';

interface TemplateItem {
  type: string;
  id?: string;
  attributes?: { label?: string };
}

/** Field id -> value. Checkbox fields and markdown blocks are skipped. */
export function parseIssueForm(body: string, templateYaml: string): Record<string, string> {
  const tpl = parseYaml(templateYaml) as { body: TemplateItem[] };
  const byLabel = new Map<string, string>();
  for (const item of tpl.body) {
    if (item.id && item.attributes?.label && item.type !== 'markdown' && item.type !== 'checkboxes') byLabel.set(item.attributes.label.trim(), item.id);
  }
  const out: Record<string, string> = {};
  const parts = body.replace(/\r\n?/g, '\n').split(/^### /m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const label = (nl < 0 ? part : part.slice(0, nl)).trim();
    const id = byLabel.get(label);
    if (!id) continue;
    const value = nl < 0 ? '' : part.slice(nl + 1).trim();
    if (value && value !== '_No response_') out[id] = value;
  }
  return out;
}

/** "120", "2h", "1h30", "1:30", "90 min", "2 hours" -> minutes; NaN when unreadable. */
export function parseDuration(s: string): number {
  const t = s.trim().toLowerCase();
  let m = /^(\d+)\s*(m|min|mins|minutes?)?$/.exec(t);
  if (m) return Number(m[1]);
  m = /^(\d+(?:[.,]\d+)?)\s*(h|hrs?|hours?)$/.exec(t);
  if (m) return Math.round(Number(m[1].replace(',', '.')) * 60);
  m = /^(\d+)\s*h\s*(\d+)\s*(m|min)?$/.exec(t) ?? /^(\d+):(\d{2})$/.exec(t);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  return NaN;
}

/** Pick an id that is free: base, base-<issue>, base-<issue>-2, ... */
export function freeId(base: string, issue: number, taken: Set<string>): string {
  const b = base.length >= 3 ? base : `${base || 'entry'}-${issue}`;
  if (!taken.has(b)) return b;
  let id = `${b}-${issue}`.slice(0, 64);
  for (let n = 2; taken.has(id); n++) id = `${b}-${issue}-${n}`.slice(0, 64);
  return id;
}

export function serverFromForm(f: Record<string, string>, issue: number, taken: Set<string>, today: string): Checked<ServerEntry> {
  const game = gameFromLabel(f.game ?? '');
  const id = freeId(slugId(`${f.name ?? ''}${game ? '-' + game : ''}`), issue, taken);
  return checkServerEntry({
    id,
    game: game ?? f.game,
    name: f.name,
    address: f.address,
    login: f.login,
    mode: f.mode,
    language: f.language,
    description: f.description,
    contact: f.contact,
    homepage: f.homepage,
    added: today,
    issue,
  });
}

export function eventFromForm(f: Record<string, string>, issue: number, taken: Set<string>): Checked<EventEntry> {
  const errors: string[] = [];
  const start = zonedTimeToIso(f.date ?? '', f.time ?? '', f.timezone ?? '');
  if (!start) errors.push(`date/time/time zone "${f.date ?? ''} ${f.time ?? ''} ${f.timezone ?? ''}": e.g. 2026-11-21, 19:00, Europe/Berlin`);
  const duration = parseDuration(f.duration ?? '');
  if (Number.isNaN(duration)) errors.push(`duration "${f.duration ?? ''}": e.g. 2h or 90 min`);
  const date = /^\d{4}-\d{2}-\d{2}$/.test((f.date ?? '').trim()) ? f.date.trim() : 'event';
  const id = freeId(slugId(`${date}-${cleanText(f.name, 100) ?? ''}`), issue, taken);
  const checked = checkEventEntry({
    id,
    title: f.name,
    games: f.games,
    start: start ?? '',
    durationMinutes: duration,
    host: f.host,
    hostLink: f.host_link,
    join: f.join,
    description: f.description,
    link: f.link,
    issue,
  });
  if (errors.length) return { entry: null, errors: [...errors, ...checked.errors.filter((e) => !/^start |^durationMinutes/.test(e))] };
  return checked;
}
