// Our own covers for the games without a Steam page (Nations ESWC, Sunrise, Original): dark gradient
// per game, diagonal speed stripes (the look of the generated mod icons, packages/shared/src/modicon.ts),
// and the game name (the pages show the year next to it). Written to public/img/covers/<id>-cover.svg (600x900) and <id>-hero.svg (1920x620).
// These are TM Horizon artwork, not store art, so they are committed and used in every build.
// Run: node scripts/make-covers.mjs
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const out = path.join(root, 'public', 'img', 'covers');
fs.mkdirSync(out, { recursive: true });

// id, title lines, year, gradient stops (top-left -> bottom-right), accent for the stripes and the year.
const GAMES = [
  { id: 'eswc', lines: ['NATIONS', 'ESWC'], year: '2006', stops: ['#3a63c9', '#1b2f6b', '#0b1330', '#070a16'], accent: '#8fb4ff' },
  { id: 'tms', lines: ['SUNRISE'], year: '2005', stops: ['#ffcf5a', '#ff7a2f', '#7a1f3a', '#1a0812'], accent: '#ffd38a' },
  { id: 'tmo', lines: ['ORIGINAL'], year: '2003', stops: ['#9ad0ff', '#3a76c4', '#16264d', '#080c18'], accent: '#cfe7ff' },
  // Fallbacks for the Steam titles: shown only when Steam's picture does not load (src/layouts/Layout.astro).
  { id: 'tmnf', lines: ['NATIONS', 'FOREVER'], year: '2008', stops: ['#1f8a5e', '#0b3d2e', '#0a1a2f', '#060b14'], accent: '#7ff0c0' },
  { id: 'tmuf', lines: ['UNITED', 'FOREVER'], year: '2008', stops: ['#a8742a', '#3b2a12', '#0f1a2c', '#070a12'], accent: '#ffd08a' },
  { id: 'tm2-stadium', kicker: 'TRACKMANIA²', lines: ['STADIUM'], year: '2013', stops: ['#3fa36b', '#1e5a3a', '#0c1726', '#060b14'], accent: '#9ff0c4' },
  { id: 'tm2-canyon', kicker: 'TRACKMANIA²', lines: ['CANYON'], year: '2011', stops: ['#e2793f', '#b5532c', '#3a1a10', '#140c0a'], accent: '#ffc39a' },
  { id: 'tm2-valley', kicker: 'TRACKMANIA²', lines: ['VALLEY'], year: '2013', stops: ['#6fbf5f', '#3f7d3a', '#14301a', '#0a140f'], accent: '#c4f0b0' },
  { id: 'tm2-lagoon', kicker: 'TRACKMANIA²', lines: ['LAGOON'], year: '2017', stops: ['#4cc3f0', '#1f86b8', '#0b3550', '#071420'], accent: '#a8e6ff' },
  { id: 'sm-storm', kicker: 'SHOOTMANIA', lines: ['STORM'], year: '2013', stops: ['#8c5ce0', '#5b2ea6', '#22124a', '#0b0816'], accent: '#d2b8ff' },
  { id: 'turbo', lines: ['TURBO'], year: '2016', stops: ['#ffd23f', '#f5b700', '#5a3a00', '#1a0f00'], accent: '#fff0a8' },
  // Console games (emulator, own copy): colours from the launcher's drawn covers (apps/launcher/src/data/catalog.ts).
  { id: 'tm-ds', kicker: 'TRACKMANIA', lines: ['DS'], year: '2008', stops: ['#ffd27a', '#d6522e', '#4a1410', '#120606'], accent: '#ffe0a8' },
  { id: 'tm-turbo-ds', kicker: 'TRACKMANIA', lines: ['TURBO', 'DS'], year: '2010', stops: ['#c6f27a', '#3aa64a', '#123a1c', '#050f08'], accent: '#e2ffb0' },
  { id: 'tm-wii', kicker: 'TRACKMANIA', lines: ['WII'], year: '2010', stops: ['#bfe4ff', '#3b8fd6', '#12305a', '#060c18'], accent: '#e0f2ff' },
  { id: 'tm2020', kicker: '2020', lines: ['TRACKMANIA'], year: '2020', stops: ['#2fd0c4', '#0f8f86', '#073a40', '#060b14'], accent: '#a8fff4' },
];
const FONT = "'Barlow Condensed', 'Arial Narrow', 'Roboto Condensed', 'Helvetica Neue', Arial, sans-serif";

