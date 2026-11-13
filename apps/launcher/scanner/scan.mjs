// Read-only scan of this machine: installed TrackMania titles, Steam/Ubisoft/Epic
// libraries, ManiaPlanet title packs, TMLoader profiles and installed mods,
// Openplanet, recent replays/maps. Writes src/generated/snapshot.json.
//
// Hard rules:
// - Never open, list, hash or start anything inside the StarForce-protected
//   "C:\Program Files (x86)\TrackMania Nations ESWC". Only existsSync on the folder.
// - Never touch dinput8.dll in the unofficial ESWC folder (we only check the exe exists).
// - Nothing is written outside this project.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const here = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.join(here, '..', 'src', 'generated', 'snapshot.json');

const HOME = os.homedir();
const LOCAL = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const PF86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const PF = process.env.ProgramFiles || 'C:\\Program Files';
const DOCS = path.join(HOME, 'Documents');

const ESWC_ORIGINAL = path.join(PF86, 'TrackMania Nations ESWC'); // existence check only

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const readText = (p) => { guard(p); try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const readYaml = (p) => { const t = readText(p); if (t == null) return null; try { return YAML.parse(t); } catch { return null; } };
const listDir = (p) => { guard(p); try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; } };
const mtime = (p) => { try { return fs.statSync(p).mtime.toISOString(); } catch { return null; } };

function guard(p) { // hoisted; used by readText/listDir
  if (path.resolve(p).toLowerCase().startsWith(path.resolve(ESWC_ORIGINAL).toLowerCase())) {
    throw new Error('refusing to touch the protected ESWC folder: ' + p);
  }
  return p;
}

// ---------- Steam ----------
function parseVdf(text) {
  // Minimal KeyValues parser, enough for libraryfolders.vdf and appmanifest_*.acf.
  const tokens = [];
  const re = /"((?:[^"\\]|\\.)*)"|([{}])/g;
  let m;
  while ((m = re.exec(text))) tokens.push(m[2] ?? m[1].replace(/\\\\/g, '\\'));
  let i = 0;
  const obj = () => {
    const o = {};
    while (i < tokens.length) {
      const k = tokens[i++];
      if (k === '}') return o;
      const v = tokens[i++];
      o[k] = v === '{' ? obj() : v;
    }
    return o;
  };
  return obj();
}

function steamLibraries() {
  const roots = [path.join(PF86, 'Steam'), path.join(PF, 'Steam')];
  const libs = new Set();
  for (const r of roots) {
    const vdf = readText(path.join(r, 'steamapps', 'libraryfolders.vdf'));
    if (!vdf) continue;
    libs.add(r);
    const data = parseVdf(vdf).libraryfolders || {};
    for (const v of Object.values(data)) if (v && v.path) libs.add(v.path);
  }
  const out = [];
  for (const lib of libs) {
    const apps = {};
    for (const e of listDir(path.join(lib, 'steamapps'))) {
      if (!/^appmanifest_\d+\.acf$/.test(e.name)) continue;
      const acf = parseVdf(readText(path.join(lib, 'steamapps', e.name)) || '').AppState;
      if (acf) apps[acf.appid] = { name: acf.name, installdir: path.join(lib, 'steamapps', 'common', acf.installdir) };
    }
    out.push({ path: lib, exists: exists(path.join(lib, 'steamapps')), apps });
  }
  return out;
}

// ---------- Epic ----------
function epicGames() {
  const dir = 'C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests';
  const out = [];
  for (const e of listDir(dir)) {
    if (!e.name.endsWith('.item')) continue;
    try {
      const j = JSON.parse(readText(path.join(dir, e.name)));
      out.push({ name: j.DisplayName, app: j.AppName, path: j.InstallLocation });
    } catch { /* ignore */ }
  }
  return out;
}

// ---------- Ubisoft Connect ----------
const UBI_GAMES = path.join(PF86, 'Ubisoft', 'Ubisoft Game Launcher', 'games');

