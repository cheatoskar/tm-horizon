// Minimal zip writer (deflate), used to wrap DLL-only uploads and TMLoader server zips into the
// TMLoader product layout <Product>/<version>/ the launcher's installer expects.
import { crc32, deflateRawSync } from 'node:zlib';
import { safeEntryName } from './zip.ts';

export function writeZip(files: { path: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const cens: Buffer[] = [];
  let offset = 0;
  // Fixed timestamp (1980-01-01): the same input gives the same bytes and the same SHA-256.
  const dosTime = 0;
  const dosDate = (0 << 9) | (1 << 5) | 1;
  for (const f of files) {
    const name = Buffer.from(safeEntryName(f.path), 'utf8');
    const deflated = deflateRawSync(f.data, { level: 9 });
    const stored = deflated.length >= f.data.length;
    const body = stored ? f.data : deflated;
    const crc = crc32(f.data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(stored ? 0 : 8, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(stored ? 0 : 8, 10);
    ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(f.data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, body);
    cens.push(ch, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(cens);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** YAML scalars as JSON strings (valid YAML, no surprises with ':' or '#'). */
const y = (v: unknown) => JSON.stringify(v ?? null);

export interface TmloaderWrap {
  product: string;
  version: string;
  executable: string | null;
  dependencies: { id: string; version: string | null }[];
  changelog?: string | null;
  priority?: number | null;
  name: string;
  author: string;
  description?: string | null;
  homepage?: string | null;
}

/** <Product>/description.yaml + <Product>/<version>/description.yaml + the files under the version folder. */
export function wrapTmloader(meta: TmloaderWrap, files: { path: string; data: Buffer }[]): Buffer {
  if (!/^[\w .+-]{1,64}$/.test(meta.product) || !/^[\w.+-]{1,40}$/.test(meta.version)) throw new Error('product id or version not usable as a folder name');
  const product = [`name: ${y(meta.name)}`, `author: ${y(meta.author)}`, `type: "modification"`, meta.homepage ? `homepage: ${y(meta.homepage)}` : null, meta.description ? `description: ${y(meta.description)}` : null]
    .filter(Boolean).join('\n') + '\n';
  const deps = meta.dependencies.length ? 'dependencies:\n' + meta.dependencies.map((d) => `  - id: ${y(d.id)}\n    version: ${y(d.version)}`).join('\n') : 'dependencies: []';
  const version = [meta.executable ? `executable: ${y(meta.executable)}` : null, deps, meta.changelog ? `changelog: ${y(meta.changelog.slice(0, 4000))}` : null,
    meta.priority != null ? `priority: ${meta.priority}` : null].filter(Boolean).join('\n') + '\n';
  const root = `${meta.product}/${meta.version}/`;
  return writeZip([
    { path: `${meta.product}/description.yaml`, data: Buffer.from(product) },
    { path: `${root}description.yaml`, data: Buffer.from(version) },
    ...files.filter((f) => f.path.toLowerCase() !== 'description.yaml').map((f) => ({ path: root + f.path, data: f.data })),
  ]);
}
