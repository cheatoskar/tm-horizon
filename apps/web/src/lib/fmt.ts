import { t, locales, type Lang } from '../i18n';
export const compact = (n: number | null | undefined, lang: Lang = 'en') => {
  if (n == null) return '';
  if (n < 1000) return String(n);
  return new Intl.NumberFormat(locales[lang], { notation: 'compact', maximumFractionDigits: n < 10000 || n >= 1e6 ? 1 : 0 }).format(n);
};

const BUILD = Date.now();
const UNITS: [number, Intl.RelativeTimeFormatUnit][] = [[60, 'second'], [60, 'minute'], [24, 'hour'], [30, 'day'], [12, 'month'], [Infinity, 'year']];
/** "3 days ago" relative to the build; the page script refreshes it in the browser (same units, same locale). */
export const ago = (iso: string | null | undefined, lang: Lang = 'en', now = BUILD) => {
  if (!iso) return '';
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (s < 0) return t(lang, 'time.soon');
  const rtf = new Intl.RelativeTimeFormat(locales[lang], { numeric: 'auto' });
  let v = s;
  for (const [n, unit] of UNITS) {
    if (v < n) return unit === 'second' ? t(lang, 'time.now') : rtf.format(-v, unit);
    v = Math.floor(v / n);
  }
  return '';
};

export const day = (iso: string | null | undefined, lang: Lang = 'en') =>
  iso ? new Date(iso).toLocaleDateString(locales[lang], { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '';

export const bytes = (n: number | null | undefined, lang: Lang = 'en') => {
  if (n == null) return '';
  const f = (x: number, d: number) => new Intl.NumberFormat(locales[lang], { minimumFractionDigits: d, maximumFractionDigits: d }).format(x);
  return n < 1024 * 1024 ? `${f(Math.round(n / 1024), 0)} ${t(lang, 'unit.kb')}` : `${f(n / 1024 / 1024, 1)} ${t(lang, 'unit.mb')}`;
};

/** Host of a link without "www.", for owner-supplied links. */
export const domain = (u: string) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return u; } };
/** Owner-supplied contact or homepage: only http(s) links become links; a bare "discord.gg/x" gets https://. Anything else stays text. */
export function safeLink(raw: string | null | undefined): { href: string | null; label: string } | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  const withScheme = /^https?:\/\//i.test(v) ? v : /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(v) ? `https://${v}` : null;
  if (!withScheme) return { href: null, label: v };
  try { return { href: new URL(withScheme).href, label: domain(withScheme) }; } catch { return { href: null, label: v }; }
}

export const isPre = (v: string) => /-(rc|test|dev|preview|alpha|beta)/i.test(v);

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** TrackMania $-codes to HTML spans: colours ($fff, $f00), italic ($i), bold ($o/$w loosely), reset ($z, $g). Links ($l, $h) dropped. */
export function tmName(raw: string) {
  let out = '', color = '', italic = false, bold = false, open = false;
  const flush = () => { if (open) { out += '</span>'; open = false; } };
  const start = () => {
    flush();
    const st = [color ? `color:${color}` : '', italic ? 'font-style:italic' : '', bold ? 'font-weight:800' : ''].filter(Boolean).join(';');
    // very light colours vanish on the light theme, very dark ones on the dark theme: CSS falls back to the text colour there
    let tone = '';
    if (color) { const [r, g, b] = color.slice(1).split('').map((h) => parseInt(h, 16) / 15); const l = 0.2126 * r + 0.7152 * g + 0.0722 * b; tone = l > 0.75 ? ' hi' : l < 0.18 ? ' lo' : ''; }
    if (st) { out += `<span class="tmc${tone}" style="${st}">`; open = true; }
  };
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '$') { out += esc(c); continue; }
    const n = raw[i + 1];
    if (n === undefined) break;
    if (n === '$') { out += '$'; i++; continue; }
    const hex = raw.slice(i + 1, i + 4);
    if (/^[0-9a-fA-F]{3}$/.test(hex)) { color = '#' + hex; i += 3; start(); continue; }
    i++;
    const k = n.toLowerCase();
    if (k === 'i') italic = true;
    else if (k === 'o' || k === 'w') bold = k === 'o' ? true : bold;
    else if (k === 'z') { color = ''; italic = false; bold = false; }
    else if (k === 'g') color = '';
    else if (k === 'l' || k === 'h' || k === 'p') { if (raw[i + 1] === '[') { const e = raw.indexOf(']', i); if (e > 0) i = e; } continue; }
    else continue;
    start();
  }
  flush();
  return out;
}

// Generated icon colours: one source with the launcher (packages/shared/src/modicon.ts).
export { iconPair as pair, iconHash as seedNum } from '@tm-hub/shared/modicon';

/** 19655 -> "13 days 16 hr" (two largest units, localized). The page script in Layout.astro does the same in the browser. */
export const duration = (minutes: number, lang: Lang = 'en') => {
  const loc = locales[lang];
  const f = (n: number, unit: string, display: 'long' | 'short') => new Intl.NumberFormat(loc, { style: 'unit', unit, unitDisplay: display }).format(n);
  const d = Math.floor(minutes / 1440), h = Math.floor((minutes % 1440) / 60), m = Math.round(minutes % 60);
  const parts: string[] = [];
  if (d) { parts.push(f(d, 'day', 'long')); if (h) parts.push(f(h, 'hour', 'short')); }
  else if (h) { parts.push(f(h, 'hour', 'short')); if (m) parts.push(f(m, 'minute', 'short')); }
  else parts.push(f(m, 'minute', 'short'));
  return parts.join(' ');
};

/** Plain text to safe HTML: everything escaped, http(s) URLs become external links. */
export const linkify = (text: string) => {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return text.replace(/(https?:\/\/[^\s<>"]+)|([^]+?(?=https?:\/\/|$))/g, (all, url: string | undefined) => {
    if (!url) return esc(all);
    const m = url.match(/^(.*?)([.,;:!?)\]]*)$/)!;
    return `<a href="${esc(m[1])}" target="_blank" rel="noopener nofollow ugc">${esc(m[1])}</a>${esc(m[2])}`;
  });
};
