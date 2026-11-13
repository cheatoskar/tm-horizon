import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, gameFromTitle, parseJoinLink, slug, stripFormatting } from '../src/lib/util.ts';
import { githubRepoFromUrl } from '../src/sources/github.ts';

test('stripFormatting removes colours, styles and links', () => {
  assert.equal(stripFormatting('Rc$ff0$w$oSSM°$fffFull.$f00Speed'), 'RcSSM°Full.Speed');
  assert.equal(stripFormatting('$sTM $2cfF$ffformula $d00L$fffeague'), 'TM Formula League');
  assert.equal(stripFormatting('$l[https://x.org]Link$l text'), 'Link text');
  assert.equal(stripFormatting('Costs $$5'), 'Costs $5');
  assert.equal(stripFormatting('plain'), 'plain');
});

test('compareVersions orders releases, prereleases and suffixes', () => {
  const sorted = ['1.4.3-rc.1', '1.4.2', '1.4.3', '1.4.3-rc.2', '1.4.10', '2.12.0-compat', '2.12.0', '1.0.3-v7', '1.0.3-v10']
    .sort(compareVersions);
  assert.deepEqual(sorted, ['1.0.3-v7', '1.0.3-v10', '1.4.2', '1.4.3-rc.1', '1.4.3-rc.2', '1.4.3', '1.4.10', '2.12.0-compat', '2.12.0']);
  assert.equal(compareVersions('v1.2.0', '1.2.0'), 0);
});

test('parseJoinLink reads Forever and ManiaPlanet links', () => {
  assert.deepEqual(parseJoinLink('tmtp://#join=forevercup'), { raw: 'tmtp://#join=forevercup', scheme: 'tmtp', action: 'join', target: 'forevercup', title: null });
  assert.deepEqual(parseJoinLink('Join: tmtp://#join=cup:secret.'), {
    raw: 'tmtp://#join=cup:secret', scheme: 'tmtp', action: 'join', target: 'cup', title: null, password: 'secret',
  });
  assert.equal(parseJoinLink('tmtp://#join=1.2.3.4:2350')?.target, '1.2.3.4:2350');
  assert.equal(parseJoinLink('tmtp://#spectate=srv')?.action, 'spectate');
  const mp = parseJoinLink('Server: maniaplanet://#join=league_srv@TMStadium@nadeo');
  assert.equal(mp?.target, 'league_srv');
  assert.equal(mp?.title, 'TMStadium@nadeo');
  assert.equal(parseJoinLink('https://example.org'), null);
  assert.equal(parseJoinLink(null), null);
});

test('slug, gameFromTitle, githubRepoFromUrl', () => {
  assert.equal(slug('TM Vibrant Shaders'), 'tm-vibrant-shaders');
  assert.equal(slug('100% TMX + Bingo'), '100-percent-tmx-plus-bingo');
  assert.equal(gameFromTitle('TMCanyon@nadeo'), 'tm2-canyon');
  assert.equal(gameFromTitle('SMStormElite@nadeolabs'), 'sm-storm');
  assert.equal(gameFromTitle('RPG@tmrpg'), null);
  assert.equal(githubRepoFromUrl('https://github.com/BigBang1112/gbx-net'), 'BigBang1112/gbx-net');
  assert.equal(githubRepoFromUrl('https://github.com/Laiteux/TMF.NET/blob/main/README.md'), 'Laiteux/TMF.NET');
  assert.equal(githubRepoFromUrl('https://github.com/a/b.git'), 'a/b');
  assert.equal(githubRepoFromUrl('https://github.com/TwinkieTweaks'), null);
  assert.equal(githubRepoFromUrl('https://gitlab.com/a/b'), null);
});
