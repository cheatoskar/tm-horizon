// Every setting comes from the environment (.env in development, /etc/tm-hub/hub.env on the server).
// .env.example lists them; docs/hub/secrets.md says which are secret.
import { z } from 'zod';

const bool = z.preprocess((v) => (typeof v === 'string' ? ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()) : v), z.boolean());
const url = z.string().url().transform((u) => (u.endsWith('/') ? u : u + '/'));
const optional = z.string().trim().optional().transform((v) => (v ? v : undefined));

const Env = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().default(8787),
  /** Public base URL of the API (download links and the index use it). */
  HUB_PUBLIC_URL: url.default('http://localhost:8787/'),
  /** Where the public website runs (https://...): its "Add your server" page may call the hub with the visitor's login (CORS with credentials, Origin check). */
  HUB_WEB_URL: optional,
  /** Where the portal runs (OAuth returns there, CORS/Origin check). */
  HUB_PORTAL_URL: url.default('http://localhost:5174/'),
  DATABASE_URL: z.string().default('sqlite:./data/hub.sqlite'),
  STORAGE: z.enum(['fs', 's3']).default('fs'),
  STORAGE_DIR: z.string().default('./data/files'),
  /** Base URL the stored files are served from (nginx cache in front of the bucket). Default: <HUB_PUBLIC_URL>files/. */
  FILES_PUBLIC_URL: optional,
  S3_ENDPOINT: optional,
  S3_REGION: optional,
  S3_BUCKET: optional,
  S3_ACCESS_KEY_ID: optional,
  S3_SECRET_ACCESS_KEY: optional,
  HUB_INDEX_SIGNING_KEY: optional,
  /** Extra public keys listed at /v1/index/keys during a key change (comma-separated base64). */
  HUB_INDEX_PUBLIC_KEYS: optional,
  INDEX_EXPIRES_DAYS: z.coerce.number().default(7),
  DISCORD_CLIENT_ID: optional,
  DISCORD_CLIENT_SECRET: optional,
  GITHUB_CLIENT_ID: optional,
  GITHUB_CLIENT_SECRET: optional,
  /** Development only: buttons that log in as made-up users. Refused when NODE_ENV=production. */
  HUB_DEV_LOGIN: bool.default(false),
  /** Admins, e.g. "discord:123456789,github:98765". */
  HUB_ADMINS: z.string().default(''),
  /** Token the crawler uses for GitHub (fine-grained, public repositories read-only). */
  GITHUB_TOKEN: optional,
  /** Secret of the GitHub App's webhook (instant release notices). */
  GITHUB_WEBHOOK_SECRET: optional,
  /** Slug of the GitHub App, for the "Install for instant updates" link. */
  GITHUB_APP_SLUG: optional,
  /** Moderation channel webhook: hold notices, review queue, reports. */
  DISCORD_WEBHOOK_URL: optional,
  VT_API_KEY: optional,
  VT_UPLOAD: bool.default(false),
  MAX_UPLOAD_MB: z.coerce.number().default(200),
  MAX_IMAGE_MB: z.coerce.number().default(5),
  HOLD_MINUTES: z.coerce.number().default(60),
  CRAWLER: bool.default(true),
  /** Live game server list: ask every listed server directly every 90 s (services/serverpoll.ts). */
  SERVER_POLL: bool.default(true),
  /** Daily GitHub search for TrackMania projects nobody listed yet (docs/hub/discover-github.md). Off by default. */
  DISCOVER_GITHUB: bool.default(false),
  CRAWL_ACTIVE_MIN: z.coerce.number().default(20),
  CRAWL_QUIET_MIN: z.coerce.number().default(240),
  /** Behind nginx: take the client address from X-Forwarded-For (rate limits only). */
  TRUST_PROXY: bool.default(false),
  /** GET /tmf/servers (TMNF/TMUF master server list) is on only when both TMF_ENABLED and TMF_LIVE are set. Bot settings: packages/tmf-master/src/config.ts. */
  TMF_ENABLED: bool.default(false),
  TMF_LIVE: bool.default(false),
});

export type Config = z.infer<typeof Env> & { filesPublicUrl: string; admins: Set<string>; production: boolean };

/** 127.0.0.1, ::1, localhost (and the rest of 127.0.0.0/8): reachable only from this machine. */
export function isLoopbackHost(h: string | undefined): boolean {
  if (!h) return false;
  const s = h.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/^::ffff:/, '');
  return s === 'localhost' || s === '::1' || /^127(\.\d{1,3}){3}$/.test(s);
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    throw new Error('Invalid configuration:\n' + parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n'));
  }
  const c = parsed.data;
  const production = c.NODE_ENV === 'production';
  if (c.HUB_DEV_LOGIN && !production) {
    // Made-up accounts only on a developer's own machine: development/test mode and bound to loopback.
    if (c.NODE_ENV !== 'development' && c.NODE_ENV !== 'test') throw new Error('HUB_DEV_LOGIN needs NODE_ENV=development');
    if (!isLoopbackHost(c.HOST)) throw new Error(`HUB_DEV_LOGIN needs HOST=127.0.0.1 (the server would listen on ${c.HOST})`);
  }
  if (production) {
    if (c.HUB_DEV_LOGIN) throw new Error('HUB_DEV_LOGIN must not be set in production');
    if (!c.HUB_INDEX_SIGNING_KEY) throw new Error('HUB_INDEX_SIGNING_KEY is required in production');
    if (!c.HUB_PUBLIC_URL.startsWith('https://') || !c.HUB_PORTAL_URL.startsWith('https://')) throw new Error('HUB_PUBLIC_URL and HUB_PORTAL_URL must be https in production');
    if (c.STORAGE === 's3' && !(c.S3_ENDPOINT && c.S3_BUCKET && c.S3_ACCESS_KEY_ID && c.S3_SECRET_ACCESS_KEY && c.S3_REGION)) throw new Error('S3_* settings incomplete');
  }
  return {
    ...c,
    production,
    filesPublicUrl: c.FILES_PUBLIC_URL ? (c.FILES_PUBLIC_URL.endsWith('/') ? c.FILES_PUBLIC_URL : c.FILES_PUBLIC_URL + '/') : c.HUB_PUBLIC_URL + 'files/',
    admins: new Set(c.HUB_ADMINS.split(',').map((s) => s.trim()).filter(Boolean)),
  };
}
