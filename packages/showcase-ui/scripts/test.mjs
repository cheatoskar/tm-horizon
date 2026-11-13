// Runs test/*.test.tsx: bundles each with esbuild (JSX; Node cannot run .tsx) and runs the bundle with node:test.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = mkdtempSync(join(tmpdir(), 'showcase-ui-test-'));
const files = readdirSync(join(root, 'test')).filter((f) => /\.test\.tsx?$/.test(f));
let failed = false;
try {
  for (const f of files) {
    const outfile = join(out, f.replace(/\.tsx?$/, '.mjs'));
    await build({
      entryPoints: [join(root, 'test', f)], outfile, bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', logLevel: 'warning',
      external: ['node:*'], banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    });
    const r = spawnSync(process.execPath, ['--test', outfile], { stdio: 'inherit', cwd: root });
    if (r.status !== 0) failed = true;
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
