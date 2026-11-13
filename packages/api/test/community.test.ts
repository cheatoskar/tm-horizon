// Community registry: validation, join links, issue forms, time zones, reachability with a fake probe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, offlineContext, root, validator } from './helpers.ts';
import {
  checkEventEntry, checkServerEntry, isPrivateIp, loadEntries, parseAddress, serverJoinLink, zonedTimeToIso,
} from '../src/lib/registry.ts';
import { eventFromForm, parseDuration, parseIssueForm, serverFromForm } from '../src/lib/issue-form.ts';
import { buildCommunityServers, buildSubmittedEvents, submittedEvent, tcpProbe } from '../src/sources/community.ts';
import type { Probe } from '../src/sources/community.ts';
import { buildServers } from '../src/sources/servers.ts';

const meta = { schemaVersion: 1 as const, generated: '2026-11-10T16:00:00.000Z', sources: [] };
const valid = (name: string, data: unknown) => {
  const v = validator(name);
  assert.ok(v(data), JSON.stringify(v.errors, null, 1));
};
const regDir = path.join(root, 'test', 'fixtures', 'registry');
const template = (kind: string) => fs.readFileSync(path.join(root, '..', '..', '.github', 'ISSUE_TEMPLATE', `${kind}.yml`), 'utf8');

test('registry: addresses and private ranges', () => {
  assert.deepEqual(parseAddress('203.0.113.7:2350'), { host: '203.0.113.7', port: 2350 });
  assert.deepEqual(parseAddress('tm.Example.org'), { host: 'tm.example.org', port: 2350 });
  assert.deepEqual(parseAddress('[2001:db8::1]:2351'), { host: '2001:db8::1', port: 2351 });
  assert.equal(parseAddress('1.2.3.4:70000'), null);
  assert.equal(parseAddress('http://x.org:2350'), null);
  assert.equal(parseAddress('localhost:2350'), null);
  for (const ip of ['10.1.2.3', '127.0.0.1', '192.168.0.5', '172.20.0.1', '100.64.1.1', '169.254.1.1', '0.0.0.0', '::1', 'fd00::1', '::ffff:10.0.0.1']) {
    assert.ok(isPrivateIp(ip), ip);
  }
  assert.ok(!isPrivateIp('203.0.113.7') && !isPrivateIp('8.8.8.8') && !isPrivateIp('2001:db8::1'));
});

test('registry: server entries and join links', () => {
  const ok = checkServerEntry({ id: 'my-server', game: 'tmnf', name: 'My server', login: 'mylogin', address: '203.0.113.7' });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.entry?.address, '203.0.113.7:2350');
  assert.equal(serverJoinLink(ok.entry!), 'tmtp://#join=mylogin');
  assert.equal(serverJoinLink({ id: 'x-y-z', game: 'tmuf', name: 'x', address: '203.0.113.7:2351' }), 'tmtp://#join=203.0.113.7:2351');
  assert.equal(serverJoinLink({ id: 'x-y-z', game: 'tm2-canyon', name: 'x', login: 'c1' }), 'maniaplanet://#join=c1@TMCanyon@nadeo');
  assert.equal(serverJoinLink({ id: 'x-y-z', game: 'eswc', name: 'x', address: '203.0.113.7:2352' }), null);

  const bad = checkServerEntry({ id: 'A', game: 'tm2020', name: '', address: '10.0.0.1:2350', contact: 'javascript:alert(1)' });
  assert.equal(bad.entry, null);
  assert.ok(bad.errors.some((e) => e.startsWith('id ')));
  assert.ok(bad.errors.some((e) => e.startsWith('game ')));
  assert.ok(bad.errors.some((e) => e.includes('private')));
  assert.ok(bad.errors.some((e) => e.startsWith('contact')));
  const eswcLogin = checkServerEntry({ id: 'eswc-x', game: 'eswc', name: 'x', login: 'abc' });
  assert.ok(eswcLogin.errors.some((e) => e.includes('join by address')));
  const ctrl = checkServerEntry({ id: 'ctrl-x', game: 'tmnf', name: 'a\u0000b\u0007c', login: 'abc' });
  assert.equal(ctrl.entry?.name, 'abc');
});

