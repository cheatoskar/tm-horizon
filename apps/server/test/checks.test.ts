import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { runChecks, type CheckInput } from '../src/checks/pipeline.ts';
import { parsePe, sensitiveImports } from '../src/checks/pe.ts';
import { safeEntryName, unzipAll, ZipError } from '../src/checks/zip.ts';
import { createVirusTotal } from '../src/checks/virustotal.ts';
import { makePe, makeZip, tmloaderZip } from './helpers.ts';

const base = (over: Partial<CheckInput>): CheckInput => ({
  fileName: 'mod.zip', data: Buffer.alloc(0), installs: { tmnf: 'tmloader-product' }, version: '1.0.0',
  newProject: false, uploaderId: 'u1', origin: 'upload', ...over,
});
const codes = (r: { findings: { code: string }[] }) => r.findings.map((f) => f.code);

test('clean TMLoader product passes', async () => {
  const r = await runChecks(base({ data: tmloaderZip() }));
  assert.equal(r.verdict, 'clean', JSON.stringify(r.findings));
  assert.equal(r.pe.length, 1);
  assert.equal(r.pe[0].machine, 'x86');
  assert.ok(r.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)));
});

test('new project always goes to review', async () => {
  const r = await runChecks(base({ data: tmloaderZip(), newProject: true }));
  assert.equal(r.verdict, 'flagged');
  assert.ok(codes(r).includes('review.new-project'));
});

// ------------------------------------------------------------ malicious zips

const rejects = async (data: Buffer, code: string, installs: CheckInput['installs'] = { tmnf: 'files:gamedata' }) => {
  const r = await runChecks(base({ data, installs }));
  assert.equal(r.verdict, 'rejected', `expected reject for ${code}: ${JSON.stringify(r.findings)}`);
  assert.ok(codes(r).includes(code), `expected ${code}, got ${codes(r).join(', ')}`);
};

test('path traversal is rejected', () => rejects(makeZip([{ name: '../../evil.dds', data: 'x' }]), 'zip.path-traversal'));
test('backslash traversal is rejected', () => rejects(makeZip([{ name: 'Skins\\..\\..\\..\\Windows\\x.dds', data: 'x' }]), 'zip.path-traversal'));
test('absolute and drive paths are rejected', async () => {
  await rejects(makeZip([{ name: '/etc/passwd', data: 'x' }]), 'zip.absolute-path');
  await rejects(makeZip([{ name: 'C:/Windows/system32/x.dds', data: 'x' }]), 'zip.absolute-path');
});
test('alternate data streams are rejected', () => rejects(makeZip([{ name: 'tex.dds:hidden.exe', data: 'x' }]), 'zip.colon'));
test('reserved device names are rejected', () => rejects(makeZip([{ name: 'Skins/CON.dds', data: 'x' }]), 'zip.reserved-name'));
test('symlinks are rejected', () => rejects(makeZip([{ name: 'link', data: '../../../../Windows', unixMode: 0o120777 }]), 'zip.symlink'));
test('encrypted entries are rejected', () => rejects(makeZip([{ name: 'a.dds', data: 'x', flags: 1 }]), 'zip.encrypted'));
test('duplicate names (case-insensitive) are rejected', () => rejects(makeZip([{ name: 'a/B.dds', data: 'x' }, { name: 'A/b.dds', data: 'y' }]), 'zip.duplicate'));
test('local header name differing from the directory is rejected', () => rejects(makeZip([{ name: 'ok.dds', data: 'x', localName: '../evil.dll' }]), 'zip.local-name'));

test('zip bomb by ratio is rejected before unpacking', async () => {
  const big = Buffer.alloc(64 * 1024 * 1024); // 64 MB of zeros deflate to ~64 KB (ratio ~1000:1)
  await rejects(makeZip([{ name: 'zeros.dds', data: big }]), 'zip.bomb');
});

