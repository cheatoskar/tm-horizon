// Copies the developer docs from their source repositories into apps/web/src/content/dev/ as a versioned snapshot.
// Every synced file gets a front matter block with source repo, branch, commit and path; the page shows it
// and links "Edit on GitHub" to the source file. Run it by hand when a source doc changed, commit the result:
//   node scripts/sync-dev-docs.mjs            (writes the files)
//   node scripts/sync-dev-docs.mjs --check    (exit 1 when a file on disk differs from the sources)
// Hand-written pages (public API, third-party APIs, showcase reference) live in the same folder and are never touched.
//
// Source folders: the hub repository is the one this script lives in; the other two are siblings of the
// worktree folder (override with HORIZON_HOST_DIR, HORIZON_KIT_DIR). Files are read with `git show <ref>:<path>`,
// so the working tree state of the source does not matter, only the branch.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'apps', 'web', 'src', 'content', 'dev');
const check = process.argv.includes('--check');

// gh: GitHub path of the repo (the repos are private for now, so the links work once they are public).
// The names of the host and kit repos are assumed to be the folder names; change them here if they differ.
const REPOS = {
  hub: { name: 'tm-horizon', gh: 'cheatoskar/tm-horizon', dir: ROOT, refs: ['integration-1111', 'main'] },
  host: { name: 'horizon-host', gh: 'cheatoskar/horizon-host', dir: process.env.HORIZON_HOST_DIR ?? join(ROOT, '..', 'horizon-host'), refs: ['client-mods'] },
  hostperf: { name: 'horizon-host', gh: 'cheatoskar/horizon-host', dir: process.env.HORIZON_HOST_DIR ?? join(ROOT, '..', 'horizon-host'), refs: ['perf'] },
  kit: { name: 'horizon-porting-kit', gh: 'cheatoskar/horizon-porting-kit', dir: process.env.HORIZON_KIT_DIR ?? join(ROOT, '..', 'horizon-porting-kit'), refs: ['main'] },
};

// slug = path below /dev/docs/. order: position in its group.
const DOCS = [
  // Publish on TM Horizon
  { slug: 'publishing', repo: 'hub', path: 'docs/mod-publishing.md', group: 'publish', order: 1, title: 'Publishing mods',
    note: 'Design document. Releases from GitHub or a TMLoader server, claims, the hold and the checks are built; signatures and the full portal flow are still being finished.' },
  { slug: 'related-links', repo: 'hub', path: 'docs/hub/related-links.md', group: 'publish', order: 3, title: 'Related links' },
  { slug: 'server-registration', repo: 'hub', path: 'docs/hub/server-registration.md', group: 'publish', order: 4, title: 'Registering game servers' },
  {
    slug: 'review-and-claims', repo: 'hub', path: 'docs/hub/moderation.md', group: 'publish', order: 5, title: 'Review, claims and appeals',
    sections: ['Versions in review', 'Statement of reasons (DSA Art. 17)', 'Appeals', 'Claims'],
    lead: 'The parts of the moderators\' runbook that concern authors: why a version waits for review, what a rejection must say, how to appeal, how claims work.',
  },
  // Horizon plugins and scripts
  { slug: 'horizon-host', repo: 'host', path: 'README.md', group: 'plugins', order: 1, title: 'Horizon Host' },
  { slug: 'plugin-abi', repo: 'host', path: 'docs/plugin-abi.md', group: 'plugins', order: 2, title: 'Plugin guide and ABI',
    note: 'ABI 1.3 (toasts and the TM Horizon bridge) is still being consolidated and not released yet. 1.0 to 1.2 are stable.' },
  { slug: 'scripting', repo: 'host', path: 'docs/scripting.md', group: 'plugins', order: 3, title: 'Horizon Scripts (AngelScript)',
    note: 'Scripts are on the same unreleased branch as ABI 1.3. The API can still change.' },
  { slug: 'client-bridge', repo: 'host', path: 'docs/client-bridge.md', group: 'plugins', order: 4, title: 'Talking to the launcher: the bridge',
    note: 'Part of ABI 1.3, not released yet.' },
  { slug: 'profile-json', repo: 'host', path: 'docs/profile-json.md', group: 'plugins', order: 5, title: 'profile.json' },
  { slug: 'performance', repo: 'hostperf', path: 'docs/performance.md', group: 'plugins', order: 6, title: 'Performance',
    note: 'From the performance branch, not merged into the client-mods branch yet.' },
  { slug: 'roadmap', repo: 'host', path: 'docs/roadmap.md', group: 'plugins', order: 7, title: 'Roadmap' },
  // Example plugins
  { slug: 'plugin-tmx-upload', repo: 'host', path: 'docs/plugins/tmx-upload.md', group: 'examples', order: 1, title: 'TMX Upload' },
  { slug: 'plugin-wr-hunter', repo: 'host', path: 'docs/plugins/wr-hunter.md', group: 'examples', order: 2, title: 'WR Hunter' },
  { slug: 'plugin-input-display', repo: 'host', path: 'docs/plugins/input-display.md', group: 'examples', order: 3, title: 'Input Display' },
  { slug: 'plugin-tmx-browser', repo: 'host', path: 'docs/plugins/tmx-browser.md', group: 'examples', order: 4, title: 'TMX Browser' },
  // Porting kit
  { slug: 'porting-kit', repo: 'kit', path: 'README.md', group: 'porting', order: 1, title: 'Porting kit' },
  { slug: 'porting', repo: 'kit', path: 'docs/PORTING.md', group: 'porting', order: 2, title: 'Porting guide' },
  { slug: 'ai-porting', repo: 'kit', path: 'docs/AI-PORTING.md', group: 'porting', order: 3, title: 'Porting with a coding agent' },
  { slug: 'automation', repo: 'kit', path: 'docs/AUTOMATION.md', group: 'porting', order: 4, title: 'CI builds per game' },
  { slug: 'atlas', repo: 'kit', path: 'docs/ATLAS.md', group: 'porting', order: 5, title: 'The address atlas' },
  { slug: 'assessment', repo: 'kit', path: 'docs/ASSESSMENT.md', group: 'porting', order: 6, title: 'What ports how easily' },
];

