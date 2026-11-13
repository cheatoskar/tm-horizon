// A fake TrackMania game port for tests (127.0.0.1 only, needs queryTestFlags.allowLocal). It answers the
// two-message info query the way a real server does: checksum with the game's key, subtype 6 with the request id.
import { createServer, type Server } from 'node:net';
import { buildMessage, type Variant } from '../src/services/tmquery.ts';

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const text = (s: string) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([u32(b.length), b]); };

export interface FakeInfo { name?: string; comment?: string; players?: number; max?: number; map?: string; password?: boolean; mode?: number; pack?: string; spectators?: number }

/** Server info bytes (the part after the subtype 6 header) as the parser reads them. */
export function infoBytes(v: Variant, o: FakeInfo = {}): Buffer {
  const forever = v === 'forever';
  const parts: Buffer[] = [
    Buffer.from([forever ? 0x2d : 0x09, 1, 0, 0, 127]), Buffer.from([0x2e, 0x09]), text('LIVE-TEST'), text('#SRV#' + (o.password ? 'p' : '')), text(''),
    Buffer.from([o.players ?? 3, o.max ?? 40, o.spectators ?? 0, 10, 0]), text(o.name ?? '$o$f00Fake $fffServer'),
  ];
  if (forever) parts.push(text(o.pack ?? 'Stadium'));
  parts.push(u32(0), text(o.comment ?? 'a comment'), Buffer.from([o.mode ?? 1]), u32(180000), Buffer.from([1]), u32(1), text(o.map ?? 'A01-Race'));
  parts.push(forever ? Buffer.concat([u32(1000), Buffer.from([1, 0, 0])]) : Buffer.concat([u32(0), u32(1000), u32(2000)]));
  return Buffer.concat(parts);
}

export type FakeMode = 'ok' | 'silent' | 'garbage' | 'badsum' | 'reject-once';

export async function startFake(v: Variant, mode: FakeMode = 'ok', o: FakeInfo = {}): Promise<{ port: number; connections: () => number; update: (o: FakeInfo) => void; close: () => Promise<void> }> {
  let conns = 0;
  let cur = o;
  const socks = new Set<import('node:net').Socket>();
  const srv: Server = createServer((sock) => {
    conns++;
    socks.add(sock);
    let buf = Buffer.alloc(0);
    sock.on('error', () => {});
    sock.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      if (buf.length < 36) return;
      const first = buf.readUInt32LE(0);
      const msg2 = buf.subarray(4 + first + 4);
      const askedVersion = msg2.readUInt32LE(6);
      const id = msg2.readUInt32LE(14);
      buf = Buffer.alloc(0);
      if (mode === 'silent') return;
      if (mode === 'garbage') { sock.write(Buffer.from('HTTP/1.1 400 Bad Request\r\n\r\n')); return; }
      const wantVersion = v === 'forever' ? 7 : v === 'eswc' ? 5 : 4;
      if (mode === 'reject-once' && askedVersion !== wantVersion) {
        const m = buildMessage(v, 3, Buffer.concat([u32(wantVersion), u32(1)]));
        sock.write(Buffer.concat([u32(m.length), m]));
        return;
      }
      const data = infoBytes(v, cur);
      const m = buildMessage(v, 3, Buffer.concat([u32(wantVersion), u32(6), u32(id), u32(data.length), data]));
      if (mode === 'badsum') m[2] ^= 0xff;
      sock.write(Buffer.concat([u32(m.length), m]));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  return { port, connections: () => conns, update: (n) => { cur = { ...cur, ...n }; }, close: () => new Promise((r) => { for (const x of socks) x.destroy(); srv.close(() => r()); }) };
}
