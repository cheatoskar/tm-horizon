// TrackMania game-port server info query (TMNF/TMUF, Nations ESWC, Sunrise, Original), a TypeScript port
// of apps/launcher/src-tauri/src/serverquery.rs + lzo1x.rs (protocol: docs/design/server-query.md).
// The hub uses it for exactly one thing: ask ONE server that somebody wants to list "are you a TrackMania
// server, and what is your name?". Safety rules (docs/hub/server-registration.md, "Abuse"):
//   - never Nadeo's master server, only the submitted game port;
//   - public IP addresses only (the host name is resolved here and the connection goes to that address),
//     ports 1024-65535, one target per call;
//   - fixed 3 s limit for the whole connection, at most one retry, answer capped at 1 MiB;
//   - a global cap of queries per minute (acquireSlot), so the hub cannot be used as a scanner.
import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { connect, isIP, type Socket } from 'node:net';
import { isPrivateIp } from '../net.ts';

export type Variant = 'forever' | 'original' | 'sunrise' | 'eswc';

/** Registry game id onto the protocol variant. TMNF and TMUF (and Original and Sunrise) answer alike. */
export function variantOf(game: string): Variant | null {
  return ({ tmnf: 'forever', tmuf: 'forever', tmo: 'original', tms: 'sunrise', eswc: 'eswc' } as Record<string, Variant>)[game] ?? null;
}

const KEY_FOREVER = Buffer.from('b89dd780726b21ba98954315fa1cece1', 'hex');
const KEY_LEGACY = Buffer.from('08c481303a1226abaf1d6ae4fb65fbc9', 'hex');
const versionOf = (v: Variant) => (v === 'forever' ? 7 : v === 'eswc' ? 5 : 4);
const MAX_FRAME = 1 << 20;
export const QUERY_TIMEOUT_MS = 3000;

export class QueryError extends Error {
  kind: 'dns' | 'private' | 'port' | 'timeout' | 'refused' | 'io' | 'protocol' | 'rejected' | 'noinfo' | 'busy';
  serverVersion?: number;
  constructor(kind: QueryError['kind'], msg: string, serverVersion?: number) {
    super(msg);
    this.kind = kind;
    this.serverVersion = serverVersion;
  }
}
const proto = (m: string): never => { throw new QueryError('protocol', m); };

// ---- LZO1X (decompress only; every read and copy is bounds-checked, output capped at 4 MiB)
export const LZO_MAX_OUT = 4 << 20;
export function lzo1xDecompress(src: Uint8Array, size: number): Buffer {
  const bad = (w: string) => new QueryError('protocol', `lzo: ${w}`);
  if (size > LZO_MAX_OUT) throw bad('size too large');
  const out = Buffer.alloc(size);
  let op = 0;
  let ip = 0;
  let state = 0;
  const byte = () => { if (ip >= src.length) throw bad('input truncated'); return src[ip++]!; };
  const run = (base: number) => {
    let n = 0;
    for (;;) {
      if (ip >= src.length) throw bad('input truncated');
      if (src[ip] !== 0) break;
      n += 255; ip++;
      if (n > LZO_MAX_OUT) throw bad('run too long');
    }
    return n + base + byte();
  };
  const literals = (n: number) => {
    if (ip + n > src.length) throw bad('literals truncated');
    if (op + n > size) throw bad('output overrun');
    out.set(src.subarray(ip, ip + n), op);
    op += n; ip += n;
  };
  const copy = (dist: number, len: number) => {
    if (dist === 0 || dist > op) throw bad('bad distance');
    if (op + len > size) throw bad('output overrun');
    for (let i = 0; i < len; i++, op++) out[op] = out[op - dist]!;
  };
  if (src.length === 0) throw bad('empty input');
  if (src[0]! > 17) {
    const n = src[0]! - 17;
    ip = 1;
    literals(n);
    state = n < 4 ? n : 4;
  }
  for (;;) {
    const t = byte();
    if (t < 16) {
      if (state === 0) {
        literals((t === 0 ? run(15) : t) + 3);
        state = 4;
        continue;
      }
      const d = (t >> 2) + (byte() << 2);
      if (state === 4) copy(0x801 + d, 3);
      else copy(1 + d, 2);
    } else if (t >= 64) {
      const d = ((t >> 2) & 7) + (byte() << 3);
      copy(1 + d, (t >> 5) + 1);
    } else if (t >= 32) {
      const n = ((t & 31) !== 0 ? t & 31 : run(31)) + 2;
      const lo = byte();
      const hi = byte();
      copy(1 + ((lo | (hi << 8)) >> 2), n);
    } else {
      const n = ((t & 7) !== 0 ? t & 7 : run(7)) + 2;
      const lo = byte();
      const hi = byte();
      const d = ((t & 8) << 11) + ((lo | (hi << 8)) >> 2);
      if (d === 0) break;
      copy(d + 0x4000, n);
    }
    state = src[ip - 2]! & 3;
    if (state !== 0) literals(state);
  }
  if (op !== size) throw bad('size mismatch');
  return out;
}

