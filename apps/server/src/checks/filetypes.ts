// Which files a version may contain, per install type. Decided by extension AND content: a PE
// file (MZ header) or an ELF/Mach-O binary under an innocent name counts as an executable.
import type { CheckSeverity, HubInstallType } from '@tm-hub/shared/hub';

/** Allowed everywhere: notes, licences, pictures, configs. */
const COMMON = ['txt', 'md', 'json', 'yaml', 'yml', 'ini', 'cfg', 'toml', 'xml', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'nfo', 'csv'];
/** Game assets (textures, sounds, maps and other GBX files, shaders, fonts, packs). */
const ASSETS = ['gbx', 'dds', 'tga', 'ogg', 'wav', 'mux', 'mp3', 'webm', 'fx', 'fxh', 'hlsl', 'glsl', 'cso', 'fnt', 'ttf', 'otf', 'zip', 'pak', 'bik', 'mat'];

/** Executable code: allowed only where a loader runs it, and always looked at more closely. */
export const EXECUTABLE = ['dll', 'exe', 'asi'];
/** Never accepted: scripts and installers Windows runs on a double click, shortcuts, drivers. */
export const FORBIDDEN = ['bat', 'cmd', 'com', 'scr', 'pif', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta', 'lnk', 'url', 'reg', 'msi', 'msp', 'sys', 'cpl', 'jar', 'appx', 'msix', 'inf', 'chm', 'iso', 'img', 'vhd', 'vhdx', 'docm', 'xlsm', 'html', 'htm', 'svg', 'sh', 'ocx', 'drv'];

interface Rule {
  allow: string[];
  /** Executable extensions accepted here (each still gets a finding). */
  exec: string[];
  /** Severity when an executable is present at all. */
  execSeverity: CheckSeverity;
}

export const RULES: Record<HubInstallType, Rule> = {
  'tmloader-product': { allow: [...COMMON, ...ASSETS], exec: ['dll', 'exe'], execSeverity: 'info' },
  'files:game': { allow: [...COMMON, ...ASSETS], exec: ['dll', 'asi', 'exe'], execSeverity: 'info' },
  'files:gamedata': { allow: [...COMMON, ...ASSETS], exec: [], execSeverity: 'reject' },
  'files:documents': { allow: [...COMMON, ...ASSETS], exec: [], execSeverity: 'reject' },
  'files:tmi-plugins': { allow: [...COMMON, 'as'], exec: ['dll'], execSeverity: 'flag' },
  'files:tmi-scripts': { allow: [...COMMON, 'inputs'], exec: [], execSeverity: 'reject' },
};

/** Extension without the dot, lower case ("Track.Map.Gbx" -> "gbx"); "" for names without one. */
export function extOf(path: string): string {
  const base = path.split('/').pop() ?? '';
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i + 1).toLowerCase();
}

/** Binary formats that run on their own, recognised by their first bytes. */
export function binaryKind(b: Uint8Array): 'pe' | 'elf' | 'macho' | null {
  if (b.length >= 2 && b[0] === 0x4d && b[1] === 0x5a) return 'pe';
  if (b.length >= 4 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return 'elf';
  if (b.length >= 4) {
    const m = (b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3];
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(m >>> 0)) return 'macho';
  }
  return null;
}

/** Plain-text names without extension that are fine (LICENSE, README, ...). */
const NAMED = /^(license|licence|readme|changelog|copying|authors|notice|credits)$/i;

export interface TypeVerdict {
  severity: CheckSeverity | null;
  code: string;
  message: string;
  executable: boolean;
}

export function classify(path: string, data: Uint8Array, type: HubInstallType): TypeVerdict {
  const rule = RULES[type];
  const ext = extOf(path);
  const base = path.split('/').pop() ?? path;
  const bin = binaryKind(data);
  if (FORBIDDEN.includes(ext)) return { severity: 'reject', code: 'type.forbidden', message: `.${ext} files are never accepted (${base})`, executable: true };
  if (bin && bin !== 'pe') return { severity: 'reject', code: 'type.foreign-binary', message: `${base} is a ${bin.toUpperCase()} program`, executable: true };
  if (bin === 'pe' && !EXECUTABLE.includes(ext)) {
    return { severity: 'reject', code: 'type.hidden-executable', message: `${base} is a Windows program disguised as .${ext || 'file without extension'}`, executable: true };
  }
  if (EXECUTABLE.includes(ext)) {
    if (!rule.exec.includes(ext)) return { severity: 'reject', code: 'type.executable-not-allowed', message: `.${ext} files are not allowed for this install type (${base})`, executable: true };
    if (bin !== 'pe') return { severity: 'reject', code: 'type.fake-executable', message: `${base} is named .${ext} but is not a Windows program`, executable: true };
    const sev: CheckSeverity = ext === 'exe' ? 'flag' : ext === 'asi' ? 'flag' : rule.execSeverity;
    return { severity: sev, code: ext === 'exe' ? 'type.exe' : 'type.executable', message: `Executable code: ${path}`, executable: true };
  }
  if (!ext && NAMED.test(base)) return { severity: null, code: 'type.ok', message: '', executable: false };
  if (!rule.allow.includes(ext)) return { severity: 'flag', code: 'type.unknown', message: `Unusual file type .${ext || '(none)'} for this install type: ${path}`, executable: false };
  return { severity: null, code: 'type.ok', message: '', executable: false };
}
