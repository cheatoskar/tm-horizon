// Logos for the directory entries that are not mods (tools, events, communities, skin sites, leaderboards,
// exchanges, docs ...) and preview pictures of ManiaPark skins. Run by hand when the catalog changes:
//   node scripts/fetch-entry-art.mjs [--force] [--only id1,id2]
// Order per entry (the first hit wins):
//   1. the project's own icon from the TMLoader mod index (same project, e.g. TMInterface)
//   2. ManiaPark skin/mod pages: their og:image preview (not the generic ManiaPark logo)
//   3. Discord invites: the server icon from Discord's public invite API (GET /api/v10/invites/<code>, no token)
//   4. websites: apple-touch-icon, else an <link rel=icon> of 64 px or more (og:image for events and skin sites)
//   5. GitHub repositories of an organisation: the organisation avatar (personal avatars are not logos)
// Every picked picture is fetched once to check it is a real raster image. The result is committed as
// src/data/entry-art.json (id -> url, kind, source, checked); scripts/build-data.mjs downloads the files into
// public/img/icons/ (git-ignored cache) and the site shows the local copy. Entries without a hit keep the
// generated type icon (packages/shared/src/modicon.ts).
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { catalogLogoUrl, modIconMap } from '../../../packages/shared/src/logo.ts'; // same pick as the hub's catalog import

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const repoRoot = path.resolve(root, '..', '..');
const outFile = path.join(root, 'src', 'data', 'entry-art.json');
const UA = 'TM-Horizon-build (+https://github.com/cheatoskar)';
const CATS = new Set(['tool', 'events', 'community', 'skins', 'leaderboard', 'exchange', 'docs', 'servers', 'environment', 'tas-plugin']);
const args = process.argv.slice(2);
const force = args.includes('--force');
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;