test('entry lying about its size stops at the cap', async () => {
  const data = Buffer.alloc(200_000, 7);
  await rejects(makeZip([{ name: 'tex.dds', data, declaredSize: 1000 }]), 'zip.size-lie');
});

test('overlapping entries (Fifield bomb) are rejected', async () => {
  await rejects(makeZip([{ name: 'a.dds', data: 'x'.repeat(1000) }, { name: 'b.dds', data: 'y'.repeat(1000) }], { overlap: true }), 'zip.overlap');
});

test('bad CRC is rejected', () => rejects(makeZip([{ name: 'a.dds', data: 'hello', crc: 1234 }]), 'zip.crc'));

test('too many entries are rejected', async () => {
  const specs = Array.from({ length: 30 }, (_, i) => ({ name: `f${i}.dds`, data: 'x', method: 0 as const }));
  const r = await runChecks(base({ data: makeZip(specs), installs: { tmnf: 'files:gamedata' }, zipLimits: { maxEntries: 20, maxTotalUncompressed: 1e9, maxEntrySize: 1e9, maxRatio: 1000, ratioMinSize: 1e6, maxDepth: 2, maxPathLength: 240 } }));
  assert.ok(codes(r).includes('zip.too-many-entries'));
});

test('total unpacked size limit counts nested archives', () => {
  const inner = makeZip([{ name: 'big.dds', data: Buffer.alloc(300_000, 1) }]);
  const outer = makeZip([{ name: 'pack.zip', data: inner, method: 0 }, { name: 'more.dds', data: Buffer.alloc(300_000, 2) }]);
  assert.throws(() => unzipAll(outer, { maxEntries: 100, maxTotalUncompressed: 500_000, maxEntrySize: 1e9, maxRatio: 1e9, ratioMinSize: 1e9, maxDepth: 2, maxPathLength: 240 }),
    (e: unknown) => e instanceof ZipError && e.code === 'zip.total-too-large');
});

test('unsupported compression method is rejected', async () => {
  const z = makeZip([{ name: 'a.dds', data: 'x', method: 0 }]);
  // Patch method 0 -> 14 (LZMA) in local and central header.
  z.writeUInt16LE(14, 8);
  const cen = z.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  z.writeUInt16LE(14, cen + 10);
  await rejects(z, 'zip.method');
});

test('truncated / garbage zip is rejected', async () => {
  await rejects(Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(100)]), 'zip.not-a-zip');
  const r = await runChecks(base({ fileName: 'x.zip', data: Buffer.from('not a zip at all') }));
  assert.ok(codes(r).includes('zip.not-a-zip'));
});

// ------------------------------------------------------------ file types

test('exe disguised as a texture is rejected', () => rejects(makeZip([{ name: 'Skins/car.dds', data: makePe({ dll: false }) }]), 'type.hidden-executable'));
test('scripts are never accepted', () => rejects(makeZip([{ name: 'install.bat', data: 'del /s C:\\' }]), 'type.forbidden'));
test('shortcuts are never accepted', () => rejects(makeZip([{ name: 'readme.lnk', data: 'L\0\0\0' }]), 'type.forbidden'));
test('DLL in a GameData pack is rejected', () => rejects(makeZip([{ name: 'x.dll', data: makePe() }]), 'type.executable-not-allowed'));
test('fake DLL (not a PE) is rejected', () => rejects(tmloaderZip('M', '1.0.0', [], Buffer.from('not a dll')), 'type.fake-executable', { tmnf: 'tmloader-product' }));
test('ELF binary is rejected', () => rejects(makeZip([{ name: 'tool.dds', data: Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]) }]), 'type.foreign-binary'));
test('dinput8.dll is rejected', () => rejects(makeZip([{ name: 'dinput8.dll', data: makePe() }]), 'type.dinput8', { eswc: 'files:game' }));
test('executable inside a nested pack is rejected', async () => {
  const inner = makeZip([{ name: 'evil.dll', data: makePe() }]);
  await rejects(makeZip([{ name: 'Skins/pack.zip', data: inner, method: 0 }]), 'type.executable-not-allowed', { tmnf: 'files:documents' });
});
test('exe inside a TMLoader product is flagged, not silently passed', async () => {
  const r = await runChecks(base({ data: tmloaderZip('M', '1.0.0', [{ name: 'M/1.0.0/updater.exe', data: makePe({ dll: false }) }]) }));
  assert.equal(r.verdict, 'flagged');
  assert.ok(codes(r).includes('type.exe'));
  assert.ok(codes(r).includes('pe.program'));
});
test('unknown file types are flagged', async () => {
  const r = await runChecks(base({ data: makeZip([{ name: 'thing.xyz', data: 'x' }]), installs: { tmnf: 'files:gamedata' } }));
  assert.equal(r.verdict, 'flagged');
});
test('TMLoader layout is required', () => rejects(makeZip([{ name: 'Mod.dll', data: makePe() }]), 'tmloader.layout', { tmnf: 'tmloader-product' }));
test('single file upload is checked by its content', async () => {
  const r = await runChecks(base({ fileName: 'car.dds', data: makePe(), installs: { tmnf: 'files:documents' } }));
  assert.ok(codes(r).includes('type.hidden-executable'));
});
test('upload size limit', async () => {
  const r = await runChecks(base({ data: tmloaderZip(), maxUpload: 100 }));
  assert.ok(codes(r).includes('size.too-large'));
});

