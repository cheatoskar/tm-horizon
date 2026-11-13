// A small, strict ZIP reader for upload checks. It reads the central directory itself (no third-party
// parser), refuses everything a mod zip never needs (encryption, symlinks, odd compression methods,
// overlapping entries, unsafe or duplicate names) and inflates each entry with a hard output cap, so
// a zip bomb or an entry that lies about its size stops at the cap instead of filling memory.
import { crc32, inflateRawSync } from 'node:zlib';

export class ZipError extends Error {
  code: string;
  path?: string;
  constructor(code: string, message: string, path?: string) {
    super(message);
    this.code = code;
    this.path = path;
  }
}

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  versionMadeBy: number;
  externalAttrs: number;
  isDir: boolean;
}

export interface ZipLimits {
  /** Entries in one archive (the launcher refuses more than 5000). */
  maxEntries: number;
  /** Sum of the declared uncompressed sizes, nested archives included. */
  maxTotalUncompressed: number;
  maxEntrySize: number;
  /** Uncompressed/compressed ratio above which an entry larger than ratioMinSize is refused. */
  maxRatio: number;
  ratioMinSize: number;
  /** Nested archives deeper than this are not opened (finding instead). */
  maxDepth: number;
  maxPathLength: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 5000,
  maxTotalUncompressed: 1024 * 1024 * 1024,
  maxEntrySize: 512 * 1024 * 1024,
  maxRatio: 1000,
  ratioMinSize: 1024 * 1024,
  maxDepth: 2,
  maxPathLength: 240,
};

const EOCD_SIG = 0x06054b50;
const EOCD64_LOC_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

export const isZip = (b: Uint8Array) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5) && (b[3] === 4 || b[3] === 6);

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** Normalises a stored name to forward slashes, or throws when it is not a safe relative path. */
export function safeEntryName(raw: string, maxLen = DEFAULT_ZIP_LIMITS.maxPathLength): string {
  if (raw.length === 0) throw new ZipError('zip.empty-name', 'An entry has an empty name');
  if (/[\x00-\x1f\x7f]/.test(raw)) throw new ZipError('zip.control-char', 'An entry name contains control characters', raw);
  const name = raw.replace(/\\/g, '/');
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name) || name.startsWith('//')) throw new ZipError('zip.absolute-path', `Absolute path in the zip: ${raw}`, raw);
  if (name.includes(':')) throw new ZipError('zip.colon', `Colon in a path (drive or alternate data stream): ${raw}`, raw);
  const parts = name.split('/');
  const clean: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === '' && i === parts.length - 1) continue; // trailing slash of a folder
    if (p === '' || p === '.') continue;
    if (p === '..') throw new ZipError('zip.path-traversal', `Path leaves the target folder: ${raw}`, raw);
    if (/[. ]$/.test(p)) throw new ZipError('zip.trailing-dot', `Name ends with a dot or space (Windows drops it): ${raw}`, raw);
    if (WINDOWS_RESERVED.test(p)) throw new ZipError('zip.reserved-name', `Reserved Windows device name: ${raw}`, raw);
    if (/[<>"|?*]/.test(p)) throw new ZipError('zip.bad-char', `Character not allowed in Windows paths: ${raw}`, raw);
    clean.push(p);
  }
  if (!clean.length) throw new ZipError('zip.empty-name', `Entry without a usable name: ${raw}`, raw);
  const out = clean.join('/');
  if (out.length > maxLen) throw new ZipError('zip.path-too-long', `Path longer than ${maxLen} characters`, raw);
  return out;
}

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new ZipError('zip.not-a-zip', 'Not a zip file (no end of central directory)');
}

function zip64Extra(extra: Buffer, need: { u: boolean; c: boolean; o: boolean }) {
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const len = extra.readUInt16LE(p + 2);
    if (p + 4 + len > extra.length) break;
    if (id === 0x0001) {
      let q = p + 4;
      const end = q + len;
      const read = () => {
        if (q + 8 > end) throw new ZipError('zip.bad-zip64', 'Broken ZIP64 field');
        const v = extra.readBigUInt64LE(q);
        q += 8;
        if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError('zip.too-large', 'ZIP64 size out of range');
        return Number(v);
      };
      return { u: need.u ? read() : undefined, c: need.c ? read() : undefined, o: need.o ? read() : undefined };
    }
    p += 4 + len;
  }
  throw new ZipError('zip.bad-zip64', 'ZIP64 sizes announced but missing');
}

