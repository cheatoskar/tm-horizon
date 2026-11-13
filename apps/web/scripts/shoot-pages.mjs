// Review screenshots of the platform pages at 1600, 2560 and 390 px. Usage: node scripts/shoot-pages.mjs <baseUrl> <outDir>
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire('%USERPROFILE%/tools/playwright/');
const { chromium } = require('playwright');
const [base, out] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const pages = {
  home: '/', 'discover-mods': '/discover/mods/', 'mod-tmloader': '/mod/tm-vibrant-shaders/', 'mod-centerspeed': '/mod/centerspeed/', 'mod-discord': '/mod/mod-bay-buildings/',
  'mod-proxy': '/mod/mod-eswc-autosave/', 'game-tmnf': '/game/tmnf/', 'game-eswc': '/game/eswc/', 'game-tm2-stadium': '/game/tm2-stadium/', 'game-tm2020': '/game/tm2020/',
  download: '/download/', events: '/events/', servers: '/discover/servers/',
};
const sizes = [['1600', { width: 1600, height: 1000 }], ['2560', { width: 2560, height: 1440 }], ['390', { width: 390, height: 844 }]];
const b = await chromium.launch();
for (const [name, vp] of sizes) {
  const ctx = await b.newContext({ viewport: vp, colorScheme: 'dark', locale: 'en-GB', timezoneId: 'Europe/Berlin' });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('JS error', e.message));
  for (const [id, path] of Object.entries(pages)) {
    await p.goto(base + path, { waitUntil: 'load' });
    await p.waitForTimeout(500);
    await p.screenshot({ path: `${out}/${id}-${name}.png`, fullPage: true });
    const ov = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (ov > 0) console.log('horizontal overflow', name, id, ov);
  }
  await ctx.close();
}
await b.close();
