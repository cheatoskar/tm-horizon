// Discord directory: xlsx reading, sheet layout, invite lookups (stubbed, no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, offlineContext, root, validator } from './helpers.ts';
import type { HubConfig } from '../src/config.ts';
import { readZip } from '../src/lib/zip.ts';
import { parseRef, parseXlsx } from '../src/lib/xlsx.ts';
import {
  applyOwn, buildCommunities, COMMUNITIES_CREDIT, COMMUNITIES_SUGGEST, iconUrl, inviteCode, parseCheckedDate, parseDirectory, parseInviteResponse,
} from '../src/sources/communities.ts';

const xlsx = fs.readFileSync(path.join(root, 'test', 'fixtures', 'directory.xlsx'));
const raw = (name: string) => fs.readFileSync(path.join(root, 'test', 'fixtures', name), 'utf8');

test('zip: reads the entries of the workbook', () => {
  const files = readZip(xlsx);
  assert.ok(files.has('xl/workbook.xml'));
  assert.ok(files.has('xl/worksheets/_rels/sheet1.xml.rels'));
  assert.throws(() => readZip(Buffer.from('not a zip file at all, just text')), /not a zip/);
});

test('xlsx: sheets, rich shared strings and hyperlinks', () => {
  assert.deepEqual(parseRef('B10'), { row: 10, col: 2 });
  assert.deepEqual(parseRef('AA3'), { row: 3, col: 27 });
  const sheets = parseXlsx(xlsx);
  assert.deepEqual(sheets.map((s) => s.name), ['Active Servers', 'The Archive']);
  const b4 = sheets[0].cells.find((c) => c.row === 4 && c.col === 2)!;
  assert.equal(b4.text, 'Official\nChecked on 2026-07-08');
  const austria = sheets[0].cells.find((c) => c.text === 'Austria' && c.col === 4)!;
  assert.equal(austria.link, 'https://discord.gg/RpFP3Vs4B3');
});

test('communities: checked dates and invite codes', () => {
  assert.equal(parseCheckedDate('Europe\nChecked on 2026-07-08'), '2026-07-08');
  assert.equal(parseCheckedDate('Retired\n(checked on December 8, 2025)'), '2025-12-08');
  assert.equal(parseCheckedDate('Inactive Servers'), null);
  assert.equal(inviteCode('https://discord.gg/RpFP3Vs4B3'), 'RpFP3Vs4B3');
  assert.equal(inviteCode('https://discord.com/invite/tD4rarRYpj'), 'tD4rarRYpj');
  assert.equal(inviteCode('https://discordapp.com/invite/abc-d_e/'), 'abc-d_e');
  assert.equal(inviteCode('https://mania.exchange/'), null);
  assert.equal(inviteCode('https://discord.com/channels/1/2'), null);
});

test('communities: sheet layout of the fixture', () => {
  const e = parseDirectory(xlsx);
  const by = (name: string, group?: string) => e.find((x) => x.name === name && (!group || x.group === group))!;
  assert.equal(e.length, 11);
  assert.equal(e.filter((x) => x.active).length, 9);
  assert.equal(new Set(e.map((x) => x.id)).size, e.length, 'ids are unique');

  const tm = by('Community & Esports: Trackmania');
  assert.deepEqual([tm.group, tm.section, tm.region, tm.checked, tm.invite, tm.active], ['Official', 'Official', null, '2026-07-08', 'trackmania', true]);
  const hub = by('Plugins: Openplanet');
  assert.deepEqual([hub.group, hub.section, hub.checked, hub.invite], ['Official', 'Community Hubs', '2025-12-04', 'openplanet']);
  assert.equal(by('Track sharing: MX (TM2, TM2020)').invite, null, 'a website is no invite');

  // The group header sits in column D but covers column F too.
  assert.deepEqual([by('Austria', 'Countries & Regions').group, by('Austria', 'Countries & Regions').region], ['Countries & Regions', 'Europe']);
  assert.equal(by('North America').region, 'North America');
  const canada = by('Canada');
  assert.deepEqual([canada.section, canada.region], ['Canada', 'North America']);
  assert.ok(!e.some((x) => x.name === 'Nebraska' || x.name.startsWith('Some Sorts')), 'cells without a link are no entries');
  assert.equal(by('Austria', 'Communities').section, 'Track Styles');
  assert.notEqual(by('Austria', 'Communities').id, by('Austria', 'Countries & Regions').id);

  const archived = e.filter((x) => !x.active);
  assert.deepEqual(archived.map((x) => [x.name, x.group, x.checked]), [['LL CUP', 'Retired/Completed/OnHiatus', '2025-12-08'], ['Alekhsi', 'Inactive Servers', null]]);
});

test('communities: invite responses', () => {
  const ok = parseInviteResponse(200, raw('discord-invite.json'), 5)!;
  assert.deepEqual(ok, { t: 5, alive: true, guildName: 'Trackmania', icon: null, members: 36071, online: 11421 });
  assert.equal(iconUrl('158349559959912448', 'a_0123456789abcdef0123456789abcdef'), 'https://cdn.discordapp.com/icons/158349559959912448/a_0123456789abcdef0123456789abcdef.png?size=64');
  assert.equal(iconUrl('158349559959912448', '../evil'), null);
  const gone = parseInviteResponse(404, raw('discord-invite-404.json'), 5)!;
  assert.equal(gone.alive, false);
  assert.equal(gone.members, null);
  assert.equal(parseInviteResponse(500, '', 5), null);
  assert.equal(parseInviteResponse(200, 'not json', 5), null);
});

