import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidLogin, splitLogins } from './logins.ts';

test('classic logins', () => {
  assert.ok(isValidLogin('nadeo'));
  assert.ok(isValidLogin('Some_User-1.x'));
  assert.ok(isValidLogin('a'));
  assert.ok(isValidLogin('a'.repeat(64)));
});
test('too long or empty', () => {
  assert.ok(!isValidLogin(''));
  assert.ok(!isValidLogin('a'.repeat(65)));
});
test('bad characters', () => {
  assert.ok(!isValidLogin('has space'));
  assert.ok(!isValidLogin('ümlaut'));
  assert.ok(!isValidLogin('a,b'));
  assert.ok(!isValidLogin('a$b'));
});
test('tm2020 uuid and 22 char login', () => {
  assert.ok(isValidLogin('01234567-89ab-cdef-0123-456789abcdef'));
  assert.ok(isValidLogin('AbCdEfGhIjKlMnOpQrSt_-'));
});
test('splitLogins', () => {
  assert.deepEqual(splitLogins('a, b;c\nd  e'), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(splitLogins('  '), []);
});
