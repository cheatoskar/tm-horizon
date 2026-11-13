// VirusTotal: hash lookup (and optional upload of unknown files). Off without VT_API_KEY.
// Public API keys allow 4 requests a minute, so calls go through a small queue.
import type { CheckReport } from '@tm-hub/shared/hub';

export type VtResult = NonNullable<CheckReport['virusTotal']>;

export interface VtClient {
  lookup(sha256: string): Promise<VtResult>;
  upload(name: string, data: Buffer): Promise<VtResult>;
}

const API = 'https://www.virustotal.com/api/v3';

export function createVirusTotal(apiKey: string | undefined, fetchImpl: typeof fetch = fetch, minIntervalMs = 15_500): VtClient | null {
  if (!apiKey) return null;
  let chain: Promise<unknown> = Promise.resolve();
  let last = 0;
  const throttled = <T>(f: () => Promise<T>): Promise<T> => {
    const next = chain.then(async () => {
      const wait = last + minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      return f();
    });
    chain = next.catch(() => undefined);
    return next;
  };
  const verdict = (stats: Record<string, number> | undefined, sha: string): VtResult => {
    const mal = stats?.malicious ?? 0;
    const sus = stats?.suspicious ?? 0;
    return { status: mal > 0 ? 'malicious' : sus > 0 ? 'suspicious' : 'clean', positives: mal + sus, link: `https://www.virustotal.com/gui/file/${sha}` };
  };
  return {
    lookup: (sha256) => throttled(async () => {
      try {
        const r = await fetchImpl(`${API}/files/${sha256}`, { headers: { 'x-apikey': apiKey } });
        if (r.status === 404) return { status: 'unknown' };
        if (!r.ok) return { status: 'error' };
        const j = (await r.json()) as { data?: { attributes?: { last_analysis_stats?: Record<string, number> } } };
        return verdict(j.data?.attributes?.last_analysis_stats, sha256);
      } catch {
        return { status: 'error' };
      }
    }),
    upload: (name, data) => throttled(async () => {
      if (data.length > 32 * 1024 * 1024) return { status: 'unknown' };
      try {
        const fd = new FormData();
        fd.append('file', new Blob([new Uint8Array(data)]), name);
        const r = await fetchImpl(`${API}/files`, { method: 'POST', headers: { 'x-apikey': apiKey }, body: fd });
        return r.ok ? { status: 'queued' } : { status: 'error' };
      } catch {
        return { status: 'error' };
      }
    }),
  };
}
