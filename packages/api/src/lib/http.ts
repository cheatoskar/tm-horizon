// Plain GET client with a disk cache: fresh entries are served without a request,
// stale ones are revalidated with If-None-Match / If-Modified-Since, and when the
// network fails a cached copy is used. Downloads for hashing are streamed and only
// their hash and size are kept.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sleep } from './util.ts';

export interface CacheEntry {
  url: string;
  etag: string | null;
  lastModified: string | null;
  fetchedAt: number;
  status: number;
  file: string;
  headers: Record<string, string>;
}

export interface FileHashEntry {
  url: string;
  etag: string | null;
  lastModified: string | null;
  checkedAt: number;
  sha256: string;
  size: number;
}

export interface GetOptions {
  /** Serve a cached copy younger than this without any request. */
  ttlMinutes?: number;
  headers?: Record<string, string>;
  /** Cache key when the URL alone is not enough (e.g. differs by token). */
  cacheKey?: string;
  timeoutMs?: number;
  /** Keep the body as raw bytes (returned and stored as a latin1 string, see getBytes). */
  binary?: boolean;
}

export interface GetResult {
  status: number;
  body: string;
  headers: Record<string, string>;
  /** Served from cache: "fresh" (no request), "revalidated" (304), "stale" (network failed). */
  cache: 'fresh' | 'revalidated' | 'stale' | null;
}

export class HttpError extends Error {
  status: number;
  body: string;
  constructor(url: string, status: number, body: string) {
    super(`${url} -> HTTP ${status}${body ? ': ' + body.slice(0, 160).replace(/\s+/g, ' ') : ''}`);
    this.status = status;
    this.body = body;
  }
}

const KEEP_HEADERS = ['content-type', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'x-ratelimit-limit'];
const sha1 = (s: string) => crypto.createHash('sha1').update(s).digest('hex');

export class Http {
  userAgent: string;
  dir: string;
  index: Record<string, CacheEntry>;
  files: Record<string, FileHashEntry>;
  /** Requests that went to the network, per host. */
  requests: Record<string, number> = {};
  /** Network errors that were retried once. */
  retries: string[] = [];
  /** Set by tests: no network at all, cache only. */
  offline = false;

  constructor(cacheDir: string, userAgent: string) {
    this.dir = cacheDir;
    this.userAgent = userAgent;
    fs.mkdirSync(path.join(cacheDir, 'http'), { recursive: true });
    this.index = readJson(path.join(cacheDir, 'http-index.json')) ?? {};
    this.files = readJson(path.join(cacheDir, 'files.json')) ?? {};
  }

  save(): void {
    fs.writeFileSync(path.join(this.dir, 'http-index.json'), JSON.stringify(this.index, null, 1));
    fs.writeFileSync(path.join(this.dir, 'files.json'), JSON.stringify(this.files, null, 1));
  }

  totalRequests(): number {
    return Object.values(this.requests).reduce((a, b) => a + b, 0);
  }

  private count(url: string): void {
    const host = new URL(url).host;
    this.requests[host] = (this.requests[host] ?? 0) + 1;
  }

  private async fetchRaw(url: string, headers: Record<string, string>, timeoutMs: number): Promise<Response> {
    if (this.offline) throw new Error('offline');
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        this.count(url);
        return await fetch(url, {
          headers: { 'User-Agent': this.userAgent, ...headers },
          redirect: 'follow',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        lastError = e;
        if (attempt === 0) {
          this.retries.push(url);
          await sleep(1500);
        }
      }
    }
    const err = lastError as { cause?: { code?: string }; message?: string };
    throw new Error(`${url} -> ${err?.cause?.code ?? err?.message ?? 'network error'}`);
  }

  private readBody(entry: CacheEntry, binary = false): string | null {
    try {
      return fs.readFileSync(path.join(this.dir, 'http', entry.file), binary ? 'latin1' : 'utf8');
    } catch {
      return null;
    }
  }

