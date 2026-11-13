// Local test of the self-update without GitHub: a THROWAWAY key pair, a fake installer, signed,
// plus a tampered copy, served on 127.0.0.1. Nothing here touches the production key.
//
//   node tools/updater-e2e.mjs [--dir <folder>] [--port 8765] [--selftest] [--no-serve]
//
// Writes into <folder> (default %TEMP%/tmh-upd-e2e): test.key, test.key.pub, pubkey.txt,
//   good/  TM-Horizon_9.9.9_x64-setup.exe + .sig + latest.json   (valid signature)
//   bad/   same names, the installer has one byte changed         (signature check must fail)
// then serves the folder and prints the lines that start the debug app against it.
// --selftest: serve, fetch latest.json and the .sig over HTTP, check the format, stop.
// Run from apps/launcher (needs the local Tauri CLI).
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, createReadStream, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLatestJson } from '../../../scripts/updater-json.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (k) => argv.includes(`--${k}`);

const root = resolve(arg('dir', join(tmpdir(), 'tmh-upd-e2e')));
const port = Number(arg('port', '8765'));
const VERSION = '9.9.9';
const NAME = `TM-Horizon_${VERSION}_x64-setup.exe`;
const PASSWORD = 'tmh-e2e-throwaway';
const launcher = resolve(fileURLToPath(new URL('..', import.meta.url)));

function tauri(args, extraEnv = {}) {
  const r = spawnSync('npx', ['tauri', ...args], { cwd: launcher, shell: true, encoding: 'utf8', env: { ...process.env, ...extraEnv } });
  if (r.status !== 0) throw new Error(`tauri ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

function prepare() {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'good'), { recursive: true });
  mkdirSync(join(root, 'bad'), { recursive: true });
  const key = join(root, 'test.key');
  tauri(['signer', 'generate', '--ci', '-p', PASSWORD, '-w', key]);
  const pubkey = readFileSync(`${key}.pub`, 'utf8').trim();
  writeFileSync(join(root, 'pubkey.txt'), pubkey);

  // A fake installer: only bytes, never run by anything.
  const bytes = Buffer.alloc(300_000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 255;
  writeFileSync(join(root, 'good', NAME), bytes);
  tauri(['signer', 'sign', '-f', key, '-p', PASSWORD, '--app-version', VERSION, join(root, 'good', NAME)]);
  const sig = readFileSync(join(root, 'good', `${NAME}.sig`), 'utf8');

  // Tampered variant: the signature of the good file next to a changed installer.
  const evil = Buffer.from(bytes);
  evil[1000] ^= 0xff;
  writeFileSync(join(root, 'bad', NAME), evil);
  writeFileSync(join(root, 'bad', `${NAME}.sig`), sig);

  for (const v of ['good', 'bad']) {
    const json = buildLatestJson({
      tag: `v${VERSION}`,
      notes: `## Test update\n\n- Throwaway key, fake installer (${v})\n- Second line of notes\n- Third line\n- Fourth line\n- Fifth line\n- Sixth line`,
      files: { [NAME]: '', [`${NAME}.sig`]: sig },
    });
    for (const p of Object.values(json.platforms)) p.url = `http://127.0.0.1:${port}/${v}/${NAME}`;
    writeFileSync(join(root, v, 'latest.json'), `${JSON.stringify(json, null, 2)}\n`);
  }
  return pubkey;
}

function serve() {
  const base = resolve(root) + sep;
  const server = createServer((req, res) => {
    const file = resolve(join(root, normalize(decodeURIComponent((req.url ?? '/').split('?')[0]))));
    if (!file.startsWith(base) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-length': statSync(file).size, 'content-type': file.endsWith('.json') ? 'application/json' : 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', () => ok(server)); });
}

async function selftest() {
  for (const v of ['good', 'bad']) {
    const j = await (await fetch(`http://127.0.0.1:${port}/${v}/latest.json`)).json();
    const p = j.platforms?.['windows-x86_64'];
    if (j.version !== VERSION || !j.pub_date || typeof j.notes !== 'string' || !p?.signature || !p?.url) throw new Error(`${v}/latest.json is malformed`);
    const sig = await (await fetch(`http://127.0.0.1:${port}/${v}/${NAME}.sig`)).text();
    if (sig.trim() !== p.signature) throw new Error(`${v}: .sig differs from latest.json`);
    const dl = Buffer.from(await (await fetch(p.url)).arrayBuffer());
    console.log(`${v}: latest.json ok (version ${j.version}), .sig ${sig.length} chars, installer ${dl.length} bytes from ${p.url}`);
  }
}

const pubkey = prepare();
const server = await serve();
const url = `http://127.0.0.1:${port}`;
console.log(`Server is serving ${root} on ${url}`);
console.log(`To check the signatures without the app:\n  TMHUB_E2E_DIR=${root} cargo test --manifest-path src-tauri/Cargo.toml e2e_signature_files -- --ignored\n`);
for (const v of ['good', 'bad']) {
  console.log(`--- ${v === 'good' ? 'valid signature (install must pass)' : 'tampered installer (must fail with the signature message)'}`);
  console.log(`PowerShell:  $env:TMHUB_UPDATE_ENDPOINT='${url}/${v}/latest.json'; $env:TMHUB_UPDATE_PUBKEY='${pubkey}'; $env:TMHUB_UPDATE_DRY_RUN='1'; npm run tauri dev`);
  console.log(`bash:        TMHUB_UPDATE_ENDPOINT=${url}/${v}/latest.json TMHUB_UPDATE_PUBKEY='${pubkey}' TMHUB_UPDATE_DRY_RUN=1 npm run tauri dev`);
}
if (flag('selftest')) {
  try { await selftest(); } finally { server.closeAllConnections?.(); server.close(); }
} else if (flag('no-serve')) {
  server.close();
} else {
  console.log('\nCtrl+C stops the server.');
}
