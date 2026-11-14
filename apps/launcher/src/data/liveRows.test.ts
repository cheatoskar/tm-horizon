import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveRows } from './liveRows.ts';

const row = (o: Record<string, unknown>) => ({ name: 'S', state: 'online', players: 3, maxPlayers: 32, mode: 'TimeAttack', ...o });

test('Nations/United rows need a live answer and get a join link', () => {
  const r = liveRows([row({ game: 'tmnf', login: 'nutt3n_speed' }), row({ game: 'tmuf', login: 'x', state: 'offline' })])!;
  assert.equal(r.length, 1);
  assert.equal(r[0]!.join, 'tmtp://#join=nutt3n_speed');
  assert.equal(r[0]!.players, 3);
});

test('ESWC rows keep the live data when the hub reached the server', () => {
  const [on, off] = liveRows([
    row({ game: 'eswc', address: '1.2.3.4:2350', players: 5, maxPlayers: 16, mode: 'Rounds' }),
    row({ game: 'eswc', login: 'eswc_only_login', state: 'unknown', players: 9 }),
  ])!;
  assert.deepEqual([on!.online, on!.players, on!.maxPlayers, on!.mode, on!.join], [true, 5, 16, 'Rounds', null]);
  assert.deepEqual([off!.online, off!.players, off!.mode], [null, 0, null]);
});

test('other games and bad input are dropped', () => {
  assert.equal(liveRows({}), null);
  assert.deepEqual(liveRows([row({ game: 'tm2020' }), row({ game: 'tmnf', name: ' ' })]), []);
});
