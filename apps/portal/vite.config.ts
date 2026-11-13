import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
// HUB_API_URL: a second local hub next to the usual one (scripts/dev-hub.mjs sets it from HUB_PORT).
const api = process.env.HUB_API_URL ?? 'http://127.0.0.1:8787';
const proxy = Object.fromEntries(['/v1', '/auth', '/dl', '/files', '/hooks'].map((p) => [p, { target: api, changeOrigin: false }]));

export default defineConfig({
  plugins: [react()],
  server: { port: 5174, strictPort: true, proxy, fs: { allow: [root] } },
  preview: { port: 4174, strictPort: true, proxy },
  build: { chunkSizeWarningLimit: 900 },
});
