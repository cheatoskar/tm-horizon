import { createHash, randomBytes } from 'node:crypto';

const ALPHA = 'abcdefghijkmnpqrstuvwxyz23456789';
/** Random id with a type prefix, e.g. "p_k3m9...". */
export function newId(prefix: string, len = 14): string {
  const b = randomBytes(len);
  let s = '';
  for (const x of b) s += ALPHA[x % ALPHA.length];
  return `${prefix}_${s}`;
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256hex = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export const nowIso = () => new Date().toISOString();
export const addMinutes = (iso: string, min: number) => new Date(Date.parse(iso) + min * 60_000).toISOString();

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (s == null) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what = 'Not found') => new HttpError(404, 'not_found', what);
export const forbidden = (what = 'Not allowed') => new HttpError(403, 'forbidden', what);
export const badRequest = (what: string, details?: unknown) => new HttpError(400, 'bad_request', what, details);

/** URL-safe project slug: 3-48 chars, lower case letters, digits and single dashes. */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,47}$/;
export function slugify(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '') || 'project';
}

/** Turns a version string into a sortable key (semver-ish, numbers compared numerically). */
export function versionKey(v: string): string {
  const [core, pre] = v.replace(/^v/i, '').split('-', 2);
  const nums = core.split(/[.+]/).map((p) => (/^\d+$/.test(p) ? p.padStart(8, '0') : p.padEnd(8, ' ')));
  while (nums.length < 4) nums.push('00000000');
  return nums.join('.') + (pre ? '-' + pre : '~');
}
export const compareVersions = (a: string, b: string) => (versionKey(a) < versionKey(b) ? -1 : versionKey(a) > versionKey(b) ? 1 : 0);

/** Small LRU-ish set with a size cap (download de-duplication, never persisted). */
export class CappedSet {
  private set = new Set<string>();
  private max: number;
  constructor(max: number) {
    this.max = max;
  }
  /** true when the key was new. */
  add(k: string): boolean {
    if (this.set.has(k)) return false;
    this.set.add(k);
    if (this.set.size > this.max) this.set.delete(this.set.values().next().value as string);
    return true;
  }
  clear() {
    this.set.clear();
  }
}