// ---- framing and checksum
function checksum(v: Variant, msg: Buffer, pos: number): number {
  const data = Buffer.from(msg);
  data.fill(0, pos, pos + 4);
  const key = v === 'forever' ? KEY_FOREVER : KEY_LEGACY;
  const d = createHmac('md5', key).update(data).digest();
  const w = (i: number) => d.readUInt32LE(i * 4);
  const sum = v === 'forever' ? w(0) + w(1) + w(2) + w(3) : w(0) + w(1) + w(2) + key.readUInt32LE(0);
  return sum >>> 0;
}

/** One message without the length prefix: flags 0x82 (checksum), type, checksum, payload. */
export function buildMessage(v: Variant, type: number, payload: Buffer): Buffer {
  const m = Buffer.concat([Buffer.from([0x82, type, 0, 0, 0, 0]), payload]);
  m.writeUInt32LE(checksum(v, m, 2), 2);
  return m;
}
const framed = (msg: Buffer) => Buffer.concat([u32(msg.length), msg]);
function u32(n: number) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }
export function connectionAdmin(v: Variant, version: number, subtype: number, args: number[] = []): Buffer {
  return framed(buildMessage(v, 3, Buffer.concat([u32(version), u32(subtype), ...args.map(u32)])));
}

/** Checks flags and checksum, decompresses. Returns [message type, payload]. */
export function decodeMessage(v: Variant, msg: Buffer): [number, Buffer] {
  if (msg.length < 2) return proto('message too short');
  const flags = msg[0]!;
  const ty = msg[1]!;
  if ((flags & 0xf0) !== 0x80) return proto('bad flags');
  let pos = 2;
  if (flags & 0x0c) pos += 2;
  // Real servers always send the checksum; it is the strongest sign that this is a TrackMania server.
  if (!(flags & 0x02)) return proto('no checksum');
  if (msg.length < pos + 4) return proto('message too short');
  if (msg.readUInt32LE(pos) !== checksum(v, msg, pos)) return proto('bad checksum');
  pos += 4;
  if (flags & 0x01) {
    if (msg.length < pos + 4) return proto('message too short');
    return [ty, lzo1xDecompress(msg.subarray(pos + 4), msg.readUInt32LE(pos))];
  }
  return [ty, msg.subarray(pos)];
}

// ---- parsing
class Rd {
  p = 0;
  d: Buffer;
  constructor(d: Buffer) { this.d = d; }
  get left() { return this.d.length - this.p; }
  take(n: number) { if (n > this.left) return proto('truncated'); this.p += n; return this.d.subarray(this.p - n, this.p); }
  u8() { return this.take(1)[0]!; }
  u16() { return this.take(2).readUInt16LE(0); }
  u32() { return this.take(4).readUInt32LE(0); }
  text() {
    const n = this.u32();
    let b = this.take(n);
    if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
    return b.toString('utf8');
  }
  count(min: number) {
    const n = this.u32();
    if (n * min > this.left) return proto('implausible count');
    return n;
  }
}

/** Removes TrackMania format codes: `$$` becomes `$`, `$fff`, `$o`, `$l[url]` and so on vanish. */
export function stripFormat(s: string): string {
  const c = Array.from(s);
  let out = '';
  let i = 0;
  while (i < c.length) {
    if (c[i] !== '$') { out += c[i]; i++; continue; }
    const n = c[i + 1];
    if (n === undefined) { out += '$'; break; }
    if (n === '$') { out += '$'; i += 2; }
    else if (/^[0-9a-fA-F]$/.test(n)) {
      let j = i + 1;
      while (j < c.length && j < i + 4 && /^[0-9a-fA-F]$/.test(c[j]!)) j++;
      i = j;
    } else if ('lLhHpP'.includes(n) && c[i + 2] === '[') {
      const e = c.indexOf(']', i + 3);
      i = e < 0 ? i + 2 : e + 1;
    } else if (n === '\n') { out += '$'; i++; }
    else i += 2;
  }
  return out;
}

