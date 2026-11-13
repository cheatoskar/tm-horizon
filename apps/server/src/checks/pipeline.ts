// The checks every version goes through, uploaded or crawled: archive safety, file types per install
// type, PE inspection of DLLs/EXEs, diff against the previous version, author signature, VirusTotal.
// Pure apart from the optional VirusTotal client, so the tests can feed it hostile files directly.
import { createHash } from 'node:crypto';
import type { CheckFinding, CheckReport, CheckSeverity, GameId, HubInstallType, PeInfo } from '@tm-hub/shared';
import { DEFAULT_ZIP_LIMITS, ZipError, isZip, unzipAll, type ZipLimits } from './zip.ts';
import { classify, extOf } from './filetypes.ts';
import { checkBrowserPackage, classifyBrowserFile } from './browser.ts';
import { parsePe, sensitiveImports } from './pe.ts';
import type { VtClient } from './virustotal.ts';

export interface PreviousVersion {
  report: CheckReport;
  installTypes: HubInstallType[];
  uploaderId: string | null;
  signatureKeyId: string | null;
  size: number;
  origin: string;
}

export interface CheckInput {
  fileName: string;
  data: Buffer;
  /** Install type per game of this version (empty for a browser extension). */
  installs: Partial<Record<GameId, HubInstallType>>;
  /** Project type (hub.ts HubProjectType); "browser-extension" uses the browser rules (browser.ts) instead of the install types. */
  projectType?: string | null;
  /** Leading folders the launcher drops (for the TMLoader layout check). */
  strip?: number;
  version: string;
  newProject: boolean;
  uploaderId: string | null;
  /** Where the file came from (upload, github:owner/repo@tag, ...). */
  origin: string;
  previous?: PreviousVersion | null;
  /** The project's owner changed in the last 14 days (transfer, approved claim). */
  ownerChangedRecently?: boolean;
  signature?: { keyId: string; verified: boolean } | null;
  vt?: VtClient | null;
  vtUpload?: boolean;
  zipLimits?: ZipLimits;
  maxUpload?: number;
}

const RANK: Record<CheckSeverity, number> = { info: 0, warn: 1, flag: 2, reject: 3 };
/** Games whose executables are 32-bit / 64-bit. */
const X86_GAMES = new Set<GameId>(['tmnf', 'tmuf', 'eswc', 'tmo', 'tms']);
const X64_GAMES = new Set<GameId>(['tm2020']);

export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

