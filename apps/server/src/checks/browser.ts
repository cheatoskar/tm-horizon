// Checks for browser extensions (project type "browser-extension"). Their files are JavaScript, HTML and
// CSS, which the game install types never accept (filetypes.ts FORBIDDEN). For an extension they are the
// point, so they pass here, but: no programs of any kind, a manifest.json, size limits, and a scan for the
// patterns that make an extension harmful (miners, code loaded or decoded at runtime, risky permissions).
// Every first version still goes to a person (review.new-project); this scan only decides what they look at.
// Review rule: docs/hub/moderation.md, "Browser extensions".
import type { CheckSeverity } from '@tm-hub/shared/hub';
import { binaryKind, extOf } from './filetypes.ts';

/** Files an extension may contain. */
const ALLOW = ['js', 'mjs', 'json', 'html', 'htm', 'css', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'ico', 'woff', 'woff2', 'ttf', 'otf', 'txt', 'md', 'map'];
/** Never in an extension: Windows/shell scripts, installers, shortcuts, programs. */
const NEVER = ['exe', 'dll', 'asi', 'sys', 'bat', 'cmd', 'com', 'scr', 'pif', 'ps1', 'psm1', 'vbs', 'vbe', 'jse', 'wsf', 'wsh', 'hta', 'lnk', 'url', 'reg', 'msi', 'msp', 'cpl', 'jar', 'appx', 'msix', 'inf', 'chm', 'iso', 'img', 'vhd', 'vhdx', 'sh', 'ocx', 'drv', 'so', 'dylib'];

export const BROWSER_LIMITS = { totalBytes: 20 * 1048576, fileBytes: 5 * 1048576 } as const;

/** Permissions that let an extension read or change far more than one site: a person looks at why it needs them. */
const RISKY_PERMISSIONS = ['<all_urls>', 'debugger', 'cookies', 'history', 'nativeMessaging', 'proxy', 'webRequestBlocking', 'management', 'privacy', 'downloads.open', 'clipboardRead', 'desktopCapture', 'tabCapture'];

interface Pattern { re: RegExp; severity: CheckSeverity; code: string; what: string }
const PATTERNS: Pattern[] = [
  { re: /coinhive|coin-hive|cryptonight|webminepool|minero\.cc|coinimp|cryptoloot|deepminer/i, severity: 'reject', code: 'browser.miner', what: 'a crypto miner' },
  { re: /\beval\s*\(\s*(atob|unescape|decodeURIComponent|String\.fromCharCode)\s*\(/, severity: 'flag', code: 'browser.eval-decoded', what: 'runs decoded code with eval' },
  { re: /new\s+Function\s*\(\s*(atob|unescape|String\.fromCharCode)\s*\(/, severity: 'flag', code: 'browser.function-decoded', what: 'builds a function from decoded text' },
  { re: /\.src\s*=\s*["'`]https?:\/\/[^"'`]+\.js\b/i, severity: 'flag', code: 'browser.remote-script', what: 'loads a script from another site' },
  { re: /\bimportScripts\s*\(\s*["'`]https?:/i, severity: 'flag', code: 'browser.remote-script', what: 'loads a script from another site' },
  { re: /chrome\.debugger\b|browser\.debugger\b/, severity: 'flag', code: 'browser.debugger', what: 'uses the debugger API' },
  { re: /(document\.cookie|chrome\.cookies\.getAll)[\s\S]{0,200}(fetch|XMLHttpRequest|sendBeacon)\s*\(/, severity: 'flag', code: 'browser.cookie-send', what: 'reads cookies and sends something' },
];

export interface Finding { severity: CheckSeverity; code: string; message: string; path?: string }

/** One file of an extension. */
export function classifyBrowserFile(path: string, data: Uint8Array): Finding[] {
  const ext = extOf(path);
  const base = path.split('/').pop() ?? path;
  const out: Finding[] = [];
  const bin = binaryKind(data);
  if (bin) return [{ severity: 'reject', code: 'browser.program', message: `${base} is a ${bin.toUpperCase()} program; extensions contain no programs`, path }];
  if (NEVER.includes(ext)) return [{ severity: 'reject', code: 'browser.forbidden', message: `.${ext} files are never accepted in a browser extension (${base})`, path }];
  if (ext && !ALLOW.includes(ext)) out.push({ severity: 'flag', code: 'browser.unknown', message: `Unusual file type .${ext} in a browser extension: ${path}`, path });
  if (data.length > BROWSER_LIMITS.fileBytes) out.push({ severity: 'flag', code: 'browser.large-file', message: `${path} is larger than ${BROWSER_LIMITS.fileBytes / 1048576} MB`, path });
  if (['js', 'mjs', 'html', 'htm'].includes(ext)) {
    const text = Buffer.from(data.subarray(0, 8 * 1048576)).toString('utf8');
    for (const p of PATTERNS) if (p.re.test(text)) out.push({ severity: p.severity, code: p.code, message: `${path} ${p.what}`, path });
  }
  return out;
}

/** The whole extension: manifest.json at the top (or in one top folder), permissions, total size. */
export function checkBrowserPackage(entries: { path: string; data: Buffer }[]): Finding[] {
  const out: Finding[] = [];
  const total = entries.reduce((n, e) => n + e.data.length, 0);
  if (total > BROWSER_LIMITS.totalBytes) out.push({ severity: 'reject', code: 'browser.too-large', message: `The extension unpacks to ${Math.round(total / 1048576)} MB (limit ${BROWSER_LIMITS.totalBytes / 1048576} MB)` });
  const man = entries.find((e) => /^([^/]+\/)?manifest\.json$/i.test(e.path) && !e.path.includes('!/'));
  if (!man) {
    out.push({ severity: 'reject', code: 'browser.no-manifest', message: 'No manifest.json: not a browser extension' });
    return out;
  }
  let m: { manifest_version?: unknown; permissions?: unknown; host_permissions?: unknown; optional_permissions?: unknown; content_security_policy?: unknown };
  try { m = JSON.parse(man.data.toString('utf8')); } catch { out.push({ severity: 'reject', code: 'browser.bad-manifest', message: 'manifest.json is not valid JSON', path: man.path }); return out; }
  if (typeof m.manifest_version !== 'number') out.push({ severity: 'reject', code: 'browser.bad-manifest', message: 'manifest.json has no manifest_version', path: man.path });
  const perms = [m.permissions, m.host_permissions].flatMap((x) => (Array.isArray(x) ? x.filter((p): p is string => typeof p === 'string') : []));
  const risky = perms.filter((p) => RISKY_PERMISSIONS.includes(p) || p === '*://*/*' || p === 'http://*/*' || p === 'https://*/*');
  if (risky.length) out.push({ severity: 'flag', code: 'browser.permissions', message: `Asks for wide permissions: ${[...new Set(risky)].join(', ')}`, path: man.path });
  else if (perms.length) out.push({ severity: 'info', code: 'browser.permissions', message: `Permissions: ${perms.slice(0, 12).join(', ')}`, path: man.path });
  const csp = JSON.stringify(m.content_security_policy ?? '');
  if (/unsafe-eval|https?:\/\/(?!localhost)/i.test(csp)) out.push({ severity: 'flag', code: 'browser.csp', message: 'The content security policy allows eval or scripts from other sites', path: man.path });
  return out;
}