// ------------------------------------------------------------ PE

test('PE parser reads machine, imports and exports (x86 and x64)', () => {
  for (const machine of ['x86', 'x64'] as const) {
    const p = parsePe(makePe({ machine, imports: { 'KERNEL32.dll': ['LoadLibraryA'], 'WININET.dll': ['InternetOpenA', 'InternetReadFile'] }, exports: ['Init', 'Shutdown'] }), 'm.dll')!;
    assert.equal(p.machine, machine);
    assert.equal(p.dll, true);
    assert.deepEqual(p.imports.map((i) => i.dll), ['KERNEL32.dll', 'WININET.dll']);
    assert.deepEqual(p.imports[1].functions, ['InternetOpenA', 'InternetReadFile']);
    assert.deepEqual(p.exports, ['Init', 'Shutdown']);
    assert.ok([...sensitiveImports(p).values()].includes('network (WinINet/URLMon)'));
  }
});
test('PE parser survives garbage after MZ', () => {
  const b = Buffer.alloc(200); b.write('MZ'); b.writeUInt32LE(0xfffffff0, 0x3c);
  const p = parsePe(b)!;
  assert.ok(p.malformed);
});
test('packed DLL is flagged', async () => {
  const r = await runChecks(base({ data: tmloaderZip('M', '1.0.0', [], makePe({ sectionName: 'UPX0' })) }));
  assert.ok(codes(r).includes('pe.packed'));
  assert.equal(r.verdict, 'flagged');
});
test('64-bit DLL for Nations Forever warns', async () => {
  const r = await runChecks(base({ data: tmloaderZip('M', '1.0.0', [], makePe({ machine: 'x64' })) }));
  assert.ok(codes(r).includes('pe.arch'));
});

// ------------------------------------------------------------ diff vs previous version

