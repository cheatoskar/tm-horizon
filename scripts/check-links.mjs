// Checks the download links of the mod catalog and the TMLoader mod index and writes a Markdown report.
//
//   node scripts/check-links.mjs [--limit N] [--dry-run] [--out report.md] [--catalog path] [--mods path]
//                                [--concurrency 6] [--max-mb 300]
//
// Sources:
//   - packages/catalog/catalog.json: `url` and `urls[]` of mod-like entries (category mod, tool, skins,
//     or any entry with mirrors). Entries without url and hosting "discord-attachment" are skipped.
//   - packages/api/dist/mods.json (if present): the newest version's `download` of every mod is downloaded
//     (size cap) and its SHA-256 compared with the one the TMLoader index states.
// Plain links get HEAD (ranged GET as fallback). Google Drive, Yandex and Discord links count as OK when
// the page answers at all. 401/403/429 are warnings (bot blocks), 404/410/5xx/network errors are broken.
// Also writes <out>.json with the counts. Exit code is 0 either way; the workflow reads the JSON.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (k) => argv.includes(`--${k}`);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};

const LIMIT = Number(opt('limit', 0)) || Infinity;
const DRY = flag('dry-run');
const OUT = opt('out', 'links-report.md');
const CATALOG = opt('catalog', join(root, 'packages', 'catalog', 'catalog.json'));
const MODS = opt('mods', join(root, 'packages', 'api', 'dist', 'mods.json'));
const CONCURRENCY = Number(opt('concurrency', 6));
const MAX_BYTES = Number(opt('max-mb', 300)) * 1024 * 1024;
const TIMEOUT_MS = 25_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;
const RETRIES = 2;
const UA = 'tm-horizon-linkcheck';
const LENIENT = /(^|\.)(drive\.google\.com|docs\.google\.com|disk\.yandex\.\w+|yadi\.sk|cdn\.discordapp\.com|media\.discordapp\.net|discord\.gg|discord\.com)$/i;
const MOD_CATEGORIES = new Set(['mod', 'tool', 'skins']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @returns {{ id: string, name: string, url: string, kind: 'link' | 'file', sha256?: string }[]} */
function collectTargets() {
  const targets = [];
  const seen = new Set();
  const add = (t) => {
    const key = `${t.kind}|${t.url}`;
    if (seen.has(key) || !/^https?:\/\//i.test(t.url)) return;
    seen.add(key);
    targets.push(t);
  };
  const catalog = JSON.parse(readFileSync(CATALOG, 'utf8'));
  for (const e of catalog.entries ?? []) {
    if (e.hosting === 'discord-attachment') continue;
    const modLike = MOD_CATEGORIES.has(e.category) || (Array.isArray(e.urls) && e.urls.length > 0);
    if (!modLike) continue;
    for (const url of [e.url, ...(e.urls ?? [])]) {
      if (typeof url === 'string' && url) add({ id: e.id, name: e.name, url, kind: 'link' });
    }
  }
  if (existsSync(MODS)) {
    const file = JSON.parse(readFileSync(MODS, 'utf8'));
    for (const m of file.mods ?? []) {
      const v = (m.versions ?? [])[0];
      if (!v?.download) continue;
      const sha256 = v.sha256Index ?? v.sha256 ?? undefined;
      add({ id: `mod:${m.id}`, name: `${m.name} ${v.version}`, url: v.download, kind: sha256 ? 'file' : 'link', sha256 });
    }
  } else {
    console.error(`note: ${MODS} not found, TMLoader files are not checked`);
  }
  return targets.slice(0, LIMIT);
}

async function request(url, init, timeout) {
  return fetch(url, {
    ...init,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
    headers: { 'User-Agent': UA, Accept: '*/*', ...(init.headers ?? {}) },
  });
}

/** One attempt for a plain link: HEAD, then a one-byte ranged GET when HEAD is refused. */
async function probe(url) {
  let res;
  try {
    res = await request(url, { method: 'HEAD' }, TIMEOUT_MS);
  } catch {
    res = null;
  }
  if (!res || res.status === 405 || res.status === 501 || res.status === 403 || res.status === 400 || res.status >= 500) {
    const get = await request(url, { method: 'GET', headers: { Range: 'bytes=0-0' } }, TIMEOUT_MS);
    await get.body?.cancel().catch(() => {});
    res = get;
  }
  return res.status;
}

function classify(url, status) {
  if (status >= 200 && status < 400) return { level: 'ok', detail: `HTTP ${status}` };
  const host = new URL(url).hostname;
  if (LENIENT.test(host) && status !== 404 && status !== 410) return { level: 'ok', detail: `HTTP ${status} (lenient host)` };
  if (status === 401 || status === 403 || status === 429) return { level: 'warn', detail: `HTTP ${status} (probably a bot block)` };
  return { level: 'broken', detail: `HTTP ${status}` };
}

async function withRetries(fn) {
  let last;
  for (let i = 0; i <= RETRIES; i++) {
    try {
      const r = await fn();
      if (r.level !== 'broken' || i === RETRIES) return r;
      last = r;
    } catch (e) {
      last = { level: 'broken', detail: `${e?.name === 'TimeoutError' ? 'timeout' : (e?.cause?.code ?? e?.message ?? 'error')}` };
      if (i === RETRIES) return last;
    }
    await sleep(1500 * (i + 1));
  }
  return last;
}

async function checkLink(t) {
  return withRetries(async () => classify(t.url, await probe(t.url)));
}

async function checkFile(t) {
  return withRetries(async () => {
    const res = await request(t.url, { method: 'GET' }, DOWNLOAD_TIMEOUT_MS);
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => {});
      return classify(t.url, res.status);
    }
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_BYTES) {
      await res.body.cancel().catch(() => {});
      return { level: 'warn', detail: `too large to hash (${(len / 1048576).toFixed(0)} MB), reachable` };
    }
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of res.body) {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) return { level: 'warn', detail: 'over the size cap, reachable, not hashed' };
      hash.update(chunk);
    }
    const got = hash.digest('hex');
    if (got.toLowerCase() !== t.sha256.toLowerCase()) {
      return { level: 'broken', detail: `SHA-256 mismatch: index ${t.sha256.slice(0, 12)}..., file ${got.slice(0, 12)}...` };
    }
    return { level: 'ok', detail: `SHA-256 ok (${(bytes / 1048576).toFixed(1)} MB)` };
  });
}

