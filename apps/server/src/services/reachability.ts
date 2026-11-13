// Reachability self-test for players who host a server from the launcher: "can the internet reach
// my game port?". The hub connects back ONLY to the address the request came from (never to an
// address in the body, so it cannot be used to scan others), only to game ports 2350-2399, with a
// plain TCP connect (no data sent), one probe per IP at a time and a rate limit on the route.
// Docs: docs/hub/server-registration.md ("Reachability self-test").
import { Socket } from 'node:net';
import { isPrivateIp } from '../net.ts';

export const REACH_PORT_MIN = 2350;
export const REACH_PORT_MAX = 2399;
export const REACH_TIMEOUT_MS = 4000;

export type ProbeResult = 'open' | 'closed' | 'timeout';
export type Probe = (ip: string, port: number) => Promise<ProbeResult>;

/** TCP connect to ip:port; "open" = handshake done (closed at once), "closed" = refused/reset. */
export const tcpProbe: Probe = (ip, port) =>
  new Promise((resolve) => {
    const s = new Socket();
    let done = false;
    const end = (r: ProbeResult) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(r);
    };
    s.setTimeout(REACH_TIMEOUT_MS, () => end('timeout'));
    s.once('connect', () => end('open'));
    s.once('error', (e: NodeJS.ErrnoException) => end(e.code === 'ETIMEDOUT' ? 'timeout' : 'closed'));
    s.connect({ host: ip, port });
  });

/** "::ffff:1.2.3.4" -> "1.2.3.4". */
export const plainIp = (ip: string) => (ip.toLowerCase().startsWith('::ffff:') && ip.includes('.') ? ip.slice(7) : ip);

const inFlight = new Set<string>();

export class ReachError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** One self-test for the caller's own address. */
export async function selfTest(callerIp: string, port: number, probe: Probe): Promise<{ ip: string; port: number; tcp: ProbeResult }> {
  const ip = plainIp(callerIp);
  if (!Number.isInteger(port) || port < REACH_PORT_MIN || port > REACH_PORT_MAX) throw new ReachError(400, 'bad_port', `Only game ports ${REACH_PORT_MIN}-${REACH_PORT_MAX}`);
  if (isPrivateIp(ip)) throw new ReachError(400, 'private_address', 'The request came from a private address; the self-test only works over the internet');
  if (inFlight.has(ip)) throw new ReachError(429, 'busy', 'A test for this address is already running');
  inFlight.add(ip);
  try {
    return { ip, port, tcp: await probe(ip, port) };
  } finally {
    inFlight.delete(ip);
  }
}
