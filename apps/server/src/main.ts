// Starts the hub: HTTP API, the publish job (held versions after their hour) and the crawler.
import { loadConfig } from './config.ts';
import { createCtx } from './ctx.ts';
import { buildApp } from './app.ts';
import { publishDue } from './services/versions.ts';
import { crawlTick } from './sources/crawler.ts';
import { currentIndex, rebuildIndex } from './services/hubindex.ts';
import { pollTick } from './services/serverpoll.ts';
import { removeLongOffline } from './services/gameservers.ts';
import { discoverTick } from './services/discover-github.ts';

const cfg = loadConfig();
const ctx = await createCtx(cfg);
const app = await buildApp(ctx, { logger: cfg.production });
await currentIndex(ctx);

let busy = false;
const tick = async () => {
  if (busy) return;
  busy = true;
  try {
    await publishDue(ctx);
    if (cfg.CRAWLER) await crawlTick(ctx);
    await discoverTick(ctx); // no-op unless DISCOVER_GITHUB=1
  } catch (e) {
    console.error('[hub] job failed', e);
  } finally {
    busy = false;
  }
};
const timer = setInterval(tick, 60_000);
setTimeout(tick, 5_000);

// Game servers: the live list. Every listed server is asked directly on its game port every 90 s (backing off to
// 10 min while it does not answer); own loop, so the slow queries never hold up publishing. The old 6-hourly
// re-check is replaced by this (the poll refreshes names and offline marks too).
let polling = false;
const serverTick = async () => {
  if (polling) return;
  polling = true;
  try {
    if (cfg.SERVER_POLL) await pollTick(ctx);
    if (Date.now() - lastClean > 6 * 3600_000) {
      lastClean = Date.now();
      if ((await removeLongOffline(ctx)).length) await rebuildIndex(ctx);
    }
  } catch (e) {
    console.error('[hub] server poll failed', (e as Error).message);
  } finally {
    polling = false;
  }
};
let lastClean = Date.now();
const serverTimer = setInterval(serverTick, 10_000);
setTimeout(serverTick, 20_000);

await app.listen({ host: cfg.HOST, port: cfg.PORT });
console.log(`[hub] listening on http://${cfg.HOST}:${cfg.PORT} (${cfg.NODE_ENV}, db ${cfg.DATABASE_URL.split(':')[0]}, storage ${cfg.STORAGE}${cfg.HUB_DEV_LOGIN ? ', DEV LOGIN ON' : ''})`);
if (cfg.HUB_DEV_LOGIN) console.warn('[hub] *** DEVELOPMENT LOGIN IS ON: anyone on this computer can log in as dev-admin, dev-author, dev-author2 or dev-user. Local testing only. ***');

const stop = async () => {
  clearInterval(timer);
  clearInterval(serverTimer);
  await app.close();
  await ctx.db.destroy();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
