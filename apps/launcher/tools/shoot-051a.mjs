// Screenshots of the 0.5.1 part A pages with a fake native backend (no Tauri, no real data, nothing written):
// window.__TAURI_INTERNALS__ answers the Rust commands from the fixtures below. Needs `npx vite preview --port 4174`.
//   node tools/shoot-051a.mjs [outDir]
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(path.join(os.homedir(), 'tools', 'playwright', 'package.json'));
const { chromium } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || path.join(here, '..', '..', '..', 'screens', '051a');
fs.mkdirSync(out, { recursive: true });
const BASE = process.env.HUB_URL || 'http://localhost:4174/';
const snapshot = JSON.parse(fs.readFileSync(path.join(here, '..', 'src', 'generated', 'snapshot.json'), 'utf8'));

const now = Date.now();
const day = 86_400_000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const copies = [
  { id: 'c:\\users\\me\\documents\\trackmania', family: 'forever', label: 'Documents\\TrackMania', path: 'C:\\Users\\me\\Documents\\TrackMania' },
  { id: 'c:\\games\\tmn-eswc\\gamedata', family: 'tmn-eswc', label: 'TMN-ESWC', path: 'C:\\Games\\TMN-ESWC\\GameData' },
  { id: 'c:\\games\\tmn-eswc-horizon-next\\gamedata', family: 'tmn-eswc', label: 'TMN-ESWC-horizon-next', path: 'C:\\Games\\TMN-ESWC-horizon-next\\GameData' },
  { id: 'c:\\games\\tmo-horizon-test\\gamedata', family: 'tm-original', label: 'TMO-horizon-test', path: 'C:\\Games\\TMO-horizon-test\\GameData' },
];
const map = (family, uid, name, env, runs, bestMs, bestRespawns, cleanRuns, cleanBestMs, lastDays) => ({
  family, uid, name, env, runs, bestMs, bestRespawns, bestAt: now - lastDays * day, lastAt: now - lastDays * day, finishes: null, starts: null, respawns: null, hostBestMs: null, cleanRuns, cleanBestMs,
});
const maps = [
  map('forever', 'A01', 'A01-Race', 'Stadium', 41, 23540, 0, 41, 23540, 1),
  map('forever', 'A07', 'A07-Race', 'Stadium', 22, 31120, 1, 9, 31560, 3),
  map('forever', 'B03', '$o$f80Dirt$fff cut track', 'Stadium', 15, 45980, 3, 0, null, 8),
  map('tmn-eswc', 'B02', 'B02', 'Stadium', 12, 39870, 0, 12, 39870, 2),
  map('tmn-eswc', 'E01', 'E01-Endurance', 'Stadium', 4, 118320, 2, 1, 121440, 12),
  map('tm-original', 'SpeedA', 'Speed A1', 'Speed', 6, 52310, null, 0, null, 20),
];
const report = (copy) => ({
  games: [
    { family: 'forever', seconds: { tmnf: 61 * 3600 + 1200, tmuf: 7 * 3600 }, sessions: 140, lastPlayed: now - day, maps: 3, runs: 78, finishes: null, respawns: null, folders: [], hostEvents: false },
    { family: 'tmn-eswc', seconds: copy ? {} : { 'tmn-eswc': 5 * 3600 + 600 }, sessions: copy ? 0 : 18, lastPlayed: now - 2 * day, maps: 2, runs: 16, finishes: null, respawns: null, folders: [], hostEvents: false },
    { family: 'tm-original', seconds: {}, sessions: 0, lastPlayed: 0, maps: 1, runs: 6, finishes: null, respawns: null, folders: [], hostEvents: false },
  ].filter((g) => !copy || g.family === 'tmn-eswc'),
  maps: copy ? maps.filter((m) => m.family === 'tmn-eswc') : maps,
  days: Array.from({ length: 30 }, (_, i) => ({ day: iso(now - i * day), family: 'forever', seconds: (i * 37 % 7) * 900 })).filter((d) => d.seconds > 0),
  files: 2140, foreign: 310, duplicates: 42, pending: 0, indexing: false, newFiles: 0, parsedFiles: 0,
  playtimeSince: now - 200 * day,
  timeline: Array.from({ length: 12 }, (_, i) => ({ month: new Date(now - i * 30 * day).toISOString().slice(0, 7), family: 'forever', runs: 10 + (i * 13) % 25, pbs: (i * 7) % 6 })),
  runDays: Array.from({ length: 120 }, (_, i) => ({ day: iso(now - i * 3 * day), family: 'forever', runs: 1 + (i * 5) % 6, pbs: i % 4 === 0 ? 1 : 0 })),
  copies, copy: copy || null, generatedAt: new Date(now).toISOString(),
});
const opPlugin = (id, identifier, name, version, games, short, downloads) => ({ id, identifier, name, authors: ['someone'], short, image: null, games, downloads, version, signed: true, signType: 'regular', download: `https://cdn.openplanet.dev/plugins/${id}/1/${identifier}.op`, page: `https://openplanet.dev/plugin/${identifier.toLowerCase()}`, updated: 0 });
const opCatalog = [
  opPlugin(1, 'BetterChat', 'Better Chat', '1.4.0', ['Trackmania', 'Maniaplanet 4'], 'A better chat with history and filters.', 98000),
  opPlugin(2, 'SplitSpeeds', 'Split Speeds', '2.3.1', ['Trackmania'], 'Your speed at every checkpoint.', 51000),
  opPlugin(3, 'MedalDistribution', 'Medal Distribution', '0.2.0', ['Trackmania'], 'How many players have which medal.', 174),
];

