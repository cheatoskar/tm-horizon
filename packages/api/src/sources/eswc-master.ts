// TrackMania Nations ESWC (unofficial 1.80 patch, exe 0.1.7.9): master server list from the
// game's own web service. Found by reading TmNationsESWC.exe (see docs/eswc-masterserver.md):
//
//   GET https://game.trackmanianations.com/online_game/getservers.php?ver=0.1.7.9&lang=en[&login=<login>]
//
// No password and no session key; the game appends &login= once a player is logged in.
// The server only speaks TLS 1.0 (AES256-SHA) and its certificate (player.trackmania.com)
// expired on 2020-11-14, so the request needs TLS 1.0 enabled and no certificate check.
// Response: text, lines split by "\n", fields by ";":
//   line 1: "<status>;<count>"   status 0 = ok
//   then <count> lines: addr;prefix;port;name;level;nbOnline;nbServer;nbBuddy;<string>;<port2>
// These are the master servers ("rooms" by ladder level) with their player and server counts.
// The list of game servers on a master server comes over the game's own TCP protocol
// (CNetFormQuerrySessions) after a login; that part is not implemented.
//
// Off by default (servers.eswcMaster.enabled): enable it once the owner has run one live test.
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import crypto from 'node:crypto';
import type { MasterServerInfo, SourceStatus } from '../types.ts';
import type { SourceContext } from '../config.ts';
import { errorText } from '../lib/util.ts';

export const ESWC_LEVELS = ['Beginner', 'Normal', 'Expert'];

export interface EswcMasterConfig {
  enabled: boolean;
  /** "game.trackmanianations.com" */
  host: string;
  /** "/online_game" */
  path: string;
  /** Version the game sends, "0.1.7.9" for the unofficial 1.80 patch. */
  version: string;
  lang: string;
  timeoutMs: number;
  /** SHA-256 fingerprint of the server certificate (colon hex as Node prints it); null = log it, do not check. */
  certSha256: string | null;
}

export function eswcGetServersUrl(cfg: Pick<EswcMasterConfig, 'host' | 'path' | 'version' | 'lang'>, login?: string | null): string {
  // same order as the game's format string "%s/getservers.php?ver=%s&lang=%s" + "&login="
  let url = `https://${cfg.host}${cfg.path}/getservers.php?ver=${encodeURIComponent(cfg.version)}&lang=${encodeURIComponent(cfg.lang)}`;
  if (login) url += `&login=${encodeURIComponent(login)}`;
  return url;
}

export class EswcError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(`getservers.php status ${status}${message ? ': ' + message : ''}`);
    this.status = status;
  }
}

/** Parse the getservers.php text, as the game does (0x00A2FC22 in TmNationsESWC.exe 0.1.7.9). */
export function parseEswcServers(text: string): MasterServerInfo[] {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.length > 0);
  if (!lines.length) throw new Error('empty getservers.php response');
  const head = lines[0].split(';');
  const status = Number(head[0]);
  const count = Number(head[1]);
  if (!Number.isInteger(status) || head.length < 2) throw new Error(`unexpected first line "${lines[0].slice(0, 80)}"`);
  if (status !== 0) throw new EswcError(status, lines.slice(1).join(' ').slice(0, 160));
  if (!Number.isInteger(count) || count < 0) throw new Error(`bad server count "${head[1]}"`);
  if (count === 0) return [];
  if (lines.length - 1 < count) throw new Error(`announced ${count} master servers, got ${lines.length - 1} lines`);
  const out: MasterServerInfo[] = [];
  for (const line of lines.slice(1, 1 + count)) {
    const f = line.split(';');
    if (f.length < 8) throw new Error(`master server line with ${f.length} fields: "${line.slice(0, 80)}"`);
    const int = (s: string | undefined, max = Number.MAX_SAFE_INTEGER) => {
      const n = Number(s);
      return Number.isInteger(n) && n >= 0 && n <= max ? n : 0;
    };
    const level = int(f[4], 2);
    const name = f[3].trim() || f[0];
    out.push({
      id: `eswc-master:${name}`,
      game: 'eswc',
      name,
      level: ESWC_LEVELS[level] ?? null,
      players: int(f[5]),
      servers: int(f[6]),
      buddies: int(f[7]),
      address: f[0].trim(),
      port: int(f[2], 65535),
    });
  }
  return out;
}

