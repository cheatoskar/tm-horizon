import { webImg } from '@tm-hub/shared/extimg';
// Small Markdown subset for changelogs: headings, bullet lists, paragraphs, links, bold, inline code.
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const inline = (s: string) =>
  esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" rel="noopener">$2</a>');
export function md(src: string, maxItems = Infinity) {
  const out: string[] = [];
  let list = false, n = 0;
  const close = () => { if (list) { out.push('</ul>'); list = false; } };
  for (const raw of src.replace(/\r/g, '').split('\n')) {
    const l = raw.trimEnd();
    if (!l.trim()) { close(); continue; }
    const h = l.match(/^(#{1,4})\s+(.*)/);
    const b = l.match(/^\s*[-*]\s+(.*)/);
    if (h) { close(); out.push(`<h3>${inline(h[2])}</h3>`); continue; }
    if (b) { if (++n > maxItems) continue; if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${inline(b[1])}</li>`); continue; }
    if (/^\s*\.\.\.\s*$/.test(l)) continue;
    close();
    out.push(/:\s*$/.test(l) && l.length < 60 ? `<h3>${inline(l.replace(/:\s*$/, ''))}</h3>` : `<p>${inline(l.trim())}</p>`);
  }
  close();
  return out.join('');
}

// ------------------------------------------------------------------ full README renderer (GitHub flavoured subset)
// Safe by construction: all HTML in the source is stripped or escaped, the output only contains tags written here,
// links are http(s)/mailto, images https. Relative links and images point into the GitHub repository.
function safeUrl(u: string, repo: string | null, image: boolean): string | null {
  u = u.trim().replace(/^<|>$/g, '');
  if (/^https:\/\//i.test(u) || (!image && /^(http:\/\/|mailto:)/i.test(u))) return u;
  if (image && /^http:\/\//i.test(u)) return 'https://' + u.slice(7);
  if (!repo || /^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith('#') || u.startsWith('//')) return null;
  const path = u.replace(/^\.?\//, '');
  return image ? `https://raw.githubusercontent.com/${repo}/HEAD/${path}` : `https://github.com/${repo}/blob/HEAD/${path}`;
}
function inlineDoc(src: string, repo: string | null): string {
  const stash: string[] = [];
  const keep = (h: string) => `\u0000${stash.push(h) - 1}\u0000`;
  let s = src.replace(/`+([^`]+)`+/g, (_, c) => keep(`<code>${esc(c)}</code>`));
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt, url) => {
    // Remote pictures only through our image proxy (/ext-img/); others are left out (their alt text stays).
    const u = webImg(safeUrl(url, repo, true));
    return u ? keep(`<img src="${esc(u)}" alt="${esc(alt)}" loading="lazy">`) : esc(alt);
  });
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, text, url) => {
    const u = safeUrl(url.replace(/&amp;/g, '&'), repo, false);
    return u ? `<a href="${esc(u)}" target="_blank" rel="noopener nofollow ugc">${text}</a>` : text;
  });
  s = s.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => `<strong>${a ?? b}</strong>`)
       .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>')
       .replace(/(^|[\s(])_([^_\s][^_]*)_(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>')
       .replace(/~~([^~]+)~~/g, '<del>$1</del>')
       .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, p, u) => `${p}<a href="${u}" target="_blank" rel="noopener nofollow ugc">${u}</a>`);
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[+i]);
}
/** Plain HTML tags in a README (badges, centred headers) become Markdown or disappear. */
function untag(seg: string): string {
  return seg
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const src = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
      const alt = tag.match(/\balt\s*=\s*["']([^"']*)["']/i)?.[1] ?? '';
      return src ? `![${alt}](${src})` : '';
    })
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => (text.trim() ? `[${text.trim()}](${href})` : ''))
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, text) => `\n${'#'.repeat(+n)} ${text.replace(/<[^>]+>/g, '').trim()}\n`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|details|summary|table|tr|ul|ol)>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/?(?!https?:)[a-z][^>\n]*>/gi, '');
}
export function mdDoc(src: string, repo: string | null = null, maxChars = 60000): string {
  const text = src.replace(/\r/g, '').slice(0, maxChars);
  // Split into fenced code and the rest, so code is never touched by untag().
  const lines: string[] = [];
  let fence: string | null = null, buf: string[] = [];
  const flush = () => { if (buf.length) lines.push(...untag(buf.join('\n')).split('\n')); buf = []; };
  const raw: { code: string[]; lang: string }[] = [];
  for (const l of text.split('\n')) {
    const f = l.match(/^\s*(```+|~~~+)\s*([\w+-]*)/);
    if (fence === null && f) { flush(); fence = f[1]; raw.push({ code: [], lang: f[2] }); lines.push(`\u0001${raw.length - 1}`); continue; }
    if (fence !== null) { if (l.trim().startsWith(fence)) fence = null; else raw[raw.length - 1].code.push(l); continue; }
    buf.push(l);
  }
  flush();
  const out: string[] = [];
  let i = 0;
  const I = (s: string) => inlineDoc(s, repo);
  const isBlockStart = (l: string) => /^(#{1,6}\s|\s*([-*+]|\d+[.)])\s|>|\u0001|\s*(-{3,}|\*{3,}|_{3,})\s*$)/.test(l);
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (l.startsWith('\u0001')) { const b = raw[+l.slice(1)]; out.push(`<pre><code>${esc(b.code.join('\n'))}</code></pre>`); i++; continue; }
    const h = l.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) { const n = Math.min(h[1].length + 1, 5); out.push(`<h${n}>${I(h[2])}</h${n}>`); i++; continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
    if (l.startsWith('>')) {
      const q: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) q.push(lines[i++].replace(/^>\s?/, '').replace(/^\[!\w+\]\s*$/, ''));
      out.push(`<blockquote>${I(q.join(' ').trim())}</blockquote>`);
      continue;
    }
    if (l.includes('|') && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1] ?? '')) {
      const cells = (r: string) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(l);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(`<div class="tbl"><table><thead><tr>${head.map((c) => `<th>${I(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${I(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const li = l.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)/);
    if (li) {
      const ordered = /\d/.test(li[2]);
      const items: { d: number; t: string }[] = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)/);
        if (m) { items.push({ d: Math.min(Math.floor(m[1].length / 2), 3), t: m[3] }); i++; }
        else if (lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1].t += ' ' + lines[i].trim(); i++; }
        else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((x) => `<li${x.d ? ` class="d${x.d}"` : ''}>${I(x.t.replace(/^\[[ xX]\]\s*/, (b) => (/x/i.test(b) ? '☑ ' : '☐ ')))}</li>`).join('')}</${tag}>`);
      continue;
    }
    const p: string[] = [];
    while (i < lines.length && lines[i].trim() && !(p.length && isBlockStart(lines[i]))) p.push(lines[i++].trim());
    out.push(`<p>${I(p.join(' '))}</p>`);
  }
  return out.join('');
}
