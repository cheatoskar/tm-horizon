// Parser tests against small recorded responses in test/fixtures/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, offlineContext, tempDir, validator } from './helpers.ts';
import { deriveCategory, mergeMods, parseModIndex, readLocalServers } from '../src/sources/modloader.ts';
import { collectRepos, parseProject, pickRelease } from '../src/sources/github.ts';
import type { GhRelease, GhRepo } from '../src/sources/github.ts';
import { parseTmxPage, tmxSearchUrl } from '../src/sources/tmx.ts';
import { buildEvents, parseDiscordEvents } from '../src/sources/discord.ts';
import { parseTmioCompetitionList, tmioCompetitionEvent, parseTmtasEvents } from '../src/sources/live-events.ts';
import { parseManiaPlanetServers, parseTmioRooms } from '../src/sources/servers.ts';
import { normaliseCatalog } from '../src/sources/catalog.ts';
import type { TmxSiteConfig } from '../src/config.ts';

const meta = { schemaVersion: 1 as const, generated: '2026-11-10T16:00:00.000Z', sources: [] };
const valid = (name: string, data: unknown) => {
  const v = validator(name);
  assert.ok(v(data), JSON.stringify(v.errors, null, 1));
};

// ------------------------------------------------------------- TMLoader

test('modloader: TM Vibrant Shaders index', () => {
  const mods = parseModIndex(fixture('modloader-tmvs.json'), 'https://cheatoskar.github.io/TM-Vibrant-Shaders/modloader/');
  assert.equal(mods.length, 1);
  const m = mods[0];
  assert.equal(m.id, 'TM Vibrant Shaders');
  assert.equal(m.slug, 'tm-vibrant-shaders');
  assert.equal(m.author, 'cheatoskar');
  assert.equal(m.category, 'graphics');
  assert.deepEqual(m.games, ['tmnf', 'tmuf']);
  assert.equal(m.latest, '1.4.2');
  assert.equal(m.versions[0].version, '1.4.2');
  assert.deepEqual(m.versions[0].dependencies, [{ id: 'CoreMod', version: '^1.0.1' }]);
  assert.match(m.versions[0].sha256Index ?? '', /^[0-9a-f]{64}$/);
  assert.equal(m.versions[0].sha256, null);
});

test('modloader: categories of the known repositories', () => {
  const all = [
    ...parseModIndex(fixture('modloader-donadigo.json'), 'd/'),
    ...parseModIndex(fixture('modloader-fullspeed.json'), 'f/'),
    ...parseModIndex(fixture('modloader-tomashu.json'), 't/'),
  ];
  const cat = Object.fromEntries(all.map((m) => [m.id, m.category]));
  assert.deepEqual(cat, { TMInterface: 'TAS', 'Competition Patch': 'competition', CenterSpeed: 'HUD', TmForever: 'library', CoreMod: 'library' });
  assert.equal(deriveCategory('TMFOXR', { description: 'OpenXR VR support for TrackMania United Forever' }), 'VR');
  assert.equal(deriveCategory('X', { description: 'extends the built-in track editor' }), 'editor');
  assert.equal(deriveCategory('X', { description: 'General Mod.' }), 'tools');
  const tmi = all.find((m) => m.id === 'TMInterface')!;
  assert.equal(tmi.latest, '2.2.1');
  assert.deepEqual(tmi.versions.map((v) => v.version), ['2.2.1', '2.2.0', '2.1.1', '2.1.0']);
});

test('modloader: mirrors merge, overrides apply', () => {
  const a = parseModIndex(fixture('modloader-tomashu.json'), 'https://a/');
  const b = parseModIndex(fixture('modloader-tomashu.json'), 'https://b/');
  const merged = mergeMods([a, b], { CoreMod: { category: 'tools', games: ['tmnf'] } });
  assert.equal(merged.length, 2);
  const core = merged.find((m) => m.id === 'CoreMod')!;
  assert.deepEqual(core.repositories, ['https://a/', 'https://b/']);
  assert.equal(core.category, 'tools');
  assert.deepEqual(core.games, ['tmnf']);
  assert.equal(core.versions.length, a.find((m) => m.id === 'CoreMod')!.versions.length);
  valid('mods', { ...meta, mods: merged });
});

