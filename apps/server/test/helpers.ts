// Test builders: zips (also deliberately broken ones) and minimal PE files.
import { crc32, deflateRawSync, deflateSync } from 'node:zlib';
const require_zlib = () => ({ deflateSync });

export interface ZipSpec {
  name: string;
  data: Buffer | string;
  method?: 0 | 8;
  /** Lie about the uncompressed size in both headers. */
  declaredSize?: number;
  crc?: number;
  /** Unix mode for the external attributes (made by Unix). */
  unixMode?: number;
  flags?: number;
  /** Name written into the local header (default: name). */
  localName?: string;
}

/** Builds a zip. `overlap` points every central entry at the first local header (overlapping-files bomb). */
export function makeZip(specs: ZipSpec[], opts: { overlap?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const cens: Buffer[] = [];
  let offset = 0;
  const offsets: number[] = [];
  for (const s of specs) {
    const raw = Buffer.isBuffer(s.data) ? s.data : Buffer.from(s.data);
    const method = s.method ?? 8;
    const comp = method === 8 ? deflateRawSync(raw) : raw;
    const size = s.declaredSize ?? raw.length;
    const crc = s.crc ?? crc32(raw) >>> 0;
    const flags = (s.flags ?? 0) | 0x800;
    const lname = Buffer.from(s.localName ?? s.name, 'utf8');
    const name = Buffer.from(s.name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(size, 22); lh.writeUInt16LE(lname.length, 26);
    offsets.push(offset);
    locals.push(lh, lname, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(s.unixMode !== undefined ? (3 << 8) | 20 : 20, 4);
    ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(size, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(s.unixMode !== undefined ? (s.unixMode << 16) >>> 0 : 0, 38);
    ch.writeUInt32LE(opts.overlap ? 0 : offset, 42);
    cens.push(ch, name);
    offset += 30 + lname.length + comp.length;
  }
  const cd = Buffer.concat(cens);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(specs.length, 8); eocd.writeUInt16LE(specs.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

export interface PeSpec {
  machine?: 'x86' | 'x64';
  dll?: boolean;
  imports?: Record<string, string[]>;
  exports?: string[];
  sectionName?: string;
}

/** A minimal but well-formed PE with one section holding the import and export tables. */
export function makePe(spec: PeSpec = {}): Buffer {
  const x64 = spec.machine === 'x64';
  const imports = spec.imports ?? { 'KERNEL32.dll': ['GetModuleHandleA', 'GetProcAddress'] };
  const exports = spec.exports ?? ['ModInit'];
  const VA = 0x1000;
  const RAW = 0x400;
  const sec = Buffer.alloc(0x1000);
  let cur = 0;
  const alloc = (n: number) => { const at = cur; cur += n + ((8 - (n % 8)) % 8); return at; };
  const str = (s: string) => { const at = alloc(s.length + 1); sec.write(s, at, 'latin1'); return VA + at; };
  const dlls = Object.entries(imports);
  const descAt = alloc((dlls.length + 1) * 20);
  const w = x64 ? 8 : 4;
  dlls.forEach(([dll, fns], i) => {
    const ilt = alloc((fns.length + 1) * w);
    fns.forEach((f, j) => {
      const hn = alloc(2 + f.length + 1);
      sec.write(f, hn + 2, 'latin1');
      if (x64) sec.writeBigUInt64LE(BigInt(VA + hn), ilt + j * w);
      else sec.writeUInt32LE(VA + hn, ilt + j * w);
    });
    const d = descAt + i * 20;
    sec.writeUInt32LE(VA + ilt, d);
    sec.writeUInt32LE(str(dll), d + 12);
    sec.writeUInt32LE(VA + ilt, d + 16);
  });
  const expAt = alloc(40);
  const names = alloc(exports.length * 4);
  exports.forEach((e, i) => sec.writeUInt32LE(str(e), names + i * 4));
  sec.writeUInt32LE(exports.length, expAt + 24);
  sec.writeUInt32LE(VA + names, expAt + 32);

  const optSize = x64 ? 240 : 224;
  const head = Buffer.alloc(RAW);
  head.write('MZ', 0, 'latin1');
  head.writeUInt32LE(0x40, 0x3c);
  head.writeUInt32LE(0x00004550, 0x40);
  const coff = 0x44;
  head.writeUInt16LE(x64 ? 0x8664 : 0x14c, coff);
  head.writeUInt16LE(1, coff + 2);
  head.writeUInt16LE(optSize, coff + 16);
  head.writeUInt16LE((spec.dll ?? true) ? 0x2102 : 0x0102, coff + 18);
  const opt = coff + 20;
  head.writeUInt16LE(x64 ? 0x20b : 0x10b, opt);
  head.writeUInt32LE(16, opt + (x64 ? 108 : 92));
  const dirs = opt + (x64 ? 112 : 96);
  head.writeUInt32LE(VA + expAt, dirs); head.writeUInt32LE(40, dirs + 4);
  head.writeUInt32LE(VA + descAt, dirs + 8); head.writeUInt32LE((dlls.length + 1) * 20, dirs + 12);
  const st = opt + optSize;
  head.write((spec.sectionName ?? '.rdata').padEnd(8, '\0'), st, 'latin1');
  head.writeUInt32LE(sec.length, st + 8); head.writeUInt32LE(VA, st + 12);
  head.writeUInt32LE(sec.length, st + 16); head.writeUInt32LE(RAW, st + 20);
  return Buffer.concat([head, sec]);
}

/** A valid TMLoader product zip. */
export function tmloaderZip(product = 'DemoMod', version = '1.0.0', extra: ZipSpec[] = [], dll: Buffer = makePe()): Buffer {
  return makeZip([
    { name: `${product}/${version}/description.yaml`, data: `name: ${product}\nversion: ${version}\nexecutable: ${product}.dll\n` },
    { name: `${product}/${version}/${product}.dll`, data: dll },
    ...extra,
  ]);
}

/** A real PNG (diagonal gradient from `rgb` to dark), for seed pictures and image tests. */
export function makeDemoPng(w: number, h: number, rgb: [number, number, number]): Buffer {
  const { deflateSync } = require_zlib();
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const t = 1 - ((x / w) * 0.6 + (y / h) * 0.4);
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = Math.round(rgb[0] * t + 10 * (1 - t));
      raw[o + 1] = Math.round(rgb[1] * t + 12 * (1 - t));
      raw[o + 2] = Math.round(rgb[2] * t + 20 * (1 - t));
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('tEXt', Buffer.from('Comment\0secret gps')), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
