// Builds latest.json for tauri-plugin-updater (Tauri v2 static JSON format) from the signed bundles
// of one release.
//
//   node scripts/updater-json.mjs --dir out --tag v0.3.0 [--repo cheatoskar/tm-horizon] [--notes "..."] > latest.json
//
// `dir` holds the release assets as uploaded (spaces already replaced by hyphens): the NSIS
// `*-setup.exe` and the `*.AppImage`, each with the `.sig` file Tauri wrote next to it.
// A platform without its .sig file is left out; no platform at all is an error.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_REPO = 'cheatoskar/tm-horizon';

/** Which updater platform an asset is the update payload for, or null. */
export function platformOf(name) {
  if (/-setup\.exe$/i.test(name)) return 'windows-x86_64';
  if (/\.AppImage$/i.test(name)) return 'linux-x86_64';
  return null;
}

/** Download URL of a release asset (name percent-encoded). */
export function assetUrl(repo, tag, name) {
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

/**
 * @param {{ tag: string, repo?: string, notes?: string, pubDate?: string,
 *           files: Record<string, string> }} opts files: asset name -> content (only the .sig files are read)
 */
export function buildLatestJson({ tag, repo = DEFAULT_REPO, notes = '', pubDate = new Date().toISOString(), files }) {
  const platforms = {};
  for (const name of Object.keys(files).sort()) {
    const platform = platformOf(name);
    const sig = files[`${name}.sig`];
    if (!platform || typeof sig !== 'string' || !sig.trim()) continue;
    platforms[platform] = { signature: sig.trim(), url: assetUrl(repo, tag, name) };
  }
  if (!Object.keys(platforms).length) throw new Error('no signed bundle found (need *-setup.exe.sig or *.AppImage.sig)');
  return { version: tag.replace(/^v/, ''), notes, pub_date: pubDate, platforms };
}

function main(argv) {
  const arg = (k, d) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : d;
  };
  const dir = arg('dir');
  const tag = arg('tag');
  if (!dir || !tag) {
    console.error('usage: node scripts/updater-json.mjs --dir <assets> --tag v1.2.3 [--repo owner/name] [--notes text]');
    process.exit(2);
  }
  const files = {};
  for (const name of readdirSync(dir)) {
    // Only the payloads and their signatures matter; do not read the big installers.
    if (name.endsWith('.sig')) files[name] = readFileSync(join(dir, name), 'utf8');
    else if (platformOf(name)) files[name] = '';
  }
  const json = buildLatestJson({ tag, repo: arg('repo', DEFAULT_REPO), notes: arg('notes', ''), files });
  process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
