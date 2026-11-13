// Screenshots of every page at 1440x900. Needs `npm run preview` running (port 4173).
// Uses the Playwright install in ~/tools/playwright (no project dependency).
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(path.join(os.homedir(), 'tools', 'playwright', 'package.json'));
const { chromium } = require('playwright');

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'screens');
fs.mkdirSync(out, { recursive: true });
const BASE = process.env.HUB_URL || 'http://localhost:4173/';

const SHOTS = [
  ['01-home', '#/home'],
  ['02-library', '#/library'],
  ['03-game-united', '#/game/tmuf'],
  ['04-game-trackmania', '#/game/tm2020'],
  ['05-mods', '#/mods'],
  ['06-mod-detail', '#/mods/' + encodeURIComponent('TM Vibrant Shaders')],
  ['07-profiles', '#/profiles'],
  ['08-servers', '#/servers'],
  ['09-community', '#/community'],
  ['10-skins', '#/skins'],
  ['11-settings', '#/settings'],
  ['12-ingame-mods', '#/overlay'],
  ['13-ingame-skins', '#/overlay/skins'],
  ['14-home-profile-menu', '#/home', async (p) => { await p.click('.psel-btn'); await p.waitForTimeout(250); }],
  ['15-maps-nations', '#/maps/tmnf'],
  ['16-maps-eswc', '#/maps/tmn-eswc'],
  ['17-mods-tools', '#/mods', async (p) => { await p.click('.seg button:nth-child(3)'); await p.waitForTimeout(300); }],
];

const only = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const t0 = Date.now();
await page.goto(BASE + '#/home', { waitUntil: 'load' });
console.log('first load', Date.now() - t0, 'ms');
for (const [name, hash, act] of SHOTS) {
  if (only.length && !only.some((o) => name.includes(o))) continue;
  await page.goto(BASE + hash, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000); // hero/fade animations
  if (act) await act(page);
  await page.screenshot({ path: path.join(out, name + '.png') });
  console.log('saved', name);
}
await browser.close();
