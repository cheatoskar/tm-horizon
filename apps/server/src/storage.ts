// File storage for hub copies and images. Keys are content-addressed ("files/<sha256>/<name>"),
// so a stored object is never replaced: a second put of the same key must carry the same bytes.
// fs: a folder (development, or a single box without a bucket). s3: Oracle Object Storage through
// its S3-compatible API (path-style, SigV4), served to players through the nginx cache.
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { AwsClient } from 'aws4fetch';
import type { Config } from './config.ts';

export interface Storage {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  publicUrl(key: string): string;
}

const SAFE_KEY = /^[a-z0-9][a-z0-9._/-]{0,400}$/i;
export function checkKey(key: string): string {
  if (!SAFE_KEY.test(key) || key.split('/').some((p) => p === '..' || p === '.' || p === '')) throw new Error(`bad storage key: ${key}`);
  return key;
}

/** Name for a stored file: letters, digits, dot, dash, underscore; everything else becomes "-". */
export const storageName = (name: string) => name.replace(/^.*[\\/]/, '').replace(/[^\w.-]+/g, '-').replace(/^[.-]+/, '').slice(0, 120) || 'file';

export function fsStorage(dir: string, publicBase: string): Storage {
  const root = resolve(dir);
  const path = (key: string) => {
    const p = resolve(join(root, checkKey(key)));
    if (!p.startsWith(root + sep)) throw new Error('key outside storage');
    return p;
  };
  return {
    async put(key, data) {
      const p = path(key);
      const old = await readFile(p).catch(() => null);
      if (old) {
        if (createHash('sha256').update(old).digest('hex') !== createHash('sha256').update(data).digest('hex')) throw new Error(`refusing to replace stored object ${key}`);
        return;
      }
      await mkdir(dirname(p), { recursive: true });
      const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmp, data);
      await rename(tmp, p);
    },
    get: (key) => readFile(path(key)).catch(() => null),
    exists: (key) => stat(path(key)).then(() => true, () => false),
    delete: (key) => unlink(path(key)).catch(() => undefined),
    publicUrl: (key) => publicBase + checkKey(key),
  };
}

export function s3Storage(c: { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string }, publicBase: string, fetchImpl: typeof fetch = fetch): Storage {
  const aws = new AwsClient({ accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, region: c.region, service: 's3' });
  const url = (key: string) => `${c.endpoint.replace(/\/$/, '')}/${encodeURIComponent(c.bucket)}/${checkKey(key).split('/').map(encodeURIComponent).join('/')}`;
  const send = async (key: string, init: RequestInit) => fetchImpl(await aws.sign(url(key), init));
  const s: Storage = {
    async put(key, data, contentType) {
      if (await s.exists(key)) return; // content-addressed: same key = same bytes
      const r = await send(key, { method: 'PUT', body: new Uint8Array(data), headers: { 'content-type': contentType, 'x-amz-content-sha256': createHash('sha256').update(data).digest('hex') } });
      if (!r.ok) throw new Error(`object storage PUT ${key}: HTTP ${r.status}`);
    },
    async get(key) {
      const r = await send(key, { method: 'GET' });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`object storage GET ${key}: HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    },
    async exists(key) {
      const r = await send(key, { method: 'HEAD' });
      if (r.status === 404) return false;
      if (!r.ok) throw new Error(`object storage HEAD ${key}: HTTP ${r.status}`);
      return true;
    },
    async delete(key) {
      const r = await send(key, { method: 'DELETE' });
      if (!r.ok && r.status !== 404) throw new Error(`object storage DELETE ${key}: HTTP ${r.status}`);
    },
    publicUrl: (key) => publicBase + checkKey(key),
  };
  return s;
}

export function createStorage(cfg: Config): Storage {
  if (cfg.STORAGE === 's3') {
    return s3Storage({ endpoint: cfg.S3_ENDPOINT!, region: cfg.S3_REGION!, bucket: cfg.S3_BUCKET!, accessKeyId: cfg.S3_ACCESS_KEY_ID!, secretAccessKey: cfg.S3_SECRET_ACCESS_KEY! }, cfg.filesPublicUrl);
  }
  return fsStorage(cfg.STORAGE_DIR, cfg.filesPublicUrl);
}