function stripes(w, h, accent) {
  // Long thin bars rotated like the mod icons' speed stripes, more on the right.
  const bars = [
    [-0.2, 0.18, 1.5, 0.012], [0.1, 0.27, 1.2, 0.006], [0.3, 0.71, 1.1, 0.009], [-0.1, 0.82, 0.8, 0.005],
    [0.45, 0.4, 0.9, 0.004], [0.55, 0.58, 0.7, 0.007],
  ];
  return `<g transform="rotate(-24 ${w / 2} ${h / 2})" fill="url(#s)">${bars.map(([x, y, l, t]) =>
    `<rect x="${(x * w).toFixed(0)}" y="${(y * h).toFixed(0)}" width="${(l * w).toFixed(0)}" height="${Math.max(3, t * h).toFixed(0)}" rx="${Math.max(1.5, (t * h) / 2).toFixed(1)}"/>`).join('')}</g>
  <circle cx="${w * 0.86}" cy="${h * 0.1}" r="${Math.min(w, h) * 0.42}" fill="${accent}" opacity=".07"/>`;
}

function defs(g) {
  const [a, b, c, d] = g.stops;
  return `<defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset=".35" stop-color="${b}"/><stop offset=".75" stop-color="${c}"/><stop offset="1" stop-color="${d}"/></linearGradient>
    <linearGradient id="s" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity=".26"/></linearGradient>
    <clipPath id="c"><rect width="100%" height="100%"/></clipPath>
    <linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop offset=".45" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".55"/></linearGradient>
  </defs>`;
}

function cover(g) {
  const w = 600, h = 900;
  const size = g.lines.some((l) => l.length > 8) ? 96 : g.lines.some((l) => l.length > 7) ? 116 : 132;
  const y0 = 610 - (g.lines.length - 1) * size * 0.92;
  const title = g.lines.map((l, i) => `<text x="52" y="${(y0 + i * size * 0.92).toFixed(0)}" font-size="${size}">${l}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" overflow="hidden" role="img" aria-label="TrackMania ${g.lines.join(' ')} (${g.year})">
  ${defs(g)}
  <g clip-path="url(#c)">
  <rect width="${w}" height="${h}" fill="url(#bg)"/>
  ${stripes(w, h, g.accent)}
  <rect width="${w}" height="${h}" fill="url(#shade)"/>
  </g>
  <g font-family="${FONT}" font-style="italic" font-weight="800" fill="#fff">
    <text x="54" y="${(y0 - size * 0.95).toFixed(0)}" font-size="34" letter-spacing="9" opacity=".82">${g.kicker ?? 'TRACKMANIA'}</text>
    ${title}
  </g>
  <rect x="52" y="820" width="64" height="6" rx="3" fill="${g.accent}" opacity=".9"/>
</svg>
`;
}

function hero(g) {
  const w = 1920, h = 620;
  const text = g.lines.join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" overflow="hidden" role="img" aria-label="TrackMania ${text} (${g.year})">
  ${defs(g)}
  <g clip-path="url(#c)">
  <rect width="${w}" height="${h}" fill="url(#bg)"/>
  ${stripes(w, h, g.accent)}
  </g>
  <g font-family="${FONT}" font-style="italic" font-weight="800" fill="#fff" opacity=".13">
    <text x="${w - 60}" y="${h - 60}" font-size="260" text-anchor="end">${text}</text>
  </g>
</svg>
`;
}

for (const g of GAMES) {
  fs.writeFileSync(path.join(out, `${g.id}-cover.svg`), cover(g));
  fs.writeFileSync(path.join(out, `${g.id}-hero.svg`), hero(g));
}
console.log(`covers: ${GAMES.map((g) => g.id).join(', ')} -> ${path.relative(root, out)}`);
