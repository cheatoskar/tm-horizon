// Minimal XML for the TrackMania Forever master server envelope: elements, text, entities.
// No attributes are needed (they are skipped), no namespaces, no DTD.

export interface XmlNode {
  name: string;
  children: XmlNode[];
  text: string;
  /** Attributes by name (prefixes kept, e.g. "r:id"); entities decoded. */
  attrs: Record<string, string>;
}

const ATTR_RE = /([A-Za-z_][\w.\-:]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseAttrs(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of src.matchAll(ATTR_RE)) out[m[1]] = xmlUnescape(m[2] ?? m[3] ?? '');
  return out;
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function xmlUnescape(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENT[e.toLowerCase()];
  });
}

export function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Parse one root element (leading XML declaration and comments are skipped). */
export function parseXml(src: string): XmlNode {
  let i = 0;
  const skipMisc = () => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src.startsWith('<?', i)) i = src.indexOf('?>', i) + 2;
      else if (src.startsWith('<!--', i)) i = src.indexOf('-->', i) + 3;
      else return;
      if (i < 2) throw new Error('unterminated XML declaration or comment');
    }
  };
  const element = (): XmlNode => {
    if (src[i] !== '<') throw new Error(`XML: expected "<" at ${i}`);
    const m = /^<([A-Za-z_][\w.\-:]*)([^>]*?)(\/?)>/.exec(src.slice(i, i + 4096));
    if (!m) throw new Error(`XML: bad tag at ${i}`);
    i += m[0].length;
    const node: XmlNode = { name: m[1], children: [], text: '', attrs: parseAttrs(m[2]) };
    if (m[3] === '/') return node;
    for (;;) {
      if (i >= src.length) throw new Error(`XML: <${node.name}> not closed`);
      if (src.startsWith('</', i)) {
        const end = src.indexOf('>', i);
        const name = src.slice(i + 2, end).trim();
        if (name !== node.name) throw new Error(`XML: </${name}> closes <${node.name}>`);
        i = end + 1;
        return node;
      }
      if (src.startsWith('<![CDATA[', i)) {
        const end = src.indexOf(']]>', i);
        node.text += src.slice(i + 9, end);
        i = end + 3;
      } else if (src.startsWith('<!--', i)) {
        i = src.indexOf('-->', i) + 3;
      } else if (src[i] === '<') {
        node.children.push(element());
      } else {
        const next = src.indexOf('<', i);
        node.text += xmlUnescape(src.slice(i, next < 0 ? src.length : next));
        i = next < 0 ? src.length : next;
      }
    }
  };
  skipMisc();
  return element();
}

export function child(node: XmlNode | null | undefined, name: string): XmlNode | null {
  return node?.children.find((c) => c.name === name) ?? null;
}

export function childText(node: XmlNode | null | undefined, name: string): string | null {
  const c = child(node, name);
  return c ? c.text.trim() : null;
}
