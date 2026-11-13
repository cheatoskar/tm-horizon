// 0.5.2-b: screenshots of the statistics game tiles (1577 h) in the four languages and two widths. Needs a vite server (HUB_URL, default :4177).
//   node tools/shoot-052b.mjs [outDir] [suffix]
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(path.join(os.homedir(), 'tools', 'playwright', 'package.json'));
const { chromium } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || path.join(here, '..', '..', '..', 'screens', '052b');
fs.mkdirSync(out, { recursive: true });
const BASE = process.env.HUB_URL || 'http://localhost:4177/';
const snapshot = JSON.parse(fs.readFileSync(path.join(here, '..', 'src', 'generated', 'snapshot.json'), 'utf8'));

const now = Date.now();
const day = 86_400_000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const copies = [
  { id: 'c:\\users\\me\\documents\\trackmania', family: 'forever', label: 'Documents\\TrackMania', path: 'C:\\Users\\me\\Documents\\TrackMania' },
  { id: 'c:\\users\\me\\documents\\tmforever', family: 'forever', label: 'Documents\\TmForever', path: 'C:\\Users\\me\\Documents\\TmForever' },
  { id: 'c:\\users\\me\\documents\\maniaplanet', family: 'maniaplanet', label: 'Documents\\ManiaPlanet', path: 'C:\\Users\\me\\Documents\\ManiaPlanet' },
  { id: 'c:\\games\\tmn-eswc\\gamedata', family: 'tmn-eswc', label: 'TMN-ESWC', path: 'C:\\Games\\TMN-ESWC\\GameData' },
];
const map = (family, uid, name, env, runs, bestMs, campaign, lastDays) => ({
  family, uid, name, env, runs, bestMs, bestRespawns: 0, bestAt: now - lastDays * day, lastAt: now - lastDays * day, finishes: null, starts: null, respawns: null, hostBestMs: null, cleanRuns: runs, cleanBestMs: bestMs, campaign,
});
const maps = [
  map('maniaplanet', 'f1cOLRy8AGBdReGaRhSRiL59IY2', '$fff$sB02', 'Stadium', 40, 26560, true, 1),
  map('forever', 'b4ubJL0Aayrg7aqhe0RwI4jBQR1', 'B02-Race', 'Stadium', 12, 26190, true, 2),
  map('forever', 'P_o6KQMKdkg4Hyr47rPtjLE7TD3', '$F00lol B02 - Speed Snake', 'Stadium', 9, 36170, false, 3),
  map('tmn-eswc', 'E01x', 'E01-Endurance', 'Stadium', 4, 118320, true, 12),
];
const report = {
  games: [
    { family: 'forever', seconds: { tmnf: 5, tmuf: 3024 }, sessions: 4, lastPlayed: now - day, maps: 2, runs: 21, finishes: null, respawns: null, folders: [], hostEvents: false,
      profileSeconds: 5677200, beforeSeconds: 5677200 - 3029, profiles: [{ name: 'osaro', seconds: 5677200 - 26601 }, { name: 'Gast', seconds: 26601 }] },
    { family: 'maniaplanet', seconds: { 'tm2-stadium': 40 }, sessions: 1, lastPlayed: now - day, maps: 1, runs: 40, finishes: null, respawns: null, folders: [], hostEvents: false },
    { family: 'tmn-eswc', seconds: { 'tmn-eswc': 1551 }, sessions: 6, lastPlayed: now - 2 * day, maps: 1, runs: 4, finishes: null, respawns: null, folders: [], hostEvents: false },
  ],
  maps,
  days: Array.from({ length: 30 }, (_, i) => ({ day: iso(now - i * day), family: 'forever', seconds: (i * 37 % 7) * 900 })).filter((d) => d.seconds > 0),
  files: 2140, foreign: 310, duplicates: 42, pending: 0, indexing: false, newFiles: 0, parsedFiles: 0,
  playtimeSince: now - 3 * day,
  timeline: Array.from({ length: 12 }, (_, i) => ({ month: new Date(now - i * 30 * day).toISOString().slice(0, 7), family: 'forever', runs: 10 + (i * 13) % 25, pbs: (i * 7) % 6 })),
  runDays: Array.from({ length: 120 }, (_, i) => ({ day: iso(now - i * 3 * day), family: 'forever', runs: 1 + (i * 5) % 6, pbs: i % 4 === 0 ? 1 : 0 })),
  copies, copy: null, generatedAt: new Date(now).toISOString(),
};
// TMX/MX answers for the map pictures (the pictures themselves come from the real sites through the preview).
const statsTmx = [
  { uid: 'f1cOLRy8AGBdReGaRhSRiL59IY2', site: 'tm.mania.exchange', trackId: 42084, at: now },
  { uid: 'b4ubJL0Aayrg7aqhe0RwI4jBQR1', site: 'tmnf.exchange', trackId: 2285, at: now },
];

