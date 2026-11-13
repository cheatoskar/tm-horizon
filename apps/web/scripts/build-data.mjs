// Builds src/data/site.json from the real sources, newest first:
//   1. packages/api/dist/*.json (mods with checksums, GitHub projects, TMX maps, events, servers, catalog), if built
//   2. otherwise: the installed TMLoader index (read-only), the directory catalog (packages/catalog/catalog.json)
//      and the GitHub API for repositories (stars, release download counts; cached in .cache/github.json)
// Events and servers stay sample data unless tm-hub-api provides real ones. Every list says where it came from.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import YAML from 'yaml';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const outDir = path.join(root, 'src', 'data');
const iconDir = path.join(root, 'public', 'img', 'icons');
const avatarDir = path.join(root, 'public', 'img', 'avatars');
const cacheDir = path.join(root, '.cache');
for (const d of [outDir, iconDir, avatarDir, cacheDir]) fs.mkdirSync(d, { recursive: true });

const home = os.homedir();
const tmloader = path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'TMLoader');
const products = path.join(tmloader, 'database', 'TmForever', 'products');
// Monorepo neighbours: packages/api/dist (built with `npm run build -w @tm-hub/api`) and packages/catalog.
const repoRoot = path.resolve(root, '..', '..');
const apiDist = process.env.HUB_API_DIST || path.join(repoRoot, 'packages', 'api', 'dist');
const realCatalog = path.join(repoRoot, 'packages', 'catalog', 'catalog.json');
const REPO_FILES = 'https://cheatoskar.github.io/TM-Vibrant-Shaders/modloader/files';
const now = new Date();

// ------------------------------------------------------------------ editorial data the indexes don't carry
// category ids follow tm-hub-api (ModCategory). online: TMX rules as far as I know them: 'yes' | 'offline' | null (not checked).
const modMeta = {
  'TM Vibrant Shaders': { cat: 'graphics', games: ['tmnf', 'tmuf', 'tm2-stadium', 'tm2-canyon', 'tm2-valley', 'tm2-lagoon'], online: 'yes',
    icon: 'icon_a.png' },
  '100% TMX + Bingo': { cat: 'HUD', games: ['tmnf'], online: 'yes' },
  CenterSpeed: { cat: 'HUD', games: ['tmnf', 'tmuf'], online: 'yes' },
  'Competition Patch': { cat: 'competition', games: ['tmnf', 'tmuf'], online: 'yes' },
  CoreMod: { cat: 'library', games: ['tmnf', 'tmuf'], online: 'yes' },
  KimMod: { cat: 'tools', games: ['tmnf', 'tmuf'], online: null },
  TMFOXR: { cat: 'VR', games: ['tmuf'], online: null },
  TMInterface: { cat: 'TAS', games: ['tmnf', 'tmuf'], online: 'offline' },
  TMUnlimiter: { cat: 'editor', games: ['tmnf', 'tmuf'], online: 'yes' },
  Twinkie: { cat: 'tools', games: ['tmnf', 'tmuf'], online: null },
};

// ------------------------------------------------------------------ helpers
const slug = (s) => s.toLowerCase().replace(/%/g, ' percent').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
// A broken description.yaml in the local TMLoader folder (e.g. an unquoted Windows path) must not
// stop the build: warn and skip that file.
const readYaml = (f) => {
  try { return YAML.parse(fs.readFileSync(f, 'utf8')) ?? {}; } catch (e) { console.warn(`skipped ${f}: ${String(e.message).split(/\r?\n/)[0]}`); return {}; }
};
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const semverKey = (v) => { const [core, pre = ''] = String(v).replace(/^v/, '').split('-'); return [...core.split('.').map((n) => parseInt(n, 10) || 0), pre ? 0 : 1]; };
const cmp = (a, b) => { const x = semverKey(a), y = semverKey(b); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
const isPre = (v) => /-(rc|test|dev|preview|alpha|beta)/i.test(v);
const ghRepo = (u) => { const m = String(u || '').match(/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?]|$)/i); return m ? `${m[1]}/${m[2]}` : null; };
const pagesRepo = (u) => { const m = String(u || '').match(/^https?:\/\/([\w-]+)\.github\.io\/([\w.-]+)/i); return m ? `${m[1]}/${m[2]}` : null; };

