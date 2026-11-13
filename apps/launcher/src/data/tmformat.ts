// TrackMania text format codes (TMNF/TMUF, ESWC, TM2, TM2020). Pure module, no app imports.
//
// Colour rule (documented choice): `$` followed by hex digits takes up to 3 of them. With fewer than
// 3 hex digits before a non-hex character the digits we have are used and the rest is padded with 0:
// `$f0x` -> colour #f00 then "x"; `$fx` -> #f00 then "x"; `$ax` -> #a00. This matches how the game
// reads short codes closely enough for a preview; the UI gets a 'bad-color' warning because the
// result is rarely what the author meant.

export type TmSegment = {
  text: string;
  color: string | null;
  bold: boolean;
  italic: boolean;
  wide: boolean;
  narrow: boolean;
  shadow: boolean;
  upper: boolean;
  link: string | null;
};

type Style = Omit<TmSegment, 'text' | 'link'>;

const BASE: Style = { color: null, bold: false, italic: false, wide: false, narrow: false, shadow: false, upper: false };
const HEX = /[0-9a-f]/i;

type Parsed = { segments: TmSegment[]; warnings: string[] };

function run(input: string): Parsed {
  const segments: TmSegment[] = [];
  const warnings: string[] = [];
  const warn = (w: string) => { if (!warnings.includes(w)) warnings.push(w); };
  let style: Style = { ...BASE };
  const stack: Style[] = [];
  let link: string | null = null; // explicit url from $l[url]
  let linkOpen = false;
  let linkSelf: TmSegment[] | null = null; // segments of a bracket-less link, url = their text

  const closeLink = () => {
    if (linkSelf) {
      const url = linkSelf.map((s) => s.text).join('');
      for (const s of linkSelf) s.link = url;
    }
    link = null; linkOpen = false; linkSelf = null;
  };
  const add = (text: string) => {
    if (!text) return;
    const last = segments[segments.length - 1];
    const same = last && last.link === link && (Object.keys(style) as (keyof Style)[]).every((k) => last[k] === style[k])
      && (linkSelf === null || (linkSelf as TmSegment[]).includes(last));
    if (same) { last.text += text; return; }
    const seg: TmSegment = { text, ...style, link };
    segments.push(seg);
    if (linkSelf) (linkSelf as TmSegment[]).push(seg);
  };

  let i = 0;
  const n = input.length;
  while (i < n) {
    const c = input[i];
    if (c !== '$') {
      let j = i + 1;
      while (j < n && input[j] !== '$') j++;
      add(input.slice(i, j));
      i = j;
      continue;
    }
    const d = input[i + 1];
    if (d === undefined) { warn('trailing-dollar'); break; }
    if (d === '$') { add('$'); i += 2; continue; }
    if (HEX.test(d)) {
      let j = i + 1;
      let hex = '';
      while (j < n && hex.length < 3 && HEX.test(input[j])) { hex += input[j]; j++; }
      if (hex.length < 3) { warn('bad-color'); hex = hex.padEnd(3, '0'); }
      style = { ...style, color: '#' + hex.toLowerCase() };
      i = j;
      continue;
    }
    const k = d.toLowerCase();
    i += 2;
    switch (k) {
      case 'o': style = { ...style, bold: true }; break;
      case 'i': style = { ...style, italic: true }; break;
      case 'w': style = { ...style, wide: true, narrow: false }; break;
      case 'n': style = { ...style, narrow: true, wide: false }; break;
      case 'm': style = { ...style, wide: false, narrow: false }; break;
      case 's': style = { ...style, shadow: true }; break;
      case 't': style = { ...style, upper: true }; break;
      case 'g': style = { ...style, color: null }; break;
      case 'z': style = { ...BASE }; break;
      case '<': stack.push(style); break;
      case '>': {
        const s = stack.pop();
        if (s) style = s; else warn('unbalanced-push');
        break;
      }
      case 'l': case 'h': case 'p': {
        if (linkOpen) {
          closeLink();
          if (input[i] !== '[') break; // a bare $l/$h/$p ends the open link (toggle)
        }
        let url: string | null = null;
        if (input[i] === '[') {
          const e = input.indexOf(']', i);
          if (e < 0) { warn('open-link'); url = input.slice(i + 1); i = n; }
          else { url = input.slice(i + 1, e); i = e + 1; }
        }
        linkOpen = true;
        if (url !== null) link = url; else linkSelf = [];
        break;
      }
      default: break; // unknown code: dropped
    }
  }
  if (linkSelf && !(linkSelf as TmSegment[]).length) warn('open-link');
  if (linkOpen) closeLink();
  if (stack.length) warn('unbalanced-push');
  return { segments, warnings };
}

export function parseTm(text: string): TmSegment[] {
  return run(text).segments;
}

export function stripTm(text: string): string {
  return run(text).segments.map((s) => s.text).join('');
}

/** Visible length (what the player sees; `$t` does not change it). */
export function tmLength(text: string): number {
  return stripTm(text).length;
}

/** Codes for the UI: 'bad-color', 'open-link', 'unbalanced-push', 'trailing-dollar'. */
export function tmWarnings(text: string): string[] {
  return run(text).warnings;
}

/** Common in-game colours for a picker. */
export const TM_COLORS: { name: string; code: string }[] = [
  { name: 'Red', code: '$f00' },
  { name: 'Orange', code: '$f80' },
  { name: 'Yellow', code: '$ff0' },
  { name: 'Green', code: '$0f0' },
  { name: 'Cyan', code: '$0ff' },
  { name: 'Blue', code: '$00f' },
  { name: 'Purple', code: '$90f' },
  { name: 'Pink', code: '$f0f' },
  { name: 'White', code: '$fff' },
  { name: 'Grey', code: '$888' },
  { name: 'Black', code: '$000' },
];