// ---------- detection ----------
const STEAM_IDS = { tmnf: '11020', tmuf: '7200', maniaplanet: '228760', tm2020: '2225070' };
const steam = steamLibraries();
const epic = epicGames();
const steamApp = (id) => {
  for (const l of steam) if (l.apps[id]) return { library: l.path, ...l.apps[id] };
  return null;
};

function forever(id, folder, exe, launcherExe) {
  const candidates = [];
  const pf = path.join(PF86, folder);
  if (exists(path.join(pf, exe))) candidates.push({ source: 'Installer', path: pf });
  const s = steamApp(STEAM_IDS[id]);
  if (s && exists(path.join(s.installdir, exe))) candidates.push({ source: 'Steam', path: s.installdir });
  return candidates.map((c) => ({
    ...c,
    exe: path.join(c.path, exe),
    launcher: exists(path.join(c.path, launcherExe)) ? path.join(c.path, launcherExe) : null,
    modified: mtime(path.join(c.path, exe)),
  }));
}

const games = {};

games.tmnf = { installs: forever('tmnf', 'TmNationsForever', 'TmForever.exe', 'TmForeverLauncher.exe') };
games.tmuf = { installs: forever('tmuf', 'TmUnitedForever', 'TmForever.exe', 'TmForeverLauncher.exe') };

// ESWC: the unofficial 1.80 patch folder; only check that the exe exists.
{
  const dir = path.join(HOME, 'Games', 'TMN-ESWC-inoffiziell');
  const exe = path.join(dir, 'TmNationsESWC.exe');
  games['tmn-eswc'] = {
    installs: exists(exe) ? [{ source: 'Unofficial 1.80 patch', path: dir, exe, modified: mtime(exe) }] : [],
    // Original StarForce version: folder existence only, never looked into.
    unsupported: exists(ESWC_ORIGINAL) ? [{ source: 'Original (StarForce)', path: ESWC_ORIGINAL, note: 'Unsupported version' }] : [],
  };
}

// ManiaPlanet + title packs
{
  const installs = [];
  const pf = path.join(PF86, 'ManiaPlanet');
  if (exists(path.join(pf, 'ManiaPlanet.exe'))) installs.push({ source: 'Installer', path: pf, exe: path.join(pf, 'ManiaPlanet.exe') });
  const s = steamApp(STEAM_IDS.maniaplanet);
  if (s && exists(path.join(s.installdir, 'ManiaPlanet.exe'))) installs.push({ source: 'Steam', path: s.installdir, exe: path.join(s.installdir, 'ManiaPlanet.exe') });
  const ubi = path.join(UBI_GAMES, 'Mania Planet');
  if (exists(path.join(ubi, 'ManiaPlanet.exe'))) installs.push({ source: 'Ubisoft Connect', path: ubi, exe: path.join(ubi, 'ManiaPlanet.exe') });
  const packDirs = [path.join(DOCS, 'ManiaPlanet', 'Packs'), ...installs.map((i) => path.join(i.path, 'Packs')), 'C:\\ProgramData\\ManiaPlanet\\Packs'];
  const titlePacks = new Set();
  for (const d of packDirs) for (const e of listDir(d)) {
    const m = /^(.+@[^.]+)\.Title\.Pack\.gbx$/i.exec(e.name);
    if (m) titlePacks.add(m[1]);
  }
  games.maniaplanet = {
    installs,
    titlePacks: [...titlePacks],
    ubisoftStub: exists(path.join(ubi, 'Maniaplanet_UplaySetup.exe')) && !exists(path.join(ubi, 'ManiaPlanet.exe')),
  };
}

// Trackmania (2020)
{
  const installs = [];
  const s = steamApp(STEAM_IDS.tm2020);
  if (s && exists(path.join(s.installdir, 'Trackmania.exe'))) installs.push({ source: 'Steam', path: s.installdir, exe: path.join(s.installdir, 'Trackmania.exe'), launch: 'steam://rungameid/2225070' });
  const ubi = path.join(UBI_GAMES, 'Trackmania');
  if (exists(path.join(ubi, 'Trackmania.exe'))) installs.push({ source: 'Ubisoft Connect', path: ubi, exe: path.join(ubi, 'Trackmania.exe'), launch: 'uplay://launch/5595/0' });
  for (const e of epic) if (/^trackmania$/i.test(e.name || '') && exists(path.join(e.path, 'Trackmania.exe'))) installs.push({ source: 'Epic Games', path: e.path, exe: path.join(e.path, 'Trackmania.exe') });
  games.tm2020 = { installs };
}