async function pool(items, worker, n) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await worker(items[i]);
      }
    }),
  );
  return results;
}

const targets = collectTargets();
console.error(`${targets.length} link(s) to check (${targets.filter((t) => t.kind === 'file').length} with SHA-256)`);

let results;
if (DRY) {
  results = targets.map(() => ({ level: 'skipped', detail: 'dry run' }));
  for (const t of targets) console.error(`- ${t.id} ${t.kind} ${t.url}`);
} else {
  results = await pool(targets, async (t) => {
    const r = await (t.kind === 'file' ? checkFile(t) : checkLink(t));
    console.error(`${r.level.padEnd(6)} ${t.id} ${t.url} ${r.detail}`);
    return r;
  }, CONCURRENCY);
}

const rows = targets.map((t, i) => ({ ...t, ...results[i] }));
const by = (level) => rows.filter((r) => r.level === level);
const line = (r) => `- \`${r.id}\` ${r.name}: ${r.url} (${r.detail})`;
const date = new Date().toISOString().slice(0, 10);
const md = [
  `# Mod link check, ${date}`,
  '',
  `Checked ${rows.length} link(s): ${by('ok').length} ok, ${by('warn').length} warnings, ${by('broken').length} broken${DRY ? ' (dry run, nothing was requested)' : ''}.`,
  '',
  ...(by('broken').length ? ['## Broken', '', ...by('broken').map(line), ''] : []),
  ...(by('warn').length ? ['## Warnings (reachable or blocked for bots, check by hand)', '', ...by('warn').map(line), ''] : []),
].join('\n');

writeFileSync(OUT, `${md}\n`);
writeFileSync(`${OUT}.json`, `${JSON.stringify({ checked: rows.length, ok: by('ok').length, warnings: by('warn').length, broken: by('broken').length }, null, 2)}\n`);
console.error(`report: ${OUT}`);
console.log(md);