const MODES: Record<number, string> = { 1: 'TimeAttack', 3: 'Rounds', 6: 'Team', 7: 'Laps', 8: 'Stunts', 9: 'Cup' };

export interface ServerInfo {
  gameTag: number; reportedAddress: string; hostLogin: string;
  password: boolean; spectatorPassword: boolean;
  players: number; maxPlayers: number; spectators: number; maxSpectators: number;
  name: string; comment: string; mode: string | null; currentMap: string | null;
}

/** Parses the server info bytes of a subtype 6 answer (the map list only as far as the current map). */
export function parseServerInfo(data: Buffer, v: Variant): ServerInfo {
  const r = new Rd(data);
  const tag = r.u8();
  const forever = v === 'forever';
  const ok = forever ? (tag & 0xe0) === 0x20 && (tag & 0x1f) === 0x0d : (tag & 0xe0) === 0 && ((tag & 0x1f) === 0x07 || (tag & 0x1f) === 0x09);
  if (!ok) return proto('game tag does not match');
  const ip = r.take(4);
  const port = r.u16();
  const reportedAddress = `${ip[3]}.${ip[2]}.${ip[1]}.${ip[0]}:${port}`;
  const hostLogin = r.text();
  const login = r.text();
  if (!login.startsWith('#SRV#')) throw new QueryError('noinfo', 'server has no game info yet');
  const flag = login[5];
  r.text(); // unused, always empty
  const players = r.u8(); const maxPlayers = r.u8(); const spectators = r.u8(); const maxSpectators = r.u8();
  r.u8(); // ladder mode
  const nameRaw = r.text();
  if (forever) r.text(); // pack mask
  const n = r.count(8);
  const names: string[] = [];
  for (let i = 0; i < n; i++) names.push(r.text());
  for (let i = 0; i < n; i++) r.take(4); // ladder ranks
  const commentRaw = r.text();
  const info: ServerInfo = {
    gameTag: tag, reportedAddress, hostLogin, password: flag === 'p' || flag === 'f', spectatorPassword: flag === 's' || flag === 'f',
    players, maxPlayers, spectators, maxSpectators, name: stripFormat(nameRaw), comment: stripFormat(commentRaw), mode: null, currentMap: null,
  };
  if (r.left === 0) return info;
  info.mode = MODES[r.u8()] ?? null;
  r.u32(); // limit
  r.u8(); // number of maps
  const m = r.count(11);
  if (m > 0) info.currentMap = stripFormat(r.text());
  return info;
}

// ---- address rules and the global cap
export const queryTestFlags = { /** Tests only: lets queries and addresses reach 127.0.0.1 (fake servers). Never set outside tests. */ allowLocal: false };

const CAP_PER_MINUTE = 30;
const slots: number[] = [];
/** True and counts one query when the global cap of 30 queries per minute allows it. */
export function acquireSlot(now = Date.now()): boolean {
  while (slots.length && slots[0]! < now - 60_000) slots.shift();
  if (slots.length >= CAP_PER_MINUTE) return false;
  slots.push(now);
  return true;
}
export const resetSlots = () => { slots.length = 0; };
/** Waits (re-checking each second) until a slot is free; for the background job only. */
export async function waitSlot(): Promise<void> {
  while (!acquireSlot()) await new Promise((r) => setTimeout(r, 1000));
}

export interface Target { ip: string; port: number }

/** Splits "host:port", checks the port and resolves to ONE public address (the connection goes to that address, not to the name). */
export async function resolveTarget(address: string): Promise<Target> {
  const m = /^(.+):(\d{1,5})$/.exec(address);
  if (!m) throw new QueryError('dns', 'bad address');
  const port = Number(m[2]);
  if (port < 1024 || port > 65535) throw new QueryError('port', 'port must be 1024-65535');
  const host = m[1]!.replace(/^\[|\]$/g, '');
  const local = queryTestFlags.allowLocal;
  let addrs: string[];
  if (isIP(host)) addrs = [host];
  else {
    try {
      addrs = (await Promise.race([lookup(host, { all: true }), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('dns timeout')), 2000))])).map((a) => a.address);
    } catch {
      throw new QueryError('dns', 'name does not resolve');
    }
  }
  if (!addrs.length) throw new QueryError('dns', 'name does not resolve');
  if (!local && addrs.some((a) => isPrivateIp(a))) throw new QueryError('private', 'address is not public');
  return { ip: addrs.find((a) => isIP(a) === 4) ?? addrs[0]!, port };
}

