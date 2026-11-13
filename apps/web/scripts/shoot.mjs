// Screenshots for review. Usage: node scripts/shoot.mjs <baseUrl> <outDir> [pageName ...]
// Uses Playwright from %USERPROFILE%\tools\playwright.
import { createRequire } from 'node:module';
const require = createRequire('%USERPROFILE%/tools/playwright/');
const { chromium } = require('playwright');
const [base, out, ...only] = process.argv.slice(2);
const pages = {
  home: '/', 'discover-mods': '/discover/mods/', 'mod-tmvs': '/mod/tm-vibrant-shaders/', 'game-tmnf': '/game/tmnf/',
  directory: '/directory/', events: '/events/', servers: '/discover/servers/', games: '/games/', 'discover-maps': '/discover/maps/',
};
const shots = [
  ['desktop-dark', { width: 1440, height: 900 }, 'dark'],
  ['desktop-light', { width: 1440, height: 900 }, 'light'],
  ['phone-dark', { width: 390, height: 844 }, 'dark'],
];
const b = await chromium.launch();
for (const [suffix, vp, scheme] of shots) {
  const ctx = await b.newContext({ viewport: vp, colorScheme: scheme, deviceScaleFactor: 1, locale: 'en-GB', timezoneId: 'Europe/Berlin' });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('JS error', e.message));
  for (const [name, path] of Object.entries(pages)) {
    if (only.length && !only.includes(name)) continue;
    await p.goto(base + path, { waitUntil: 'networkidle' });
    await p.waitForTimeout(250);
    await p.screenshot({ path: `${out}/${name}-${suffix}.png` });
    if (suffix !== 'desktop-light') await p.screenshot({ path: `${out}/${name}-${suffix}-full.png`, fullPage: true });
    const ov = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (ov > 0) console.log('horizontal overflow', suffix, name, ov);
  }
  await ctx.close();
}
// open states: phone filter drawer and menu, desktop Discover dropdown
if (!only.length || only.includes('states')) {
  const pc = await b.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', locale: 'en-GB' });
  const pp = await pc.newPage();
  await pp.goto(base + '/discover/mods/', { waitUntil: 'networkidle' });
  await pp.click('[data-open-facets]'); await pp.waitForTimeout(400);
  await pp.screenshot({ path: `${out}/discover-mods-phone-filters.png` });
  await pp.goto(base + '/', { waitUntil: 'networkidle' });
  await pp.click('.phone-menu summary'); await pp.waitForTimeout(300);
  await pp.screenshot({ path: `${out}/home-phone-menu.png` });
  const dc = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', locale: 'en-GB' });
  const dp = await dc.newPage();
  await dp.goto(base + '/discover/mods/', { waitUntil: 'networkidle' });
  await dp.click('.discover-dd summary'); await dp.waitForTimeout(300);
  await dp.screenshot({ path: `${out}/discover-menu-desktop-dark.png` });
}
await b.close();