async function download(url, file, timeout = 10000) {
  if (fs.existsSync(file)) return true;
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'TM-Horizon-build (+https://tm-horizon.com)' }, signal: AbortSignal.timeout(timeout) });
    if (!r.ok || !/^(image\/|application\/octet-stream)/i.test(r.headers.get('content-type') ?? 'image/')) return false;
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    return true;
  } catch { return false; }
}

// ------------------------------------------------------------------ GitHub (stars, release downloads), cached
const ghCacheFile = path.join(cacheDir, 'github.json');
const ghCache = fs.existsSync(ghCacheFile) ? readJson(ghCacheFile) : {};
let ghToken = process.env.GITHUB_TOKEN || '';
if (!ghToken) try { ghToken = execSync('gh auth token', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}
const ghHeaders = { Accept: 'application/vnd.github+json', 'User-Agent': 'TM-Horizon-site (+https://tm-horizon.com)', ...(ghToken ? { Authorization: `Bearer ${ghToken}` } : {}) };
const MAX_AGE = 6 * 3600_000;
async function github(repo) {
  const c = ghCache[repo];
  if (c && now - Date.parse(c.fetched) < MAX_AGE && !process.env.REFRESH) return c;
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}`, { headers: ghHeaders, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`${r.status}`);
    const j = await r.json();
    const rr = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100`, { headers: ghHeaders, signal: AbortSignal.timeout(10000) });
    const rel = rr.ok ? await rr.json() : [];
    const pub = rel.filter((x) => !x.draft);
    const latest = pub.find((x) => !x.prerelease) || pub[0] || null;
    const out = {
      id: j.full_name, name: j.name, description: j.description, url: j.html_url, homepage: j.homepage || null,
      stars: j.stargazers_count, forks: j.forks_count, openIssues: j.open_issues_count, language: j.language,
      license: j.license?.spdx_id && j.license.spdx_id !== 'NOASSERTION' ? j.license.spdx_id : null, topics: j.topics || [],
      archived: j.archived, pushed: j.pushed_at, owner: j.owner.login, avatar: j.owner.avatar_url,
      downloads: pub.reduce((s, x) => s + x.assets.reduce((t, a) => t + a.download_count, 0), 0),
      releases: pub.slice(0, 30).map((x) => ({ tag: x.tag_name, name: x.name, published: x.published_at, prerelease: x.prerelease, url: x.html_url,
        downloads: x.assets.reduce((t, a) => t + a.download_count, 0), assets: x.assets.map((a) => ({ name: a.name, size: a.size, download: a.browser_download_url, downloads: a.download_count })) })),
      release: latest ? { tag: latest.tag_name, published: latest.published_at, url: latest.html_url } : null,
      fetched: now.toISOString(),
    };
    ghCache[repo] = out;
    return out;
  } catch (e) {
    if (c) return c;
    console.log('github failed', repo, e.message);
    return null;
  }
}

// README of a repository (Markdown), cached for a day; written to src/data/readmes/ for the mod pages. Fails softly.
const readmeDir = path.join(outDir, 'readmes');
fs.mkdirSync(readmeDir, { recursive: true });
const rmCacheFile = path.join(cacheDir, 'readmes.json');
const rmCache = fs.existsSync(rmCacheFile) ? readJson(rmCacheFile) : {};
const README_AGE = 24 * 3600_000;
async function readme(repo) {
  const file = path.join(readmeDir, repo.replace('/', '__') + '.md');
  const c = rmCache[repo];
  if (c && now - Date.parse(c.fetched) < README_AGE && !process.env.REFRESH) { if (c.text) fs.writeFileSync(file, c.text); return !!c.text; }
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/readme`, { headers: { ...ghHeaders, Accept: 'application/vnd.github.raw+json' }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`${r.status}`);
    const text = (await r.text()).slice(0, 80000);
    rmCache[repo] = { fetched: now.toISOString(), text };
    fs.writeFileSync(file, text);
    return true;
  } catch (e) {
    if (c?.text) { fs.writeFileSync(file, c.text); return true; }
    rmCache[repo] = { fetched: now.toISOString(), text: null };
    console.log('readme failed', repo, e.message);
    return false;
  }
}

async function avatar(gh) {
  if (!gh?.owner) return null;
  const file = path.join(avatarDir, gh.owner.toLowerCase() + '.png');
  return (await download(`https://avatars.githubusercontent.com/${gh.owner}?s=128`, file, 20000)) ? `/img/avatars/${gh.owner.toLowerCase()}.png` : null;
}