test('modloader: rejects the masterserver index and junk', () => {
  assert.throws(() => parseModIndex(fixture('modloader-master.json'), 'x/'), /products/);
  assert.throws(() => parseModIndex(null, 'x/'));
  assert.ok(Array.isArray(fixture<{ servers: string[] }>('modloader-master.json').servers));
});

test('modloader: reads servers from a TMLoader config.yaml', () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'TMLoader'));
  fs.writeFileSync(path.join(dir, 'TMLoader', 'config.yaml'), "version: 1.0.1\nservers:\n  - 'https://a.example/modloader/'\n  - 'https://b.example/'\n");
  assert.deepEqual(readLocalServers({ LOCALAPPDATA: dir }), ['https://a.example/modloader/', 'https://b.example/']);
  assert.deepEqual(readLocalServers({ LOCALAPPDATA: path.join(dir, 'missing') }), []);
});

// ------------------------------------------------------------- GitHub

test('github: project with releases', () => {
  const repo = fixture<GhRepo>('github-repo-gbx-net.json');
  const releases = fixture<GhRelease[]>('github-releases-gbx-net.json');
  const p = parseProject(repo, releases, ['gbx-net'], ['tmnf']);
  assert.equal(p.id, 'BigBang1112/gbx-net');
  assert.ok(p.stars > 0);
  assert.equal(p.release?.tag, releases.find((r) => !r.draft && !r.prerelease)?.tag_name);
  assert.ok((p.release?.assets.length ?? 0) > 0);
  assert.ok(p.release!.assets.every((a) => a.download.startsWith('https://github.com/')));
  const none = parseProject(fixture<GhRepo>('github-repo-evosc.json'), [], ['evosc'], []);
  assert.equal(none.release, null);
  valid('projects', { ...meta, projects: [p, none] });
});

test('github: release choice and repository list', () => {
  const r = (tag: string, prerelease: boolean, draft = false) => ({ tag_name: tag, prerelease, draft }) as GhRelease;
  assert.equal(pickRelease([r('v3-draft', false, true), r('v2-rc', true), r('v1', false)])?.tag_name, 'v1');
  assert.equal(pickRelease([r('v2-rc', true)])?.tag_name, 'v2-rc');
  assert.equal(pickRelease([]), null);
  const cat = normaliseCatalog(fixture('catalog.json')).entries;
  const repos = collectRepos(cat, ['TwinkieTweaks/twinkieforever', 'a/b']);
  const twinkie = repos.find((x) => x.repo.toLowerCase() === 'twinkietweaks/twinkieforever')!;
  assert.deepEqual(twinkie.catalogIds, ['twinkie-forever']);
  assert.ok(repos.some((x) => x.repo === 'a/b'));
  assert.ok(!repos.some((x) => x.repo === 'TwinkieTweaks'));
});

// ------------------------------------------------------------- TMX

const tmnf: TmxSiteConfig = { site: 'tmnf-x', game: 'tmnf', host: 'tmnf.exchange', kind: 'tracks' };
const tm2: TmxSiteConfig = { site: 'tm2-mx', game: 'tm2-stadium', host: 'tm.mania.exchange', kind: 'maps', titlepack: 'TMStadium' };