export async function runChecks(input: CheckInput): Promise<CheckReport> {
  const findings: CheckFinding[] = [];
  const add = (severity: CheckSeverity, code: string, message: string, path?: string) => findings.push({ severity, code, message, ...(path ? { path } : {}) });
  const files: CheckReport['files'] = [];
  const pe: PeInfo[] = [];
  const types = [...new Set(Object.values(input.installs))] as HubInstallType[];
  const done = (vt: CheckReport['virusTotal'] = null): CheckReport => {
    const worst = findings.reduce((m, f) => Math.max(m, RANK[f.severity]), 0);
    const verdict = worst >= RANK.reject ? 'rejected' : worst >= RANK.flag ? 'flagged' : 'clean';
    return { verdict, findings, files, pe, virusTotal: vt, checkedAt: new Date().toISOString() };
  };

  const browser = input.projectType === 'browser-extension';
  if (!types.length && !browser) add('reject', 'meta.no-games', 'The version names no game to install into');
  if (input.maxUpload && input.data.length > input.maxUpload) {
    add('reject', 'size.too-large', `The file is larger than ${Math.round(input.maxUpload / 1048576)} MB`);
    return done();
  }
  if (input.data.length === 0) {
    add('reject', 'size.empty', 'The file is empty');
    return done();
  }
  const fileName = input.fileName.replace(/^.*[\\/]/, '');
  if (!/^[\w .()+-]{1,160}$/.test(fileName) || fileName.startsWith('.')) add('reject', 'meta.file-name', `File name not accepted: ${fileName}`);

  // Unpack (or treat a single file as the only entry).
  let entries: { path: string; data: Buffer; depth: number }[];
  if (isZip(input.data)) {
    try {
      const r = unzipAll(input.data, input.zipLimits ?? DEFAULT_ZIP_LIMITS);
      entries = r.files;
      for (const p of r.tooDeep) add('flag', 'zip.nested-too-deep', `Archive nested too deep, not inspected: ${p}`, p);
    } catch (e) {
      if (e instanceof ZipError) {
        add('reject', e.code, e.message, e.path);
        return done();
      }
      throw e;
    }
    if (!entries.length) add('reject', 'zip.empty', 'The zip contains no files');
  } else {
    if (/\.zip$/i.test(fileName)) {
      add('reject', 'zip.not-a-zip', 'Named .zip but is not a zip file');
      return done();
    }
    entries = [{ path: fileName, data: input.data, depth: 0 }];
  }

  // File types, executables, PE details.
  const execPaths: string[] = [];
  for (const e of entries) {
    files.push({ path: e.path, size: e.data.length, sha256: sha256(e.data) });
    const inner = e.path.includes('!/');
    if (browser) for (const f of classifyBrowserFile(e.path, e.data)) add(f.severity, f.code, f.message, f.path);
    for (const t of browser ? [] : types) {
      // Nested archives are game packs: what is inside follows the gamedata rules whatever the outer type.
      const v = classify(e.path, e.data, inner ? 'files:gamedata' : t);
      if (v.severity) add(v.severity, v.code, `${v.message}${types.length > 1 ? ` [${t}]` : ''}`, e.path);
      if (v.executable && !execPaths.includes(e.path)) execPaths.push(e.path);
    }
    const base = e.path.split('/').pop()!.toLowerCase();
    if (base === 'dinput8.dll') add('reject', 'type.dinput8', 'dinput8.dll is never installed (StarForce games break, the launcher refuses it)', e.path);
    const p = parsePe(e.data, e.path);
    if (p) {
      const { packed, malformed, ...info } = p;
      pe.push(info);
      if (malformed) add('flag', 'pe.malformed', `${e.path}: ${malformed}`, e.path);
      if (packed.length) add('flag', 'pe.packed', `${e.path} is packed (${packed.join(', ')}); its real imports are hidden`, e.path);
      const games = Object.keys(input.installs) as GameId[];
      if (info.machine === 'x64' && games.some((g) => X86_GAMES.has(g))) add('warn', 'pe.arch', `${e.path} is 64-bit but a 32-bit game is selected`, e.path);
      if (info.machine === 'x86' && games.some((g) => X64_GAMES.has(g))) add('warn', 'pe.arch', `${e.path} is 32-bit but Trackmania (2020) is 64-bit`, e.path);
      const sens = sensitiveImports(info);
      if (sens.size) add('info', 'pe.sensitive-imports', `${e.path} uses: ${[...new Set(sens.values())].join(', ')}`, e.path);
      if (extOf(e.path) === 'exe' || !info.dll) add('flag', 'pe.program', `${e.path} is a program, not a library`, e.path);
    }
  }

  if (browser && entries.length) for (const f of checkBrowserPackage(entries)) add(f.severity, f.code, f.message, f.path);

  // TMLoader layout: <Product>/<version>/description.yaml after strip.
  if (types.includes('tmloader-product') && entries.length) {
    const strip = input.strip ?? 0;
    const descs = entries.map((e) => e.path.split('/').slice(strip)).filter((p) => p.length === 3 && p[2].toLowerCase() === 'description.yaml');
    if (!descs.length) add('reject', 'tmloader.layout', 'Not a TMLoader product: expected <Product>/<version>/description.yaml in the zip');
    else if (!descs.some((d) => d[1] === input.version || d[1] === input.version.replace(/^v/, ''))) {
      add('warn', 'tmloader.version-folder', `The version folder (${descs.map((d) => d[1]).join(', ')}) differs from the version ${input.version}`);
    }
  }

  // New projects always get a human look.
  if (input.newProject) add('flag', 'review.new-project', 'First version of a new project');

  // Diff against the previous published version.
  const prev = input.previous;
  if (prev) {
    const prevPaths = new Set(prev.report.files.map((f) => f.path.toLowerCase()));
    const prevExec = prev.report.files.filter((f) => /\.(dll|exe|asi)$/i.test(f.path)).map((f) => f.path.toLowerCase());
    const nowExec = execPaths.map((p) => p.toLowerCase());
    const added = nowExec.filter((p) => !prevPaths.has(p));
    const removed = prevExec.filter((p) => !nowExec.includes(p));
    // Version folders (TMLoader: Product/1.2.0/x.dll) change every release; compare names without them.
    const baseName = (p: string) => p.split('/').pop()!;
    const addedNames = added.map(baseName).filter((n) => !removed.map(baseName).includes(n));
    const removedNames = removed.map(baseName).filter((n) => !added.map(baseName).includes(n));
    for (const n of addedNames) {
      if (removedNames.length) add('flag', 'diff.dll-renamed', `Executable renamed or swapped: ${removedNames.join(', ')} -> ${n}`);
      else add('flag', 'diff.new-executable', `New executable compared to the previous version: ${n}`);
    }
    for (const now of pe) {
      const before = prev.report.pe.find((x) => baseName(x.path.toLowerCase()) === baseName(now.path.toLowerCase()));
      if (!before) continue;
      const was = sensitiveImports(before);
      const fresh = [...sensitiveImports(now)].filter(([k]) => !was.has(k));
      if (fresh.length) add('flag', 'diff.new-sensitive-imports', `${now.path} newly imports ${fresh.map(([k, why]) => `${k} (${why})`).join(', ')}`, now.path);
      if (before.machine !== now.machine) add('warn', 'diff.arch-changed', `${now.path} changed from ${before.machine} to ${now.machine}`, now.path);
    }
    const prevTypes = [...new Set(prev.installTypes)].sort().join(',');
    if (prevTypes && prevTypes !== [...types].sort().join(',')) add('flag', 'diff.install-type', `Install type changed (${prevTypes} -> ${types.join(',')})`);
    if (prev.size > 1024 * 1024 && input.data.length > prev.size * 3) add('warn', 'diff.size-jump', `File grew from ${prev.size} to ${input.data.length} bytes`);
    if (prev.uploaderId && input.uploaderId && prev.uploaderId !== input.uploaderId) add('warn', 'diff.uploader', 'Uploaded by a different team member than the previous version');
    if (prev.signatureKeyId && !input.signature) add('flag', 'diff.signature-missing', 'The previous version was signed by the author, this one is not');
    if (prev.signatureKeyId && input.signature && input.signature.keyId !== prev.signatureKeyId) add('flag', 'diff.key-changed', 'Signed with a different author key than the previous version');
    const src = (o: string) => o.replace(/@.*$/, '');
    if (prev.origin.startsWith('github:') && input.origin.startsWith('github:') && src(prev.origin) !== src(input.origin)) add('flag', 'diff.source-changed', `Source repository changed (${src(prev.origin)} -> ${src(input.origin)})`);
  }
  if (input.ownerChangedRecently) add('flag', 'diff.owner-change', 'The project changed owner in the last 14 days');
  if (input.signature && !input.signature.verified) add('reject', 'sig.invalid', 'The author signature does not match the file');

  // VirusTotal, only for files that passed so far.
  let vt: CheckReport['virusTotal'] = input.vt ? null : { status: 'off' };
  if (input.vt && !findings.some((f) => f.severity === 'reject')) {
    const sha = sha256(input.data);
    vt = await input.vt.lookup(sha);
    if (vt.status === 'unknown' && input.vtUpload) vt = await input.vt.upload(fileName, input.data);
    if (vt.status === 'malicious') add((vt.positives ?? 0) >= 3 ? 'reject' : 'flag', 'vt.malicious', `VirusTotal: ${vt.positives} engines report this file`);
    else if (vt.status === 'suspicious') add('flag', 'vt.suspicious', `VirusTotal: ${vt.positives} engines find it suspicious`);
    else if (vt.status === 'error') add('warn', 'vt.error', 'VirusTotal lookup failed; checked again before publishing');
  }
  return done(vt);
}