// Trackmania Turbo
{
  const installs = [];
  const s = steamApp('375900');
  if (s && exists(s.installdir)) installs.push({ source: 'Steam', path: s.installdir, launch: 'steam://rungameid/375900' });
  for (const name of ['Trackmania Turbo', 'TrackMania Turbo']) {
    const ubi = path.join(UBI_GAMES, name);
    if (exists(path.join(ubi, 'TrackmaniaTurbo.exe'))) installs.push({ source: 'Ubisoft Connect', path: ubi, exe: path.join(ubi, 'TrackmaniaTurbo.exe') });
  }
  games['tm-turbo'] = { installs };
}

// TrackMania Original / Sunrise (old retail installs; folder + exe check only)
for (const [id, folders, exe] of [
  ['tm-original', ['TrackMania', 'TmOriginal', 'TrackMania Original'], 'TrackMania.exe'],
  ['tm-sunrise', ['TmSunrise', 'TrackMania Sunrise', 'TrackMania Sunrise Extreme', 'TmSunriseExtreme'], 'TmSunrise.exe'],
]) {
  const installs = [];
  for (const f of folders) {
    const dir = path.join(PF86, f);
    if (exists(path.join(dir, exe))) installs.push({ source: 'Installer', path: dir, exe: path.join(dir, exe) });
  }
  games[id] = { installs };
}

// ---------- TMLoader (read only) ----------
function tmloader() {
  const root = path.join(LOCAL, 'TMLoader');
  const cfg = readYaml(path.join(root, 'config.yaml'));
  if (!cfg) return { installed: false };
  const db = path.resolve(root, cfg.database || './database');
  const gameDir = path.join(db, 'TmForever');
  const products = {};
  for (const e of listDir(path.join(gameDir, 'products'))) {
    if (!e.isDirectory()) continue;
    const pdir = path.join(gameDir, 'products', e.name);
    const desc = readYaml(path.join(pdir, 'description.yaml')) || {};
    const settings = readYaml(path.join(pdir, 'settings.yaml'));
    const versions = [];
    for (const v of listDir(pdir)) {
      if (!v.isDirectory()) continue;
      const vdir = path.join(pdir, v.name);
      const vdesc = readYaml(path.join(vdir, 'description.yaml'));
      if (!vdesc) continue;
      const files = listDir(vdir).filter((f) => f.isFile() && f.name !== 'description.yaml').map((f) => f.name);
      versions.push({
        version: v.name,
        installed: files.length > 0,
        executable: vdesc.executable ?? null,
        dependencies: (vdesc.dependencies || []).map((d) => ({ id: d.id, version: d.version ?? null })),
        changelog: vdesc.changelog ?? null,
      });
    }
    products[e.name] = {
      id: e.name,
      name: desc.name ?? e.name,
      author: desc.author ?? null,
      type: desc.type ?? null,
      homepage: desc.homepage ?? null,
      description: desc.description ?? null,
      icon_link: desc.icon_link ?? null,
      external: !!desc.external,
      install: settings?.install ?? null,
      versions,
    };
  }
  const profiles = [];
  for (const e of listDir(path.join(gameDir, 'profiles'))) {
    if (!e.isFile() || !e.name.endsWith('.yaml')) continue;
    const p = readYaml(path.join(gameDir, 'profiles', e.name)) || {};
    profiles.push({
      name: e.name.replace(/\.yaml$/, ''),
      program: p.program || null,
      args: p.args ?? null,
      mods: (p.mods || []).map((m) => ({ id: m.id, version: m.version ?? null })),
      modified: mtime(path.join(gameDir, 'profiles', e.name)),
    });
  }
  return {
    installed: true,
    exe: path.join(root, 'TMLoader.exe'),
    version: cfg.version ?? null,
    servers: cfg.servers || [],
    masterserver: cfg.masterserver ?? null,
    defaultProfiles: cfg.default_profiles || {},
    products,
    profiles,
  };
}

