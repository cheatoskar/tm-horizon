// Project pictures (icon, banner, gallery). The portal crops in the browser and uploads PNG/JPEG/WebP;
// the server checks the format by its bytes, reads the size from the header and strips metadata
// (EXIF with GPS, comments, text chunks) before storing.
import type { HubImage } from '@tm-hub/shared';
import type { Ctx } from '../ctx.ts';
import { HttpError, newId, nowIso, sha256hex } from '../util.ts';

export type ImageKind = HubImage['kind'];
const LIMITS: Record<ImageKind, { min: [number, number]; max: [number, number] }> = {
  icon: { min: [64, 64], max: [1024, 1024] },
  banner: { min: [640, 160], max: [3840, 1600] },
  gallery: { min: [320, 180], max: [3840, 2400] },
};
export const MAX_GALLERY = 12;

export function imageInfo(b: Buffer): { type: 'png' | 'jpeg' | 'webp'; width: number; height: number } | null {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString('latin1', 12, 16) === 'IHDR') return { type: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let p = 2;
    while (p + 9 < b.length) {
      if (b[p] !== 0xff) return null;
      const m = b[p + 1];
      const len = b.readUInt16BE(p + 2);
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { type: 'jpeg', height: b.readUInt16BE(p + 5), width: b.readUInt16BE(p + 7) };
      p += 2 + len;
    }
    return null;
  }
  if (b.length > 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = b.toString('latin1', 12, 16);
    if (chunk === 'VP8X') return { type: 'webp', width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (chunk === 'VP8 ') return { type: 'webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') { const v = b.readUInt32LE(21); return { type: 'webp', width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 }; }
  }
  return null;
}

/** Drops JPEG APP1-APP15 and COM segments, PNG text/EXIF/time chunks, WebP EXIF/XMP chunks. */
export function stripMetadata(b: Buffer, type: 'png' | 'jpeg' | 'webp'): Buffer {
  if (type === 'jpeg') {
    const out: Buffer[] = [b.subarray(0, 2)];
    let p = 2;
    while (p + 4 <= b.length && b[p] === 0xff) {
      const m = b[p + 1];
      if (m === 0xda) { out.push(b.subarray(p)); return Buffer.concat(out); }
      const len = b.readUInt16BE(p + 2);
      if (!((m >= 0xe1 && m <= 0xef) || m === 0xfe)) out.push(b.subarray(p, p + 2 + len));
      p += 2 + len;
    }
    return Buffer.concat(out);
  }
  if (type === 'png') {
    const out: Buffer[] = [b.subarray(0, 8)];
    let p = 8;
    while (p + 12 <= b.length) {
      const len = b.readUInt32BE(p);
      const t = b.toString('latin1', p + 4, p + 8);
      if (!['tEXt', 'iTXt', 'zTXt', 'eXIf', 'tIME'].includes(t)) out.push(b.subarray(p, p + 12 + len));
      p += 12 + len;
      if (t === 'IEND') break;
    }
    return Buffer.concat(out);
  }
  // WebP: keep VP8/VP8L/VP8X/ALPH/ANIM/ANMF/ICCP, drop EXIF and XMP, fix the RIFF size.
  const chunks: Buffer[] = [];
  let p = 12;
  while (p + 8 <= b.length) {
    const t = b.toString('latin1', p, p + 4);
    const len = b.readUInt32LE(p + 4);
    const total = 8 + len + (len & 1);
    if (t !== 'EXIF' && t !== 'XMP ') chunks.push(b.subarray(p, p + total));
    p += total;
  }
  const body = Buffer.concat(chunks);
  const head = Buffer.from(b.subarray(0, 12));
  head.writeUInt32LE(body.length + 4, 4);
  return Buffer.concat([head, body]);
}

export async function storeImage(ctx: Ctx, projectId: string, kind: ImageKind, data: Buffer, order: number, caption: string | null): Promise<HubImage> {
  if (data.length > ctx.cfg.MAX_IMAGE_MB * 1048576) throw new HttpError(413, 'too_large', `Pictures up to ${ctx.cfg.MAX_IMAGE_MB} MB`);
  const info = imageInfo(data);
  if (!info) throw new HttpError(415, 'bad_image', 'Only PNG, JPEG or WebP pictures');
  const lim = LIMITS[kind];
  if (info.width < lim.min[0] || info.height < lim.min[1] || info.width > lim.max[0] || info.height > lim.max[1]) {
    throw new HttpError(400, 'bad_size', `${kind}: ${lim.min.join('x')} to ${lim.max.join('x')} pixels (got ${info.width}x${info.height})`);
  }
  if (kind === 'gallery') {
    const n = await ctx.db.selectFrom('images').select((eb) => eb.fn.countAll().as('n')).where('project_id', '=', projectId).where('kind', '=', 'gallery').executeTakeFirst();
    if (Number(n?.n ?? 0) >= MAX_GALLERY) throw new HttpError(400, 'gallery_full', `Up to ${MAX_GALLERY} screenshots`);
  }
  const clean = stripMetadata(data, info.type);
  const key = `images/${sha256hex(clean)}.${info.type === 'jpeg' ? 'jpg' : info.type}`;
  await ctx.storage.put(key, clean, `image/${info.type}`);
  if (kind !== 'gallery') await ctx.db.deleteFrom('images').where('project_id', '=', projectId).where('kind', '=', kind).execute();
  const row = { id: newId('i'), project_id: projectId, kind, storage_key: key, width: info.width, height: info.height, ord: order, caption: caption?.slice(0, 140) ?? null, created_at: nowIso() };
  await ctx.db.insertInto('images').values(row).execute();
  return { id: row.id, url: ctx.storage.publicUrl(key), kind, width: row.width, height: row.height, order: row.ord, caption: row.caption };
}