const catalog = JSON.parse(fs.readFileSync(path.join(repoRoot, 'packages', 'catalog', 'catalog.json'), 'utf8'));
const prev = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : {};
let ghToken = process.env.GITHUB_TOKEN || '';
if (!ghToken) { try { ghToken = execSync('gh auth token', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* unauthenticated */ } }

// TMLoader mod icons (launcher's bundled hub copy and the launcher's own mod index).
let modIcons = new Map();
try { modIcons = modIconMap(JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps/launcher/src/generated/hub/mods.json'), 'utf8')).mods); } catch { /* optional */ }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, accept = '*/*', timeout = 12000) {
  await sleep(250); // polite: one request at a time, a short gap between them
  try {
    const headers = { 'user-agent': UA, accept };
    if (ghToken && url.startsWith('https://api.github.com/')) headers.authorization = `Bearer ${ghToken}`;
    return await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeout) });
  } catch { return null; }
}
/** A real raster picture (png, jpeg, gif, webp, ico) of at least 200 bytes. */
async function isPicture(url) {
  const r = await get(url, 'image/*');
  if (!r?.ok) return false;
  const b = Buffer.from(await r.arrayBuffer());
  if (b.length < 200) return false;
  const png = b[0] === 0x89 && b[1] === 0x50, jpg = b[0] === 0xff && b[1] === 0xd8, gif = b.toString('latin1', 0, 4) === 'GIF8';
  const webp = b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP', ico = b[0] === 0 && b[1] === 0 && b[2] === 1;
  return png ? 'png' : jpg ? 'jpg' : gif ? 'gif' : webp ? 'webp' : ico ? 'ico' : false;
}
const abs = (u, base) => { try { const x = new URL(u.replace(/&amp;/g, '&'), base); return x.protocol === 'https:' ? x.href : null; } catch { return null; } };
const attr = (tag, name) => new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)?.[1] ?? null;

async function fromHtml(url, allowOg, preferOg = false) {
  const r = await get(url, 'text/html');
  if (!r?.ok || !/html/i.test(r.headers.get('content-type') ?? '')) return null;
  const html = (await r.text()).slice(0, 400_000);
  const base = r.url || url;
  const og = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]).find((m) => /property\s*=\s*["']og:image["']/i.test(m));
  if (preferOg && og && attr(og, 'content')) return { url: abs(attr(og, 'content'), base), source: 'og:image' };
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
  const touch = links.find((l) => /rel\s*=\s*["'][^"']*apple-touch-icon/i.test(l));
  if (touch && attr(touch, 'href')) return { url: abs(attr(touch, 'href'), base), source: 'apple-touch-icon' };
  const big = links.filter((l) => /rel\s*=\s*["'](?:shortcut )?icon["']/i.test(l))
    .map((l) => ({ href: attr(l, 'href'), size: Math.max(0, ...String(attr(l, 'sizes') ?? '').split(/\s+/).map((s) => parseInt(s, 10) || 0)), svg: /\.svg(\?|$)/i.test(attr(l, 'href') ?? '') }))
    .filter((x) => x.href && !x.svg && x.size >= 64).sort((a, b) => b.size - a.size)[0];
  if (big) return { url: abs(big.href, base), source: `icon ${big.size}px` };
  if (allowOg && og && attr(og, 'content')) return { url: abs(attr(og, 'content'), base), source: 'og:image' };
  return null;
}

async function find(e) {
  const urls = [e.url, ...(e.urls ?? [])].filter(Boolean);
  // 1. TMLoader mod index icon of the same project
  const own = catalogLogoUrl(e, modIcons);
  if (own) return { url: own.url, kind: 'logo', source: 'tmloader-index' };
  for (const u of urls) {
    // 2. ManiaPark preview
    if (/^https:\/\/maniapark\.com\/(skin|mod)\//i.test(u)) {
      const h = await fromHtml(u, true, true);
      if (h?.url && !/logos\/mp\/logo\.png/i.test(h.url)) return { url: h.url, kind: 'preview', source: 'maniapark og:image' };
      continue;
    }
    // 3. Discord invite
    const code = /^https?:\/\/(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/([A-Za-z0-9_-]+)/i.exec(u)?.[1];
    if (code) {
      const r = await get(`https://discord.com/api/v10/invites/${encodeURIComponent(code)}`, 'application/json');
      if (r?.ok) {
        const j = await r.json().catch(() => null);
        const id = j?.guild?.id, hash = j?.guild?.icon;
        if (/^\d+$/.test(String(id ?? '')) && /^(a_)?[0-9a-f]{32}$/.test(String(hash ?? ''))) return { url: `https://cdn.discordapp.com/icons/${id}/${hash}.png?size=128`, kind: 'logo', source: 'discord invite' };
      }
      continue;
    }
    // 5. GitHub organisation avatar
    const gh = /^https:\/\/github\.com\/([A-Za-z0-9-]+)(?:\/|$)/i.exec(u)?.[1];
    if (gh) {
      const r = await get(`https://api.github.com/users/${gh}`, 'application/vnd.github+json');
      const j = r?.ok ? await r.json().catch(() => null) : null;
      if (j?.type === 'Organization' && j.avatar_url) return { url: `${j.avatar_url}${j.avatar_url.includes('?') ? '&' : '?'}s=128`, kind: 'logo', source: 'github organisation' };
      continue;
    }
    // 4. Website icon
    if (/^https:\/\//i.test(u) && !/(youtube\.com|youtu\.be|twitch\.tv|reddit\.com|steampowered\.com|archive\.org|google\.com|drive\.google|yandex)/i.test(u)) {
      const h = await fromHtml(u, ['events', 'skins'].includes(e.category));
      if (h?.url) return { url: h.url, kind: 'logo', source: h.source };
    }
  }
  return null;
}

const out = { ...prev };
const today = new Date().toISOString().slice(0, 10);
let tried = 0, found = 0;
for (const e of catalog.entries) {
  if (!CATS.has(e.category) || e.status === 'dead') continue;
  if (only && !only.has(e.id)) continue;
  if (!force && !only && prev[e.id]) continue;
  tried++;
  const hit = await find(e);
  const ext = hit?.url ? await isPicture(hit.url) : false;
  if (ext) {
    out[e.id] = { url: hit.url, ext, kind: hit.kind, source: hit.source, checked: today };
    found++;
    console.log(`${e.id}: ${hit.source}`);
  } else {
    out[e.id] = { url: null, kind: null, source: null, checked: today };
  }
}
const sorted = Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
fs.writeFileSync(outFile, JSON.stringify(sorted, null, 1) + '\n');
console.log(`entry art: ${found} of ${tried} looked up have a picture -> ${path.relative(root, outFile)}`);