const fixtures = {
  app_info: {
    version: '0.5.1', platform: 'windows', tmloaderRoot: null, tmloaderDefault: null, embeddedProfile: 'C:\\x', clipsDir: null, dataDir: 'C:\\x', protocolCommand: null, protocolExpected: 'x', pendingLinks: [],
    pendingFiles: process.env.GBX ? ['C:\\Users\\me\\Downloads\\B02 hunt.Challenge.Gbx'] : [], discordAvailable: true,
    settings: { hubUrl: '', updateUrl: '', tmloaderDir: null, eswcUseLauncher: false, protocolAsked: true, extraFolders: [], foundInstalls: [], installerHashes: {}, discordAppId: '', discordPresence: true, discordTas: true, coverDownloads: false, language: process.env.LANG_UI || 'en', theme: 'dark', accent: 'orange', density: 'normal', modsView: 'tiles', defaultGame: '', playFromHome: false, tickExe: null, updateChannel: 'stable', updateAtStart: false, selectedInstall: {}, linux: {}, setupDone: true, consoles: {}, suggestionsDismissed: [] },
  },
  cached_snapshot: snapshot, scan: snapshot, tml_snapshot: snapshot,
  playtime_all: { games: { tmnf: { seconds: 0, sessions: 0, lastPlayed: 0 } } },
  op_catalog: opCatalog,
  op_installed: { openplanet: true, dir: 'C:\\Users\\me\\OpenplanetNext\\Plugins', plugins: [{ file: 'SplitSpeeds.op', identifier: 'SplitSpeeds', isDir: false, version: '2.1.0' }, { file: 'BetterChat.op', identifier: 'BetterChat', isDir: false, version: '1.4.0' }] },
  more_projects: [
    { name: 'tmnf-replay-tools', summary: 'Read and convert TMNF replays: inputs, checkpoints and ghosts as JSON.', link: 'https://github.com/someone/tmnf-replay-tools', repo: 'someone/tmnf-replay-tools', kind: 'tool', stars: 40 },
    { name: 'forever-stats', summary: 'Personal records and play time for TMNF.', link: 'https://github.com/other/forever-stats', repo: 'other/forever-stats', kind: 'tool', stars: 12 },
    { name: 'Split Speeds', summary: 'Your speed at every checkpoint.', link: 'https://openplanet.dev/plugin/splitspeeds', repo: 'x/SplitSpeeds', kind: 'openplanet-plugin', stars: 9 },
  ],
  gbx_assoc_status: { on: false, current: { progid: 'TmForever.Gbx', command: '"C:\\Program Files (x86)\\TmNationsForever\\TmForever.exe" /useexedir /singleinst /file="%1"', program: 'TmForever.exe', name: 'TrackMania file' }, userChoice: null, userChoiceOurs: false },
  take_pending_files: [],
  gbx_open_info: {
    path: 'C:\\Users\\me\\Downloads\\B02 hunt.Challenge.Gbx', file: 'B02 hunt.Challenge.Gbx',
    detected: { kind: 'map', uid: 'B02', name: '$o$fffB02 $f80hunt', author: 'Nadeo', env: 'Stadium', timeMs: 39870, exever: null, games: ['tmn-eswc', 'tmnf', 'tmuf'], thumbnail: null },
    choices: [
      { game: 'tmn-eswc', label: 'TMN-ESWC-horizon-next', dir: 'C:\\Users\\me\\Games\\TMN-ESWC-horizon-next', instance: null, main: true },
      { game: 'tmn-eswc', label: 'TMN-ESWC-test', dir: 'C:\\Users\\me\\Games\\TMN-ESWC-test', instance: null, main: false },
      { game: 'tmnf', label: 'TmNationsForever', dir: 'C:\\Program Files (x86)\\TmNationsForever', instance: null, main: true },
      { game: 'tmuf', label: 'TmUnitedForever', dir: 'C:\\Program Files (x86)\\TmUnitedForever', instance: null, main: true },
    ],
  },
  client_bridge_status: { port: null, paired: [], asks: [] }, suggestions_done: [],
  horizon_targets: [], stats_tmx: [], stats_map_thumb: null, instances_list: [], list_instances: [],
};

