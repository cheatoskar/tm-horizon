// The limited Markdown of a showcase text block, parsed to a small tree (never to HTML): headings (# to ####),
// paragraphs, bullet and numbered lists, **bold**, *italic*, `code`, code fences and [links](https://...).
// Everything else (raw HTML, pictures, tables, quotes) stays plain text. The renderers turn the tree into
// elements themselves, so nothing an author writes can become markup or script.
import { cleanHttpsUrl } from './links.ts';

export type MdInline =
  | { t: 'text'; v: string }
  | { t: 'b' | 'i'; c: MdInline[] }
  | { t: 'code'; v: string }
  | { t: 'a'; href: string; c: MdInline[] };
export type MdBlock =
  | { t: 'h'; level: 3 | 4; c: MdInline[] }
  | { t: 'p'; c: MdInline[] }
  | { t: 'ul' | 'ol'; items: MdInline[][] }
  | { t: 'pre'; v: string };

const MAX_DEPTH = 3;

/** Inline Markdown. A link whose URL is not a clean https URL keeps its text and loses the link. */
export function parseInline(s: string, depth = 0): MdInline[] {
  const out: MdInline[] = [];
  let text = '';
  const flush = () => { if (text) { out.push({ t: 'text', v: text }); text = ''; } };
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    let m: RegExpExecArray | null;
    if ((m = /^`([^`\n]+)`/.exec(rest))) {
      flush(); out.push({ t: 'code', v: m[1]! }); i += m[0].length; continue;
    }
    if (depth < MAX_DEPTH && (m = /^\*\*([^\n]+?)\*\*/.exec(rest))) {
      flush(); out.push({ t: 'b', c: parseInline(m[1]!, depth + 1) }); i += m[0].length; continue;
    }
    if (depth < MAX_DEPTH && ((m = /^\*([^*\s][^*\n]*?)\*/.exec(rest)) || (m = /^_([^_\s][^_\n]*?)_(?![\w])/.exec(rest)))) {
      if (!(m[0].startsWith('_') && /\w/.test(s[i - 1] ?? ' '))) { flush(); out.push({ t: 'i', c: parseInline(m[1]!, depth + 1) }); i += m[0].length; continue; }
    }
    // Pictures are not part of the subset: ![alt](url) keeps only its alt text.
    if ((m = /^!\[([^\]\n]*)\]\(\s*[^)\s]+\s*\)/.exec(rest))) { text += m[1]; i += m[0].length; continue; }
    if (depth < MAX_DEPTH && (m = /^\[([^\]\n]+)\]\(\s*([^)\s]+)\s*\)/.exec(rest))) {
      const href = cleanHttpsUrl(m[2]);
      flush();
      if (href) out.push({ t: 'a', href, c: parseInline(m[1]!, depth + 1) });
      else out.push(...parseInline(m[1]!, depth + 1));
      i += m[0].length;
      continue;
    }
    text += s[i];
    i++;
  }
  flush();
  return out;
}

/** Block Markdown to a tree. */
export function parseMarkdown(src: string): MdBlock[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: MdBlock[] = [];
  let para: string[] = [];
  const flushPara = () => { if (para.length) { out.push({ t: 'p', c: parseInline(para.join(' ')) }); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^```/.test(line)) {
      flushPara();
      const code: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]!); i++) code.push(lines[i]!);
      out.push({ t: 'pre', v: code.join('\n') });
      continue;
    }
    if (!line.trim()) { flushPara(); continue; }
    const h = /^(#{1,4})\s+(.+?)\s*#*$/.exec(line);
    if (h) {
      flushPara();
      // The block title is the section heading (h2): "#" and "##" become h3, "###" and "####" h4.
      const level = h[1]!.length <= 2 ? 3 : 4;
      out.push({ t: 'h', level, c: parseInline(h[2]!) });
      continue;
    }
    const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      const ordered = /\d/.test(li[1]!);
      const items: MdInline[][] = [parseInline(li[2]!)];
      for (; i + 1 < lines.length; i++) {
        const nx = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i + 1]!);
        if (!nx || /\d/.test(nx[1]!) !== ordered) break;
        items.push(parseInline(nx[2]!));
      }
      out.push({ t: ordered ? 'ol' : 'ul', items });
      continue;
    }
    para.push(line.trim());
  }
  flushPara();
  return out;
}
