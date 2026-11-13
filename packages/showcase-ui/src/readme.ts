// README renderer shared by the launcher, the portal and the website (static build): Markdown -> safe HTML.
// No DOM needed (marked + a parse5 allowlist walk), so it runs the same in the browser and in Node/Astro.
// Output only contains the tags and attributes listed below; scripts, styles, forms, iframes, event handlers and
// non-http(s) URLs never get through. Style it with '@tm-hub/showcase-ui/readme.css' (class `rd`).
import { marked } from 'marked';
import { parseFragment, serialize } from 'parse5';

export interface ReadmeOptions {
  /** `owner/name` of the GitHub repository: relative links and pictures resolve against its blob/raw URLs. */
  repo?: string | null;
  /** Name of the mod: a first H1 that repeats it is left out (the page already shows it as its title). */
  title?: string;
  /** Heading levels to move down (the page owns the H1). Default 1; the level never exceeds 6. */
  demote?: number;
  /** Remove badge pictures (shields.io etc.) and SVGs. */
  dropBadges?: boolean;
  /** Put picture sources into data-src instead of src, so the host can load them (launcher: its picture cache). */
  lazySrc?: boolean;
  /** Maps a picture URL (https) to the one to use, or null to leave it out (website: same-origin proxy). */
  imageUrl?: (url: string) => string | null;
  /** Only https links keep their href. Default: https, http and mailto. */
  httpsOnly?: boolean;
  /** Open links in a new tab (rel noopener always set). */
  newTab?: boolean;
  /** Cut the source here. Default 120000 characters. */
  maxChars?: number;
}

