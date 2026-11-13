// TMX sends "X-Frame-Options: SAMEORIGIN", so a browser iframe stays empty. For the
// prototype the Maps page shows a static capture of each TMX site instead; the native
// app would show the live site in a WebView2. Captures the frame size at 1440x900.
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(path.join(os.homedir(), 'tools', 'playwright', 'package.json'));
const { chromium } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'public', 'tmx-capture');
fs.mkdirSync(out, { recursive: true });

const SITES = ['tmnf.exchange', 'tmuf.exchange', 'tm.mania.exchange', 'sm.mania.exchange', 'trackmania.exchange',
  'original.tm-exchange.com', 'sunrise.tm-exchange.com', 'nations.tm-exchange.com'];
const only = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1364, height: 812 }, userAgent: 'Mozilla/5.0 TM-Horizon-capture', colorScheme: 'dark' });
for (const host of SITES) {
  if (only.length && !only.includes(host)) continue;
  try {
    await page.goto(`https://${host}/`, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(out, host + '.jpg'), type: 'jpeg', quality: 82 });
    console.log('captured', host);
  } catch (e) { console.log('FAILED', host, e.message.split('\n')[0]); }
}
await browser.close();
