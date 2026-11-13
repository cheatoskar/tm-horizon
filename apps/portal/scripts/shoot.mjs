// Screenshots of every portal page at desktop and phone width. Needs the seeded hub server and the
// portal dev server running (see apps/portal README in the task notes). Usage:
//   node apps/portal/scripts/shoot.mjs [outDir]
// Playwright comes from the install outside the repo (PLAYWRIGHT_DIR, default ~/tools/playwright).
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const pwDir = process.env.PLAYWRIGHT_DIR ?? join(homedir(), 'tools', 'playwright');
const { chromium } = createRequire(join(pwDir, 'package.json'))('playwright');
const BASE = process.env.PORTAL_URL ?? 'http://localhost:5174';
const out = resolve(process.argv[2] ?? 'screens/portal');
mkdirSync(out, { recursive: true });

const sizes = { desktop: { width: 1600, height: 1000 }, phone: { width: 390, height: 844 } };
const problems = [];

async function login(page, who) {
  await page.goto(`${BASE}/login`);
  await page.getByRole('button', { name: who, exact: true }).click();
  await page.waitForURL(`${BASE}/`);
}

async function shot(page, size, name, full = true) {
  await page.waitForTimeout(500);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (over > 1) problems.push(`${size} ${name}: horizontal overflow ${over}px`);
  await page.screenshot({ path: join(out, `${size}-${name}.png`), fullPage: full });
  console.log('shot', size, name);
}

const browser = await chromium.launch();
for (const [size, viewport] of Object.entries(sizes)) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && problems.push(`${size} console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`${size} pageerror: ${e.message}`));

  await page.goto(`${BASE}/login`);
  await shot(page, size, '01-login');
  await login(page, 'Author');
  await shot(page, size, '02-projects');
  await page.goto(`${BASE}/new`);
  await page.getByLabel('Repository or server URL').fill('https://github.com/example/nothing-here');
  await page.getByRole('button', { name: 'Preview' }).click();
  await page.waitForTimeout(2500);
  await shot(page, size, '03-new-import');
  await page.getByRole('button', { name: 'Create by hand' }).click();
  await shot(page, size, '04-new-by-hand');

  for (const tab of ['details', 'images', 'versions', 'sources', 'team', 'analytics']) {
    await page.goto(`${BASE}/projects/demo-shaders?tab=${tab}`);
    await page.waitForTimeout(800);
    await shot(page, size, `05-project-${tab}`);
  }
  // cropper
  await page.goto(`${BASE}/projects/demo-shaders?tab=images`);
  await page.locator('input[type=file]').first().setInputFiles(process.env.SAMPLE ?? resolve('screens/sample.png'));
  await page.waitForTimeout(800);
  await shot(page, size, '06-cropper');

  // claim tab of an unclaimed project
  const list = await (await page.request.get(`${BASE}/v1/projects?limit=1&sort=name`)).json();
  const unclaimed = list.items[0].slug;
  await page.goto(`${BASE}/projects/${unclaimed}?tab=claim`);
  await shot(page, size, '07-claim');

  await page.goto(`${BASE}/account`);
  await shot(page, size, '08-account');

  await page.goto(`${BASE}/p/demo-shaders`);
  await shot(page, size, '09-public');
  await page.getByRole('button', { name: 'Report' }).last().click();
  await shot(page, size, '10-report-dialog', false);
  await page.keyboard.press('Escape');
  await page.goto(`${BASE}/p/${unclaimed}`);
  await shot(page, size, '11-public-unclaimed');
  for (const n of ['impressum', 'datenschutz', 'nutzungsbedingungen']) {
    await page.goto(`${BASE}/legal/${n}`);
    await shot(page, size, `12-legal-${n}`);
  }
  await page.goto(`${BASE}/admin`);
  await shot(page, size, '13-admin-denied');
  await ctx.close();

  const actx = await browser.newContext({ viewport });
  const ap = await actx.newPage();
  ap.on('pageerror', (e) => problems.push(`${size} admin pageerror: ${e.message}`));
  await login(ap, 'Admin');
  await ap.goto(`${BASE}/admin`);
  await shot(ap, size, '14-admin-queue');
  for (const [id, label] of [['users', 'Users'], ['audit', 'Audit log'], ['revocations', 'Revocations'], ['notices', 'Notices']]) {
    await ap.getByRole('tab', { name: label }).click();
    await shot(ap, size, `15-admin-${id}`);
  }
  await actx.close();
}
await browser.close();
console.log(problems.length ? 'PROBLEMS:\n' + problems.join('\n') : 'no problems');
