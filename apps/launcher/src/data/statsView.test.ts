import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyChoices, firstDesc, shownBest, tableRows, tmxPage, tmxThumbDirect, tmxThumbProxy, type MapRowLike } from './statsView.ts';

const row = (p: Partial<MapRowLike>): MapRowLike => ({ family: 'forever', uid: 'u', name: 'Map', env: 'Stadium', runs: 1, bestMs: 50000, bestRespawns: 0, lastAt: 1, finishes: null, starts: null, hostBestMs: null, cleanRuns: 1, cleanBestMs: 50000, ...p });

test('TMX thumbnails go through the proxy, only for the five exchange sites', () => {
  assert.equal(tmxThumbProxy('tmnf.exchange', 123), 'https://hub.tm-horizon.com/ext-img/tmx/tmnf/123/thumbnail');
  assert.equal(tmxThumbProxy('sunrise.tm-exchange.com', 9), 'https://hub.tm-horizon.com/ext-img/tmx/sunrise/9/thumbnail');
  assert.equal(tmxThumbProxy('nations.tm-exchange.com', 1), 'https://hub.tm-horizon.com/ext-img/tmx/nations/1/thumbnail');
  assert.equal(tmxThumbProxy('trackmania.exchange', 1), null);
  assert.equal(tmxThumbProxy('tmuf.exchange', 0), null);
  assert.equal(tmxThumbProxy('tmuf.exchange', 1.5), null);
  assert.equal(tmxThumbProxy(null, 5), null);
  assert.equal(tmxThumbDirect('original.tm-exchange.com', 7), 'https://original.tm-exchange.com/trackshow/7/thumbnail');
  assert.equal(tmxThumbDirect('evil.example', 7), null);
  // ManiaPlanet maps (B02 of TM2 Stadium is MX 42084) and Trackmania (2020): straight from the exchange.
  assert.equal(tmxThumbProxy('tm.mania.exchange', 42084), null);
  assert.equal(tmxThumbDirect('tm.mania.exchange', 42084), 'https://tm.mania.exchange/mapthumb/42084');
  assert.equal(tmxThumbDirect('trackmania.exchange', 5), 'https://trackmania.exchange/mapthumb/5');
  assert.equal(tmxPage('tm.mania.exchange', 42084), 'https://tm.mania.exchange/mapshow/42084');
  assert.equal(tmxPage('tmnf.exchange', 2285), 'https://tmnf.exchange/trackshow/2285');
  assert.equal(tmxPage('evil.example', 1), null);
});

test('no respawns only: rows with a clean run, their clean best', () => {
  const maps = [
    row({ uid: 'a', name: 'A', bestMs: 40000, bestRespawns: 2, cleanRuns: 1, cleanBestMs: 45000 }),
    row({ uid: 'b', name: 'B', bestMs: 30000, bestRespawns: 1, cleanRuns: 0, cleanBestMs: null }),
    row({ uid: 'c', name: 'C', bestMs: 35000, bestRespawns: 0, cleanRuns: 3, cleanBestMs: 35000 }),
  ];
  const v = { fam: '', q: '', clean: true, sort: { key: 'bestMs' as const, desc: false } };
  assert.deepEqual(tableRows(maps, v).map((m) => m.uid), ['c', 'a']);
  assert.equal(shownBest(maps[0], true), 45000);
  assert.equal(shownBest(maps[0], false), 40000);
});

test('sort by respawns, unknown counts last both ways', () => {
  const maps = [row({ uid: 'x', bestRespawns: 3 }), row({ uid: 'n', bestRespawns: null }), row({ uid: 'z', bestRespawns: 0 })];
  const up = tableRows(maps, { fam: '', q: '', clean: false, sort: { key: 'bestRespawns', desc: false } });
  assert.deepEqual(up.map((m) => m.uid), ['z', 'x', 'n']);
  const down = tableRows(maps, { fam: '', q: '', clean: false, sort: { key: 'bestRespawns', desc: true } });
  assert.deepEqual(down.map((m) => m.uid), ['x', 'z', 'n']);
  assert.equal(firstDesc('bestRespawns'), false);
  assert.equal(firstDesc('runs'), true);
});

test('search and game filter', () => {
  const maps = [row({ uid: 'a', name: '$f00Red', family: 'forever' }), row({ uid: 'b', name: 'Blue', family: 'tmn-eswc', env: 'Stadium' })];
  const strip = (s: string) => s.replace(/\$[0-9a-f]{3}/gi, '');
  assert.deepEqual(tableRows(maps, { fam: '', q: 'red', clean: false, sort: { key: 'name', desc: false } }, strip).map((m) => m.uid), ['a']);
  assert.deepEqual(tableRows(maps, { fam: 'tmn-eswc', q: '', clean: false, sort: { key: 'name', desc: false } }, strip).map((m) => m.uid), ['b']);
});

test('copy filter shows only when a game has two copies', () => {
  const c = (id: string, family: string) => ({ id, family, label: id, path: id });
  const copies = [c('docs', 'forever'), c('e1', 'tmn-eswc'), c('e2', 'tmn-eswc'), c('s1', 'tm-sunrise')];
  assert.equal(copyChoices(copies, '').length, 4);
  assert.deepEqual(copyChoices(copies, 'tmn-eswc').map((x) => x.id), ['e1', 'e2']);
  assert.deepEqual(copyChoices(copies, 'forever'), []);
  assert.deepEqual(copyChoices([c('a', 'forever'), c('b', 'tm-sunrise')], ''), []);
});
