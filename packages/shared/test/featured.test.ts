import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorKey, pickFeatured, recencyScore } from '../src/featured.ts';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

test('featured: recency is 1 within 30 days, 0 after a year or without a date', () => {
  assert.equal(recencyScore(day(5), NOW), 1);
  assert.equal(recencyScore(day(400), NOW), 0);
  assert.equal(recencyScore(null, NOW), 0);
  assert.ok(recencyScore(day(200), NOW) > 0 && recencyScore(day(200), NOW) < 1);
});

test('featured: at most one mod per author (clan tags ignored), best score first', () => {
  const list = [
    { id: 'a', name: 'A', author: 'cheatoskar [TMX]', updated: day(2), downloads: 5000 },
    { id: 'b', name: 'B', author: 'cheatoskar', updated: day(1), downloads: 9000 },
    { id: 'c', name: 'C', author: 'donadigo', updated: day(300), downloads: 90000 },
    { id: 'd', name: 'D', author: 'Kim', updated: day(10), downloads: 100 },
    { id: 'e', name: 'E', author: 'Kim', updated: day(500), downloads: 10 },
  ];
  const got = pickFeatured(list, 3, NOW).map((x) => x.id);
  assert.equal(got.length, 3);
  assert.equal(new Set(got.map((id) => authorKey(list.find((x) => x.id === id)!.author))).size, 3);
  assert.equal(got[0], 'b');
  assert.ok(!got.includes('a') && !got.includes('e'));
});

test('featured: fewer authors than slots gives fewer picks', () => {
  assert.equal(pickFeatured([{ id: 'x', name: 'X', author: 'one' }, { id: 'y', name: 'Y', author: 'One' }], 3, NOW).length, 1);
});
