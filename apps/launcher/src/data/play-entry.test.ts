// Every Play entry point goes through the same action: the UI's hub.play (state.tsx), which calls
// backend.launch, which is the one native command launch_game. A Play button with its own launch path
// was how the game page's upper Play button ended up doing nothing (owner test 1111g).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const src = join(import.meta.dirname, '..');
const files = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) && !f.endsWith('.test.ts') ? [p] : []; });
const all = files(src).map((p) => ({ p: p.slice(src.length + 1).replace(/\\/g, '/'), s: readFileSync(p, 'utf8') }));

test('only hub.play (and the map opener) call backend.launch', () => {
  const callers = all.filter((f) => /backend\.launch\(/.test(f.s)).map((f) => f.p).sort();
  assert.deepEqual(callers, ['pages/Maps.tsx', 'state.tsx']);
});

test('backend.launch is the single native command launch_game', () => {
  const native = all.find((f) => f.p === 'data/native.ts')!.s;
  assert.equal((native.match(/invoke\('launch_game'/g) ?? []).length, 1);
  assert.equal(all.filter((f) => f.p !== 'data/native.ts' && f.s.includes("'launch_game'")).length, 0);
});

test('the Play buttons call hub.play', () => {
  const common = all.find((f) => f.p === 'ui/common.tsx')!.s;
  const playButton = common.slice(common.indexOf('export function PlayButton'), common.indexOf('export function Toasts'));
  assert.match(playButton, /hub\.play\(game\.id\)/);
  for (const f of all.filter((x) => /<PlayButton /.test(x.s))) assert.ok(!/onClick=\{[^}]*launch/.test(f.s), f.p);
  // Rows and cards with their own Play button (library card, installations, join dialogs) use hub.play too.
  for (const p of ['pages/Library.tsx', 'ui/GameMods.tsx', 'ui/JoinGuide.tsx', 'ui/HorizonHost.tsx']) assert.match(all.find((f) => f.p === p)!.s, /hub\.play\(/, p);
});

test('the Horizon Client start (normal and safe mode) runs inside hub.play', () => {
  for (const f of all) {
    for (const m of f.s.matchAll(/\bh\.play\(/g)) {
      const before = f.s.slice(Math.max(0, m.index! - 60), m.index);
      assert.match(before, /hub\.play\([^)]*\(\) => $/, f.p + ': h.play outside hub.play');
    }
  }
});
