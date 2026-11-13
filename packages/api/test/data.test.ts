// Every registry file in data/ must validate (runs on pull requests and in the hourly build).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { root } from './helpers.ts';
import { checkEventEntry, checkServerEntry, loadEntries } from '../src/lib/registry.ts';

test('data/servers: every entry is valid', () => {
  const { errors } = loadEntries(path.join(root, 'data', 'servers'), checkServerEntry);
  assert.deepEqual(errors, []);
});

test('data/events: every entry is valid', () => {
  const { errors } = loadEntries(path.join(root, 'data', 'events'), checkEventEntry);
  assert.deepEqual(errors, []);
});
