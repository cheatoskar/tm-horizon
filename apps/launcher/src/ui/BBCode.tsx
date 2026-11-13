// Exchange post BBCode as React elements (no HTML strings): [b] [i] [u] [s] [url] [img] [align]
// [center] [user] [quote] [list]/[*]. Unknown tags vanish, their text stays. Links and pictures
// only over https; links open in the system browser, pictures come from the picture cache.
import type { ReactNode } from 'react';
import { backend } from '../data/backend';
import { useCachedImage } from './common';

type Node = { tag: string; arg: string | null; kids: (Node | string)[] };

const KNOWN = new Set(['b', 'i', 'u', 's', 'url', 'img', 'align', 'center', 'user', 'quote', 'list', 'size', 'color', 'spoiler', 'code']);

/** Small tolerant parser: unmatched closing tags are ignored, unclosed tags end at the end of the text. */
function parse(src: string): Node {
  const root: Node = { tag: '', arg: null, kids: [] };
  const stack: Node[] = [root];
  const re = /\[(\/)?([a-z*]+)(?:=([^\]]*))?\]/gi;
  let last = 0;
  for (const m of src.matchAll(re)) {
    const top = stack[stack.length - 1];
    const tag = m[2].toLowerCase();
    if (tag !== '*' && !KNOWN.has(tag)) continue;
    if (m.index! > last) top.kids.push(src.slice(last, m.index));
    last = m.index! + m[0].length;
    if (tag === '*') { top.kids.push('\n• '); continue; }
    if (m[1]) {
      const at = stack.map((n) => n.tag).lastIndexOf(tag);
      if (at > 0) stack.length = at;
      continue;
    }
    const n: Node = { tag, arg: m[3]?.trim().replace(/^["']|["']$/g, '') ?? null, kids: [] };
    top.kids.push(n);
    stack.push(n);
  }
  if (last < src.length) stack[stack.length - 1].kids.push(src.slice(last));
  return root;
}

const https = (u: string | null | undefined) => (u && /^https:\/\/[^\s"'<>]+$/i.test(u.trim()) ? u.trim() : null);
const text = (n: Node | string): string => (typeof n === 'string' ? n : n.kids.map(text).join(''));

function Img({ url }: { url: string }) {
  const src = useCachedImage(url);
  return src ? <img className="bb-img" src={src} alt="" loading="lazy" /> : null;
}

function render(n: Node | string, key: number): ReactNode {
  if (typeof n === 'string') return n;
  const kids = n.kids.map(render);
  switch (n.tag) {
    case 'b': return <b key={key}>{kids}</b>;
    case 'i': return <i key={key}>{kids}</i>;
    case 'u': return <u key={key}>{kids}</u>;
    case 's': return <s key={key}>{kids}</s>;
    case 'center': return <div key={key} className="bb-center">{kids}</div>;
    case 'align': return <div key={key} className={n.arg === 'center' ? 'bb-center' : n.arg === 'right' ? 'bb-right' : undefined}>{kids}</div>;
    case 'quote': return <blockquote key={key} className="bb-quote">{kids}</blockquote>;
    case 'code': return <code key={key}>{text(n)}</code>;
    case 'user': return <b key={key} className="bb-user">@{text(n) || n.arg}</b>;
    case 'img': { const u = https(n.arg?.includes('://') ? n.arg : text(n)); return u ? <Img key={key} url={u} /> : null; }
    case 'url': {
      const u = https(n.arg ?? text(n));
      return u ? <a key={key} href={u} onClick={(e) => { e.preventDefault(); void backend.openExternal(u); }}>{n.kids.length ? kids : u}</a> : <span key={key}>{kids}</span>;
    }
    default: return <span key={key}>{kids}</span>;
  }
}

export function BBCode({ text: src, className = '' }: { text: string; className?: string }) {
  return <div className={'bbcode ' + className}>{parse(src.replace(/\r\n/g, '\n')).kids.map(render)}</div>;
}