test('registry: time zones', () => {
  assert.equal(zonedTimeToIso('2026-11-21', '19:00', 'Europe/Berlin'), '2026-11-21T19:00:00+01:00');
  assert.equal(zonedTimeToIso('2026-07-01', '19:00', 'Europe/Berlin'), '2026-07-01T19:00:00+02:00');
  assert.equal(zonedTimeToIso('2026-11-21', '9:30', 'America/New_York'), '2026-11-21T09:30:00-05:00');
  assert.equal(zonedTimeToIso('2026-11-21', '19:00', 'UTC'), '2026-11-21T19:00:00+00:00');
  assert.equal(zonedTimeToIso('2026-11-21', '19:00', 'UTC+5:30'), '2026-11-21T19:00:00+05:30');
  assert.equal(zonedTimeToIso('2026-11-21', '19:00', '-03:00'), '2026-11-21T19:00:00-03:00');
  assert.equal(zonedTimeToIso('2026-02-30', '19:00', 'UTC'), null);
  assert.equal(zonedTimeToIso('2026-11-21', '25:00', 'UTC'), null);
  assert.equal(zonedTimeToIso('2026-11-21', '19:00', 'Mars/Olympus'), null);
  assert.equal(Date.parse(zonedTimeToIso('2026-03-29', '12:00', 'Europe/Berlin')!), Date.parse('2026-03-29T10:00:00Z'));
});

test('issue forms: server', () => {
  const payload = fixture<{ issue: { number: number; body: string } }>('issue-server.json');
  const fields = parseIssueForm(payload.issue.body, template('server'));
  assert.equal(fields.game, 'TrackMania Nations ESWC (eswc)');
  assert.equal(fields.login, undefined);
  assert.equal(fields.confirm, undefined);
  const { entry, errors } = serverFromForm(fields, payload.issue.number, new Set(['100-tmx-eswc-eswc']), '2026-11-10');
  assert.deepEqual(errors, []);
  assert.equal(entry?.id, '100-tmx-eswc-eswc-42');
  assert.equal(entry?.game, 'eswc');
  assert.equal(entry?.language, 'en');
  assert.equal(entry?.description, 'Random unfinished TMX maps.\nEvery finish helps.');
  assert.equal(entry?.added, '2026-11-10');
  assert.equal(entry?.issue, 42);
});

test('issue forms: event', () => {
  const payload = fixture<{ issue: { number: number; body: string } }>('issue-event.json');
  const fields = parseIssueForm(payload.issue.body, template('event'));
  const { entry, errors } = eventFromForm(fields, payload.issue.number, new Set());
  assert.deepEqual(errors, []);
  assert.equal(entry?.id, '2026-11-21-forever-night-cup-3');
  assert.deepEqual(entry?.games, ['tmnf', 'tmuf']);
  assert.equal(entry?.start, '2026-11-21T19:00:00+01:00');
  assert.equal(entry?.durationMinutes, 120);
  assert.equal(entry?.join, 'tmtp://#join=nightcup');
  assert.equal(entry?.link, undefined);
  const bad = eventFromForm({ ...fields, timezone: 'Somewhere', duration: 'long' }, 44, new Set());
  assert.equal(bad.entry, null);
  assert.equal(bad.errors.length, 2);
  assert.deepEqual([parseDuration('90'), parseDuration('1h30'), parseDuration('1:45'), parseDuration('2,5 h'), parseDuration('90 min')], [90, 90, 105, 150, 90]);
  assert.ok(Number.isNaN(parseDuration('soon')));
});

test('registry: loading a folder reports bad files', () => {
  const servers = loadEntries(path.join(regDir, 'servers'), checkServerEntry);
  assert.deepEqual(servers.entries.map((e) => e.id), ['example-eswc-lan', 'example-tm2-stadium', 'example-tmnf-rpg']);
  assert.ok(servers.errors.every((e) => e.startsWith('broken-private.yaml: ')));
  assert.ok(servers.errors.some((e) => /private/.test(e)));
  const events = loadEntries(path.join(regDir, 'events'), checkEventEntry);
  assert.equal(events.entries.length, 3);
  assert.deepEqual(events.errors, []);
});

