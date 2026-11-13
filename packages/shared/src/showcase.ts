// Showcase pages: the page an author designs for a mod. Declarative blocks only, no HTML and no scripts
// from the author; the launcher, the website and the portal render the same data with the same components
// (packages/showcase-ui). This file is the format: types, limits, allowlists and the validator that the
// hub server (strict, answers 400), the portal editor (live) and the launcher (lenient, drops what is wrong)
// all use. The JSON Schema for editors is showcase.schema.json next to package.json.
import { HUB_GAMES } from './hub.ts';
import type { GameId } from './types.ts';
import { cleanHttpsUrl } from './links.ts';

export * from './showcase-md.ts';

export const SHOWCASE_VERSION = 1;

/** Accent colours: a fixed palette, each with a light and a dark variant (CSS in showcase-ui). */
export const ACCENTS = ['blue', 'cyan', 'green', 'lime', 'amber', 'orange', 'red', 'pink', 'violet', 'slate'] as const;
export type ShowcaseAccent = (typeof ACCENTS)[number];

/** Lucide icons a feature may use (kebab-case names of lucide.dev). */
export const SHOWCASE_ICONS = [
  'sparkles', 'sun', 'moon', 'palette', 'zap', 'gauge', 'keyboard', 'mouse-pointer', 'monitor', 'camera', 'film', 'image', 'wand-2',
  'settings', 'sliders-horizontal', 'download', 'upload', 'save', 'shield', 'lock', 'heart', 'star', 'flag', 'trophy', 'timer', 'clock',
  'map', 'route', 'car', 'wrench', 'package', 'layers', 'cpu', 'gamepad-2', 'headphones', 'volume-2', 'music', 'globe', 'users',
  'message-circle', 'book-open', 'code-2', 'bug', 'rocket', 'eye', 'flame', 'droplets', 'wind', 'cloud', 'mountain', 'lightbulb',
  'refresh-cw', 'check', 'languages', 'share-2', 'puzzle', 'gift', 'tag', 'target',
] as const;
export type ShowcaseIcon = (typeof SHOWCASE_ICONS)[number];

export const BLOCK_TYPES = ['hero', 'features', 'gallery', 'compare', 'video', 'text', 'compat', 'hotkeys', 'changelog', 'faq', 'cta'] as const;
export type ShowcaseBlockType = (typeof BLOCK_TYPES)[number];

export const COMPAT_STATUS = ['works', 'partial', 'planned', 'no'] as const;
export type CompatStatus = (typeof COMPAT_STATUS)[number];
export const CTA_KINDS = ['install', 'companion', 'link'] as const;
export type CtaKind = (typeof CTA_KINDS)[number];

/** Limits (characters unless noted). One place, used by the validator, the editor and the docs. */
export const SHOWCASE_LIMITS = {
  blocks: 30,
  bytes: 60_000,
  rawBytes: 120_000,
  heroTitle: 60, tagline: 140, badges: 3, badge: 24,
  blockTitle: 60,
  features: 9, featureTitle: 40, featureText: 140,
  galleryImages: 12, caption: 120, alt: 120, label: 24,
  markdown: 4000,
  compatRows: 14, note: 80,
  hotkeyRows: 20, keys: 24, action: 80,
  changelogCount: 3,
  faqItems: 12, question: 120, answer: 600,
  ctaButtons: 3, ctaLabel: 30, ctaText: 160,
  url: 500,
} as const;

/** Image sizes the author should stay under; checked by the hub for pictures it stores, and HEAD-checked for linked ones (see the server). */
export const SHOWCASE_IMAGE = { types: ['png', 'jpg', 'jpeg', 'webp', 'gif'], maxBytes: 5 * 1048576, maxSide: 3840 } as const;

// ---------------------------------------------------------------- types

export interface ShowcaseFeature { icon: ShowcaseIcon; title: string; text: string }
export interface ShowcaseImage { url: string; caption?: string; alt?: string }
export interface ShowcaseCompatRow { game: GameId; status: CompatStatus; note?: string }
export interface ShowcaseHotkey { keys: string; action: string }
export interface ShowcaseFaq { q: string; a: string }
export interface ShowcaseButton { kind: CtaKind; label: string; url?: string; style?: 'primary' | 'ghost' }

