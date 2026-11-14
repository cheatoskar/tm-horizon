// 0.5.3: full-page screenshots of the game page, the home page and the Servers page (events section), with a
// fake native backend (no Tauri, nothing written). Needs the vite preview on port 4174 (or HUB_URL).
//   node tools/shoot-053.mjs [outDir] [suffix] [filter...]
// Prints the height of the main column and of the side column, so the balance can be compared before/after.
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(path.join(os.homedir(), 'tools', 'playwright', 'package.json'));
const { chromium } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || path.join(here, '..', '..', '..', 'screens', '053');
fs.mkdirSync(out, { recursive: true });
const BASE = process.env.HUB_URL || 'http://localhost:4174/';
const snapshot = JSON.parse(fs.readFileSync(path.join(here, '..', 'src', 'generated', 'snapshot.json'), 'utf8'));
const lang = process.env.LANG_UI || 'en';
// An Original install for the small card (Cpu/Gpu synchro only).
snapshot.games['tm-original'] = { ...(snapshot.games['tm-original'] ?? {}), installs: [{ source: 'Online Patch v2', path: 'C:\\Games\\TMO', exe: 'C:\\Games\\TMO\\TmOriginal.exe' }] };

const base = {
  app_info: {
    version: '0.5.2', platform: 'windows', tmloaderRoot: null, tmloaderDefault: null, embeddedProfile: 'C:\\x', clipsDir: null, dataDir: 'C:\\x', protocolCommand: null, protocolExpected: 'x', pendingLinks: [], pendingFiles: [], discordAvailable: true,
    settings: { hubUrl: '', updateUrl: '', tmloaderDir: null, eswcUseLauncher: false, useLauncher: { tmuf: true }, protocolAsked: true, extraFolders: [], foundInstalls: [], installerHashes: {}, discordAppId: '', discordPresence: true, discordTas: true, coverDownloads: false, language: lang, theme: 'dark', accent: 'orange', density: 'normal', modsView: 'tiles', defaultGame: '', playFromHome: false, tickExe: null, updateChannel: 'stable', updateAtStart: false, selectedInstall: {}, linux: {}, setupDone: true, consoles: {}, suggestionsDismissed: [] },
  },
  cached_snapshot: snapshot, scan: snapshot, tml_snapshot: snapshot,
  playtime_all: { games: { tmuf: { seconds: 0, sessions: 0, lastPlayed: 0 } } },
  op_catalog: [], op_installed: { openplanet: false, dir: null, plugins: [] }, more_projects: [],
  gbx_assoc_status: { on: false, current: null, userChoice: null, userChoiceOurs: false }, take_pending_files: [],
  client_bridge_status: { port: null, paired: [], asks: [] }, suggestions_done: [],
  horizon_targets: [], instances_list: [], list_instances: [],
  optimize_state: { supported: true, reason: null, exe: 'C:\\Program Files (x86)\\TmUnitedForever\\TmForever.exe', fso: true, dpi: false, gpu: true, canUndo: true },
  syscfg_state: { path: 'C:\\Users\\me\\Documents\\TrackMania\\Config\\Default.SystemConfig.Gbx', display: { format: 'binary', width: 2560, height: 1440, windowPreset: 0, colorDepth: 1, antialiasing: 5, refresh: 0, vsync: true, fullscreen: false, textures: 3, shadows: 5 }, writable: true, tips: ['vsync', 'aa'], canUndo: false },
  dxvk_state: { supported: true, reason: null, dir: 'C:\\Program Files (x86)\\TmUnitedForever', status: 'off', version: '3.1.1', admin: true },
  gpusync_state: { supported: true, value: 7, writable: true, path: 'C:\\Users\\me\\Documents\\TrackMania\\Config\\Default.SystemConfig.Gbx', canUndo: false, reason: null },
  horizon_tml_status: { tmloader: true, installed: ['0.3.1'], source: { kind: 'github' }, update: false, profilesOn: [], profiles: [], plugins: [], hostRoot: null, hasLog: false },
  startwatch_state: { supported: true, on: false, rows: [] },
  bench_state: { available: true, dir: 'C:\\x', lastMap: 'C:\\Users\\me\\Documents\\TrackMania\\Tracks\\Challenges\\A01-Race.Challenge.Gbx', results: [{ file: 'a', label: 'baseline', run: 1, avgFps: 212.4, low1Fps: 140.2, low01Fps: 98.1, stutters: 2 }], compare: [] },
  replay_state: { replaysDir: 'C:\\x', archiveDir: 'C:\\Users\\me\\Documents\\TM Horizon\\Replay-Archiv\\tmuf', count: 12043, bytes: 2.1e9, archivedCount: 0, archivedBytes: 0, days: 60, keep: 300, canUndo: false },
};

async function shoot(name, hash, { width = 1440, fx = {}, sel = null, clipAbove = 0 } = {}) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  await page.addInitScript(({ fx }) => {
    let n = 1;
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
      transformCallback: () => n++,
      convertFileSrc: (p) => p,
      invoke: async (cmd, args) => {
        if (cmd.startsWith('plugin:')) return n++;
        if (cmd === 'cached_image') return args.url;
        if (cmd in fx) return fx[cmd];
        if (/(^list|_list)$/.test(cmd)) return [];
        return null;
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  }, { fx: { ...base, ...fx } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE + hash, { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  const cols = await page.evaluate(() => {
    const h = (s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().height) : null; };
    // The page scrolls inside .main (the window itself does not grow).
    return { main: h('.game-grid > .col:not(.side)') ?? h('.home-grid > .home-col'), side: h('.game-grid > .col.side') ?? h('.home-grid > .home-news') };
  });
  // Full page: let the scroll box grow to its content for the shot.
  await page.addStyleTag({ content: 'html, body, #root, .app, .main, .content { height: auto !important; max-height: none !important; overflow: visible !important; }' });
  await page.waitForTimeout(300);
  const target = sel ? page.locator(sel).first() : null;
  if (clipAbove && target && await target.count()) {
    // The element plus `clipAbove` px above it (the gap between the server table and the Events head).
    const b = await target.boundingBox();
    await page.screenshot({ path: path.join(out, name + '.png'), fullPage: true, clip: { x: 0, y: Math.max(0, b.y - clipAbove), width, height: b.height + clipAbove } });
  } else if (target && await target.count()) await target.screenshot({ path: path.join(out, name + '.png') });
  else await page.screenshot({ path: path.join(out, name + '.png'), fullPage: true });
  console.log('saved', name, `main=${cols.main} side=${cols.side}`, errors.length ? 'errors: ' + errors.slice(0, 2).join(' | ') : '');
  await browser.close();
}

const sfx = process.argv[3] || 'after';
const only = process.argv.slice(4);
const run = (n) => !only.length || only.some((o) => n.includes(o));
const shots = [
  ['game-tmuf-1440', '#/game/tmuf', {}],
  ['game-tmuf-1920', '#/game/tmuf', { width: 1920 }],
  ['game-tmn-eswc-1440', '#/game/tmn-eswc', {}],
  ['home-1440', '#/home', {}],
  ['servers-events-1440', '#/servers', { sel: '.events', clipAbove: 160 }],
];
for (const [n, h, o] of shots) if (run(n)) await shoot(`${n}-${sfx}`, h, o);
