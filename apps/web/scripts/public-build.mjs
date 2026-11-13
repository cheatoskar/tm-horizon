// `npm run build:public`: astro build with TMHUB_PUBLIC_BUILD=1 (no rehosted game art; see astro.config.mjs).
import { spawnSync } from 'node:child_process';
const r = spawnSync('npx', ['astro', 'build'], { stdio: 'inherit', shell: true, env: { ...process.env, TMHUB_PUBLIC_BUILD: '1' } });
process.exit(r.status ?? 1);
