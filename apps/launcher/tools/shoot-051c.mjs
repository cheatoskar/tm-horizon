// 0.5.1-c: control-height audit of every page plus screenshots of the fixed spots, with a fake native backend
// (no Tauri, no real data, nothing written). Needs `npx vite preview --port 4174` (or HUB_URL).
//   node tools/shoot-051c.mjs [outDir] [filter...]
// The audit lists every row of toolbar controls (buttons, selects, segmented toggles, chips, search fields
// that sit side by side in one flex row) whose heights differ. Exit code 1 when it finds one.
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(path.join(os.homedir(), 'tools', 'playwright', 'package.json'));
const { chromium } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || path.join(here, '..', '..', '..', 'screens', '051c');
fs.mkdirSync(out, { recursive: true });
const BASE = process.env.HUB_URL || 'http://localhost:4174/';
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
      profileSeconds: 1380263 + 26601, beforeSeconds: 1380263 + 26601 - 3029, profiles: [{ name: 'osaro', seconds: 1380263 }, { name: 'Gast', seconds: 26601 }] },
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

/** `hash` starting with "!" = the browser preview's own sample data (no fake native backend). */
async function shoot(name, hash, act) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const plain = hash.startsWith('!');
  hash = hash.replace(/^!/, '');
  if (!plain) await page.addInitScript(({ fx, statsTmx }) => {
    let n = 1;
    const cbs = {};
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
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE + hash, { waitUntil: 'load' });
  await page.waitForTimeout(2200);
  if (act) await act(page);
  await page.waitForTimeout(500);
  // Rows of controls: siblings in one flex row whose vertical centres line up.
  const bad = await page.evaluate(() => {
    const SEL = 'button.btn, .select, .seg, .fchip, input.text-in, input.search, .search, select.input, input.input';
    const els = [...document.querySelectorAll(SEL)].filter((e) => {
      const r = e.getBoundingClientRect();
      // A segmented toggle counts as one control: its own buttons are skipped.
      return r.width > 0 && r.height > 0 && !(e.parentElement && e.parentElement.closest('.seg'));
    });
    const groups = new Map();
    for (const e of els) {
      const p = e.parentElement;
      if (!p || getComputedStyle(p).display.indexOf('flex') < 0) continue;
      const list = groups.get(p) ?? [];
      list.push(e);
      groups.set(p, list);
    }
    const out = [];
    for (const [p, list] of groups) {
      if (list.length < 2) continue;
      // One visual row = controls whose vertical extents overlap.
      const sorted = list.map((e) => ({ e, r: e.getBoundingClientRect() })).sort((a, b) => a.r.top - b.r.top);
      const rows = [];
      for (const it of sorted) {
        const last = rows.at(-1);
        if (last && it.r.top < last.bottom - 2) { last.items.push({ e: it.e, h: Math.round(it.r.height) }); last.bottom = Math.max(last.bottom, it.r.bottom); }
        else rows.push({ bottom: it.r.bottom, items: [{ e: it.e, h: Math.round(it.r.height) }] });
      }
      for (const { items } of rows) {
        const hs = [...new Set(items.map((i) => i.h))];
        if (items.length >= 2 && hs.length > 1) {
          out.push({ parent: p.className || p.tagName, items: items.map((i) => `${i.e.className.split(' ').slice(0, 3).join('.') || i.e.tagName}=${i.h}`).join(', ') });
        }
      }
    }
    return out;
  });
  if (process.env.DUMP) console.log(await page.evaluate((sel) => [...document.querySelectorAll(sel)].map((e) => `  ${e.tagName}.${e.className} h=${e.getBoundingClientRect().height}`).join('\n'), process.env.DUMP));
  await page.screenshot({ path: path.join(out, name + '.png') });
  console.log('saved', name, errors.length ? 'errors: ' + errors.slice(0, 2).join(' | ') : '');
  for (const b of bad) console.log('  MISMATCH in', b.parent, '->', b.items);
  await browser.close();
  return bad.length;
}

const only = process.argv.slice(3);
const run = (n) => !only.length || only.some((o) => n.includes(o));
let mismatches = 0;
const pages = [
  ['01-stats', '#/stats'], ['02-library', '#/library'], ['03-mods', '#/mods'], ['04-maps', '#/maps'], ['05-servers', '#/servers'],
  ['06-community', '#/community'], ['07-news', '#/news'], ['08-clips', '#/clips'], ['09-media', '#/media'], ['10-skinlib', '#/skinlib'],
  ['11-settings', '#/settings'], ['12-game-tmnf', '#/game/tmnf'], ['13-profiles', '#/profiles'], ['14-skins', '#/skins'], ['15-tashome', '#/tashome'],
];
for (const [n, h] of pages) if (run(n)) mismatches += await shoot(n, h);
if (run('stats')) {
  mismatches += await shoot('20-stats-playchart', '#/stats', async (p) => { await p.evaluate(() => document.querySelector('.st-two')?.scrollIntoView({ block: 'center' })); });
  mismatches += await shoot('21-stats-topmaps', '#/stats', async (p) => { await p.evaluate(() => document.querySelector('.st-topgrid')?.scrollIntoView({ block: 'center' })); await p.waitForTimeout(2500); });
  mismatches += await shoot('22-stats-table', '#/stats', async (p) => { await p.evaluate(() => document.querySelector('.st-table')?.scrollIntoView({ block: 'start' })); await p.waitForTimeout(2500); });
}
if (run('host')) mismatches += await shoot('30-host-servers', '#/servers');
if (run('host')) mismatches += await shoot('31-host-engines', '!#/servers', async (p) => {
  await p.getByRole('button', { name: /My servers|Eigener Server/ }).first().click().catch((e) => console.log('tab', String(e).slice(0, 100)));
  await p.waitForTimeout(800);
  await p.getByRole('button', { name: /New server|Neuer Server|Server erstellen|Create/ }).first().click().catch((e) => console.log('new', String(e).slice(0, 100)));
  await p.waitForTimeout(800);
  if (process.env.DUMP2) console.log(await p.evaluate(() => [...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean).join(' | ')));
  await p.evaluate(() => [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && /100% TMX\)/.test(e.textContent ?? ''))?.scrollIntoView({ block: 'center' }));
});
if (run('host')) mismatches += await shoot('32-host-randomizer-maps', '!#/servers', async (p) => {
  await p.getByRole('button', { name: /My servers|Eigener Server/ }).first().click().catch(() => {});
  await p.waitForTimeout(600);
  await p.getByRole('button', { name: /New server|Neuer Server/ }).first().click().catch(() => {});
  await p.waitForTimeout(600);
  await p.evaluate(() => {
    const el = [...document.querySelectorAll('label, button, [role=radio]')].find((e) => /Zufallskarten|Random maps/.test(e.textContent ?? ''));
    (el?.querySelector('input') ?? el)?.click();
  });
  await p.waitForTimeout(400);
  await p.evaluate(() => [...document.querySelectorAll('button')].find((b) => /^\d?(Karten|Maps)$/.test(b.textContent?.trim() ?? ''))?.click());
  await p.waitForTimeout(600);
  console.log('  preset options:', await p.evaluate(() => [...(document.querySelector('.hs-form select')?.options ?? [])].map((o) => o.textContent).join(' | ')));
});
console.log(mismatches ? `${mismatches} rows with mixed control heights` : 'no mixed control heights');
process.exitCode = mismatches ? 1 : 0;
