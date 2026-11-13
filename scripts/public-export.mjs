// Clean public export of this repository: the committed tree of HEAD without private parts, as a fresh git
// repository with a single commit. Nothing is pushed.
//
//   node scripts/public-export.mjs --out ../tm-horizon-public-export [--message "TM Horizon 0.5.0" | --message-file msg.txt]
//
// Left out: the TMF master-server bot (packages/tmf-master, docs/tmf-master; the hub's /tmf/servers route then
// always answers "tmf-disabled"), the staging notes and deploy script, .env files (the documented .env.example
// files stay), packet captures, the development screenshot folders (they can show local paths; the vetted ones
// are in docs/screenshots). The DATABASE_URL example in docs/hub/secrets.md shows `<password>`.
// The output folder is replaced (only when it is empty or an earlier export: it must hold .public-export).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const out = path.resolve(opt('--out', path.join(repo, '..', 'tm-horizon-public-export')));
const messageFile = opt('--message-file', null);
const message = messageFile ? fs.readFileSync(messageFile, 'utf8').trimEnd() : opt('--message', 'TM Horizon ' + JSON.parse(fs.readFileSync(path.join(repo, 'apps/launcher/package.json'), 'utf8')).version);

const EXCLUDE = [
  /^packages\/tmf-master\//,
  /^docs\/tmf-master\//,
  /^docs\/hub\/staging\.md$/,
  /^scripts\/deploy-staging\.sh$/,
  // Production box specifics stay private (self-hosting docs: docs/hub/deploy-oracle.md).
  /^docs\/hub\/production\.md$/,
  /^scripts\/deploy-prod\.sh$/,
  /^apps\/server\/deploy\/prod\//,
  /(^|\/)\.env(\..*)?$/,
  /\.pcapng?$/i,
  /^screens\//,
  /^apps\/[^/]+\/screens\//,
];
const KEEP = [/(^|\/)\.env\.example$/];
const excluded = (p) => EXCLUDE.some((r) => r.test(p)) && !KEEP.some((r) => r.test(p));

const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28 });

// 1. Output folder
if (fs.existsSync(out)) {
  const entries = fs.readdirSync(out);
  if (entries.length && !entries.includes('.public-export')) throw new Error(`${out} exists and is not an earlier export; refusing to replace it`);
  fs.rmSync(out, { recursive: true, force: true });
}
fs.mkdirSync(out, { recursive: true });

// 2. Committed files of HEAD
const files = git('ls-tree', '-r', '-z', '--name-only', 'HEAD').split('\0').filter(Boolean);
const kept = files.filter((f) => !excluded(f));
for (const f of kept) {
  const dest = path.join(out, f);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, execFileSync('git', ['show', `HEAD:${f}`], { cwd: repo, maxBuffer: 1 << 28 }));
}

// 3. Edits
const edit = (rel, fn) => { const p = path.join(out, rel); if (fs.existsSync(p)) fs.writeFileSync(p, fn(fs.readFileSync(p, 'utf8'))); };
edit('docs/hub/secrets.md', (s) => s.replace(/postgres:\/\/tmhub:<pw>@/g, 'postgres://tmhub:<password>@'));
edit('package.json', (s) => s.replace(/\s*"packages\/tmf-master",/, ''));
edit('apps/server/package.json', (s) => s.replace(/\s*"@tm-hub\/tmf-master": "\*",/, ''));
edit('apps/server/src/services/tmf.ts', (s) => s
  .replace(/import \{ loadConfig as loadTmfConfig, TmfServerService \} from '@tm-hub\/tmf-master';\n/, '')
  .replace(/export function createTmfService\([^]*?\n\}\n/, `/** The master-server bot is not part of the public code: the route always answers "tmf-disabled". */
export function createTmfService(_cfg: Config, _env: Record<string, string | undefined> = process.env): (TmfSource & { stop(): Promise<void> }) | null {
  return null;
}
`));
edit('package-lock.json', (s) => {
  const j = JSON.parse(s);
  const ws = j.packages[''].workspaces;
  if (Array.isArray(ws)) j.packages[''].workspaces = ws.filter((w) => w !== 'packages/tmf-master');
  delete j.packages['packages/tmf-master'];
  delete j.packages['node_modules/@tm-hub/tmf-master'];
  const srv = j.packages['apps/server'];
  if (srv?.dependencies) delete srv.dependencies['@tm-hub/tmf-master'];
  return JSON.stringify(j, null, 2) + '\n';
});
// Local user paths and the Windows user name (dev notes, preview data) and the staging host name.
const user = os.userInfo().username;
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const userPath = new RegExp(String.raw`[A-Za-z]:[\\/]+Users[\\/]+` + esc(user) + String.raw`(?=[\\/"'\s)]|$)`, 'gi');
const replayPrefix = new RegExp(String.raw`\b` + esc(user) + '_', 'g');
for (const f of kept) {
  const p = path.join(out, f);
  const buf = fs.readFileSync(p);
  if (buf.includes(0)) continue; // binary
  const t = buf.toString('utf8');
  const n = t.replace(userPath, '%USERPROFILE%').replace(replayPrefix, 'player_').replace(/hub-staging\.tm-horizon\.com/g, 'hub.example.org');
  if (n !== t) fs.writeFileSync(p, n);
}
// No file-share link (Drive, Yandex, Mega, MediaFire, Dropbox, OneDrive, Discord attachments) may leave in the
// public code (packages/catalog/check-release.mjs); stop before the commit.
const { checkTreeForShares } = await import(new URL('../packages/catalog/check-release.mjs', import.meta.url).href);
const shares = checkTreeForShares(out);
if (shares.length) { console.error('public export stopped, file-share links:\n  ' + shares.join('\n  ')); process.exit(1); }
fs.writeFileSync(path.join(out, '.public-export'), `Exported from the private repository (HEAD ${git('rev-parse', '--short', 'HEAD').trim()}) by scripts/public-export.mjs.\n`);

// 4. Fresh history, one commit (author and committer from this repository's git config)
const name = git('config', 'user.name').trim();
const email = git('config', 'user.email').trim();
const run = (...a) => execFileSync('git', a, { cwd: out, stdio: 'ignore' });
run('init', '-q', '-b', 'main');
run('add', '-A');
const msgFile = path.join(os.tmpdir(), `tmh-export-msg-${process.pid}.txt`);
fs.writeFileSync(msgFile, message + '\n');
run('-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-q', '-F', msgFile);
fs.rmSync(msgFile, { force: true });

console.log(`exported ${kept.length} of ${files.length} files to ${out}`);
console.log('left out:\n' + files.filter(excluded).map((f) => '  ' + f).join('\n'));