// ---------- Openplanet ----------
function openplanet() {
  const out = {};
  for (const [key, dir] of [['tm2020', path.join(HOME, 'OpenplanetNext')], ['maniaplanet', path.join(HOME, 'Openplanet4')]]) {
    if (!exists(dir)) { out[key] = { installed: false }; continue; }
    const plugins = listDir(path.join(dir, 'Plugins')).map((e) => e.name.replace(/\.op$/, ''));
    out[key] = { installed: true, path: dir, plugins };
  }
  return out;
}

// ---------- recent files ----------
function recent(dirs, re, n = 6) {
  const all = [];
  for (const d of dirs) for (const e of listDir(d)) {
    if (!e.isFile() || !re.test(e.name)) continue;
    const full = path.join(d, e.name);
    all.push({ name: e.name, modified: mtime(full) });
  }
  return all.sort((a, b) => (b.modified || '').localeCompare(a.modified || '')).slice(0, n);
}
const tmDocs = path.join(DOCS, 'TrackMania');
const mpDocs = path.join(DOCS, 'ManiaPlanet');
const tm20Docs = path.join(DOCS, 'Trackmania2020');
const recentFiles = {
  forever: {
    replays: recent([path.join(tmDocs, 'Tracks', 'Replays'), path.join(tmDocs, 'Tracks', 'Replays', 'Autosaves')], /\.Replay\.Gbx$/i),
    maps: recent([path.join(tmDocs, 'Tracks', 'Challenges', 'My Challenges'), path.join(tmDocs, 'Tracks', 'Challenges', 'Downloaded')], /\.Challenge\.Gbx$/i),
  },
  maniaplanet: {
    replays: recent([path.join(mpDocs, 'Replays'), path.join(mpDocs, 'Replays', 'Autosaves')], /\.Replay\.Gbx$/i),
    maps: recent([path.join(mpDocs, 'Maps', 'My Maps'), path.join(mpDocs, 'Maps', 'Downloaded'), path.join(mpDocs, 'Maps')], /\.(Map|Challenge)\.Gbx$/i),
  },
  tm2020: {
    replays: recent([path.join(tm20Docs, 'Replays'), path.join(tm20Docs, 'Replays', 'Autosaves')], /\.Replay\.Gbx$/i),
    maps: recent([path.join(tm20Docs, 'Maps', 'My Maps'), path.join(tm20Docs, 'Maps', 'Downloaded')], /\.Map\.Gbx$/i),
  },
};

// Strip the user name from paths shown in the UI.
const scrub = (v) => JSON.parse(JSON.stringify(v).split(JSON.stringify(HOME).slice(1, -1)).join('%USERPROFILE%'));

const snapshot = scrub({
  scannedAt: new Date().toISOString(),
  machine: { platform: process.platform },
  games,
  steamLibraries: steam.map((l) => ({ path: l.path, exists: l.exists, appCount: Object.keys(l.apps).length })),
  epic: epic.map((e) => e.name),
  tmloader: tmloader(),
  openplanet: openplanet(),
  recent: recentFiles,
});

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(snapshot, null, 2));
const g = snapshot.games;
console.log('snapshot written:', outFile);
console.log('  TMNF', g.tmnf.installs.length, '| TMUF', g.tmuf.installs.length, '| ESWC', g['tmn-eswc'].installs.length,
  '| MP', g.maniaplanet.installs.length, 'packs', g.maniaplanet.titlePacks.join(','), '| TM2020', g.tm2020.installs.map((i) => i.source).join(','));
console.log('  TMLoader profiles:', snapshot.tmloader.profiles?.map((p) => p.name).join(', '));
