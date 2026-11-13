// 0.5.2: screenshots of the game page's Performance card (Optimize tab) and the start options, with a fake
// native backend (no Tauri, nothing written). Needs the vite dev server or preview on port 4174 (or HUB_URL).
//   node tools/shoot-052.mjs [outDir] [filter...]
// Also lists rows of controls with mixed heights inside the card (same audit as shoot-051c.mjs).
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(path.join(os.homedir(), 'tools', 'playwright', 'package.json'));
const { chromium } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || path.join(here, '..', '..', '..', 'screens', '052');
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

async function shoot(name, hash, { width = 1440, fx = {}, sel = null, act = null } = {}) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height: 1700 }, deviceScaleFactor: 1 });
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
  if (act) await act(page);
  await page.waitForTimeout(400);
  const target = sel ? page.locator(sel).first() : null;
  if (target) await target.scrollIntoViewIfNeeded().catch(() => {});
  const bad = await page.evaluate((sel) => {
    const root = (sel && document.querySelector(sel)) || document;
    const SEL = 'button.btn, .select, .seg, select, input[type=text], input[type=number]';
    const els = [...root.querySelectorAll(SEL)].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !(e.parentElement && e.parentElement.closest('.seg')); });
    const groups = new Map();
    for (const e of els) { const p = e.parentElement; if (!p || getComputedStyle(p).display.indexOf('flex') < 0) continue; (groups.get(p) ?? groups.set(p, []).get(p)).push(e); }
    const res = [];
    for (const [p, list] of groups) {
      const hs = [...new Set(list.map((e) => Math.round(e.getBoundingClientRect().height)))];
      if (list.length > 1 && hs.length > 1) res.push(`${p.className || p.tagName}: ${hs.join('/')}`);
    }
    return res;
  }, sel);
  if (target && await target.count()) await target.screenshot({ path: path.join(out, name + '.png') });
  else await page.screenshot({ path: path.join(out, name + '.png') });
  console.log('saved', name, errors.length ? 'errors: ' + errors.slice(0, 2).join(' | ') : '');
  for (const b of bad) console.log('  MISMATCH', b);
  await browser.close();
  return bad.length;
}

const only = process.argv.slice(3);
const run = (n) => !only.length || only.some((o) => n.includes(o));
const perf = '.panel:has(.perf-tabs)';
let bad = 0;
const shots = [
  ['perf-tmuf-wide', '#/game/tmuf', { sel: perf }],
  ['perf-tmuf-narrow', '#/game/tmuf', { sel: perf, width: 1100 }],
  ['perf-tmuf-phone', '#/game/tmuf', { sel: perf, width: 700 }],
  ['perf-tmuf-bench', '#/game/tmuf', { sel: perf, act: (p) => p.locator('.perf-tabs button').nth(1).click() }],
  ['perf-tmuf-replays', '#/game/tmuf', { sel: perf, act: (p) => p.locator('.perf-tabs button').nth(2).click() }],
  ['perf-tmo', '#/game/tm-original', { sel: '.panel:has(.perf-block)' }],
  ['perf-tmuf-dxvk-on', '#/game/tmuf', { sel: perf, fx: { dxvk_state: { ...base.dxvk_state, status: 'on' }, gpusync_state: { ...base.gpusync_state, value: 5 } } }],
  ['perf-tmuf-foreign', '#/game/tmuf', { sel: perf, fx: { dxvk_state: { ...base.dxvk_state, status: 'foreign' }, horizon_tml_status: null } }],
  ['start-tmuf', '#/game/tmuf', { sel: '.panel.start-options' }],
  ['synctip-tmuf', '#/game/tmuf', { sel: '.sync-tip' }],
  ['synctip-readonly', '#/game/tmuf', { sel: '.sync-tip', fx: { gpusync_state: { ...base.gpusync_state, writable: false, launcher: 'C:\\x\\TmForeverLauncher.exe' } } }],
  ['skid-gamefolder', '#/game/tmuf', { sel: '.game-extras', fx: { skid_state: { mark: 'clean', canClean: true, canRestore: true, protected: true, tml: { available: true, installed: true, profilesOn: ['default'], profiles: ['default'] }, mode: 'gameFolder' } } }],
  ['skid-tml', '#/game/tmuf', { sel: '.game-extras', fx: { skid_state: { mark: 'classic', canClean: true, canRestore: false, protected: true, tml: { available: true, installed: false, profilesOn: [], profiles: ['default'] }, mode: 'tml' } } }],
];
for (const [n, h, o] of shots) if (run(n)) bad += await shoot(n, h, o);
console.log(bad ? `${bad} rows with mixed control heights` : 'no mixed control heights');
