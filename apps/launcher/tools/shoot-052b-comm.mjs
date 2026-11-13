// 0.5.2-b: Communities page and the community panel of a game page in the browser preview (own server pinned, icons). Needs a vite server (HUB_URL).
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(path.join(os.homedir(), 'tools', 'playwright', 'package.json'));
const { chromium } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', '..', '..', 'screens', '052b');
fs.mkdirSync(out, { recursive: true });
const BASE = process.env.HUB_URL || 'http://localhost:4177/';
const browser = await chromium.launch();
for (const [name, hash] of [['communities', '#/community'], ['game-tmnf-community', '#/game/tmnf']]) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(BASE + hash, { waitUntil: 'load' });
  await page.waitForTimeout(3500);
  await page.screenshot({ path: path.join(out, name + '.png') });
  console.log('saved', name);
}
await browser.close();
