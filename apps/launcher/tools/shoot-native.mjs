// Screenshots of the running native app (no clicks on Play, Install or anything that writes).
// Start the app with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222, then:
//   PLAYWRIGHT_DIR=~/tools/playwright node tools/shoot-native.mjs [name=hash ...]
// The route is switched through the page's own hash router (CDP), the picture is taken with
// PrintWindow so the embedded TMX/ManiaPark webview is in it (tools/capture-window.ps1).
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const pwDir = process.env.PLAYWRIGHT_DIR;
const { chromium } = await import(pathToFileURL(path.join(pwDir, 'node_modules', 'playwright', 'index.mjs')).href);
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const out = path.join(here, '..', 'screens', 'native');

const shots = process.argv.slice(2).length
  ? process.argv.slice(2).map((a) => { const [n, h, w] = a.split('='); return [n, h, Number(w || 2500)]; })
  : [
    ['01-home', '#/home', 2500],
    ['02-library', '#/library', 2000],
    ['03-mods', '#/mods', 2500],
    ['04-maps-tmx', '#/maps/tmnf', 9000],
    ['05-skins-maniapark', '#/skins/tmuf', 9000],
    ['06-clips', '#/clips', 2500],
    ['07-settings', '#/settings', 2000],
    ['08-game-united', '#/game/tmuf', 2500],
  ];

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => /tauri\.localhost|localhost:5173/.test(p.url()));
if (!page) throw new Error('TM Horizon page not found: ' + browser.contexts().flatMap((c) => c.pages()).map((p) => p.url()).join(', '));
for (const [name, hash, wait] of shots) {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForTimeout(wait);
  const file = path.join(out, name + '.png');
  console.log(execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'capture-window.ps1'), '-Out', file]).toString().trim());
}
// Just disconnect; the app is closed by the caller.
process.exit(0);