// ------------------------------------------------------------------ catalog
let catalog, catalogSource;
try {
  catalog = readJson(realCatalog);
  if (!Array.isArray(catalog.entries) || !catalog.entries.length) throw new Error('empty');
  catalogSource = 'catalog';
} catch {
  catalog = readJson(path.join(root, 'src', 'data', 'catalog.sample.json'));
  catalogSource = 'sample';
}

// ------------------------------------------------------------------ mods
// Local TMLoader index first (dates = when a version reached this machine), then tm-hub-api on top
// (download URLs and SHA-256 from the mod servers). Mods only in the local index (their servers are not in
// tm-hub-api's config) are kept.
const sources = {};
const local = [];
if (fs.existsSync(products)) {
  for (const name of fs.readdirSync(products)) {
    const dir = path.join(products, name);
    const descFile = path.join(dir, 'description.yaml');
    if (!fs.statSync(dir).isDirectory() || !fs.existsSync(descFile)) continue;
    const d = readYaml(descFile);
    if (d.type === 'program') continue; // the patched game itself, not a mod
    const id = slug(name);
    const versions = [];
    for (const v of fs.readdirSync(dir)) {
      const vd = path.join(dir, v, 'description.yaml');
      if (!fs.existsSync(vd)) continue;
      const vy = readYaml(vd);
      versions.push({
        version: v, date: fs.statSync(path.join(dir, v)).mtime.toISOString(), dateSource: 'index',
        executable: vy.executable || null,
        dependencies: (vy.dependencies || []).map((x) => ({ id: slug(x.id), name: x.id, version: x.version || '*' })),
        changelog: (vy.changelog || '').trim(), fileUrl: null, sha256: null, size: null,
      });
    }
    versions.sort((a, b) => cmp(b.version, a.version));
    if (!versions.length) continue;
    const meta = modMeta[name] || { cat: 'tools', games: ['tmnf', 'tmuf'], online: null };
    const stable = versions.find((v) => !isPre(v.version)) || versions[0];
    let icon = null;
    if (meta.icon && fs.existsSync(path.join(dir, meta.icon))) { fs.copyFileSync(path.join(dir, meta.icon), path.join(iconDir, id + '.png')); icon = `/img/icons/${id}.png`; }
    else if (d.icon_link) { const ext = (new URL(d.icon_link).pathname.match(/\.(png|jpe?g|webp|gif)$/i) || [, 'png'])[1].toLowerCase(); if (await download(d.icon_link, path.join(iconDir, `${id}.${ext}`))) icon = `/img/icons/${id}.${ext}`; }
    local.push({
      id, key: name, name: name === 'TMFOXR' ? 'TMFOXR' : d.name || name, fullName: d.name || name, author: d.author || 'unknown', category: meta.cat, games: meta.games,
      system: 'TMLoader', summary: String(d.description || '').trim().replace(/\s+/g, ' '), homepage: d.homepage || null, icon, online: meta.online ?? null,
      shots: meta.shots || [], latest: stable.version, versions, iconLink: d.icon_link || null, from: 'tmloader-index',
    });
  }
  // Without tm-hub-api, public file URLs are only known for TMVS releases listed on its gh-pages branch.
  for (const m of local) if (m.id === 'tm-vibrant-shaders') for (const v of m.versions) v.fileUrl = ['1.4.0-rc.2', '1.4.1', '1.4.2'].includes(v.version) ? `${REPO_FILES}/${v.version}/TMVS-modloader.zip` : null;
}

