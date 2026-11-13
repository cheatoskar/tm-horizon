// Outgoing requests to addresses that authors control (TMLoader servers, README pictures, release
// downloads) must not reach the box itself or the cloud's internal network (SSRF). guardedFetch
// resolves the host, refuses private, loopback, link-local and similar ranges, and follows redirects
// by hand so every hop is checked. (DNS rebinding between check and connect is not covered; the
// hub process also runs without access to other local services' credentials.)
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

function privateV4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
function privateV6(ip: string): boolean {
  const x = ip.toLowerCase();
  if (x === '::' || x === '::1') return true;
  if (x.startsWith('::ffff:')) return privateV4(x.slice(7));
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(x);
}
export const isPrivateIp = (ip: string) => (isIP(ip) === 4 ? privateV4(ip) : isIP(ip) === 6 ? privateV6(ip) : true);

export async function assertPublicUrl(u: string): Promise<URL> {
  const url = new URL(u);
  if (url.protocol !== 'https:') throw new Error('only https');
  if (url.username || url.password) throw new Error('credentials in URL');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error(`refusing to contact ${host} (private or local address)`);
  return url;
}

export function guardedFetch(base: typeof fetch = fetch, maxHops = 5): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    let url = String(input instanceof Request ? input.url : input);
    for (let hop = 0; hop <= maxHops; hop++) {
      await assertPublicUrl(url);
      const r = await base(url, { ...init, redirect: 'manual', signal: init.signal ?? AbortSignal.timeout(60_000) });
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
        if (init.redirect === 'manual') return r;
        url = new URL(r.headers.get('location')!, url).toString();
        continue;
      }
      return r;
    }
    throw new Error('too many redirects');
  }) as typeof fetch;
}
