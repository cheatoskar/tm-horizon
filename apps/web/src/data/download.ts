// Files of a TM Horizon release (built by the release workflow, see .github/workflows) and where to get them.
// Names follow Tauri's bundle names with the space as '-' (renamed by the release workflow); the version comes from apps/launcher/src-tauri/tauri.conf.json.
// While REPO.public is false the download buttons are disabled ("Available after the first release").
import fs from 'node:fs';
import { REPO, repoUrl } from '@tm-hub/shared';

let version = '0.0.0';
try { version = JSON.parse(fs.readFileSync('../launcher/src-tauri/tauri.conf.json', 'utf8')).version ?? version; } catch { /* keep the placeholder */ }

export const downloadsOpen = REPO.public;
export const releasePage = repoUrl('/releases/latest');
const asset = (name: string) => repoUrl(`/releases/latest/download/${name}`);

export type DownloadKind = 'windows' | 'appimage' | 'deb' | 'rpm';
export interface DownloadFile { id: DownloadKind; file: string; url: string; os: 'windows' | 'linux'; icon: string }
export const downloads: DownloadFile[] = [
  { id: 'windows', file: `TM-Horizon_${version}_x64-setup.exe`, os: 'windows', icon: 'monitor' },
  { id: 'appimage', file: `TM-Horizon_${version}_amd64.AppImage`, os: 'linux', icon: 'package' },
  { id: 'deb', file: `TM-Horizon_${version}_amd64.deb`, os: 'linux', icon: 'package' },
  { id: 'rpm', file: `TM-Horizon-${version}-1.x86_64.rpm`, os: 'linux', icon: 'package' },
].map((d) => ({ ...(d as Omit<DownloadFile, 'url'>), url: asset(d.file) }));
export const checksums = { file: 'SHA256SUMS', url: asset('SHA256SUMS') };

// Arch Linux: PKGBUILDs in packaging/arch/ of the repository.
export const arch = {
  source: 'tm-horizon',
  bin: 'tm-horizon-bin',
  folder: repoUrl('/tree/main/packaging/arch'),
  commands: (pkg: string) => `git clone ${repoUrl()}.git\ncd tm-horizon/packaging/arch/${pkg}\nmakepkg -si`,
};
export { version };