async function shoot(name, hash, act, env = {}) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  Object.assign(process.env, env);
  const fx = JSON.parse(JSON.stringify(fixtures));
  fx.app_info.pendingFiles = env.GBX ? ['C:\\Users\\me\\Downloads\\B02 hunt.Challenge.Gbx'] : [];
  await page.addInitScript(({ fx, rep, rep1, copyId }) => {
    let n = 1;
    const cbs = {};
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
      transformCallback: (f) => { const id = n++; cbs[id] = f; return id; },
      convertFileSrc: (p) => p,
      invoke: async (cmd, args) => {
        if (cmd.startsWith('plugin:')) return n++;
        if (cmd === 'stats_report') return args && args.copy === copyId ? rep1 : rep;
        if (cmd in fx) return fx[cmd];
        if (/(^list|_list)$/.test(cmd)) return [];
        window.__unknown = (window.__unknown || []).concat(cmd);
        return null;
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    try { localStorage.setItem('tmhub.moreProjects', 'open'); } catch {}
  }, { fx, rep: report(''), rep1: report(copies[2].id), copyId: copies[2].id });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  await page.goto(BASE + hash, { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  if (act) await act(page);
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(out, name + '.png') });
  console.log('saved', name, errors.length ? 'errors: ' + errors.slice(0, 3).join(' | ') : '');
  await browser.close();
}

const only = process.argv.slice(3);
const run = (n) => !only.length || only.some((o) => n.includes(o));
if (run('stats')) await shoot('01-stats-all-copies', '#/stats');
if (run('stats')) await shoot('02-stats-copy-filter', '#/stats/tmn-eswc', async (p) => {
  await p.selectOption('.st-copy select', copies[2].id).catch((e) => console.log('select', String(e)));
  await p.waitForTimeout(800);
});
if (run('stats')) await shoot('03-stats-no-respawns-sorted', '#/stats', async (p) => {
  await p.click('button.fchip:has-text("No respawns")').catch((e) => console.log('chip', String(e)));
  await p.click('th button.st-sort:has-text("Respawns")').catch(() => p.click('th[title] button.st-sort').catch((e) => console.log('sort', String(e))));
  await p.evaluate(() => document.querySelector('.st-table')?.scrollIntoView({ block: 'start' }));
});
if (run('gbx')) await shoot('04-gbx-open-dialog', '#/library', null, { GBX: '1' });
if (run('settings')) await shoot('05-settings-gbx-assoc', '#/settings', async (p) => {
  await p.evaluate(() => [...document.querySelectorAll('.setrow b')].find((b) => /\.Gbx/.test(b.textContent))?.scrollIntoView({ block: 'center' }));
});
if (run('settings')) await shoot('06-settings-gbx-confirm', '#/settings', async (p) => {
  await p.evaluate(() => [...document.querySelectorAll('.setrow b')].find((b) => /\.Gbx/.test(b.textContent))?.scrollIntoView({ block: 'center' }));
  await p.evaluate(() => [...document.querySelectorAll('.setrow')].find((r) => /\.Gbx/.test(r.textContent))?.querySelector('button, [role=switch], input')?.click());
});
if (run('game')) await shoot('07-game-tmnf-more-projects', '#/game/tmnf', async (p) => {
  await p.evaluate(() => document.querySelector('.gm-moreproj')?.scrollIntoView({ block: 'center' }));
});
if (run('game')) await shoot('08-game-tm2020-openplanet', '#/game/tm2020', async (p) => {
  await p.evaluate(() => (document.querySelector('.op-installed') ?? document.querySelector('.gm-moreproj'))?.scrollIntoView({ block: 'center' }));
});
if (run('mods')) await shoot('09-mods-openplanet-cards', '#/mods', async (p) => {
  await p.click('button:has-text("Openplanet 3")').catch((e) => console.log('tab', String(e).slice(0, 120)));
  await p.waitForTimeout(800);
});
if (run('mods')) await shoot('10-openplanet-plugin-page', '#/mods/op:1');
