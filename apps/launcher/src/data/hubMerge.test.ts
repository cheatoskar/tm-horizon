// The production hub index of 2026-11-12 (seq 19, saved unchanged as fixtures/hub-index-prod-seq19.json) against
// the bundled catalog: what the 0.5.0 Launcher Preview shows when the index is live.
import { test as t } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { catalogFromIndex } from './hubMerge.ts';

const root = join(import.meta.dirname, '..', '..', '..', '..');
const env = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'hub-index-prod-seq19.json'), 'utf8'));
const payloadBytes = Buffer.from(env.payload, 'base64');
const payload = JSON.parse(payloadBytes.toString('utf8'));
const catalog = JSON.parse(readFileSync(join(root, 'packages', 'catalog', 'catalog.json'), 'utf8'));
const policy = JSON.parse(readFileSync(join(root, 'packages', 'catalog', 'release-policy.json'), 'utf8'));

/** Same rules as releasePolicy.ts applyReleasePolicy in a public build. */
function applyPolicy<T extends { id: string; installSpec?: unknown; launcher?: string | null }>(entries: T[]): T[] {
  return entries.filter((e) => !(e.id in policy.hide)).map((e) => (e.id in policy.linkOnly ? { ...e, installSpec: null, launcher: 'open download page' } : e));
}
const bundled = applyPolicy(catalog.entries);
const list = catalogFromIndex(payload, bundled, applyPolicy) ?? [];
const byId = new Map(list.map((e) => [e.id, e]));

t('the saved index is the signed production index', () => {
  const raw = Buffer.from('yZMyZ/lPyU+7rKCuDHFSxCqGmOcgqU/YBOt+jBgmgjI=', 'base64');
  const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
  assert.ok(crypto.verify(null, Buffer.concat([Buffer.from('tmhub-index-v1\n'), payloadBytes]), key, Buffer.from(env.sig, 'base64')));
  assert.equal(payload.seq, 19);
});

t('171 projects in the index, 171 visible, same ids as bundled; removed entries are withdrawn', () => {
  assert.equal(payload.projects.length, 171);
  assert.equal(list.length, 171);
  for (const id of policy.removed) {
    assert.ok(!byId.has(id), id);
    assert.ok(payload.withdrawn.includes(id), id);
  }
  assert.deepEqual([...byId.keys()].sort(), bundled.map((e: { id: string }) => e.id).sort());
});

t('withdrawn and hidden ids stay out', () => {
  assert.ok(payload.withdrawn.length >= 30);
  for (const id of payload.withdrawn) assert.ok(!byId.has(id), id);
  for (const id of Object.keys(policy.hide)) assert.ok(!byId.has(id), id);
});

t('ESWC mods still show for ESWC and keep their install', () => {
  const eswc = list.filter((e) => e.games.includes('eswc'));
  assert.ok(eswc.length >= 40, String(eswc.length));
  const autosave = byId.get('mod-eswc-autosave')!;
  assert.deepEqual(autosave.games, ['eswc']);
  // Installed by its own ESWC card (EswcMods), not through installSpec: the bundled launcher text stays.
  assert.equal(autosave.launcher, 'install from GitHub release');
});

t('link-only stays link-only, installable stays installable', () => {
  for (const id of Object.keys(policy.linkOnly)) if (byId.has(id)) assert.equal(byId.get(id)!.installSpec ?? null, null, id);
  for (const id of ['tmfoxr', 'mod-always-official', 'tas-saimoen-incremental', 'tas-saimoen-finetuner']) assert.ok(byId.get(id)?.installSpec, id);
});

t('browser add-on: Chrome file, no game install', () => {
  const a = byId.get('tmx-universal-track-downloader')!;
  assert.match(String((a as { addon?: { asset?: string } }).addon?.asset), /chrome\.zip$/);
  assert.equal(a.category, 'browser-addon');
});

t('bundled fields survive: category, games ids, no duplicate games', () => {
  for (const e of list) {
    const b = bundled.find((x: { id: string }) => x.id === e.id)!;
    assert.equal(e.category, b.category, e.id);
    assert.equal(new Set(e.games).size, e.games.length, e.id);
  }
});

t('an empty index keeps the bundled catalog', () => {
  assert.equal(catalogFromIndex({ ...payload, projects: [] }, bundled, applyPolicy), null);
});

t('starForceBlocked of a version reaches the install spec (hub-allowed dinput8.dll)', async () => {
  const { specOf } = await import('./hubMerge.ts');
  const sha = 'a'.repeat(64);
  const v = { version: '1.3.0', channel: 'stable', files: [{ url: 'https://github.com/cheatoskar/eswc-autosave/releases/download/v1.3.0/legacy-essentials-1.3.0.zip', sha256: sha }],
    installs: { tms: { kind: 'files', base: 'game' }, tmo: { kind: 'files', base: 'game' } } };
  const pl = { ...payload, revoked: [] };
  assert.equal(specOf(pl, v as never)!.starForceBlocked, undefined, 'no field: nothing marked (the launcher then keeps dinput8.dll out)');
  const withSf = specOf(pl, { ...v, starForceBlocked: ['dinput8.dll', 42] } as never);
  assert.deepEqual(withSf!.starForceBlocked, ['dinput8.dll']);
  assert.equal(withSf!.games.length, 2);
});
