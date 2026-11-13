// Everything a request handler or job needs, built once at start (tests build their own).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import type { Config } from './config.ts';
import { isPostgres, openDb, type Db } from './db/db.ts';
import { migrate } from './db/migrations.ts';
import { createStorage, type Storage } from './storage.ts';
import { loadSigningKey, type SigningKey } from './index/sign.ts';
import { createVirusTotal, type VtClient } from './checks/virustotal.ts';
import { nowIso } from './util.ts';
import { guardedFetch } from './net.ts';

export interface Notice {
  kind: 'hold' | 'review' | 'published' | 'rejected' | 'report' | 'claim' | 'revoked' | 'source-error' | 'server';
  text: string;
  url?: string;
}

export interface Ctx {
  cfg: Config;
  db: Db;
  sqlite: boolean;
  storage: Storage;
  key: SigningKey;
  vt: VtClient | null;
  /** Network access of the crawler and OAuth (tests pass a fake). */
  fetch: typeof fetch;
  notify(n: Notice): Promise<void>;
  /** Last notices (tests and the admin page read them). */
  notices: (Notice & { at: string })[];
  audit(actor: string, action: string, target: string, detail?: unknown): Promise<void>;
}

/** Development without HUB_INDEX_SIGNING_KEY: a key kept in data/ (gitignored), printed once. Never in production. */
function devKey(cfg: Config): SigningKey {
  const file = './data/dev-index-key.txt';
  if (!existsSync(file)) {
    const { privateKey } = generateKeyPairSync('ed25519');
    const der = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, der.subarray(der.length - 32).toString('base64') + '\n', { mode: 0o600 });
  }
  const k = loadSigningKey(readFileSync(file, 'utf8'));
  if (cfg.NODE_ENV === 'development') console.log(`[hub] development index key ${k.keyId}, public key ${k.publicKey} (launcher debug builds: TMHUB_HUB_DEV_PUBKEYS=${k.publicKey})`);
  return k;
}

export async function createCtx(cfg: Config, over: Partial<Pick<Ctx, 'fetch' | 'storage' | 'db' | 'key'>> & { directMigrations?: boolean } = {}): Promise<Ctx> {
  if (cfg.DATABASE_URL.startsWith('sqlite:') && !cfg.DATABASE_URL.includes(':memory:')) mkdirSync(dirname(cfg.DATABASE_URL.slice('sqlite:'.length)), { recursive: true });
  const db = over.db ?? openDb(cfg.DATABASE_URL);
  const sqlite = !isPostgres(cfg.DATABASE_URL);
  await migrate(db, sqlite, { direct: over.directMigrations });
  // Every outgoing request goes through the SSRF guard (tests pass their own fake).
  const fetchImpl = over.fetch ?? guardedFetch();
  const notices: Ctx['notices'] = [];
  const ctx: Ctx = {
    cfg, db, sqlite, notices,
    storage: over.storage ?? createStorage(cfg),
    key: over.key ?? (cfg.HUB_INDEX_SIGNING_KEY ? loadSigningKey(cfg.HUB_INDEX_SIGNING_KEY) : devKey(cfg)),
    vt: createVirusTotal(cfg.VT_API_KEY, fetchImpl),
    fetch: fetchImpl,
    async notify(n) {
      notices.push({ ...n, at: nowIso() });
      if (notices.length > 200) notices.shift();
      if (!cfg.DISCORD_WEBHOOK_URL) return;
      const content = `${n.text}${n.url ? `\n<${n.url}>` : ''}`.slice(0, 1900);
      try {
        await fetchImpl(cfg.DISCORD_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content, allowed_mentions: { parse: [] } }) });
      } catch (e) {
        console.error('[hub] Discord webhook failed', (e as Error).message);
      }
    },
    async audit(actor, action, target, detail) {
      await db.insertInto('audit').values({ at: nowIso(), actor, action, target, detail: detail === undefined ? null : JSON.stringify(detail) }).execute();
    },
  };
  return ctx;
}