// ---- network
function queryOnce(t: Target, v: Variant, version: number, requestId: number, timeoutMs: number): Promise<ServerInfo> {
  return new Promise((resolve, reject) => {
    let done = false;
    let sock: Socket | null = null;
    const finish = (err: unknown, info?: ServerInfo) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock?.destroy();
      if (err) reject(err); else resolve(info!);
    };
    const timer = setTimeout(() => finish(new QueryError('timeout', 'no answer in time')), timeoutMs);
    let buf = Buffer.alloc(0);
    sock = connect({ host: t.ip, port: t.port });
    sock.setNoDelay(true);
    sock.on('error', (e: NodeJS.ErrnoException) => finish(new QueryError(e.code === 'ECONNREFUSED' ? 'refused' : 'io', e.code ?? e.message)));
    sock.on('close', () => finish(new QueryError('io', 'closed before an answer')));
    sock.on('connect', () => {
      sock!.write(Buffer.concat([connectionAdmin(v, version, 8), connectionAdmin(v, version, 7, [requestId])]));
    });
    let frames = 0;
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        for (;;) {
          if (buf.length < 4) return;
          const n = buf.readUInt32LE(0);
          if (n < 2 || n > MAX_FRAME) return proto('bad frame length');
          if (buf.length < 4 + n) return;
          const msg = buf.subarray(4, 4 + n);
          buf = buf.subarray(4 + n);
          if (++frames > 16) return proto('no matching answer');
          const [ty, payload] = decodeMessage(v, Buffer.from(msg));
          if (ty !== 3) continue;
          const r = new Rd(payload);
          const serverVersion = r.u32();
          const subtype = r.u32();
          if (subtype === 1) throw new QueryError(v === 'forever' ? 'protocol' : 'rejected', 'query refused', serverVersion);
          if (subtype !== 6) continue;
          const id = r.u32();
          const len = r.u32();
          const data = r.take(len);
          if (id === 0xffffffff) throw new QueryError('noinfo', 'server has no game info yet');
          if (id !== requestId) continue;
          return finish(null, parseServerInfo(Buffer.from(data), v));
        }
      } catch (e) { finish(e); }
    });
  });
}

const randomId = () => 1 + Math.floor(Math.random() * 0x7ffffffe);

export interface QueryResult { info: ServerInfo; pingMs: number }

/**
 * Asks one server of `game` at "host:port". One connection; at most one retry (after a timeout or reset,
 * or when a legacy server wants the other protocol version). Every connection takes a slot of the global
 * cap; with none free this throws QueryError('busy') unless `wait` is set (background job).
 */
export async function queryServer(game: string, address: string, opts: { wait?: boolean } = {}): Promise<QueryResult> {
  const v = variantOf(game);
  if (!v) throw new QueryError('protocol', `unknown game ${game}`);
  const target = await resolveTarget(address);
  const started = Date.now();
  let version = versionOf(v);
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (opts.wait) await waitSlot();
    else if (!acquireSlot()) throw new QueryError('busy', 'too many checks right now, try again in a minute');
    const left = QUERY_TIMEOUT_MS - (Date.now() - started);
    if (attempt > 0 && left < 800) break;
    try {
      const t0 = Date.now();
      const info = await queryOnce(target, v, version, randomId(), attempt === 0 ? QUERY_TIMEOUT_MS : Math.max(800, left));
      return { info, pingMs: Date.now() - t0 };
    } catch (e) {
      lastErr = e;
      if (!(e instanceof QueryError)) throw e;
      const sv = e.serverVersion;
      if (e.kind === 'rejected' && sv !== undefined && sv !== version && (sv === 4 || sv === 5)) { version = sv; continue; }
      if (e.kind === 'timeout' || e.kind === 'io') continue;
      throw e;
    }
  }
  throw lastErr;
}