const mods = [];
if (fs.existsSync(path.join(apiDist, 'mods.json'))) {
  const mf = readJson(path.join(apiDist, 'mods.json'));
  for (const m of mf.mods) {
    if (m.type === 'program') continue;
    const meta = modMeta[m.id] || {};
    const loc = local.find((x) => x.key === m.id);
    let icon = loc?.icon || null;
    if (!icon && m.icon) { const ext = (m.icon.match(/\.(png|jpe?g|webp|gif)(\?|$)/i) || [, 'png'])[1].toLowerCase(); if (await download(m.icon, path.join(iconDir, `${m.slug}.${ext}`))) icon = `/img/icons/${m.slug}.${ext}`; }
    const versions = m.versions.map((v) => {
      const lv = loc?.versions.find((x) => x.version === v.version);
      return { version: v.version, date: lv?.date || null, dateSource: lv ? 'index' : null, executable: v.executable,
        dependencies: v.dependencies.map((d) => ({ id: slug(d.id), name: d.id, version: d.version || '*' })),
        changelog: (v.changelog || lv?.changelog || '').trim(), fileUrl: v.download, sha256: v.sha256 || v.sha256Index || null, sha256Checked: !!v.sha256, hashMismatch: !!v.hashMismatch, size: v.size };
    });
    mods.push({
      id: m.slug, key: m.id, name: m.name, fullName: m.name, author: m.author || 'unknown', category: meta.cat || m.category,
      games: meta.games || (m.games?.length ? m.games : ['tmnf', 'tmuf']), system: 'TMLoader',
      summary: (m.description || loc?.summary || '').trim().replace(/\s+/g, ' '), homepage: m.homepage, icon, online: meta.online ?? null,
      shots: meta.shots || [], latest: m.latest, versions, repositories: m.repositories, iconLink: m.icon, from: 'tm-hub-api',
    });
  }
  const only = local.filter((x) => !mods.some((m) => m.key === x.key));
  mods.push(...only);
  sources.mods = { from: 'tm-hub-api', sample: mf.sources.some((s) => s.sample), generated: mf.generated, localOnly: only.map((x) => x.name) };
} else {
  mods.push(...local);
  sources.mods = { from: local.length ? 'tmloader-index' : 'none', sample: !local.length, generated: now.toISOString() };
}

// TM Horizon's own in-game mod: shown as "Horizon Client" with the Saturn module logo (public/img/modules/horizon-client.png).
for (const m of mods) if (m.key === 'Horizon Host') {
  m.name = m.fullName = 'Horizon Client';
  m.icon = '/img/modules/horizon-client.png';
  m.summary = m.summary.replace(/^In-game mod host of TM Horizon/i, 'In-game client of TM Horizon');
}

// GitHub stats for mods that live in a GitHub repository (homepage, GitHub Pages icon host, raw icon, catalog entry)
const catByName = new Map(catalog.entries.map((e) => [e.name.toLowerCase(), e]));
const modRepoOverride = { tmfoxr: 'jiink/TrackManiaForeverOpenXR' };
// Catalog picture overrides: repo null = the homepage is another project's repository (TM Clips -> TMVS).
const pictureOv = new Map((catalog.pictures ?? []).map((p) => [String(p.mod).toLowerCase(), p]));
for (const m of mods) {
  const rawIcon = m.iconLink?.replace('raw.githubusercontent.com', 'github.com');
  const ov = pictureOv.get(m.name.toLowerCase()) ?? pictureOv.get(m.id.toLowerCase());
  const repo = ov && 'repo' in ov ? ov.repo ?? null : modRepoOverride[m.id] || ghRepo(m.homepage) || pagesRepo(m.homepage) || pagesRepo(m.iconLink) || ghRepo(rawIcon) || ghRepo(catByName.get(m.name.toLowerCase())?.url);
  delete m.iconLink;
  if (!repo) continue;
  const gh = await github(repo);
  if (!gh) continue;
  m.repo = { id: gh.id, url: gh.url, stars: gh.stars, forks: gh.forks, downloads: gh.releases.length ? gh.downloads : null, license: gh.license, language: gh.language, openIssues: gh.openIssues };
  for (const v of m.versions) {
    const rel = gh.releases.find((r) => r.tag.replace(/^v/i, '') === v.version);
    if (rel) { v.date = rel.published; v.dateSource = 'github'; v.downloads = rel.downloads; v.releaseUrl = rel.url; }
  }
}
for (const m of mods) {
  m.updated = m.versions.map((v) => v.date).filter(Boolean).sort().pop() || null;
  m.downloads = m.repo?.downloads ?? null;
  m.stars = m.repo?.stars ?? null;
}
mods.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));

// READMEs for the mod pages: repositories of TMLoader mods and of catalog mod entries (modType set or listed extras)
{
  const repos = new Set(mods.map((m) => m.repo?.id).filter(Boolean));
  for (const e of catalog.entries) {
    if (!(e.modType || ['openplanet', 'bingoforever', 'foreverrpc'].includes(e.id))) continue;
    for (const u of [e.url, ...(e.urls || [])]) { const r = ghRepo(u); if (r) repos.add(r); }
  }
  let ok = 0;
  for (const r of repos) if (await readme(r)) ok++;
  fs.writeFileSync(rmCacheFile, JSON.stringify(rmCache));
  console.log(`readmes ${ok}/${repos.size}`);
}

