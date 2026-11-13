// Migration names sort in the order they must run (Kysely runs them by name and refuses a new one that sorts
// before an executed one): a fresh database and one upgraded from the 2026-11-11 staging state both end up complete.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Migrator, sql } from 'kysely';
import { openDb } from '../src/db/db.ts';
import { migrate, migrationsFor } from '../src/db/migrations.ts';

const names = Object.keys(migrationsFor(true));

test('the newest migration sorts last (Kysely runs them by name)', () => {
  assert.equal([...names].sort().at(-1), '0007-discovered');
  assert.equal(new Set(names).size, names.length);
});

for (const [label, upTo] of [['fresh', null], ['upgraded from staging (0001-0005)', '0005-project-type-downloads']] as const) {
  test(`migrations run: ${label}`, async () => {
    const db = openDb('sqlite::memory:');
    if (upTo) {
      const m = new Migrator({ db, provider: { getMigrations: async () => migrationsFor(true) } });
      const r = await m.migrateTo(upTo);
      assert.equal(r.error, undefined);
    }
    await migrate(db, true);
    const done = (await sql<{ name: string }>`select name from kysely_migration order by name`.execute(db)).rows.map((r) => r.name);
    assert.deepEqual(done, [...names].sort());
    await db.destroy();
  });
}