/** Badges (shields.io, badgen, workflow status, coverage) and SVG pictures. */
export const BADGE = /shields\.io|badgen\.net|badge\.fury\.io|codecov\.io|travis-ci\.|coveralls\.io|\/badges?\/|\/badge\.(svg|png)|\/actions\/workflows\/|\.svg([?#]|$)/i;

const TAGS = new Set(['a', 'abbr', 'b', 'blockquote', 'br', 'code', 'dd', 'del', 'details', 'div', 'dl', 'dt', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 's', 'small', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul']);
/** Gone with everything inside (all others that are not allowed are unwrapped: their content stays). */
const DROP = new Set(['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'input', 'button', 'textarea', 'select', 'option', 'svg', 'math', 'template', 'noscript', 'link', 'meta', 'base', 'title', 'head', 'video', 'audio', 'source', 'track', 'canvas', 'dialog', 'portal']);
const ATTRS: Record<string, string[]> = {
  a: ['href', 'title', 'name'],
  img: ['src', 'alt', 'title', 'width'],
  th: ['colspan', 'rowspan', 'align'], td: ['colspan', 'rowspan', 'align'],
  ol: ['start'], details: ['open'], code: ['class'],
  p: ['align'], div: ['align'], h1: ['align'], h2: ['align'], h3: ['align'], h4: ['align'], h5: ['align'], h6: ['align'],
};
const ALIGN = /^(left|right|center|justify)$/i;
const HTML_NS = 'http://www.w3.org/1999/xhtml';

// parse5's tree is loosely typed here on purpose (its node types differ between element/text/fragment).
type N = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const attr = (n: N, name: string): string | undefined => n.attrs?.find((a: { name: string }) => a.name === name)?.value;
const text = (n: N): string => (n.nodeName === '#text' ? n.value : (n.childNodes ?? []).map(text).join(''));
const isEl = (n: N) => typeof n.tagName === 'string';
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** GitHub-style heading id. */
export function slug(s: string): string {
  return s.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-');
}

function repoUrl(u: string, repo: string | null | undefined, image: boolean): string | null {
  u = u.trim().replace(/^<|>$/g, '');
  if (!u) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith('//') || u.startsWith('#')) return u.startsWith('//') ? 'https:' + u : u;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  const path = u.replace(/^\.?\//, '').replace(/ /g, '%20');
  return image ? `https://raw.githubusercontent.com/${repo}/HEAD/${path}` : `https://github.com/${repo}/blob/HEAD/${path}`;
}

function el(tag: string, attrs: Record<string, string> = {}, children: N[] = []): N {
  const e: N = { nodeName: tag, tagName: tag, attrs: Object.entries(attrs).map(([name, value]) => ({ name, value })), namespaceURI: HTML_NS, childNodes: [], parentNode: null };
  children.forEach((c) => { c.parentNode = e; e.childNodes.push(c); });
  return e;
}
const txt = (value: string): N => ({ nodeName: '#text', value, parentNode: null });

function replaceNode(n: N, withNodes: N[]) {
  const p = n.parentNode;
  const i = p.childNodes.indexOf(n);
  withNodes.forEach((c) => { c.parentNode = p; });
  p.childNodes.splice(i, 1, ...withNodes);
}

export function renderReadme(md: string, o: ReadmeOptions = {}): string {
  const src = md.replace(/\r\n?/g, '\n').slice(0, o.maxChars ?? 120000);
  const raw = (marked.parse(src, { gfm: true, async: false, breaks: false }) as string)
    .replace(/<input\b[^>]*type=\"checkbox\"[^>]*>\s?/gi, (m) => (/\bchecked\b/i.test(m) ? '\u2611 ' : '\u2610 '));
  const root: N = parseFragment(raw);
  const demote = Math.max(0, o.demote ?? 1);

  const clean = (n: N) => {
    for (const c of [...(n.childNodes ?? [])]) {
      if (c.nodeName === '#comment' || c.nodeName === '#documentType') { n.childNodes.splice(n.childNodes.indexOf(c), 1); continue; }
      if (!isEl(c)) continue;
      const tag: string = c.tagName.toLowerCase();
      if (c.namespaceURI !== HTML_NS || DROP.has(tag)) { n.childNodes.splice(n.childNodes.indexOf(c), 1); continue; }
      clean(c);
      if (!TAGS.has(tag)) { replaceNode(c, c.childNodes); continue; }
      const keep = ATTRS[tag] ?? [];
      c.attrs = (c.attrs ?? []).filter((a: { name: string }) => keep.includes(a.name));
      if (tag === 'img') fixImg(c);
      else if (tag === 'a') fixLink(c);
      else if (tag === 'code') c.attrs = c.attrs.filter((a: { name: string; value: string }) => /^language-[\w+-]{1,20}$/.test(a.value));
      else c.attrs = c.attrs.filter((a: { name: string; value: string }) => a.name !== 'align' || ALIGN.test(a.value));
    }
  };

  const fixImg = (img: N) => {
    const s = attr(img, 'src') ?? '';
    const alt = attr(img, 'alt') ?? '';
    let url = repoUrl(s, o.repo, true);
    if (url && /^http:\/\//i.test(url)) url = 'https://' + url.slice(7);
    const badge = !!url && BADGE.test(url);
    const mapped = url && /^https:\/\//i.test(url) && !(badge && o.dropBadges) ? (o.imageUrl ? o.imageUrl(url) : url) : null;
    if (!mapped) { replaceNode(img, alt.trim() && !badge ? [txt(alt)] : []); return; }
    const w = attr(img, 'width');
    img.attrs = [
      { name: o.lazySrc ? 'data-src' : 'src', value: mapped },
      { name: 'alt', value: alt },
      { name: 'loading', value: 'lazy' },
      { name: 'decoding', value: 'async' },
      { name: 'referrerpolicy', value: 'no-referrer' },
      ...(badge ? [{ name: 'class', value: 'rd-badge' }] : []),
      ...(w && /^\d{1,4}$/.test(w) ? [{ name: 'width', value: w }] : []),
    ];
  };

  const fixLink = (a: N) => {
    const h = attr(a, 'href');
    const name = attr(a, 'name');
    let url = h ? repoUrl(h, o.repo, false) : null;
    if (url && !(url.startsWith('#') || /^https:/i.test(url) || (!o.httpsOnly && /^(http:|mailto:)/i.test(url)))) url = null;
    if (!url) {
      if (name && !h) { a.attrs = [{ name: 'id', value: name.replace(/[^\w.-]/g, '') }]; return; }
      replaceNode(a, a.childNodes); // no usable href: plain content
      return;
    }
    const title = attr(a, 'title');
    a.attrs = [
      { name: 'href', value: url },
      ...(title ? [{ name: 'title', value: title }] : []),
      ...(url.startsWith('#') ? [] : [{ name: 'rel', value: 'noopener noreferrer nofollow ugc' }, ...(o.newTab ? [{ name: 'target', value: '_blank' }] : [])]),
    ];
  };

  clean(root);

  // First H1 that repeats the mod's name.
  if (o.title) {
    const seen = (n: N): boolean => {
      for (const c of n.childNodes ?? []) {
        if (!isEl(c)) continue;
        if (/^h[1-6]$/.test(c.tagName)) {
          if (c.tagName === 'h1' && (() => { const a = norm(text(c)); const b = norm(o.title!); return !!a && (a === b || a.includes(b) || b.includes(a)); })()) { replaceNode(c, []); }
          return true;
        }
        if (seen(c)) return true;
      }
      return false;
    };
    seen(root);
  }

  // Headings: demote, ids; tables: scroll wrapper; empty leftovers (what a removed badge leaves behind): innermost first.
  const used = new Set<string>();
  const walk = (n: N) => {
    for (const c of [...(n.childNodes ?? [])]) {
      if (!isEl(c)) continue;
      walk(c);
      const tag: string = c.tagName;
      const m = /^h([1-6])$/.exec(tag);
      if (m) {
        const lvl = Math.min(6, +m[1] + demote);
        c.tagName = c.nodeName = 'h' + lvl;
        if (!attr(c, 'id')) {
          let id = slug(text(c)), k = id, i = 1;
          while (id && used.has(k)) k = `${id}-${i++}`;
          if (id) { used.add(k); c.attrs.push({ name: 'id', value: k }); }
        }
      } else if (tag === 'thead' && !text(c).trim()) {
        replaceNode(c, []);
      } else if (tag === 'table') {
        const wrap = el('div', { class: 'rd-table' }); replaceNode(c, [wrap]); c.parentNode = wrap; wrap.childNodes.push(c);
      } else if (/^(a|span|p|div)$/.test(tag) && !text(c).replace(/[\s ]+/g, '') && !hasKeep(c)) {
        replaceNode(c, []);
      }
    }
  };
  const hasKeep = (n: N): boolean => (n.childNodes ?? []).some((c: N) => isEl(c) && (/^(img|hr|table|pre|code|br)$/.test(c.tagName) || c.attrs?.some((a: { name: string }) => a.name === 'id') || hasKeep(c)));
  walk(root);

  return serialize(root);
}