test('tmx: track site', () => {
  const maps = parseTmxPage(fixture('tmx-tmnf-tracks.json'), tmnf, 'awarded');
  assert.equal(maps.length, 3);
  const m = maps[0];
  assert.equal(m.id, 'tmnf-x:3726386');
  assert.equal(m.name, 'ANE Tech me');
  assert.equal(m.author, 'RonMatrixa');
  assert.equal(m.awards, 6);
  assert.equal(m.environment, 'Stadium');
  assert.equal(m.uploaded, '2011-02-11T18:04:32.000Z');
  assert.equal(m.url, 'https://tmnf.exchange/trackshow/3726386');
  assert.equal(m.thumbnail, 'https://tmnf.exchange/trackshow/3726386/image/1');
  assert.equal(m.download, 'https://tmnf.exchange/trackgbx/3726386');
});

test('tmx: map site and search URLs', () => {
  const maps = parseTmxPage(fixture('tmx-tm2-maps.json'), tm2, 'latest');
  assert.equal(maps.length, 3);
  assert.ok(maps.every((m) => m.game === 'tm2-stadium' && m.environment === 'Stadium' && m.lists.join() === 'latest'));
  assert.equal(maps[0].download, `https://tm.mania.exchange/mapgbx/${maps[0].exchangeId}`);
  assert.equal(maps[0].thumbnail, `https://tm.mania.exchange/mapthumb/${maps[0].exchangeId}`);
  valid('maps', { ...meta, lists: { awarded: 'a', latest: 'b' }, maps });
  const u = new URL(tmxSearchUrl(tm2, 'awarded', 8));
  assert.equal(u.pathname, '/api/maps');
  assert.equal(u.searchParams.get('order1'), '40');
  assert.equal(u.searchParams.get('titlepack'), 'TMStadium');
  assert.match(u.searchParams.get('fields') ?? '', /^MapId,Name,/);
  assert.equal(new URL(tmxSearchUrl(tmnf, 'latest', 8)).searchParams.get('order1'), '2');
  assert.throws(() => parseTmxPage({ error: 'x' }, tmnf, 'latest'), /Results/);
});

// ------------------------------------------------------------- Discord