/** Reads and validates the central directory. */
export function readEntries(buf: Buffer, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipEntry[] {
  if (buf.length < 22) throw new ZipError('zip.not-a-zip', 'Not a zip file (too short)');
  const eocd = findEocd(buf);
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0) throw new ZipError('zip.multi-disk', 'Split zip archives are not accepted');
  let count = buf.readUInt16LE(eocd + 10);
  let cdSize = buf.readUInt32LE(eocd + 12);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || buf.readUInt32LE(loc) !== EOCD64_LOC_SIG) throw new ZipError('zip.bad-zip64', 'ZIP64 end record missing');
    const off = Number(buf.readBigUInt64LE(loc + 8));
    if (off + 56 > buf.length || buf.readUInt32LE(off) !== EOCD64_SIG) throw new ZipError('zip.bad-zip64', 'ZIP64 end record broken');
    count = Number(buf.readBigUInt64LE(off + 32));
    cdSize = Number(buf.readBigUInt64LE(off + 40));
    cdOffset = Number(buf.readBigUInt64LE(off + 48));
  }
  if (count > limits.maxEntries) throw new ZipError('zip.too-many-entries', `The zip has ${count} entries (limit ${limits.maxEntries})`);
  if (cdOffset + cdSize > buf.length) throw new ZipError('zip.truncated', 'Central directory outside the file');

  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) throw new ZipError('zip.truncated', 'Central directory entry broken');
    const versionMadeBy = buf.readUInt16LE(p + 4);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    let compressedSize = buf.readUInt32LE(p + 20);
    let uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const externalAttrs = buf.readUInt32LE(p + 38);
    let localHeaderOffset = buf.readUInt32LE(p + 42);
    const end = p + 46 + nameLen + extraLen + commentLen;
    if (end > buf.length) throw new ZipError('zip.truncated', 'Central directory entry broken');
    const nameBuf = buf.subarray(p + 46, p + 46 + nameLen);
    const rawName = nameBuf.toString(flags & 0x800 ? 'utf8' : 'latin1');
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      const z = zip64Extra(buf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen), {
        u: uncompressedSize === 0xffffffff, c: compressedSize === 0xffffffff, o: localHeaderOffset === 0xffffffff,
      });
      if (z.u !== undefined) uncompressedSize = z.u;
      if (z.c !== undefined) compressedSize = z.c;
      if (z.o !== undefined) localHeaderOffset = z.o;
    }
    p = end;

    const isDir = rawName.endsWith('/') || rawName.endsWith('\\');
    const name = safeEntryName(rawName, limits.maxPathLength);
    if (flags & 0x1) throw new ZipError('zip.encrypted', `Encrypted entry: ${name}`, name);
    const unixMode = versionMadeBy >> 8 === 3 ? externalAttrs >>> 16 : 0;
    if ((unixMode & 0o170000) === 0o120000) throw new ZipError('zip.symlink', `Symbolic link in the zip: ${name}`, name);
    if (!isDir && method !== 0 && method !== 8) throw new ZipError('zip.method', `Compression method ${method} is not accepted (only stored and deflate): ${name}`, name);
    const key = name.toLowerCase();
    if (seen.has(key)) throw new ZipError('zip.duplicate', `The same path is in the zip twice: ${name}`, name);
    seen.add(key);
    if (uncompressedSize > limits.maxEntrySize) throw new ZipError('zip.entry-too-large', `${name} unpacks to more than ${limits.maxEntrySize} bytes`, name);
    if (uncompressedSize > limits.ratioMinSize && uncompressedSize / Math.max(1, compressedSize) > limits.maxRatio) {
      throw new ZipError('zip.bomb', `${name} is compressed ${Math.round(uncompressedSize / Math.max(1, compressedSize))}:1 (zip bomb?)`, name);
    }
    entries.push({ name, method, flags, crc32: crc, compressedSize, uncompressedSize, localHeaderOffset, versionMadeBy, externalAttrs, isDir });
  }

  // Overlapping entries (several names sharing one compressed stream) are a known zip-bomb trick.
  const ranges = entries.map((e) => {
    const lp = e.localHeaderOffset;
    if (lp + 30 > buf.length || buf.readUInt32LE(lp) !== LOC_SIG) throw new ZipError('zip.truncated', `Local header of ${e.name} broken`, e.name);
    const start = lp;
    const end = lp + 30 + buf.readUInt16LE(lp + 26) + buf.readUInt16LE(lp + 28) + e.compressedSize;
    if (end > buf.length) throw new ZipError('zip.truncated', `${e.name} reaches past the end of the file`, e.name);
    return [start, end, e.name] as const;
  }).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i][0] < ranges[i - 1][1]) throw new ZipError('zip.overlap', `Entries overlap in the file (${ranges[i - 1][2]}, ${ranges[i][2]})`, ranges[i][2]);
  }
  return entries;
}

