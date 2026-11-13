// Read cells and hyperlinks from an .xlsx workbook (zip of XML). Only what the Discord directory needs:
// sheet names, cell text (shared strings, inline strings, plain values) and external hyperlink targets.
import { parseXml } from './xml.ts';
import type { XmlNode } from './xml.ts';
import { readZip } from './zip.ts';

export interface XlsxCell {
  /** 1-based. */
  row: number;
  /** 1-based (A = 1). */
  col: number;
  text: string;
  /** External hyperlink target of the cell, if any. */
  link: string | null;
}

export interface XlsxSheet {
  name: string;
  /** Non-empty cells (text or link), in row order, then column order. */
  cells: XlsxCell[];
}

/** "B10" -> { row: 10, col: 2 } */
export function parseRef(ref: string): { row: number; col: number } {
  const m = /^([A-Z]+)(\d+)/.exec(ref);
  if (!m) throw new Error(`bad cell reference "${ref}"`);
  let col = 0;
  for (const ch of m[1]) col = col * 26 + ch.charCodeAt(0) - 64;
  return { row: Number(m[2]), col };
}

/** All text below a node (rich text runs <r><t>, plain <t>); phonetic runs are skipped. */
function textOf(n: XmlNode): string {
  if (n.name === 'rPh') return '';
  if (n.name === 't') return n.text;
  return n.children.map(textOf).join('');
}

const all = (n: XmlNode | undefined, name: string): XmlNode[] => n?.children.filter((c) => c.name === name) ?? [];
const first = (n: XmlNode, name: string): XmlNode | undefined => n.children.find((c) => c.name === name);

/** Resolve a relationship target ("worksheets/sheet1.xml" or "/xl/worksheets/sheet1.xml") to a zip path. */
function zipPath(baseDir: string, target: string): string {
  return target.startsWith('/') ? target.slice(1) : `${baseDir}${target}`;
}

export function parseXlsx(buf: Buffer): XlsxSheet[] {
  const files = readZip(buf);
  const text = (name: string): string | null => files.get(name)?.toString('utf8') ?? null;
  const workbook = text('xl/workbook.xml');
  const wbRels = text('xl/_rels/workbook.xml.rels');
  if (!workbook || !wbRels) throw new Error('not an xlsx workbook (xl/workbook.xml missing)');

  const relTarget = new Map<string, string>();
  for (const r of all(parseXml(wbRels), 'Relationship')) relTarget.set(r.attrs.Id, r.attrs.Target);

  const sharedXml = text('xl/sharedStrings.xml');
  const shared = sharedXml ? all(parseXml(sharedXml), 'si').map(textOf) : [];

  const sheets: XlsxSheet[] = [];
  for (const s of all(first(parseXml(workbook), 'sheets'), 'sheet')) {
    const target = relTarget.get(s.attrs['r:id']);
    if (!target) continue;
    const file = zipPath('xl/', target);
    const xml = text(file);
    if (!xml) continue;
    const relsXml = text(file.replace(/([^/]+)$/, '_rels/$1.rels'));
    const links = new Map<string, string>();
    if (relsXml) {
      for (const r of all(parseXml(relsXml), 'Relationship')) {
        if (r.attrs.TargetMode === 'External') links.set(r.attrs.Id, r.attrs.Target);
      }
    }
    const sheet = parseXml(xml);
    const linkAt = new Map<string, string>();
    for (const h of all(first(sheet, 'hyperlinks'), 'hyperlink')) {
      const target = links.get(h.attrs['r:id']);
      if (target) linkAt.set(h.attrs.ref.split(':')[0], target);
    }
    const cells: XlsxCell[] = [];
    for (const row of all(first(sheet, 'sheetData'), 'row')) {
      for (const c of all(row, 'c')) {
        const ref = c.attrs.r;
        if (!ref) continue;
        let value = '';
        const v = first(c, 'v');
        if (c.attrs.t === 's') value = shared[Number(v?.text)] ?? '';
        else if (c.attrs.t === 'inlineStr') value = textOf(first(c, 'is') ?? c);
        else if (v) value = v.text;
        const link = linkAt.get(ref) ?? null;
        if (!value.trim() && !link) continue;
        const { row: r, col } = parseRef(ref);
        cells.push({ row: r, col, text: value, link });
      }
    }
    cells.sort((a, b) => a.row - b.row || a.col - b.col);
    sheets.push({ name: s.attrs.name, cells });
  }
  return sheets;
}
