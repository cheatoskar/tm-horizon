// When dist/ exists (after npm run build), every file must match its schema.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { root, validator } from './helpers.ts';

const dist = path.join(root, 'dist');
const names = ['hub', 'mods', 'projects', 'maps', 'events', 'servers', 'catalog', 'communities'];

for (const name of names) {
  const file = path.join(dist, `${name}.json`);
  test(`dist/${name}.json matches schema/${name}.json`, { skip: !fs.existsSync(file) && 'no dist/ yet (npm run build)' }, () => {
    const v = validator(name);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(v(data), JSON.stringify(v.errors?.slice(0, 5), null, 1));
  });
}

test('hub.json counts match the files', { skip: !fs.existsSync(path.join(dist, 'hub.json')) && 'no dist/ yet' }, () => {
  const hub = JSON.parse(fs.readFileSync(path.join(dist, 'hub.json'), 'utf8'));
  const len = (n: string, key: string) => JSON.parse(fs.readFileSync(path.join(dist, `${n}.json`), 'utf8'))[key].length;
  assert.equal(hub.counts.mods, len('mods', 'mods'));
  assert.equal(hub.counts.maps, len('maps', 'maps'));
  assert.equal(hub.counts.servers, len('servers', 'servers'));
  assert.equal(hub.counts.catalog, len('catalog', 'entries'));
});
