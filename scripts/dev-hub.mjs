// Local test of the hub with one command: API (SQLite, development login), developer portal and website.
//
//   npm run dev:hub               start (seeds demo data on the first run)
//   npm run dev:hub -- --fresh    start over with an empty database (deletes apps/server/data/devhub*)
//   npm run dev:hub -- --no-web   without the website
//   Other ports (a second hub next to a running one): set PORTAL_PORT, HUB_PORT, WEB_PORT before the start.
//
//   API      http://127.0.0.1:8787   (only on this computer)
//   Portal   http://localhost:5174   (log in with "Development login")
//   Website  http://localhost:4321
//
// Everything stays on this computer: the server listens on 127.0.0.1 only, no OAuth app, no secrets,
// no .env file is read (all settings are passed below). The development login is refused by the server
// unless NODE_ENV=development and HOST is a loopback address. Ctrl+C stops all three.
// Step by step: docs/hub/local-test.md
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const node = process.execPath;
const serverDir = join(root, 'apps/server');
const PORTAL_PORT = process.env.PORTAL_PORT || '5174';
const HUB_PORT = process.env.HUB_PORT || '8787';
const WEB_PORT = process.env.WEB_PORT || '4321';
const portalUrl = `http://localhost:${PORTAL_PORT}/`;

const env = {
  ...process.env,
  NODE_ENV: 'development',
  HOST: '127.0.0.1',
  PORT: HUB_PORT,
  HUB_DEV_LOGIN: '1',
  HUB_PUBLIC_URL: portalUrl,
  HUB_PORTAL_URL: portalUrl,
  DATABASE_URL: 'sqlite:./data/devhub.sqlite',
  STORAGE: 'fs',
  STORAGE_DIR: './data/devhub-files',
  // No background crawler: without a GitHub token it would use up GitHub's 60 requests per hour on
  // the ~100 catalog sources. Imports and "Check now" still ask GitHub directly.
  CRAWLER: '0',
  VT_UPLOAD: '0',
  TMF_ENABLED: '0',
  TMF_LIVE: '0',
  HUB_ADMINS: '',
  DISCORD_WEBHOOK_URL: '',
  VT_API_KEY: '',
};
const nodeFlags = ['--disable-warning=ExperimentalWarning'];

const db = join(serverDir, 'data/devhub.sqlite');
if (args.includes('--fresh')) {
  for (const f of ['', '-wal', '-shm']) rmSync(db + f, { force: true });
  rmSync(join(serverDir, 'data/devhub-files'), { recursive: true, force: true });
  console.log('[dev-hub] fresh start: database and files deleted');
}
if (!existsSync(db)) {
  console.log('[dev-hub] first run: demo data (catalog projects, a demo project in every state, a report, a claim)');
  const r = spawnSync(node, [...nodeFlags, 'scripts/seed.ts'], { cwd: serverDir, env, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const webDir = join(root, 'apps/web');
const withWeb = !args.includes('--no-web');
if (withWeb && !existsSync(join(webDir, 'src/data/site.json'))) {
  console.log('[dev-hub] website data missing: building it once (scripts/build-data.mjs)');
  const r = spawnSync(node, ['scripts/build-data.mjs'], { cwd: webDir, env: process.env, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

/** A package's file, looked up in the app's own node_modules first, then the workspace root (no exports map). */
function bin(appDir, pkg, file) {
  for (const base of [join(appDir, 'node_modules'), join(root, 'node_modules')]) {
    const p = join(base, pkg, file);
    if (existsSync(p)) return p;
  }
  throw new Error(`${pkg}/${file} not found: run npm ci in ${root}`);
}

const children = [];
function run(name, cwd, argv, childEnv = process.env) {
  const c = spawn(node, argv, { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = `[${name}]`.padEnd(9);
  const pipe = (s, out) => {
    let rest = '';
    s.on('data', (b) => {
      const lines = (rest + b.toString()).split(/\r?\n/);
      rest = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) out.write(`${tag}${l}\n`);
    });
  };
  pipe(c.stdout, process.stdout);
  pipe(c.stderr, process.stderr);
  c.on('exit', (code) => {
    console.log(`${tag}stopped (${code ?? 'signal'})`);
    if (!stopping) stop(code ?? 1);
  });
  children.push(c);
}

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill();
  setTimeout(() => process.exit(code), 500);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

run('hub', serverDir, [...nodeFlags, 'src/main.ts'], env);
run('portal', join(root, 'apps/portal'), [bin(join(root, 'apps/portal'), 'vite', 'bin/vite.js'), '--port', PORTAL_PORT, '--strictPort', '--host', '127.0.0.1'], { ...process.env, HUB_API_URL: `http://127.0.0.1:${HUB_PORT}` });
if (withWeb) run('web', webDir, [bin(webDir, 'astro', 'astro.js'), 'dev', '--port', WEB_PORT, '--host', '127.0.0.1']);

// Banner once the API answers.
const until = Date.now() + 60_000;
(async function banner() {
  while (Date.now() < until && !stopping) {
    try {
      const keys = await (await fetch(`http://127.0.0.1:${HUB_PORT}/v1/index/keys`)).json();
      console.log([
        '',
        '================ TM Horizon hub: local test ================',
        `  Portal   ${portalUrl}   (Login > Development login > admin or author)`,
        withWeb ? `  Website  http://localhost:${WEB_PORT}/   (legal pages: /de/impressum/, /de/datenschutz/, /de/nutzungsbedingungen/)` : '',
        `  API      http://127.0.0.1:${HUB_PORT}/v1/index.json (signed index)`,
        `  Launcher (debug build): TMHUB_HUB_DEV_PUBKEYS=${keys.current.publicKey}`,
        `           then Settings > TM Horizon Hub: ${portalUrl}`,
        '  Steps: docs/hub/local-test.md        Stop: Ctrl+C',
        '  DEVELOPMENT LOGIN IS ON (made-up accounts, this computer only)',
        '=============================================================',
        '',
      ].filter((l) => l !== '').join('\n'));
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 700));
    }
  }
})();