const fixtures = {
  app_info: {
    version: '0.5.1', platform: 'windows', tmloaderRoot: null, tmloaderDefault: null, embeddedProfile: 'C:\\x', clipsDir: null, dataDir: 'C:\\x', protocolCommand: null, protocolExpected: 'x', pendingLinks: [], pendingFiles: [], discordAvailable: true,
    settings: { hubUrl: '', updateUrl: '', tmloaderDir: null, eswcUseLauncher: false, protocolAsked: true, extraFolders: [], foundInstalls: [], installerHashes: {}, discordAppId: '', discordPresence: true, discordTas: true, coverDownloads: false, language: process.env.LANG_UI || 'en', theme: 'dark', accent: 'orange', density: 'normal', modsView: 'tiles', defaultGame: '', playFromHome: false, tickExe: null, updateChannel: 'stable', updateAtStart: false, selectedInstall: {}, linux: {}, setupDone: true, consoles: {}, suggestionsDismissed: [] },
  },
  cached_snapshot: snapshot, scan: snapshot, tml_snapshot: snapshot,
  playtime_all: { games: { tmnf: { seconds: 0, sessions: 0, lastPlayed: 0 } } },
  op_catalog: [], op_installed: { openplanet: false, dir: null, plugins: [] }, more_projects: [],
  gbx_assoc_status: { on: false, current: null, userChoice: null, userChoiceOurs: false }, take_pending_files: [],
  client_bridge_status: { port: null, paired: [], asks: [] }, suggestions_done: [],
  horizon_targets: [], stats_map_thumb: null, instances_list: [], list_instances: [],
  stats_report: report,
  server_registry: { enabled: true, servers: [
    { game: 'tmnf', address: 'game.100tmx.com:2350', name: '100% TMX (Nations Forever)', source: 'seed' },
    { game: 'tmuf', address: '84.83.178.80:2370', name: 'FreeZone', source: 'community' },
  ] },
  server_status_cached: [], server_status_all: [], server_status: [],
};

async function shoot(name, hash, width, lang) {
  fixtures.app_info.settings.language = lang;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height: 700 }, deviceScaleFactor: 1 });
  await page.addInitScript(({ fx, statsTmx }) => {
    let n = 1; const cbs = {};
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
      transformCallback: (f) => { const id = n++; cbs[id] = f; return id; },
      convertFileSrc: (p) => p,
      invoke: async (cmd, args) => {
        if (cmd.startsWith('plugin:')) return n++;
        if (cmd === 'cached_image') return args.url;
        if (cmd === 'stats_tmx') return statsTmx.filter((h) => args.uids.includes(h.uid));
        if (cmd in fx) return fx[cmd];
        if (/(^list|_list)$/.test(cmd)) return [];
        return null;
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  }, { fx: fixtures, statsTmx });
  await page.goto(BASE + hash, { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  const info = await page.evaluate(() => [...document.querySelectorAll('.st-gt-time')].map((e) => `${e.textContent} h=${Math.round(e.getBoundingClientRect().height)}`).join(' | '));
  const tile = page.locator('.st-tiles-row').first();
  await tile.screenshot({ path: path.join(out, name + '.png') });
  console.log(name, info);
  await browser.close();
}
const sfx = process.argv[3] || 'after';
for (const lang of ['en', 'de', 'pl', 'fr']) for (const w of [1440, 560]) await shoot(`stats-tiles-${lang}-${w}-${sfx}`, '#/stats', w, lang);