// ------------------------------------------------------------------ projects (GitHub repositories in the catalog)
const projects = [];
if (fs.existsSync(path.join(apiDist, 'projects.json'))) {
  const pf = readJson(path.join(apiDist, 'projects.json'));
  sources.projects = { from: 'tm-hub-api', sample: pf.sources.some((s) => s.sample), generated: pf.generated };
  for (const p of pf.projects) {
    const owner = p.id.split('/')[0];
    const cat = catalog.entries.find((e) => p.catalogIds.includes(e.id));
    projects.push({ id: slug(p.id), repo: p.id, name: cat?.name || p.name, description: cat?.description || p.description, url: p.url, homepage: p.homepage, stars: p.stars, forks: p.forks,
      downloads: p.release ? p.release.assets.reduce((s, a) => s + a.downloads, 0) : null, downloadsScope: 'latest release',
      language: p.language, license: p.license, archived: p.archived, pushed: p.pushed, release: p.release ? { tag: p.release.tag, published: p.release.published, url: p.release.url } : null,
      games: p.games, icon: await avatar({ avatar: `https://github.com/${owner}.png`, owner }), catalogIds: p.catalogIds, category: cat?.category || 'tool', status: cat?.status || 'alive' });
  }
} else {
  sources.projects = { from: 'github-api', sample: false, generated: now.toISOString() };
  const seen = new Set();
  for (const e of catalog.entries) {
    const repo = ghRepo(e.url) || (e.category !== 'leaderboard' ? ghRepo(e.api) : null);
    if (!repo || seen.has(repo.toLowerCase())) continue;
    seen.add(repo.toLowerCase());
    const gh = await github(repo);
    if (!gh) continue;
    projects.push({ id: slug(gh.id), repo: gh.id, name: e.name || gh.name, description: e.description || gh.description, url: gh.url, homepage: gh.homepage, stars: gh.stars, forks: gh.forks,
      downloads: gh.releases.length ? gh.downloads : null, downloadsScope: 'all releases', language: gh.language, license: gh.license, archived: gh.archived, pushed: gh.pushed,
      release: gh.release, games: e.games, icon: await avatar(gh), catalogIds: [e.id], category: e.category, status: e.status });
  }
}
fs.writeFileSync(ghCacheFile, JSON.stringify(ghCache, null, 1));

// ------------------------------------------------------------------ events, servers, maps: tm-hub-api if present, else sample
// Without a fresh packages/api build, the copy the launcher bundles (apps/launcher/src/generated/hub, refreshed by
// `npm run hub-api -w @tm-hub/launcher`) is the fallback, so the Servers, Events and Communities tabs are never empty.
const bundledHub = path.join(repoRoot, 'apps', 'launcher', 'src', 'generated', 'hub');
const hubFrom = {};
const optional = (f) => {
  for (const [dir, from] of [[apiDist, 'tm-hub-api'], [bundledHub, 'launcher-bundle']]) {
    if (fs.existsSync(path.join(dir, f))) { hubFrom[f] = from; return readJson(path.join(dir, f)); }
  }
  return null;
};
const ev = optional('events.json'), sv = optional('servers.json');
const events = ev ? ev.events.map((e) => ({ id: e.id, title: e.name, kind: 'Event', game: e.games[0] || 'tmnf', host: e.community?.name || '', start: e.start,
  minutes: e.end ? Math.round((Date.parse(e.end) - Date.parse(e.start)) / 60000) : 120, join: e.join?.raw || null, source: e.source ?? (e.id.startsWith('discord') ? 'discord' : e.id.startsWith('submitted') ? 'submitted' : 'sample'), address: e.address ?? null,
  community: e.community ? { name: e.community.name, invite: e.community.invite ?? null } : null,
  note: e.description || '', sample: e.sample, image: e.image, url: e.url, interested: e.interested })) : null;
sources.events = ev ? { from: hubFrom['events.json'], sample: ev.events.some((e) => e.sample), generated: ev.generated } : { from: 'sample', sample: true };
let servers = sv ? sv.servers.map((s) => ({ id: s.id, name: s.name, game: s.game, mode: s.mode || '', players: s.players, max: s.maxPlayers, map: s.zone || '', login: s.login, join: s.join, sample: s.sample, zone: s.zone, nameRaw: s.nameRaw ?? null,
  // community servers (data/servers/): source, game port address, reachability, language and the owner's links
  source: s.source ?? null, address: s.address ?? null, online: s.online ?? null, lastSeen: s.lastSeen ?? null, language: s.language ?? null, contact: s.contact ?? null, homepage: s.homepage ?? null })) : null;
