// npm run import-server-seeds -w @tm-hub/server [-- --file seeds/server-seeds.json]
// Puts the seed list of public game servers into game_servers (approved, no owner). Idempotent, matched by login.
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { createCtx } from '../src/ctx.ts';
import { importServerSeeds, loadSeedFile } from '../src/services/server-seeds.ts';

const i = process.argv.indexOf('--file');
const file = resolve(i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : 'seeds/server-seeds.json');
const ctx = await createCtx(loadConfig());
const r = await importServerSeeds(ctx, loadSeedFile(file));
console.log(`servers: ${r.created} created, ${r.updated} refreshed (${file})`);
await ctx.db.destroy();