  async get(url: string, opts: GetOptions = {}): Promise<GetResult> {
    const key = opts.cacheKey ?? url;
    const entry = this.index[key];
    const cachedBody = entry ? this.readBody(entry, opts.binary) : null;
    if (entry && cachedBody !== null && opts.ttlMinutes && Date.now() - entry.fetchedAt < opts.ttlMinutes * 60_000) {
      return { status: entry.status, body: cachedBody, headers: entry.headers, cache: 'fresh' };
    }
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (entry && cachedBody !== null) {
      if (entry.etag) headers['If-None-Match'] = entry.etag;
      if (entry.lastModified) headers['If-Modified-Since'] = entry.lastModified;
    }
    let res: Response;
    try {
      res = await this.fetchRaw(url, headers, opts.timeoutMs ?? 25_000);
    } catch (e) {
      if (entry && cachedBody !== null) return { status: entry.status, body: cachedBody, headers: entry.headers, cache: 'stale' };
      throw e;
    }
    const kept: Record<string, string> = {};
    for (const h of KEEP_HEADERS) {
      const v = res.headers.get(h);
      if (v !== null) kept[h] = v;
    }
    if (res.status === 304 && entry && cachedBody !== null) {
      entry.fetchedAt = Date.now();
      entry.headers = { ...entry.headers, ...kept };
      return { status: entry.status, body: cachedBody, headers: entry.headers, cache: 'revalidated' };
    }
    const body = opts.binary ? Buffer.from(await res.arrayBuffer()).toString('latin1') : await res.text();
    if (!res.ok) {
      // Rate limited or a server error: an older copy beats nothing.
      if (entry && cachedBody !== null && (res.status === 429 || res.status === 403 || res.status >= 500)) {
        return { status: entry.status, body: cachedBody, headers: { ...entry.headers, ...kept }, cache: 'stale' };
      }
      throw new HttpError(url, res.status, body);
    }
    const file = sha1(key) + '.body';
    fs.writeFileSync(path.join(this.dir, 'http', file), body, opts.binary ? 'latin1' : 'utf8');
    this.index[key] = {
      url,
      etag: res.headers.get('etag'),
      lastModified: res.headers.get('last-modified'),
      fetchedAt: Date.now(),
      status: res.status,
      file,
      headers: kept,
    };
    return { status: res.status, body, headers: kept, cache: null };
  }

  async getJson<T>(url: string, opts: GetOptions = {}): Promise<{ data: T; result: GetResult }> {
    const result = await this.get(url, { ...opts, headers: { Accept: 'application/json', ...(opts.headers ?? {}) } });
    try {
      return { data: JSON.parse(result.body) as T, result };
    } catch {
      throw new Error(`${url} -> not JSON (${result.body.slice(0, 80).replace(/\s+/g, ' ')})`);
    }
  }

  /** A binary download (e.g. an xlsx export) with the same cache rules as get(). */
  async getBytes(url: string, opts: GetOptions = {}): Promise<{ bytes: Buffer; result: GetResult }> {
    const result = await this.get(url, { ...opts, binary: true });
    return { bytes: Buffer.from(result.body, 'latin1'), result };
  }

  /**
   * One uncached request whose status is returned instead of thrown (404 and 429 are answers here).
   * Honours offline mode and counts the request; the caller handles caching and pacing.
   */
  async getStatus(url: string, opts: { headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<{ status: number; body: string; retryAfterSec: number | null }> {
    const res = await this.fetchRaw(url, { Accept: 'application/json', ...(opts.headers ?? {}) }, opts.timeoutMs ?? 20_000);
    const body = await res.text();
    const ra = Number(res.headers.get('retry-after'));
    return { status: res.status, body, retryAfterSec: Number.isFinite(ra) && res.headers.get('retry-after') !== null ? ra : null };
  }

  /**
   * SHA-256 and size of a file, downloaded once and remembered by URL. A known file is
   * rechecked (conditional GET, 304 = unchanged) at most every recheckHours.
   */
  async hashFile(url: string, recheckHours: number): Promise<{ sha256: string; size: number; cached: boolean }> {
    const known = this.files[url];
    if (known && Date.now() - known.checkedAt < recheckHours * 3_600_000) {
      return { sha256: known.sha256, size: known.size, cached: true };
    }
    const headers: Record<string, string> = {};
    if (known?.etag) headers['If-None-Match'] = known.etag;
    if (known?.lastModified) headers['If-Modified-Since'] = known.lastModified;
    let res: Response;
    try {
      res = await this.fetchRaw(url, headers, 300_000);
    } catch (e) {
      if (known) return { sha256: known.sha256, size: known.size, cached: true };
      throw e;
    }
    if (res.status === 304 && known) {
      known.checkedAt = Date.now();
      await res.body?.cancel();
      return { sha256: known.sha256, size: known.size, cached: true };
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      if (known) return { sha256: known.sha256, size: known.size, cached: true };
      throw new HttpError(url, res.status, '');
    }
    const hash = crypto.createHash('sha256');
    let size = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      size += chunk.byteLength;
    }
    const sha256 = hash.digest('hex');
    this.files[url] = {
      url,
      etag: res.headers.get('etag'),
      lastModified: res.headers.get('last-modified'),
      checkedAt: Date.now(),
      sha256,
      size,
    };
    return { sha256, size, cached: false };
  }
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}