export type ShowcaseBlock =
  | { type: 'hero'; title: string; tagline?: string; image?: string; video?: string; badges?: string[] }
  | { type: 'features'; title?: string; items: ShowcaseFeature[] }
  | { type: 'gallery'; title?: string; images: ShowcaseImage[] }
  | { type: 'compare'; title?: string; before: { url: string; label?: string }; after: { url: string; label?: string }; caption?: string }
  | { type: 'video'; title?: string; url: string; caption?: string; poster?: string }
  | { type: 'text'; title?: string; markdown: string }
  | { type: 'compat'; title?: string; rows: ShowcaseCompatRow[] }
  | { type: 'hotkeys'; title?: string; rows: ShowcaseHotkey[] }
  | { type: 'changelog'; title?: string; count?: number }
  | { type: 'faq'; title?: string; items: ShowcaseFaq[] }
  | { type: 'cta'; title?: string; text?: string; buttons: ShowcaseButton[] };

export interface Showcase {
  version: 1;
  theme?: { accent: ShowcaseAccent };
  blocks: ShowcaseBlock[];
}

export interface ShowcaseIssue { path: string; message: string }
export interface ShowcaseResult {
  /** The cleaned showcase (invalid parts dropped); null when nothing usable is left. */
  showcase: Showcase | null;
  /** Everything that was wrong. Strict callers (server, portal) refuse on any issue, lenient ones (launcher, import) use `showcase`. */
  issues: ShowcaseIssue[];
  ok: boolean;
}
export interface ShowcaseOptions {
  /** Extra hosts allowed for pictures: the hub's own storage host. */
  imageHosts?: readonly string[];
}

// ---------------------------------------------------------------- text and URL cleaning

// Control characters (except tab/newline), bidi overrides and isolates, zero-width characters, BOM.
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁯﻿]/g;

/** One line of plain text (what React and the static renderer then escape), or null when empty. */
export function cleanLine(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}
/** Multi-line text (the Markdown source). */
export function cleanMultiline(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\r\n?/g, '\n').replace(INVISIBLE, '').replace(/[ \t]+\n/g, '\n').trim();
  return s ? s.slice(0, max) : null;
}

const hostIs = (host: string, names: readonly string[]) => names.includes(host.toLowerCase());

/** An https picture URL on an allowed host (hub storage, raw.githubusercontent.com, GitHub release assets, i.imgur.com) with an image extension; null otherwise. */
export function cleanImageUrl(u: unknown, opts: ShowcaseOptions = {}): string | null {
  const c = cleanHttpsUrl(u);
  if (!c || c.length > SHOWCASE_LIMITS.url) return null;
  const x = new URL(c);
  if (x.port || x.hash || x.search) return null;
  const ext = /\.([a-z0-9]{3,4})$/i.exec(x.pathname)?.[1]?.toLowerCase();
  if (!ext || !(SHOWCASE_IMAGE.types as readonly string[]).includes(ext)) return null;
  const h = x.hostname.toLowerCase();
  const ok = h === 'raw.githubusercontent.com' || h === 'i.imgur.com'
    || (h === 'github.com' && /^\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/]+$/.test(x.pathname))
    || hostIs(h, (opts.imageHosts ?? []).map((s) => s.toLowerCase()));
  return ok ? x.toString() : null;
}

export type VideoProvider = 'youtube' | 'vimeo' | 'streamable';
export interface VideoRef {
  provider: VideoProvider;
  id: string;
  /** The privacy-friendly embed URL (no cookies before play: youtube-nocookie, vimeo dnt). */
  embed: string;
  /** The normal page of the video, for "open in browser". */
  watch: string;
}

