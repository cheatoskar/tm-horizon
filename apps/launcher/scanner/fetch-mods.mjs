// Fetch the public TMLoader repository indexes (<server>/index.json) listed in
// TMLoader's config.yaml and download the mod icons. Plain GETs only, no
// personal data sent. Writes src/generated/mods.json and public/mod-icons/*.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.join(here, '..', 'src', 'generated', 'mods.json');
const iconDir = path.join(here, '..', 'public', 'mod-icons');
const UA = 'TM-Horizon-scanner (+https://tm-horizon.com)';

const cfgPath = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'TMLoader', 'config.yaml');
let servers = [];
try { servers = YAML.parse(fs.readFileSync(cfgPath, 'utf8')).servers || []; } catch { /* fall back below */ }
if (!servers.length) {
  servers = [
    'https://modloader.tomashu.dev/modloader/TmForever/v1/',
    'https://tomashu.pages.dev/modloader/TmForever/v1/',
    'https://unlimiter.net/modloader/',
    'https://donadigo.com/modloader/',
    'https://fullspeed.mooo.com/modloader/',
    'https://cheatoskar.github.io/TM-Vibrant-Shaders/modloader/',
    'https://home.koyaanis.com/modloader/',
  ];
}
// Always Official has its own server (see its README); the launcher reads it too (modindex.rs EXTRA_SERVERS).
const AO = 'https://bigbang1112.github.io/always-official/modloader/';
if (!servers.some((s) => s.replace(/\/+$/, '').toLowerCase() === AO.replace(/\/+$/, ''))) servers.push(AO);

const semverKey = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(v) || [];
  return [Number(m[1] || 0), Number(m[2] || 0), Number(m[3] || 0), m[4] ? 0 : 1, m[4] || ''];
};
export const cmpVersion = (a, b) => {
  const x = semverKey(a), y = semverKey(b);
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x[4].localeCompare(y[4]);
};

async function get(url, binary = false, tries = 3) {
  let r;
  try {
    r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    if (tries > 1) { await new Promise((ok) => setTimeout(ok, 1500)); return get(url, binary, tries - 1); }
    // Some hosts time out on Node's connect (IPv6/happy eyeballs); curl.exe ships with Windows.
    try {
      const buf = execFileSync('curl', ['-sfL', '-m', '30', '-A', UA, url], { maxBuffer: 64 << 20 });
      return binary ? buf : JSON.parse(buf.toString('utf8'));
    } catch {
      throw new Error(url + ' -> ' + (e.cause?.code || e.message));
    }
  }
  if (!r.ok) throw new Error(url + ' -> HTTP ' + r.status);
  return binary ? Buffer.from(await r.arrayBuffer()) : r.json();
}

const products = {};
const serverStatus = [];
for (const s of servers) {
  const url = s.replace(/\/?$/, '/') + 'index.json';
  try {
    const j = await get(url);
    serverStatus.push({ server: s, ok: true, count: Object.keys(j.products || {}).length });
    for (const [id, p] of Object.entries(j.products || {})) {
      if (products[id]) { products[id].servers.push(s); continue; } // mirrors
      const versions = Object.entries(p.versions || {}).map(([v, d]) => ({
        version: v,
        executable: d.executable ?? null,
        dependencies: d.dependencies || [],
        changelog: d.changelog ?? null,
        download: d.download_link ?? null,
        size: null,
      })).sort((a, b) => cmpVersion(b.version, a.version));
      products[id] = {
        id, name: p.name ?? id, author: p.author ?? null, type: p.type ?? null,
        description: p.description ?? null, homepage: p.homepage ?? null,
        icon_link: p.icon_link ?? null, external: !!p.external,
        servers: [s], versions,
      };
    }
  } catch (e) {
    serverStatus.push({ server: s, ok: false, error: String(e.message || e) });
  }
}

// Size and date of the latest download (HEAD only; nothing is downloaded).
const head = (url) => {
  try {
    const out = execFileSync('curl', ['-sIL', '-m', '20', '-A', UA, url]).toString('latin1');
    const blocks = out.trim().split(/\r?\n\r?\n/);
    const last = blocks[blocks.length - 1];
    const get = (h) => new RegExp('^' + h + ':\\s*(.+)$', 'im').exec(last)?.[1]?.trim() ?? null;
    const len = Number(get('content-length'));
    const lm = get('last-modified');
    return { size: len > 0 ? len : null, updated: lm ? new Date(lm).toISOString() : null };
  } catch { return { size: null, updated: null }; }
};
for (const p of Object.values(products)) {
  const v = p.versions[0];
  if (v?.download) { const h = head(v.download); v.size = h.size; v.updated = h.updated; }
}

// Icons
fs.mkdirSync(iconDir, { recursive: true });
const iconFor = async (id, link) => {
  if (!link) return null;
  const ext = (/\.(png|jpg|jpeg|webp|gif|ico)(\?|$)/i.exec(link)?.[1] || 'png').toLowerCase();
  const file = id.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.' + ext;
  try {
    fs.writeFileSync(path.join(iconDir, file), await get(link, true));
    return 'mod-icons/' + file;
  } catch { return null; }
};
for (const p of Object.values(products)) p.icon = await iconFor(p.id, p.icon_link);

// Products only known from the local TMLoader database (server no longer in config).
const snapPath = path.join(here, '..', 'src', 'generated', 'snapshot.json');
let localOnly = [];
try {
  const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
  for (const lp of Object.values(snap.tmloader?.products || {})) {
    if (products[lp.id]) continue;
    const p = {
      id: lp.id, name: lp.name, author: lp.author, type: lp.type, description: lp.description,
      homepage: lp.homepage, icon_link: lp.icon_link, external: lp.external, servers: [],
      versions: lp.versions.map((v) => ({ version: v.version, executable: v.executable, dependencies: v.dependencies, changelog: v.changelog, download: null, size: null }))
        .sort((a, b) => cmpVersion(b.version, a.version)),
      localOnly: true,
    };
    p.icon = await iconFor(p.id, p.icon_link);
    products[p.id] = p;
    localOnly.push(p.id);
  }
} catch { /* run scan first */ }

fs.writeFileSync(outFile, JSON.stringify({ fetchedAt: new Date().toISOString(), servers: serverStatus, products }, null, 2));
console.log('mods written:', outFile);
for (const s of serverStatus) console.log(' ', s.ok ? 'ok ' : 'ERR', s.server, s.ok ? s.count : s.error);
console.log('  products:', Object.keys(products).join(', '));
console.log('  local only:', localOnly.join(', ') || '-');
