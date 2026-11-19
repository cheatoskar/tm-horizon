import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanHidden, navShows, OPTIONAL_PAGES, parseHidden, presetHidden, presetOf, toggleHidden } from './navPages.ts';

test('presets: Play hides every optional page, Modding keeps maps, skins, profiles and media, Everything hides none', () => {
  assert.deepEqual(presetHidden('play'), [...OPTIONAL_PAGES]);
  assert.deepEqual(presetHidden('modding'), ['news', 'stats', 'servers', 'community']);
  assert.deepEqual(presetHidden('all'), []);
  assert.deepEqual(presetHidden('nope'), []);
  assert.equal(presetOf([]), 'all');
  assert.equal(presetOf(['community', 'servers', 'stats', 'news']), 'modding');
  assert.equal(presetOf(presetHidden('play')), 'play');
  assert.equal(presetOf(['news']), null);
});

test('home, library and mods can never be hidden', () => {
  assert.deepEqual(cleanHidden(['home', 'library', 'mods', 'servers', 'servers', 'x']), ['servers']);
  assert.deepEqual(toggleHidden([], 'home'), []);
  assert.deepEqual(toggleHidden(['news'], 'mods'), ['news']);
  assert.ok(navShows('home', ['home'], 'news'));
  assert.ok(navShows('settings', ['settings'], 'home'));
});

test('toggling keeps sidebar order', () => {
  assert.deepEqual(toggleHidden(['servers'], 'news'), ['news', 'servers']);
  assert.deepEqual(toggleHidden(['news', 'servers'], 'news'), ['servers']);
});

test('a hidden page stays in the sidebar while it is open', () => {
  assert.equal(navShows('stats', ['stats'], 'home'), false);
  assert.equal(navShows('stats', ['stats'], 'stats'), true);
  assert.equal(navShows('news', ['stats'], 'home'), true);
});

test('stored lists: broken or foreign values show every page', () => {
  assert.deepEqual(parseHidden(''), []);
  assert.deepEqual(parseHidden('{ no'), []);
  assert.deepEqual(parseHidden('{"a":1}'), []);
  assert.deepEqual(parseHidden('["media", 3, "home"]'), ['media']);
});
