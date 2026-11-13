// The dinput8.dll exception: only the author's own projects, by project id and release repository, never by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dinput8Allowed } from '../src/checks/dinput8.ts';

const mine = { id: 'p_7cyfbx7p963ysz', claimed: 1 };

test('allowed: the author\'s project with its own repository, claimed', () => {
  assert.equal(dinput8Allowed(mine, 'github:cheatoskar/eswc-autosave@v1.1.0'), true);
  assert.equal(dinput8Allowed(mine, 'github:cheatoskar/legacy-essentials@v1.3.0'), true, 'renamed repository');
  assert.equal(dinput8Allowed({ id: 'p_other', claimed: 1 }, 'github:cheatoskar/legacy-essentials@v1.3.0'), false, 'renamed repository, wrong project id');
  assert.equal(dinput8Allowed({ id: 'p_any', claimed: 1 }, 'github:cheatoskar/legacy-randomizer@v0.1.0'), true, 'no project id pinned yet: repository and claim');
});
test('not allowed: other repository, other project id, unclaimed, not from GitHub, name tricks', () => {
  assert.equal(dinput8Allowed(mine, 'github:someone/eswc-autosave@v1'), false);
  assert.equal(dinput8Allowed({ id: 'p_other', claimed: 1 }, 'github:cheatoskar/eswc-autosave@v1'), false, 'wrong project id');
  assert.equal(dinput8Allowed({ ...mine, claimed: 0 }, 'github:cheatoskar/eswc-autosave@v1'), false);
  assert.equal(dinput8Allowed(mine, 'upload'), false);
  assert.equal(dinput8Allowed(mine, 'tmloader:https://x/#p@1'), false);
  assert.equal(dinput8Allowed(mine, 'github:cheatoskar/eswc-autosave-evil@v1'), false);
});
