// npm run build: gather every source into dist/*.json.
// Each source is optional: a failure becomes a warning and the other files still build.
// Flags: --pretty (indented JSON), --strict (exit 1 when there are warnings), --offline (cache only).
// Exit 3 when every network source came back empty (files are still written).
import fs from 'node:fs';
import path from 'node:path';
import type {
  CatalogFile, CommunitiesFile, EventsFile, FileMeta, HubFileInfo, HubIndex, MapsFile, ModsFile, ProjectsFile, ServersFile, SourceStatus,
} from './types.ts';
import { loadConfig } from './config.ts';
import type { SourceContext } from './config.ts';
import { Http } from './lib/http.ts';
import { buildCatalog } from './sources/catalog.ts';
import { buildMods } from './sources/modloader.ts';
import { buildProjects } from './sources/github.ts';
import { buildMaps, LIST_TEXT } from './sources/tmx.ts';
import { buildEvents } from './sources/discord.ts';
import { buildServers } from './sources/servers.ts';
import { buildLiveEvents } from './sources/live-events.ts';
import { buildSubmittedEvents } from './sources/community.ts';
import { buildCommunities, COMMUNITIES_CREDIT, COMMUNITIES_SUGGEST } from './sources/communities.ts';

const root = path.resolve(import.meta.dirname, '..');
const args = new Set(process.argv.slice(2));
const outDir = path.resolve(root, process.env.HUB_OUT_DIR ?? 'dist');
const cacheDir = path.resolve(root, process.env.HUB_CACHE_DIR ?? '.cache');

async function main(): Promise<number> {
  const started = Date.now();
  const now = new Date();
  const config = loadConfig(path.join(root, 'config', process.env.HUB_CONFIG ?? 'hub.config.json'));
  const http = new Http(cacheDir, config.userAgent);
  http.offline = args.has('--offline');
  const warnings: string[] = [];
  const ctx: SourceContext = {
    http,
    config,
    root,
    env: process.env,
    warn: (m) => {
      warnings.push(m);
      console.warn('warn  ' + m);
    },
    log: (m) => console.log(m),
  };

  const catalog = await buildCatalog(ctx);
  const [mods, projects, maps, discordEvents, servers] = await Promise.all([
    buildMods(ctx),
    buildProjects(ctx, catalog.entries),
    buildMaps(ctx),
    buildEvents(ctx, now),
    buildServers(ctx, now),
  ]);
  http.save();
  // The Discord directory comes last: one invite lookup per second, so it is paced on its own.
  const communities = await buildCommunities(ctx, now);
  http.save();
  // Real events only: Discord (with a bot token), trackmania.io, TMTAS, and submitted ones (data/events/).
  const submitted = buildSubmittedEvents(ctx, now);
  const live = await buildLiveEvents(ctx, now);
  http.save();
  const events = {
    events: [...discordEvents.events, ...live.events, ...submitted.events].sort((a, b) => a.start.localeCompare(b.start)),
    sources: [...discordEvents.sources, ...live.sources, ...submitted.sources],
  };

  const generated = now.toISOString();
  const meta = (sources: SourceStatus[]): FileMeta => ({ schemaVersion: 1, generated, sources });
  const files = {
    mods: { ...meta(mods.sources), mods: mods.mods } satisfies ModsFile,
    projects: { ...meta(projects.sources), projects: projects.projects } satisfies ProjectsFile,
    maps: { ...meta(maps.sources), lists: LIST_TEXT, maps: maps.maps } satisfies MapsFile,
    events: { ...meta(events.sources), events: events.events } satisfies EventsFile,
    servers: { ...meta(servers.sources), servers: servers.servers, notAvailable: servers.notAvailable, masterServers: servers.masterServers } satisfies ServersFile,
    catalog: { ...meta(catalog.sources), catalogUpdated: catalog.updated, ...(catalog.collections?.length ? { collections: catalog.collections } : {}), entries: catalog.entries } satisfies CatalogFile,
    communities: {
      ...meta(communities.sources),
      credit: { text: COMMUNITIES_CREDIT.text, url: ctx.config.communities.sheetUrl },
      suggest: COMMUNITIES_SUGGEST,
      communities: communities.communities,
    } satisfies CommunitiesFile,
  };
  const info = (name: keyof typeof files, count: number, items: { sample?: boolean }[]): HubFileInfo => ({
    path: `${name}.json`,
    count,
    sample: files[name].sources.some((s) => s.sample) || items.some((i) => i.sample === true),
  });
  const hub: HubIndex = {
    schemaVersion: 1,
    name: 'tm-hub',
    generated,
    buildMs: 0,
    files: {
      mods: info('mods', mods.mods.length, []),
      projects: info('projects', projects.projects.length, []),
      maps: info('maps', maps.maps.length, []),
      events: info('events', events.events.length, events.events),
      servers: info('servers', servers.servers.length, servers.servers),
      catalog: info('catalog', catalog.entries.length, []),
      communities: info('communities', communities.communities.length, []),
    },
    counts: {
      mods: mods.mods.length,
      projects: projects.projects.length,
      maps: maps.maps.length,
      events: events.events.length,
      servers: servers.servers.length,
      catalog: catalog.entries.length,
      communities: communities.communities.length,
      playersOnline:
        servers.servers.filter((s) => !s.sample).reduce((a, s) => a + s.players, 0) +
        servers.masterServers.reduce((a, m) => a + m.players, 0),
    },
    warnings,
  };

  fs.mkdirSync(outDir, { recursive: true });
  const write = (name: string, data: unknown) => {
    const text = args.has('--pretty') ? JSON.stringify(data, null, 2) : JSON.stringify(data);
    fs.writeFileSync(path.join(outDir, name), text + '\n');
    return Buffer.byteLength(text);
  };
  const sizes: Record<string, number> = {};
  for (const [name, data] of Object.entries(files)) sizes[`${name}.json`] = write(`${name}.json`, data);
  hub.buildMs = Date.now() - started;
  sizes['hub.json'] = write('hub.json', hub);

  console.log('');
  for (const [name, bytes] of Object.entries(sizes)) {
    const key = name.replace('.json', '') as keyof HubIndex['counts'];
    const count = name === 'hub.json' ? '' : `${String(hub.counts[key]).padStart(5)} items`;
    console.log(`${name.padEnd(14)} ${count.padEnd(11)} ${(bytes / 1024).toFixed(1).padStart(8)} KiB`);
  }
  console.log(`requests: ${http.totalRequests()} (${Object.entries(http.requests).map(([h, n]) => `${h} ${n}`).join(', ') || 'none'})`);
  if (http.retries.length) console.log(`retried after a network error: ${http.retries.join(', ')}`);
  console.log(`${warnings.length} warnings, ${hub.buildMs} ms -> ${outDir}`);
  // Every network source empty: most likely the runner is offline. Fail, so CI keeps the last published data.
  const realServers = servers.servers.some((s) => !s.sample);
  if (!mods.mods.length && !projects.projects.length && !maps.maps.length && !realServers) {
    console.error('no network source returned anything: failing so the last published data stays');
    return 3;
  }
  return args.has('--strict') && warnings.length ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(2);
  },
);
