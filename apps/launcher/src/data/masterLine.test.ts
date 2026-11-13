import { test } from 'node:test';
import assert from 'node:assert/strict';
import { masterLine } from './masterLine.ts';

test('a master with nothing listed points to the known servers below', () => {
  assert.deepEqual(masterLine(0, 0, 3), { key: 'v052.masterNone', vars: { n: 3 } });
});

test('real counts and an empty list keep the counts line', () => {
  assert.deepEqual(masterLine(12, 4, 3), { key: 'server.masterCounts', vars: { players: 12, servers: 4 } });
  assert.deepEqual(masterLine(0, 0, 0), { key: 'server.masterCounts', vars: { players: 0, servers: 0 } });
  assert.deepEqual(masterLine(0, 2, 5), { key: 'server.masterCounts', vars: { players: 0, servers: 2 } });
});