test('community servers: reachability and lastSeen', async () => {
  const ctx = offlineContext((c) => (c.servers.community.dir = 'test/fixtures/registry/servers'));
  ctx.http.offline = false; // the probe below is fake, nothing goes to the network
  let up = true;
  const asked: string[] = [];
  const probe: Probe = async (host, port) => {
    asked.push(`${host}:${port}`);
    return up ? { online: true, ms: 12 } : { online: false, ms: null, error: 'ECONNREFUSED' };
  };
  const first = await buildCommunityServers(ctx, new Date('2026-11-10T10:00:00Z'), probe);
  assert.deepEqual(asked.sort(), ['198.51.100.20:2352', '203.0.113.10:2350']);
  const rpg = first.servers.find((s) => s.id === 'community:example-tmnf-rpg')!;
  assert.equal(rpg.online, true);
  assert.equal(rpg.lastSeen, '2026-11-10T10:00:00.000Z');
  assert.equal(rpg.join, 'tmtp://#join=example_rpg');
  const stadium = first.servers.find((s) => s.id === 'community:example-tm2-stadium')!;
  assert.equal(stadium.online, null);
  assert.equal(stadium.join, 'maniaplanet://#join=example_stadium@TMStadium@nadeo');
  assert.equal(first.sources[0].ok, false); // broken-private.yaml
  assert.ok(ctx.warnings.length > 0 && ctx.warnings.every((w) => w.includes('broken-private.yaml')));
  up = false;
  const second = await buildCommunityServers(ctx, new Date('2026-11-10T11:00:00Z'), probe);
  const eswc = second.servers.find((s) => s.id === 'community:example-eswc-lan')!;
  assert.equal(eswc.online, false);
  assert.equal(eswc.lastSeen, '2026-11-10T10:00:00.000Z');
  assert.equal(eswc.join, null);
  assert.equal(eswc.address, '198.51.100.20:2352');
  valid('servers', { ...meta, servers: second.servers, notAvailable: [], masterServers: [] });
});

test('community servers: the real probe never connects to private addresses', async () => {
  const r = await tcpProbe('127.0.0.1', 2350, 500);
  assert.equal(r.online, false);
  assert.match(r.error ?? '', /private/);
});

test('submitted events: past ones drop out', () => {
  const ctx = offlineContext((c) => (c.events.submittedDir = 'test/fixtures/registry/events'));
  const { events, sources } = buildSubmittedEvents(ctx, new Date('2026-11-12T19:30:00Z'));
  assert.deepEqual(events.map((e) => e.id), ['submitted:2026-11-12-eswc-night', 'submitted:2026-11-21-example-cup']);
  const [night, cup] = events;
  assert.equal(night.status, 'active');
  assert.equal(night.address, '198.51.100.20:2352');
  assert.equal(night.join, null);
  assert.equal(cup.status, 'scheduled');
  assert.equal(cup.start, '2026-11-21T18:00:00.000Z');
  assert.equal(cup.end, '2026-11-21T20:00:00.000Z');
  assert.equal(cup.join?.target, 'example_cup');
  assert.deepEqual(cup.community, { id: 'submitted:example-community', name: 'Example Community', invite: 'https://discord.gg/example' });
  assert.ok(events.every((e) => e.source === 'submitted' && !e.sample));
  assert.equal(sources[0].count, 2);
  valid('events', { ...meta, events });
  const e = checkEventEntry({ id: 'later', title: 'x', games: ['tmnf'], start: '2026-11-21T19:00:00Z', durationMinutes: 60, host: 'h' });
  assert.equal(submittedEvent(e.entry!, new Date('2026-11-21T20:00:00Z')), null);
});

test('servers.json: community entries only, no made-up Forever servers', async () => {
  const ctx = offlineContext((c) => {
    c.servers.maniaplanet.enabled = false;
    c.servers.trackmaniaIo.enabled = false;
    c.servers.eswcMaster.enabled = false;
    c.servers.community.dir = 'test/fixtures/registry/servers';
  });
  ctx.http.offline = false;
  const out = await buildServers(ctx, new Date('2026-11-10T10:00:00Z'), { probe: async () => ({ online: true, ms: 5 }) });
  assert.ok(out.servers.every((s) => s.source === 'community'));
  assert.ok(!out.sources.some((s) => s.id === 'servers:forever'));
  assert.deepEqual(out.masterServers, []);
  valid('servers', { ...meta, servers: out.servers, notAvailable: out.notAvailable, masterServers: out.masterServers });
  const empty = offlineContext((c) => {
    c.servers.maniaplanet.enabled = false;
    c.servers.trackmaniaIo.enabled = false;
    c.servers.eswcMaster.enabled = false;
    c.servers.community.dir = 'test/fixtures/registry/none';
  });
  const none = await buildServers(empty);
  assert.equal(none.servers.length, 0);
  assert.ok(!none.sources.some((s) => s.sample));
});