export interface TlsGetResult {
  status: number;
  body: string;
  /** SHA-256 fingerprint of the server certificate. */
  fingerprint: string | null;
  protocol: string | null;
}

/**
 * GET over TLS 1.0 with AES256-SHA allowed (OpenSSL security level 0) and no certificate check,
 * the way the game talks to the old Nadeo server. Only for this one host.
 */
export function tls10Get(url: string, userAgent: string, timeoutMs: number): Promise<TlsGetResult> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        minVersion: 'TLSv1',
        ciphers: 'DEFAULT:AES256-SHA:@SECLEVEL=0',
        rejectUnauthorized: false,
        // the old server does not support secure renegotiation (RFC 5746)
        secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
        headers: { 'User-Agent': userAgent, Accept: '*/*' },
        agent: false,
        timeout: timeoutMs,
      },
      (res) => {
        const sock = res.socket as import('node:tls').TLSSocket;
        const cert = sock.getPeerCertificate?.();
        const fingerprint = cert && cert.fingerprint256 ? cert.fingerprint256 : null;
        const protocol = sock.getProtocol?.() ?? null;
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > 1_000_000) req.destroy(new Error('response larger than 1 MB'));
          else chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('latin1'), fingerprint, protocol }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs} ms`)));
    req.on('error', reject);
  });
}

export type EswcFetch = (url: string) => Promise<TlsGetResult>;

export async function buildEswcMaster(
  ctx: SourceContext,
  fetcher?: EswcFetch,
): Promise<{ masterServers: MasterServerInfo[]; sources: SourceStatus[] }> {
  const cfg = ctx.config.servers.eswcMaster;
  if (!cfg.enabled) {
    ctx.log('servers: ESWC master server list off (servers.eswcMaster.enabled)');
    return { masterServers: [], sources: [] };
  }
  const login = ctx.env.ESWC_LOGIN || null;
  if (ctx.env.ESWC_PASSWORD && !login) ctx.warn('servers: ESWC_PASSWORD set without ESWC_LOGIN');
  const url = eswcGetServersUrl(cfg, login);
  const shown = login ? url.replace(/login=[^&]*/, 'login=***') : url;
  const cacheFile = path.join(ctx.http.dir, 'eswc-getservers.txt');
  const fetch = fetcher ?? ((u: string) => tls10Get(u, ctx.config.userAgent, cfg.timeoutMs));
  try {
    if (ctx.http.offline) throw new Error('offline');
    const r = await fetch(url);
    if (r.status !== 200) throw new Error(`${shown} -> HTTP ${r.status}`);
    if (cfg.certSha256 && r.fingerprint && r.fingerprint.toUpperCase() !== cfg.certSha256.toUpperCase()) {
      throw new Error(`certificate changed: ${r.fingerprint} (expected ${cfg.certSha256})`);
    }
    if (!cfg.certSha256) ctx.log(`servers: ESWC master ${r.protocol ?? '?'} certificate ${r.fingerprint ?? '?'} (set servers.eswcMaster.certSha256 to pin it)`);
    const list = parseEswcServers(r.body);
    try {
      fs.writeFileSync(cacheFile, r.body, 'latin1');
    } catch {
      // cache is optional
    }
    return { masterServers: list, sources: [{ id: 'servers:eswc-master', ok: true, count: list.length, sample: false }] };
  } catch (e) {
    let cached: MasterServerInfo[] = [];
    try {
      cached = parseEswcServers(fs.readFileSync(cacheFile, 'latin1'));
    } catch {
      // no usable copy
    }
    if (errorText(e) !== 'offline') ctx.warn(`servers: ESWC master: ${errorText(e)}`);
    return {
      masterServers: cached,
      sources: [{ id: 'servers:eswc-master', ok: false, count: cached.length, sample: false, cached: cached.length > 0, error: errorText(e) }],
    };
  }
}

/** For docs and tests: the fingerprint format Node reports. */
export function fingerprintOf(der: Buffer): string {
  return crypto.createHash('sha256').update(der).digest('hex').toUpperCase().match(/../g)!.join(':');
}