test('discord: scheduled events with join links', () => {
  const guild = { id: '1100000000000000000', name: 'Test community', invite: 'https://discord.gg/example', games: ['tmnf' as const] };
  const events = parseDiscordEvents(fixture('discord-events.json'), guild);
  assert.equal(events.length, 3);
  const [cup, voice, league] = events;
  assert.equal(cup.id, 'discord:1100000000000000000:1305000000000000001');
  assert.equal(cup.start, '2026-11-14T19:00:00.000Z');
  assert.equal(cup.status, 'scheduled');
  assert.equal(cup.interested, 23);
  assert.deepEqual(cup.join, { raw: 'tmtp://#join=forevercup', scheme: 'tmtp', action: 'join', target: 'forevercup', title: null });
  assert.match(cup.image ?? '', /^https:\/\/cdn\.discordapp\.com\/guild-events\/1305000000000000001\//);
  assert.equal(cup.url, 'https://discord.com/events/1100000000000000000/1305000000000000001');
  assert.equal(voice.status, 'active');
  assert.equal(voice.join, null);
  assert.equal(league.join?.title, 'TMStadium@nadeo');
  assert.ok(!JSON.stringify(events).includes('creator'), 'creator ids must not be copied');
  valid('events', { ...meta, events });
});

test('discord: no token means no events (nothing made up)', async () => {
  const ctx = offlineContext((c) => (c.discord.guilds = [{ id: '1', name: 'x' }]));
  const out = await buildEvents(ctx, new Date());
  assert.equal(out.events.length, 0);
  assert.ok(!out.sources[0].sample);
});

test('events: trackmania.io competitions (dates from the detail call)', () => {
  const list = parseTmioCompetitionList(fixture('tmio-competitions.json'));
  assert.equal(list.length, 3);
  const comp = fixture('tmio-comp.json');
  const upcoming = tmioCompetitionEvent(comp, new Date('2026-11-06T00:00:00Z'));
  assert.equal(upcoming?.status, 'scheduled');
  assert.equal(upcoming?.games[0], 'tm2020');
  assert.equal(upcoming?.start, '2026-11-07T14:00:00.000Z');
  assert.equal(tmioCompetitionEvent(comp, new Date('2026-11-09T00:00:00Z')), null, 'finished competitions drop out');
  valid('events', { ...meta, events: [upcoming!] });
});

test('events: TMTAS exchange events are TAS events', () => {
  const ev = parseTmtasEvents(fixture('tmtas-events-data.json'), new Date('2026-11-05T00:00:00Z'));
  assert.ok(ev.length >= 1 && ev.every((e) => e.tas && e.source === 'tmtas' && !e.sample));
  assert.ok(ev.some((e) => e.name === 'TASmania 39'));
  assert.ok(!JSON.stringify(ev).includes('skycrafter'), 'creator names are not copied');
  valid('events', { ...meta, events: ev });
});

// ------------------------------------------------------------- Servers

test('servers: ManiaPlanet list', () => {
  const s = parseManiaPlanetServers(fixture('maniaplanet-servers.json'));
  assert.equal(s.length, 5);
  assert.equal(s[0].login, 'fsstad1');
  assert.equal(s[0].game, 'tm2-stadium');
  assert.equal(s[0].name, 'RcSSM°Full.Speed.Beginner.New+46');
  assert.equal(s[0].join, 'maniaplanet://#join=fsstad1@TMStadium@nadeo');
  assert.ok(s.every((x) => x.players >= 0 && !x.sample));
});

test('servers: trackmania.io rooms', () => {
  const rooms = parseTmioRooms(fixture('tmio-rooms.json'));
  assert.equal(rooms.length, 5);
  assert.equal(rooms[0].club?.name, '[KACKY]');
  assert.equal(rooms[1].mode, 'TM_TimeAttack_Online');
  assert.ok(rooms.every((r) => r.game === 'tm2020'));
  valid('servers', { ...meta, servers: [...parseManiaPlanetServers(fixture('maniaplanet-servers.json')), ...rooms], notAvailable: [], masterServers: [] });
});

// ------------------------------------------------------------- Catalog

test('catalog: normalised passthrough', () => {
  const raw = fixture<{ updated: string; entries: Record<string, unknown>[] }>('catalog.json');
  const broken = { ...raw, entries: [...raw.entries, { id: 'x', name: 'X', category: 'nonsense', url: 'https://x' }, { ...raw.entries[0] }] };
  const c = normaliseCatalog(broken);
  assert.equal(c.dropped, 2);
  assert.equal(c.entries.length, raw.entries.length);
  const twinkie = c.entries.find((e) => e.id === 'twinkie-forever')!;
  assert.equal(twinkie.github, 'TwinkieTweaks/TwinkieForever');
  assert.ok(c.entries.every((e) => ['alive', 'dead', 'unclear'].includes(e.status)));
  valid('catalog', { ...meta, catalogUpdated: c.updated, entries: c.entries });
  assert.throws(() => normaliseCatalog({}), /entries/);
});

test('catalog: Discord-only mods keep their fields without a url', () => {
  const raw = {
    updated: '2026-11-10',
    entries: [
      { id: 'mod-a', name: 'A', category: 'mod', games: ['tmuf', 'tm1'], url: null, hosting: 'discord-attachment', modType: 'interface', requires: [], urls: [], author: 'x', note: 'Only in the post.' },
      { id: 'mod-b', name: 'B', category: 'mod', games: ['tmnf'], url: null, hosting: 'github' },
    ],
  };
  const c = normaliseCatalog(raw);
  assert.equal(c.dropped, 1);
  const a = c.entries[0];
  assert.equal(a.url, null);
  assert.deepEqual(a.games, ['tmuf', 'tm1']);
  assert.equal(a.hosting, 'discord-attachment');
  assert.equal(a.modType, 'interface');
  valid('catalog', { ...meta, catalogUpdated: c.updated, entries: c.entries });
});
