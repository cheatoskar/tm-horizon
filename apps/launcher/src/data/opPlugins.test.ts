import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchOpPlugin, opGamesOf, opNewer, opTargets } from './opPlugins.ts';

const p = (games: string[], identifier = 'BetterChat', page = 'https://openplanet.dev/plugin/betterchat') => ({ id: 1, identifier, name: identifier, games, version: '1.0', page });

test('games per Openplanet folder, only installed ones', () => {
  assert.deepEqual(opGamesOf(p(['Trackmania', 'Maniaplanet 4', 'Trackmania Turbo', 'x'])), ['tm2020', 'tm2-stadium', 'tm-turbo']);
  assert.deepEqual(opTargets(p(['Trackmania', 'Maniaplanet 4']), []), [], 'nothing installed');
  assert.deepEqual(opTargets(p(['Trackmania', 'Maniaplanet 4']), ['tm2-canyon', 'tmnf']), ['tm2-stadium'], 'any ManiaPlanet title counts');
  assert.deepEqual(opTargets(p(['Trackmania']), ['tm2020', 'tm-turbo']), ['tm2020']);
});

test('versions', () => {
  assert.ok(opNewer('1.10.0', '1.9.5'));
  assert.ok(!opNewer('1.2', '1.2.0'));
  assert.ok(opNewer('1.2.1', '1.2'));
  assert.ok(!opNewer('0.1.2', '0.1.2'));
  assert.ok(opNewer('v2.0', '1.99'));
});

test('hub entries find their openplanet.dev plugin', () => {
  const cat = [p(['Trackmania']), p(['Trackmania'], 'SplitSpeeds', 'https://openplanet.dev/plugin/splitspeeds')];
  assert.equal(matchOpPlugin({ link: 'https://openplanet.dev/plugin/betterchat', repo: null }, cat)?.identifier, 'BetterChat');
  assert.equal(matchOpPlugin({ link: 'https://github.com/someone/split-speeds', repo: 'someone/split-speeds' }, cat)?.identifier, 'SplitSpeeds');
  assert.equal(matchOpPlugin({ link: 'https://github.com/someone/other', repo: 'someone/other' }, cat), null);
});