test('diff: new sensitive imports, renamed DLL, missing signature, install type change', async () => {
  const v1 = await runChecks(base({ data: tmloaderZip('M', '1.0.0') }));
  const prev = { report: v1, installTypes: ['tmloader-product' as const], uploaderId: 'u1', signatureKeyId: 'k1', size: 1000, origin: 'github:a/b@v1' };
  const v2 = await runChecks(base({
    version: '1.1.0', previous: prev, origin: 'github:a/b@v2',
    data: tmloaderZip('M', '1.1.0', [], makePe({ imports: { 'KERNEL32.dll': ['CreateProcessA', 'WriteProcessMemory'] } })),
  }));
  assert.ok(codes(v2).includes('diff.new-sensitive-imports'));
  assert.ok(codes(v2).includes('diff.signature-missing'));
  assert.equal(v2.verdict, 'flagged');

  const renamed = makeZip([
    { name: 'M/1.2.0/description.yaml', data: 'x' },
    { name: 'M/1.2.0/Other.dll', data: makePe() },
  ]);
  const v3 = await runChecks(base({ version: '1.2.0', previous: { ...prev, signatureKeyId: null }, data: renamed }));
  assert.ok(codes(v3).includes('diff.dll-renamed'), codes(v3).join());

  const v4 = await runChecks(base({ previous: { ...prev, signatureKeyId: null }, data: makeZip([{ name: 'a.dds', data: 'x' }]), installs: { tmnf: 'files:gamedata' } }));
  assert.ok(codes(v4).includes('diff.install-type'));

  const v5 = await runChecks(base({ previous: { ...prev, signatureKeyId: null }, data: tmloaderZip('M', '1.0.0'), origin: 'github:someone-else/b@v3' }));
  assert.ok(codes(v5).includes('diff.source-changed'));
});

test('clean update with the same files is clean', async () => {
  const v1 = await runChecks(base({ data: tmloaderZip('M', '1.0.0') }));
  const v2 = await runChecks(base({ version: '1.0.1', data: tmloaderZip('M', '1.0.1'), previous: { report: v1, installTypes: ['tmloader-product'], uploaderId: 'u1', signatureKeyId: null, size: 1000, origin: 'upload' } }));
  assert.equal(v2.verdict, 'clean', JSON.stringify(v2.findings));
  // Two games with the same install type are still the same install type.
  const two = await runChecks(base({ version: '1.0.2', installs: { tmnf: 'tmloader-product', tmuf: 'tmloader-product' }, data: tmloaderZip('M', '1.0.2'),
    previous: { report: v1, installTypes: ['tmloader-product', 'tmloader-product'], uploaderId: 'u1', signatureKeyId: null, size: 1000, origin: 'upload' } }));
  assert.equal(two.verdict, 'clean', JSON.stringify(two.findings));
});

test('owner change and invalid signature', async () => {
  const r = await runChecks(base({ data: tmloaderZip(), ownerChangedRecently: true, signature: { keyId: 'k', verified: false } }));
  assert.ok(codes(r).includes('diff.owner-change'));
  assert.ok(codes(r).includes('sig.invalid'));
  assert.equal(r.verdict, 'rejected');
});

// ------------------------------------------------------------ VirusTotal

test('VirusTotal: malicious rejects, unknown uploads when enabled, off without key', async () => {
  assert.equal(createVirusTotal(undefined), null);
  const calls: string[] = [];
  const fake = (stats: Record<string, number> | null) => (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (String(url).endsWith('/files') && init?.method === 'POST') return new Response('{}', { status: 200 });
    if (!stats) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify({ data: { attributes: { last_analysis_stats: stats } } }), { status: 200 });
  }) as typeof fetch;
  const bad = await runChecks(base({ data: tmloaderZip(), vt: createVirusTotal('k', fake({ malicious: 5 }), 0) }));
  assert.equal(bad.verdict, 'rejected');
  assert.equal(bad.virusTotal?.status, 'malicious');
  const unknown = await runChecks(base({ data: tmloaderZip(), vt: createVirusTotal('k', fake(null), 0), vtUpload: true }));
  assert.equal(unknown.virusTotal?.status, 'queued');
  assert.ok(calls.some((c) => c.startsWith('POST')));
  const off = await runChecks(base({ data: tmloaderZip() }));
  assert.equal(off.virusTotal?.status, 'off');
});

test('safeEntryName normalises harmless forms', () => {
  assert.equal(safeEntryName('./a/./b\\c.dds'), 'a/b/c.dds');
  assert.equal(safeEntryName('dir/'), 'dir');
  assert.throws(() => safeEntryName('a/../../b'));
  assert.throws(() => safeEntryName('a/b. '));
  // deflate sanity for the helper
  assert.ok(deflateRawSync(Buffer.from('x')).length > 0);
});