function networkContext(patch: (c: HubConfig) => void = () => {}) {
  const ctx = offlineContext((c) => {
    c.communities.delayMs = 0;
    patch(c);
  });
  ctx.http.offline = false;
  const asked: string[] = [];
  let limited = false;
  ctx.http.getBytes = async () => ({ bytes: xlsx, result: { status: 200, body: '', headers: {}, cache: null } });
  ctx.http.getStatus = async (url: string) => {
    const code = /invites\/([^?]+)\?with_counts=true$/.exec(url)![1];
    asked.push(code);
    if (code === 'openplanet' && !limited) {
      limited = true;
      return { status: 429, body: '{"retry_after":0.001}', retryAfterSec: 0.001 };
    }
    return code === 'trackmania'
      ? { status: 200, body: raw('discord-invite.json'), retryAfterSec: null }
      : { status: 404, body: raw('discord-invite-404.json'), retryAfterSec: null };
  };
  return { ctx, asked };
}

test('communities: build looks every invite up once, handles 429 and caches the answers', async () => {
  const { ctx, asked } = networkContext();
  const now = new Date('2026-11-10T16:00:00.000Z');
  const out = await buildCommunities(ctx, now);
  out.communities = out.communities.filter((c) => c.source === 'directory'); // data/communities-own.json is covered by its own test
  assert.equal(out.communities.length, 11);
  assert.equal(new Set(asked).size, 10, 'one lookup per distinct invite');
  assert.equal(asked.filter((c) => c === 'openplanet').length, 2, 'the rate limited lookup was repeated');
  const tm = out.communities.find((c) => c.invite === 'trackmania')!;
  assert.deepEqual([tm.alive, tm.members, tm.online, tm.guildName], [true, 36071, 11421, 'Trackmania']);
  const dead = out.communities.find((c) => c.invite === 'deadinvite1')!;
  assert.deepEqual([dead.alive, dead.members, dead.guildName], [false, null, null]);
  const site = out.communities.find((c) => c.invite === null)!;
  assert.deepEqual([site.alive, site.members], [null, null]);

  const file: unknown = {
    schemaVersion: 1, generated: now.toISOString(), sources: out.sources,
    credit: { ...COMMUNITIES_CREDIT, url: ctx.config.communities.sheetUrl }, suggest: COMMUNITIES_SUGGEST, communities: out.communities,
  };
  const v = validator('communities');
  assert.ok(v(file), JSON.stringify(v.errors, null, 1));

  // Second build within the TTL: no lookup at all.
  asked.length = 0;
  const again = await buildCommunities(ctx, new Date(now.getTime() + 3_600_000));
  assert.equal(asked.length, 0);
  assert.equal(again.communities.find((c) => c.invite === 'trackmania')!.members, 36071);
  // Offline: the cache answers even when it is old.
  ctx.http.offline = true;
  const old = await buildCommunities(ctx, new Date(now.getTime() + 10 * 86_400_000));
  assert.equal(asked.length, 0);
  assert.equal(old.communities.find((c) => c.invite === 'trackmania')!.alive, true);
});

test('communities: lookups per build are capped', async () => {
  const { ctx } = networkContext((c) => {
    c.communities.maxLookupsPerBuild = 3;
  });
  const out = await buildCommunities(ctx, new Date('2026-11-10T16:00:00.000Z'));
  out.communities = out.communities.filter((c) => c.source === 'directory');
  assert.equal(out.communities.filter((c) => c.invite && c.alive === null).length, 7);
  assert.match(out.sources.find((s) => s.id === 'discord-invites')!.error ?? '', /7 waiting/);
});

test('communities: a failing sheet is a warning and an empty list', async () => {
  const ctx = offlineContext();
  const out = await buildCommunities(ctx, new Date());
  assert.equal(out.communities.length, 0);
  assert.equal(out.sources[0].ok, false);
  assert.equal(ctx.warnings.length, 1);
  assert.deepEqual(fixture('discord-invite-404.json'), { message: 'Unknown Invite', code: 10006 });
});

test('communities: own entries win over directory entries with the same invite code', () => {
  const base = (id: string, invite: string | null, extra = {}) => ({
    id, name: id, url: `https://discord.gg/${invite}`, invite, group: 'Communities', section: 'Communities', region: null, active: true,
    alive: true, members: 323, online: 10, guildName: 'G', icon: 'https://cdn.example/x.png', checked: '2025-12-04', source: 'directory' as const, ...extra,
  });
  const list = [base('dir:a', 'AAA'), base('dir:a-2', 'AAA'), base('dir:b', 'BBB')];
  const out = applyOwn(list, [
    { invite: 'AAA', name: 'Mine', games: ['tmnf', 'tmuf'], featured: true, icon: '/community/a.png' },
    { invite: 'CCC', name: 'New', games: ['tmnf'] },
  ]);
  const mine = out.filter((c) => c.invite === 'AAA');
  assert.equal(mine.length, 1);
  assert.deepEqual([mine[0].name, mine[0].icon, mine[0].featured, mine[0].games, mine[0].source, mine[0].members], ['Mine', '/community/a.png', true, ['tmnf', 'tmuf'], 'own', 323]);
  assert.equal(out.find((c) => c.invite === 'BBB')!.source, 'directory');
  assert.equal(out.find((c) => c.invite === 'CCC')!.url, 'https://discord.gg/CCC');
  assert.equal(out.length, 3);
});