/** YouTube, Vimeo and Streamable links in their usual forms; anything else is null. */
export function parseVideoUrl(u: unknown): VideoRef | null {
  const c = cleanHttpsUrl(u);
  if (!c || c.length > SHOWCASE_LIMITS.url) return null;
  const x = new URL(c);
  if (x.port) return null;
  const h = x.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
  const seg = x.pathname.split('/').filter(Boolean);
  const yt = (id: string | undefined): VideoRef | null =>
    id && /^[\w-]{11}$/.test(id) ? { provider: 'youtube', id, embed: `https://www.youtube-nocookie.com/embed/${id}`, watch: `https://www.youtube.com/watch?v=${id}` } : null;
  if (h === 'youtu.be') return yt(seg[0]);
  if (h === 'youtube.com' || h === 'youtube-nocookie.com') {
    if (seg[0] === 'watch') return yt(x.searchParams.get('v') ?? undefined);
    if (seg[0] === 'embed' || seg[0] === 'shorts' || seg[0] === 'live') return yt(seg[1]);
    return null;
  }
  if (h === 'vimeo.com' || h === 'player.vimeo.com') {
    const id = h === 'vimeo.com' ? seg[0] : seg[0] === 'video' ? seg[1] : undefined;
    return id && /^\d{5,12}$/.test(id) ? { provider: 'vimeo', id, embed: `https://player.vimeo.com/video/${id}?dnt=1`, watch: `https://vimeo.com/${id}` } : null;
  }
  if (h === 'streamable.com') {
    const id = seg[0] === 'e' ? seg[1] : seg[0];
    return id && /^[a-z0-9]{4,10}$/i.test(id) ? { provider: 'streamable', id, embed: `https://streamable.com/e/${id}`, watch: `https://streamable.com/${id}` } : null;
  }
  return null;
}

// ---------------------------------------------------------------- validator

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);

class Ctx {
  issues: ShowcaseIssue[] = [];
  opts: ShowcaseOptions;
  constructor(opts: ShowcaseOptions) { this.opts = opts; }
  bad(path: string, message: string) { this.issues.push({ path, message }); }
  /** Reports keys that are not in `known`. */
  keys(o: Rec, known: readonly string[], path: string) {
    for (const k of Object.keys(o)) if (!known.includes(k)) this.bad(path ? `${path}.${k}` : k, 'unknown field');
  }
  line(o: Rec, key: string, max: number, path: string, required = false): string | undefined {
    const v = o[key];
    if (v === undefined || v === null) { if (required) this.bad(`${path}.${key}`, 'required'); return undefined; }
    if (typeof v !== 'string') { this.bad(`${path}.${key}`, 'must be text'); return undefined; }
    const full = cleanLine(v, 100_000);
    if (!full) { if (required) this.bad(`${path}.${key}`, 'required'); return undefined; }
    if (full.length > max) this.bad(`${path}.${key}`, `too long (max ${max}), cut`);
    return full.slice(0, max);
  }
  image(o: Rec, key: string, path: string, required = false): string | undefined {
    const v = o[key];
    if (v === undefined || v === null) { if (required) this.bad(`${path}.${key}`, 'required'); return undefined; }
    const u = cleanImageUrl(v, this.opts);
    if (!u) this.bad(`${path}.${key}`, 'picture must be an https .png/.jpg/.webp/.gif on the hub, raw.githubusercontent.com, a GitHub release or i.imgur.com');
    return u ?? undefined;
  }
  list(o: Rec, key: string, max: number, path: string): unknown[] {
    const v = o[key];
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) { this.bad(`${path}.${key}`, 'must be a list'); return []; }
    if (v.length > max) this.bad(`${path}.${key}`, `at most ${max} entries`);
    return v.slice(0, max);
  }
}

const L = SHOWCASE_LIMITS;
const pick = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

