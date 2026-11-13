// npm run schema: JSON Schema for every dist file, generated from packages/shared/src/types.ts.
import fs from 'node:fs';
import path from 'node:path';
import { createGenerator } from 'ts-json-schema-generator';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, 'schema');
fs.mkdirSync(outDir, { recursive: true });

const files: Record<string, string> = {
  hub: 'HubIndex',
  mods: 'ModsFile',
  projects: 'ProjectsFile',
  maps: 'MapsFile',
  events: 'EventsFile',
  servers: 'ServersFile',
  catalog: 'CatalogFile',
  communities: 'CommunitiesFile',
};

const generator = createGenerator({
  path: path.join(root, '..', 'shared', 'src', 'types.ts'),
  tsconfig: path.join(root, 'tsconfig.json'),
  type: '*',
  expose: 'export',
  topRef: true,
  jsDoc: 'extended',
  additionalProperties: false,
  skipTypeCheck: true,
});

for (const [name, type] of Object.entries(files)) {
  const schema = generator.createSchema(type) as Record<string, unknown>;
  schema.$id = `https://cheatoskar.github.io/tm-hub/schema/${name}.json`;
  schema.title = `tm-hub ${name}.json`;
  const file = path.join(outDir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(schema, null, 2) + '\n');
  console.log('wrote', path.relative(root, file));
}
