// node --test scripts/
import test from 'node:test';
import assert from 'node:assert/strict';
import { assetUrl, buildLatestJson, platformOf } from './updater-json.mjs';

test('platformOf picks the update payloads only', () => {
  assert.equal(platformOf('TM-Horizon_0.3.0_x64-setup.exe'), 'windows-x86_64');
  assert.equal(platformOf('TM-Horizon_0.3.0_amd64.AppImage'), 'linux-x86_64');
  assert.equal(platformOf('TM-Horizon_0.3.0_amd64.deb'), null);
  assert.equal(platformOf('TM-Horizon_0.3.0_x64-setup.exe.sig'), null);
});

test('assetUrl encodes the asset name', () => {
  assert.equal(
    assetUrl('cheatoskar/tm-horizon', 'v0.3.0', 'TM Horizon_0.3.0_x64-setup.exe'),
    'https://github.com/cheatoskar/tm-horizon/releases/download/v0.3.0/TM%20Horizon_0.3.0_x64-setup.exe',
  );
});

test('buildLatestJson: both platforms, trimmed signatures, version without v', () => {
  const json = buildLatestJson({
    tag: 'v0.3.0-beta.1',
    notes: 'Notes',
    pubDate: '2026-01-01T00:00:00.000Z',
    files: {
      'TM-Horizon_0.3.0_x64-setup.exe': '',
      'TM-Horizon_0.3.0_x64-setup.exe.sig': 'SIGWIN\n',
      'TM-Horizon_0.3.0_amd64.AppImage': '',
      'TM-Horizon_0.3.0_amd64.AppImage.sig': 'SIGLIN',
      'TM-Horizon_0.3.0_amd64.deb': '',
    },
  });
  assert.equal(json.version, '0.3.0-beta.1');
  assert.equal(json.pub_date, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(Object.keys(json.platforms), ['linux-x86_64', 'windows-x86_64']);
  assert.equal(json.platforms['windows-x86_64'].signature, 'SIGWIN');
  assert.match(json.platforms['linux-x86_64'].url, /\/releases\/download\/v0\.3\.0-beta\.1\/TM-Horizon_0\.3\.0_amd64\.AppImage$/);
});

test('buildLatestJson: a platform without .sig is left out, none at all throws', () => {
  const one = buildLatestJson({ tag: 'v1.0.0', files: { 'a-setup.exe': '', 'a-setup.exe.sig': 'S', 'b.AppImage': '' } });
  assert.deepEqual(Object.keys(one.platforms), ['windows-x86_64']);
  assert.throws(() => buildLatestJson({ tag: 'v1.0.0', files: { 'a-setup.exe': '' } }), /no signed bundle/);
});