function block(c: Ctx, raw: unknown, path: string): ShowcaseBlock | null {
  if (!isRec(raw)) { c.bad(path, 'must be an object'); return null; }
  const type = raw.type;
  if (typeof type !== 'string' || !(BLOCK_TYPES as readonly string[]).includes(type)) { c.bad(`${path}.type`, `unknown block type (one of ${BLOCK_TYPES.join(', ')})`); return null; }
  const title = () => c.line(raw, 'title', L.blockTitle, path);
  switch (type as ShowcaseBlockType) {
    case 'hero': {
      c.keys(raw, ['type', 'title', 'tagline', 'image', 'video', 'badges'], path);
      const t = c.line(raw, 'title', L.heroTitle, path, true);
      if (!t) return null;
      let video: string | undefined;
      if (raw.video !== undefined && raw.video !== null) {
        const v = parseVideoUrl(raw.video);
        if (v) video = v.watch; else c.bad(`${path}.video`, 'video must be a YouTube, Vimeo or Streamable link');
      }
      const badges = c.list(raw, 'badges', L.badges, path).map((b, i) => {
        const s = cleanLine(b, L.badge);
        if (!s) c.bad(`${path}.badges[${i}]`, 'must be short text');
        return s;
      }).filter((s): s is string => !!s);
      return pick({ type: 'hero' as const, title: t, tagline: c.line(raw, 'tagline', L.tagline, path), image: c.image(raw, 'image', path), video, badges: badges.length ? badges : undefined });
    }
    case 'features': {
      c.keys(raw, ['type', 'title', 'items'], path);
      const items = c.list(raw, 'items', L.features, path).flatMap((it, i): ShowcaseFeature[] => {
        const p = `${path}.items[${i}]`;
        if (!isRec(it)) { c.bad(p, 'must be an object'); return []; }
        c.keys(it, ['icon', 'title', 'text'], p);
        const icon = it.icon;
        if (typeof icon !== 'string' || !(SHOWCASE_ICONS as readonly string[]).includes(icon)) { c.bad(`${p}.icon`, 'icon is not in the allowed set'); return []; }
        const ti = c.line(it, 'title', L.featureTitle, p, true);
        const tx = c.line(it, 'text', L.featureText, p, true);
        return ti && tx ? [{ icon: icon as ShowcaseIcon, title: ti, text: tx }] : [];
      });
      return items.length ? pick({ type: 'features' as const, title: title(), items }) : (c.bad(path, 'features needs at least one valid item'), null);
    }
    case 'gallery': {
      c.keys(raw, ['type', 'title', 'images'], path);
      const images = c.list(raw, 'images', L.galleryImages, path).flatMap((it, i): ShowcaseImage[] => {
        const p = `${path}.images[${i}]`;
        if (!isRec(it)) { c.bad(p, 'must be an object'); return []; }
        c.keys(it, ['url', 'caption', 'alt'], p);
        const url = c.image(it, 'url', p, true);
        return url ? [pick({ url, caption: c.line(it, 'caption', L.caption, p), alt: c.line(it, 'alt', L.alt, p) })] : [];
      });
      return images.length ? pick({ type: 'gallery' as const, title: title(), images }) : (c.bad(path, 'gallery needs at least one valid image'), null);
    }
    case 'compare': {
      c.keys(raw, ['type', 'title', 'before', 'after', 'caption'], path);
      const side = (k: 'before' | 'after') => {
        const s = raw[k];
        if (!isRec(s)) { c.bad(`${path}.${k}`, 'required (url, label)'); return null; }
        c.keys(s, ['url', 'label'], `${path}.${k}`);
        const url = c.image(s, 'url', `${path}.${k}`, true);
        return url ? pick({ url, label: c.line(s, 'label', L.label, `${path}.${k}`) }) : null;
      };
      const before = side('before');
      const after = side('after');
      return before && after ? pick({ type: 'compare' as const, title: title(), before, after, caption: c.line(raw, 'caption', L.caption, path) }) : null;
    }
    case 'video': {
      c.keys(raw, ['type', 'title', 'url', 'caption', 'poster'], path);
      const v = parseVideoUrl(raw.url);
      if (!v) { c.bad(`${path}.url`, 'video must be a YouTube, Vimeo or Streamable link'); return null; }
      return pick({ type: 'video' as const, title: title(), url: v.watch, caption: c.line(raw, 'caption', L.caption, path), poster: c.image(raw, 'poster', path) });
    }
    case 'text': {
      c.keys(raw, ['type', 'title', 'markdown'], path);
      const md = cleanMultiline(raw.markdown, L.markdown);
      if (typeof raw.markdown === 'string' && raw.markdown.length > L.markdown) c.bad(`${path}.markdown`, `too long (max ${L.markdown}), cut`);
      if (!md) { c.bad(`${path}.markdown`, 'required'); return null; }
      return pick({ type: 'text' as const, title: title(), markdown: md });
    }
    case 'compat': {
      c.keys(raw, ['type', 'title', 'rows'], path);
      const rows = c.list(raw, 'rows', L.compatRows, path).flatMap((it, i): ShowcaseCompatRow[] => {
        const p = `${path}.rows[${i}]`;
        if (!isRec(it)) { c.bad(p, 'must be an object'); return []; }
        c.keys(it, ['game', 'status', 'note'], p);
        if (typeof it.game !== 'string' || !HUB_GAMES.includes(it.game as GameId)) { c.bad(`${p}.game`, `game must be one of ${HUB_GAMES.join(', ')}`); return []; }
        if (typeof it.status !== 'string' || !(COMPAT_STATUS as readonly string[]).includes(it.status)) { c.bad(`${p}.status`, `status must be one of ${COMPAT_STATUS.join(', ')}`); return []; }
        return [pick({ game: it.game as GameId, status: it.status as CompatStatus, note: c.line(it, 'note', L.note, p) })];
      });
      return rows.length ? pick({ type: 'compat' as const, title: title(), rows }) : (c.bad(path, 'compat needs at least one valid row'), null);
    }
    case 'hotkeys': {
      c.keys(raw, ['type', 'title', 'rows'], path);
      const rows = c.list(raw, 'rows', L.hotkeyRows, path).flatMap((it, i): ShowcaseHotkey[] => {
        const p = `${path}.rows[${i}]`;
        if (!isRec(it)) { c.bad(p, 'must be an object'); return []; }
        c.keys(it, ['keys', 'action'], p);
        const k = c.line(it, 'keys', L.keys, p, true);
        const a = c.line(it, 'action', L.action, p, true);
        return k && a ? [{ keys: k, action: a }] : [];
      });
      return rows.length ? pick({ type: 'hotkeys' as const, title: title(), rows }) : (c.bad(path, 'hotkeys needs at least one valid row'), null);
    }
    case 'changelog': {
      c.keys(raw, ['type', 'title', 'count'], path);
      let count: number | undefined;
      if (raw.count !== undefined && raw.count !== null) {
        if (typeof raw.count === 'number' && Number.isInteger(raw.count) && raw.count >= 1 && raw.count <= L.changelogCount) count = raw.count;
        else c.bad(`${path}.count`, `count must be a whole number from 1 to ${L.changelogCount}`);
      }
      return pick({ type: 'changelog' as const, title: title(), count });
    }
    case 'faq': {
      c.keys(raw, ['type', 'title', 'items'], path);
      const items = c.list(raw, 'items', L.faqItems, path).flatMap((it, i): ShowcaseFaq[] => {
        const p = `${path}.items[${i}]`;
        if (!isRec(it)) { c.bad(p, 'must be an object'); return []; }
        c.keys(it, ['q', 'a'], p);
        const q = c.line(it, 'q', L.question, p, true);
        const a = c.line(it, 'a', L.answer, p, true);
        return q && a ? [{ q, a }] : [];
      });
      return items.length ? pick({ type: 'faq' as const, title: title(), items }) : (c.bad(path, 'faq needs at least one valid question'), null);
    }
    case 'cta': {
      c.keys(raw, ['type', 'title', 'text', 'buttons'], path);
      const buttons = c.list(raw, 'buttons', L.ctaButtons, path).flatMap((it, i): ShowcaseButton[] => {
        const p = `${path}.buttons[${i}]`;
        if (!isRec(it)) { c.bad(p, 'must be an object'); return []; }
        c.keys(it, ['kind', 'label', 'url', 'style'], p);
        if (typeof it.kind !== 'string' || !(CTA_KINDS as readonly string[]).includes(it.kind)) { c.bad(`${p}.kind`, `kind must be one of ${CTA_KINDS.join(', ')}`); return []; }
        const label = c.line(it, 'label', L.ctaLabel, p, true);
        if (!label) return [];
        let url: string | undefined;
        if (it.url !== undefined && it.url !== null) {
          url = cleanHttpsUrl(it.url) ?? undefined;
          if (!url) c.bad(`${p}.url`, 'must be an https link');
        }
        if (it.kind === 'link' && !url) { c.bad(`${p}.url`, 'a link button needs an https url'); return []; }
        if (it.kind === 'install' && url) { c.bad(`${p}.url`, 'an install button takes no url'); url = undefined; }
        let style: 'primary' | 'ghost' | undefined;
        if (it.style !== undefined && it.style !== null) {
          if (it.style === 'primary' || it.style === 'ghost') style = it.style; else c.bad(`${p}.style`, 'style must be primary or ghost');
        }
        return [pick({ kind: it.kind as CtaKind, label, url, style })];
      });
      return buttons.length ? pick({ type: 'cta' as const, title: title(), text: c.line(raw, 'text', L.ctaText, path), buttons }) : (c.bad(path, 'cta needs at least one valid button'), null);
    }
  }
}

