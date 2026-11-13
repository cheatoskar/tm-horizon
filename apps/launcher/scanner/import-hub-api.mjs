// Copy the hub data build (packages/api/dist in this monorepo) into src/generated/hub so the UI can
// bundle it as the offline fallback: real ManiaPlanet servers, TM2020 club rooms, community servers
// and events, GitHub project stats and TMLoader mods with SHA-256 (maps.json is not used: maps = TMX
// itself). Override the folder with HUB_API_DIR. The types come from @tm-hub/shared, not a copy.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const api = process.env.HUB_API_DIR || path.join(here, '..', '..', '..', 'packages', 'api');
const dist = path.join(api, 'dist');
const out = path.join(here, '..', 'src', 'generated', 'hub');
if (!fs.existsSync(path.join(dist, 'hub.json'))) {
  console.error(`No hub data in ${dist}. Run "npm run build -w @tm-hub/api" first.`);
  process.exit(1);
}
fs.mkdirSync(out, { recursive: true });

for (const f of ['hub.json', 'servers.json', 'projects.json', 'mods.json', 'events.json', 'communities.json']) {
  fs.copyFileSync(path.join(dist, f), path.join(out, f));
}
const hub = JSON.parse(fs.readFileSync(path.join(out, 'hub.json'), 'utf8'));
console.log('hub data', hub.generated, JSON.stringify(hub.counts));
