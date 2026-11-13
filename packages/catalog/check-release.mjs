// Release check of the catalog against release-policy.json (rules: docs/legal/permissions.md). After the policy
// is applied (hide, linkOnly), an entry the launcher shows must not
//   - install from anywhere but a GitHub repository listed in installLicences (OSI licence or my own),
//   - describe a copy-protection workaround (StarForce bypass, no-CD, crack).
// No entry at all (hidden ones included, the whole catalog is public source) may link a personal file share
// (Google Drive, Yandex Disk, Mega, MediaFire, Dropbox, OneDrive/SharePoint, Discord attachments) as its page,
// mirror or download. Every id in the policy must exist, except the ids in policy.removed, which must not.
// Exit code 1 on a violation. The public launcher build runs it (apps/launcher/vite.config.ts); by hand:
//   node packages/catalog/check-release.mjs
//   node packages/catalog/check-release.mjs --tree <dir>   only the file-share scan of a tree (scripts/public-export.mjs runs it)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/** StarForce or copy protection together with bypass words, no-CD, crack. */
export const DRM_WORKAROUND = /(starforce|copy[- ]protection)[^.]{0,60}\b(bypass|despite|without|free|remov|crack|patch)|\b(bypass|despite|without|remov|crack)[^.]{0,40}(starforce|copy[- ]protection)|\bno[- ]?cd\b|\bcrack(ed)?\b/i;

/** Host names of personal file shares (tested against a URL's hostname). */
export const SHARE_HOST = /(^|\.)(discordapp\.com|discordapp\.net|drive\.google\.com|drive\.usercontent\.google\.com|disk\.yandex\.[a-z.]+|yadi\.sk|mega\.(nz|io|co\.nz)|mediafire\.com|dropbox\.com|dropboxusercontent\.com|1drv\.ms|onedrive\.live\.com|sharepoint\.com)$/i;
/** A file-share link in free text: the host followed by a path. A bare host in code (a URL prefix test) does not count. */
export const SHARE_LINK = /\b(drive\.google\.com|drive\.usercontent\.google\.com|disk\.yandex\.[a-z.]+|yadi\.sk|mega\.(nz|io|co\.nz)|mediafire\.com|dropbox\.com|dropboxusercontent\.com|1drv\.ms|onedrive\.live\.com|[a-z0-9-]+\.sharepoint\.com|(cdn|media)\.discordapp\.(com|net)\/attachments)\/[^\s"'`)\]]/i;

const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
/** Public server invites (discord.gg, discordapp.com/invite/...) are fine; attachments and shares are not. */
export const isShareUrl = (u) => SHARE_HOST.test(hostOf(u)) && !/^https:\/\/(www\.)?discord(app)?\.com\/invite\//i.test(u);

/** Violations as text lines (empty: fine). */
export function checkRelease(catalog, policy) {
  const out = [];
  const ids = new Set(catalog.entries.map((e) => e.id));
  // Removed ids (taken out of the source for good) stay in hide, so a re-import stays hidden; they must not come back.
  const removed = new Set(policy.removed ?? []);
  for (const id of removed) if (ids.has(id)) out.push(`${id}: removed from the catalog for good (policy.removed); take it out again`);
  for (const k of ['hide', 'linkOnly', 'noShowcase']) for (const id of Object.keys(policy[k] ?? {})) if (!ids.has(id) && !removed.has(id)) out.push(`policy.${k}: unknown id ${id}`);
  const allowed = new Set(Object.keys(policy.installLicences ?? {}).map((r) => r.toLowerCase()));
  for (const e of catalog.entries) {
    for (const u of [e.url, ...(e.urls ?? []), e.installSpec?.download?.url].filter(Boolean)) if (isShareUrl(u)) out.push(`${e.id}: links a file share (${hostOf(u)})`);
    if (e.id in (policy.hide ?? {})) continue;
    const linkOnly = e.id in (policy.linkOnly ?? {});
    if (['discord-attachment', 'google-drive', 'yandex'].includes(e.hosting)) out.push(`${e.id}: hosting ${e.hosting} is not allowed in a release`);
    // Copy-protection workarounds (StarForce bypasses, no-CD/cracked exes) are never linked or installed.
    const text = [e.name, e.description, e.note, e.downloadNote, e.install].filter(Boolean).join(' ');
    if (DRM_WORKAROUND.test(text)) out.push(`${e.id}: describes a copy-protection workaround (StarForce/no-CD/crack); hide it`);
    const spec = linkOnly ? null : e.installSpec;
    if (!spec) continue;
    const d = spec.download ?? {};
    let repo = d.github ?? null;
    if (!repo && d.url) {
      const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\//i.exec(d.url);
      repo = m ? m[1] : null;
      if (!repo) { out.push(`${e.id}: installs from ${hostOf(d.url) || d.url} (not a GitHub release)`); continue; }
    }
    if (repo && !allowed.has(repo.toLowerCase())) out.push(`${e.id}: installs from ${repo}, which is not in installLicences`);
  }
  return out;
}

/** File-share links anywhere in the launcher's UI strings and sources (i18n JSON, src/*.ts(x), src-tauri/src/*.rs):
 * file shares are never offered, from the catalog or from a hard-coded link. Returns violations. */
export function checkLauncherSources(launcherDir) {
  const out = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'target' || e.name === 'generated' ? [] : walk(p);
    return /\.(json|tsx?|rs)$/.test(e.name) && !/\.test\.ts$/.test(e.name) ? [p] : [];
  });
  for (const f of [...walk(path.join(launcherDir, 'src')), ...walk(path.join(launcherDir, 'src-tauri', 'src'))]) {
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    lines.forEach((l, i) => { if (SHARE_LINK.test(l)) out.push(`${path.relative(launcherDir, f)}:${i + 1}: file-share link`); });
  }
  return out;
}

/** Every text file of a source tree (the public export): no file-share link anywhere. Returns violations. */
export function checkTreeForShares(dir) {
  const out = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) return ['.git', 'node_modules', 'target', 'dist'].includes(e.name) ? [] : walk(p);
    return [p];
  });
  for (const f of walk(dir)) {
    const buf = fs.readFileSync(f);
    if (buf.includes(0)) continue; // binary
    buf.toString('utf8').split(/\r?\n/).forEach((l, i) => {
      if (SHARE_LINK.test(l)) out.push(`${path.relative(dir, f)}:${i + 1}: file-share link`);
    });
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ti = process.argv.indexOf('--tree');
  if (ti > 0) {
    const v = checkTreeForShares(path.resolve(process.argv[ti + 1]));
    if (v.length) { console.error('tree check failed:\n  ' + v.join('\n  ')); process.exit(1); }
    console.log('tree check: ok (no file-share links)');
    process.exit(0);
  }
  const catalog = JSON.parse(fs.readFileSync(path.join(here, 'catalog.json'), 'utf8'));
  const policy = JSON.parse(fs.readFileSync(path.join(here, 'release-policy.json'), 'utf8'));
  const v = [...checkRelease(catalog, policy), ...checkLauncherSources(path.join(here, '..', '..', 'apps', 'launcher'))];
  if (v.length) { console.error('catalog release check failed:\n  ' + v.join('\n  ')); process.exit(1); }
  console.log(`catalog release check: ok (${catalog.entries.filter((e) => !(e.id in policy.hide)).length} entries shown)`);
}