/** Checks and cleans a showcase from outside (showcase.json, the portal editor, the hub API). Never throws. */
export function validateShowcase(raw: unknown, opts: ShowcaseOptions = {}): ShowcaseResult {
  const c = new Ctx(opts);
  const done = (showcase: Showcase | null): ShowcaseResult => ({ showcase, issues: c.issues, ok: c.issues.length === 0 && showcase !== null });
  if (!isRec(raw)) { c.bad('', 'a showcase is an object with a "blocks" list'); return done(null); }
  try {
    if (JSON.stringify(raw).length > L.rawBytes) { c.bad('', `too large (max ${L.rawBytes} characters)`); return done(null); }
  } catch { c.bad('', 'not JSON data'); return done(null); }
  c.keys(raw, ['$schema', 'version', 'theme', 'blocks'], '');
  if (raw.version !== undefined && raw.version !== SHOWCASE_VERSION) c.bad('version', `version must be ${SHOWCASE_VERSION}`);
  let accent: ShowcaseAccent | undefined;
  if (raw.theme !== undefined && raw.theme !== null) {
    if (!isRec(raw.theme)) c.bad('theme', 'must be an object');
    else {
      c.keys(raw.theme, ['accent'], 'theme');
      const a = raw.theme.accent;
      if (a === undefined) c.bad('theme.accent', 'required');
      else if (typeof a === 'string' && (ACCENTS as readonly string[]).includes(a)) accent = a as ShowcaseAccent;
      else c.bad('theme.accent', `accent must be one of ${ACCENTS.join(', ')}`);
    }
  }
  if (!Array.isArray(raw.blocks)) { c.bad('blocks', 'required: a list of blocks'); return done(null); }
  if (raw.blocks.length > L.blocks) c.bad('blocks', `at most ${L.blocks} blocks`);
  const blocks: ShowcaseBlock[] = [];
  let heroes = 0;
  raw.blocks.slice(0, L.blocks).forEach((b, i) => {
    const r = block(c, b, `blocks[${i}]`);
    if (!r) return;
    if (r.type === 'hero' && ++heroes > 1) { c.bad(`blocks[${i}]`, 'only one hero block'); return; }
    blocks.push(r);
  });
  if (!blocks.length) { c.bad('blocks', 'no valid block'); return done(null); }
  const showcase: Showcase = { version: 1, ...(accent ? { theme: { accent } } : {}), blocks };
  if (JSON.stringify(showcase).length > L.bytes) { c.bad('', `too large after cleaning (max ${L.bytes} characters)`); return done(null); }
  return done(showcase);
}

/** The cleaned showcase of data from outside, or null (lenient: issues are dropped). */
export const cleanShowcase = (raw: unknown, opts: ShowcaseOptions = {}): Showcase | null => validateShowcase(raw, opts).showcase;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
/** Showcase for a mod out of the catalog's `showcases` list ({ mod, showcase }), found by any of its ids or names. */
export function showcaseOf(list: { mod: string; showcase: unknown }[] | undefined, ...keys: (string | null | undefined)[]): Showcase | null {
  const want = new Set(keys.filter((k): k is string => !!k).map(norm));
  if (!want.size || !list) return null;
  const hit = list.find((x) => want.has(norm(x.mod)));
  return hit ? cleanShowcase(hit.showcase) : null;
}