/** Inflates one entry with a hard cap; checks local name, size and CRC. */
export function extractEntry(buf: Buffer, e: ZipEntry): Buffer {
  const lp = e.localHeaderOffset;
  const nameLen = buf.readUInt16LE(lp + 26);
  const extraLen = buf.readUInt16LE(lp + 28);
  const localName = buf.subarray(lp + 30, lp + 30 + nameLen).toString(buf.readUInt16LE(lp + 6) & 0x800 ? 'utf8' : 'latin1');
  let localSafe: string;
  try { localSafe = safeEntryName(localName); } catch { throw new ZipError('zip.local-name', `Local header name of ${e.name} is unsafe`, e.name); }
  if (localSafe !== e.name) throw new ZipError('zip.local-name', `Local header says "${localName}" but the directory says "${e.name}"`, e.name);
  const start = lp + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + e.compressedSize);
  let out: Buffer;
  if (e.method === 0) {
    if (e.compressedSize !== e.uncompressedSize) throw new ZipError('zip.size-mismatch', `${e.name}: stored entry with two different sizes`, e.name);
    out = Buffer.from(data);
  } else {
    try {
      out = inflateRawSync(data, { maxOutputLength: Math.max(1, e.uncompressedSize + 1) });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|buffer/i.test(String(err))) throw new ZipError('zip.size-lie', `${e.name} unpacks to more than it declares (zip bomb?)`, e.name);
      throw new ZipError('zip.corrupt', `${e.name} cannot be unpacked`, e.name);
    }
  }
  if (out.length !== e.uncompressedSize) throw new ZipError('zip.size-lie', `${e.name} declares ${e.uncompressedSize} bytes but unpacks to ${out.length}`, e.name);
  if ((crc32(out) >>> 0) !== (e.crc32 >>> 0)) throw new ZipError('zip.crc', `${e.name} fails its checksum`, e.name);
  return out;
}

export interface ZipFile {
  /** Path inside the upload; nested archives use "outer.zip!/inner/file". */
  path: string;
  data: Buffer;
  depth: number;
}

/**
 * Every file of the archive (directories skipped), nested zips opened up to limits.maxDepth.
 * Throws ZipError on the first problem; the pipeline turns it into a "reject" finding.
 */
export function unzipAll(buf: Buffer, limits: ZipLimits = DEFAULT_ZIP_LIMITS): { files: ZipFile[]; tooDeep: string[] } {
  const files: ZipFile[] = [];
  const tooDeep: string[] = [];
  let total = 0;
  let count = 0;
  const walk = (b: Buffer, prefix: string, depth: number) => {
    for (const e of readEntries(b, limits)) {
      if (e.isDir) continue;
      if (++count > limits.maxEntries) throw new ZipError('zip.too-many-entries', `More than ${limits.maxEntries} files including nested archives`);
      total += e.uncompressedSize;
      if (total > limits.maxTotalUncompressed) throw new ZipError('zip.total-too-large', `The upload unpacks to more than ${Math.round(limits.maxTotalUncompressed / 1048576)} MB`);
      const data = extractEntry(b, e);
      const path = prefix + e.name;
      files.push({ path, data, depth });
      if (isZip(data) && /\.zip$/i.test(e.name)) {
        if (depth + 1 > limits.maxDepth) tooDeep.push(path);
        else walk(data, path + '!/', depth + 1);
      }
    }
  };
  walk(buf, '', 0);
  return { files, tooDeep };
}
