import { test } from 'node:test';
import assert from 'node:assert/strict';
import { afterCheck, checkDue, CHECK_EVERY_MS, newer, showWhatsNew } from './updateRules.ts';

test('checks again after six hours, not before', () => {
  assert.equal(checkDue(null, 0), true);
  assert.equal(checkDue(1000, 1000 + CHECK_EVERY_MS - 1), false);
  assert.equal(checkDue(1000, 1000 + CHECK_EVERY_MS), true);
});

test('versions', () => {
  assert.equal(newer('0.5.1', '0.5.0'), true);
  assert.equal(newer('0.5.10', '0.5.9'), true);
  assert.equal(newer('0.5.1', '0.5.1-beta.3'), true);
  assert.equal(newer('0.5.1-beta.10', '0.5.1-beta.9'), true);
  assert.equal(newer('0.5.0', '0.5.0'), false);
  assert.equal(newer('0.4.9', '0.5.0'), false);
  assert.equal(newer('x', '0.5.0'), false);
});

test('what a check result leads to', () => {
  const r = { enabled: true, available: true, version: '0.5.2', auto: true, staged: null };
  assert.equal(afterCheck(r, false), 'stage');
  assert.equal(afterCheck({ ...r, staged: '0.5.2' }, true), 'apply', 'downloaded last session: install at start');
  assert.equal(afterCheck({ ...r, staged: '0.5.2' }, false), 'none', 'downloaded: waits for close or Restart now');
  assert.equal(afterCheck({ ...r, staged: '0.5.1' }, false), 'stage', 'a newer one than the downloaded one');
  assert.equal(afterCheck({ ...r, auto: false }, true), 'show');
  assert.equal(afterCheck({ ...r, available: false }, true), 'none');
  assert.equal(afterCheck({ ...r, enabled: false }, true), 'none');
});

test("what's new only after an update", () => {
  assert.equal(showWhatsNew(null, '0.5.1'), false, 'fresh install');
  assert.equal(showWhatsNew('0.5.0', '0.5.1'), true);
  assert.equal(showWhatsNew('0.5.1', '0.5.1'), false);
  assert.equal(showWhatsNew('0.5.2', '0.5.1'), false, 'downgrade');
});