// Registered community servers (packages/api/data/servers/*.yaml, the same files the api build reads) that the
// copy above does not carry yet: listed with their address, reachability unknown until the next api build.
const registryDir = path.join(repoRoot, 'packages', 'api', 'data', 'servers');
const registered = [];
if (fs.existsSync(registryDir)) {
  for (const f of fs.readdirSync(registryDir).filter((x) => x.endsWith('.yaml')).sort()) {
    const e = readYaml(path.join(registryDir, f));
    if (!e?.id || !e.game || !e.name || !e.address) { console.warn(`servers: ${f} skipped (id, game, name and address needed)`); continue; }
    registered.push({ id: `community:${e.id}`, name: e.name, game: e.game, mode: e.mode || '', players: 0, max: 0, map: '', login: e.login ?? null, join: null, sample: false, zone: null, nameRaw: null,
      source: 'community', address: e.address, online: null, lastSeen: null, language: e.language ?? null, contact: e.contact ?? null, homepage: e.homepage ?? null });
  }
}
for (const r of registered) if (!servers?.some((s) => s.id === r.id)) (servers ?? (servers = [])).push(r);
sources.servers = sv ? { from: hubFrom['servers.json'], sample: sv.servers.some((s) => s.sample), generated: sv.generated, registered: registered.length }
  : registered.length ? { from: 'registry', sample: false, generated: now.toISOString(), registered: registered.length } : { from: 'sample', sample: true };
// Discord server directory (mx_eyebo's list, looked up by the api build): the Communities tab. Without the file the tab falls back to the catalog.
const cm = optional('communities.json');
let communities = cm ? cm.communities.map((c) => ({ id: c.id, name: c.name, url: c.url, invite: c.invite, group: c.group, section: c.section, region: c.region, active: c.active,
  alive: c.alive, members: c.members, online: c.online, guildName: c.guildName, checked: c.checked, iconUrl: c.icon ?? null, icon: null })) : null;
sources.communities = cm ? { from: hubFrom['communities.json'], sample: false, generated: cm.generated, credit: cm.credit, suggest: cm.suggest } : { from: 'catalog', sample: false };
// No map lists on the site: the Maps tab links out to the exchange for each game.

// ------------------------------------------------------------------ Openplanet plugins (Trackmania 2020 and ManiaPlanet)
// The public plugin list of openplanet.dev (the API the launcher uses, apps/launcher/src-tauri/src/openplanet.rs):
// all pages once, polite user agent and a short gap per page, cached a day in .cache/openplanet.json (the cache
// is used when offline). Thumbnails of the 200 most downloaded plugins are saved once into public/img/icons/op/;
// the others show the generated icon.
const UA = 'TM-Horizon-build (+https://tm-horizon.com)';
const opCacheFile = path.join(cacheDir, 'openplanet.json');
async function openplanetPlugins() {
  const cached = fs.existsSync(opCacheFile) ? readJson(opCacheFile) : null;
  if (cached && Date.now() - Date.parse(cached.fetched) < 24 * 3600_000) return cached.items;
  const items = [];
  try {
    for (let page = 1, pages = 1; page <= pages && page <= 200; page++) {
      const r = await fetch(`https://openplanet.dev/api/plugins?page=${page}`, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      pages = Math.max(1, Number(j.pages) || 1);
      items.push(...(j.items ?? []));
      await new Promise((res) => setTimeout(res, 400));
    }
  } catch (e) {
    console.warn(`openplanet: ${e.message}; ${cached ? 'using the cached list' : 'no plugins listed'}`);
    return cached?.items ?? [];
  }
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(opCacheFile, JSON.stringify({ fetched: now.toISOString(), items }));
  return items;
}
const OP_GAMES = { trackmania: ['tm2020'], maniaplanet: ['tm2-stadium', 'tm2-canyon', 'tm2-valley', 'tm2-lagoon'], turbo: ['turbo'] };
const opRaw = await openplanetPlugins();
const opPlugins = opRaw.filter((x) => !x.broken && !x.deprecated && x.id && x.name).map((x) => ({
  id: x.id, identifier: x.identifier, name: String(x.name).trim(), authors: (x.authors ?? []).map((a) => a.displayname).filter(Boolean),
  summary: x.shortdescription ?? '', games: [...new Set((x.games ?? []).flatMap((g) => OP_GAMES[String(g).toLowerCase().replace(/[^a-z]/g, '').replace(/\d+$/, '')] ?? OP_GAMES[String(g).toLowerCase().startsWith('maniaplanet') ? 'maniaplanet' : ''] ?? []))],
  downloads: Number(x.downloads) || 0, version: x.version ?? null, updated: x.updatetime ? new Date(x.updatetime * 1000).toISOString() : null,
  signed: !!x.signed, page: `https://openplanet.dev/${String(x.url ?? '').replace(/^\//, '')}`,
  image: x.image ? `https://openplanet.dev/${String(x.image).replace(/^\//, '')}` : null, icon: null,
})).filter((p) => p.games.length);
{
  const opIconDir = path.join(iconDir, 'op');
  fs.mkdirSync(opIconDir, { recursive: true });
  const top = [...opPlugins].sort((a, b) => b.downloads - a.downloads).slice(0, 200).filter((p) => p.image && /^https:\/\/openplanet\.dev\//.test(p.image));
  let i = 0;
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (i < top.length) {
      const p = top[i++];
      const ext = (/\.(png|jpe?g|webp|gif)(\?|$)/i.exec(p.image)?.[1] ?? 'jpg').toLowerCase().replace('jpeg', 'jpg');
      const file = path.join(opIconDir, `${p.id}.${ext}`);
      if (fs.existsSync(file) || (await download(p.image, file, 15000))) p.icon = `/img/icons/op/${p.id}.${ext}`;
    }
  }));
}
sources.openplanet = { from: opRaw.length ? 'openplanet.dev' : 'none', sample: false, count: opPlugins.length };