const git = (repo, args) => execFileSync('git', ['-C', repo.dir, ...args], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
const resolved = new Map();
function resolveRef(key) {
  if (resolved.has(key)) return resolved.get(key);
  const repo = REPOS[key];
  if (!existsSync(repo.dir)) throw new Error(`${key}: folder ${repo.dir} not found`);
  for (const ref of repo.refs) {
    try { const commit = git(repo, ['rev-parse', '--short=10', `${ref}^{commit}`]).trim(); const r = { ref, commit }; resolved.set(key, r); return r; } catch { /* next ref */ }
  }
  throw new Error(`${key}: none of ${repo.refs.join(', ')} exists in ${repo.dir}`);
}

// Lookup: "<repo name>:<path>" -> slug, so links between synced docs become site links.
const bySource = new Map(DOCS.map((d) => [`${REPOS[d.repo].name}:${d.path}`, d.slug]));

function rewriteLinks(text, d) {
  const repo = REPOS[d.repo];
  const { ref } = resolveRef(d.repo);
  const dir = posix.dirname(d.path);
  const target = (raw) => {
    const m = raw.match(/^([^#]*)(#.*)?$/);
    const file = m[1], hash = m[2] ?? '';
    if (!file) return raw; // same-page anchor
    if (/^[a-z][a-z0-9+.-]*:/i.test(file) || file.startsWith('//')) return raw;
    const p = posix.normalize(file.startsWith('/') ? file.slice(1) : posix.join(dir, file));
    const slug = bySource.get(`${repo.name}:${p}`);
    if (slug) return `/dev/docs/${slug}/${hash}`;
    if (p.startsWith('..')) return raw;
    const kind = /\.[a-z0-9]+$/i.test(p) ? 'blob' : 'tree';
    return `https://github.com/${repo.gh}/${kind}/${ref}/${p.replace(/\/$/, '')}${hash}`;
  };
  let fence = false;
  return text.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return line; }
    if (fence) return line;
    return line.replace(/(!?)\[([^\]]*)\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g, (all, bang, label, url, title) => {
      if (bang) { // relative images point into the repo (works once it is public)
        if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return all;
        const p = posix.normalize(posix.join(dir, url));
        return `${bang}[${label}](https://raw.githubusercontent.com/${repo.gh}/${ref}/${p}${title})`;
      }
      return `[${label}](${target(url)}${title})`;
    });
  }).join('\n');
}

function section(text, names) {
  const lines = text.split('\n');
  const out = [];
  let take = false, fence = false;
  for (const l of lines) {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    const h = !fence && l.match(/^(#{1,2})\s+(.*?)\s*$/);
    if (h) take = names.includes(h[2]);
    if (take) out.push(l);
  }
  const missing = names.filter((n) => !lines.some((l) => l.replace(/\s+$/, '') === `## ${n}`));
  if (missing.length) throw new Error(`sections not found: ${missing.join(', ')}`);
  return out.join('\n');
}

const q = (s) => JSON.stringify(s);
let changed = 0;
for (const d of DOCS) {
  const repo = REPOS[d.repo];
  const { ref, commit } = resolveRef(d.repo);
  let src = git(repo, ['show', `${ref}:${d.path}`]).replace(/\r\n/g, '\n');
  // title line out (the page prints the title), keep the rest
  src = src.replace(/^﻿/, '').replace(/^# .*\n+/, '');
  if (d.sections) src = section(src, d.sections);
  src = rewriteLinks(src, d).trim() + '\n';
  const head = [
    '---',
    `title: ${q(d.title)}`,
    `group: ${q(d.group)}`,
    `order: ${d.order}`,
    'synced: true',
    `sourceRepo: ${q(repo.gh)}`,
    `sourceBranch: ${q(ref)}`,
    `sourceCommit: ${q(commit)}`,
    `sourcePath: ${q(d.path)}`,
    `editUrl: ${q(`https://github.com/${repo.gh}/edit/${ref}/${d.path}`)}`,
    ...(d.note ? [`note: ${q(d.note)}`] : []),
    '---',
    '',
  ].join('\n');
  const body = (d.lead ? `${d.lead}\n\n` : '') + src;
  const file = join(OUT, `${d.slug}.md`);
  const next = head + body;
  const prev = existsSync(file) ? readFileSync(file, 'utf8') : null;
  if (prev !== next) {
    changed++;
    if (check) console.error(`differs: ${d.slug}.md`);
    else { mkdirSync(OUT, { recursive: true }); writeFileSync(file, next, 'utf8'); console.log(`wrote ${d.slug}.md  (${repo.gh}@${ref} ${commit})`); }
  }
}
if (check && changed) { console.error(`sync-dev-docs: ${changed} file(s) out of date, run node scripts/sync-dev-docs.mjs`); process.exit(1); }
console.log(`sync-dev-docs: ${DOCS.length} docs, ${changed} ${check ? 'differ' : 'written'}`);