// ------------------------------------------------------------------ logos of directory entries (scripts/fetch-entry-art.mjs -> src/data/entry-art.json)
// Downloaded once into public/img/icons/entry/ and shown from there; Discord server icons of the community directory too.
{
  const artFile = path.join(outDir, 'entry-art.json');
  const art = fs.existsSync(artFile) ? readJson(artFile) : {};
  const dir = path.join(iconDir, 'entry');
  fs.mkdirSync(dir, { recursive: true });
  const extOf = (u) => (/\.(png|jpe?g|webp|gif|ico)(\?|$)/i.exec(u)?.[1] ?? 'png').toLowerCase().replace('jpeg', 'jpg');
  for (const e of catalog.entries) {
    const a = art[e.id];
    if (!a?.url) continue;
    const name = `${slug(e.id)}.${a.ext ?? extOf(a.url)}`;
    if (await download(a.url, path.join(dir, name), 15000)) e[a.kind === 'preview' ? 'preview' : 'logo'] = `/img/icons/entry/${name}`;
  }
  if (communities) {
    const ddir = path.join(iconDir, 'discord');
    fs.mkdirSync(ddir, { recursive: true });
    const todo = communities.filter((c) => c.iconUrl && /^https:\/\/cdn\.discordapp\.com\/icons\/\d+\/(a_)?[0-9a-f]{32}\.png/.test(c.iconUrl));
    let i = 0;
    await Promise.all(Array.from({ length: 3 }, async () => {
      while (i < todo.length) {
        const c = todo[i++];
        const [, gid, hash] = /icons\/(\d+)\/((?:a_)?[0-9a-f]{32})/.exec(c.iconUrl);
        const name = `${gid}-${hash}.png`;
        if (await download(c.iconUrl, path.join(ddir, name), 15000)) c.icon = `/img/icons/discord/${name}`;
      }
    }));
    for (const c of communities) delete c.iconUrl;
  }
}

const site = {
  generated: now.toISOString(),
  sources: { ...sources, catalog: { from: catalogSource, sample: catalogSource === 'sample', updated: catalog.updated ?? null } },
  mods, projects, catalog: catalog.entries, showcases: catalog.showcases ?? [], events, servers, communities, opPlugins,
};
fs.writeFileSync(path.join(outDir, 'site.json'), JSON.stringify(site, null, 1));
console.log(`openplanet ${opPlugins.length}, mods ${mods.length} (${sources.mods.from}), projects ${projects.length} (${sources.projects.from}), catalog ${catalog.entries.length} (${catalogSource}), events ${events ? events.length : 'sample'}, servers ${servers ? servers.length : 'sample'}, communities ${communities ? communities.length : 'catalog'}`);
