import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { checkLauncherSources, checkRelease } from '../../packages/catalog/check-release.mjs';
import { publicCatalog, writePublicCatalog } from '../../packages/catalog/public-catalog.mjs';

// Public build (TMHUB_PUBLIC_BUILD=1 or `vite build --mode public`, see docs/release.md): the TMX Headers
// Contest banners and the box covers are preview-only art (the ESWC hero is my own screenshot since 0.5.0) (ART_CREDITS.md). The UI then never
// references them (__PUBLIC_BUILD__, src/data/catalog.ts, src/ui/HeaderArt.tsx) and this plugin deletes the
// files from dist, because Vite copies public/ wholesale.
// Also third-party pictures without permission (docs/legal/permissions.md): screenshots of the Exchange sites
// (tmx-capture, only used by the browser preview) and bundled logos of other people's mods; the app then shows
// the icon the mod's own TMLoader server publishes (icon_link) or the generated tile.
const PREVIEW_ONLY = ['header-art', 'tmx-capture'];
// Strings that only exist in src/data/sample.ts: a public build fails when one is in the bundle.
const SAMPLE_MARKERS = ['Sunday Stadium Cup', 'Red Comet', 's:tm2-online', 'Night Lights Showcase'];
const OWN_MOD_ICONS = new Set(['100-tmx-bingo.png', 'tm-vibrant-shaders.png']);
const COVER = /^cover\.[a-z0-9]+$/i;
const CATALOG_DIR = path.resolve(__dirname, '../../packages/catalog');
const catalogPolicy = () => JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, 'release-policy.json'), 'utf8'));

function dropPreviewArt(): Plugin {
  let outDir = 'dist';
  return {
    name: 'tmhub-drop-preview-art',
    enforce: 'pre',
    apply: 'build',
    // The generated JSON tables would still carry the paths as strings: strip them from the bundle too.
    transform(code, id) {
      const file = id.split('?')[0].replaceAll('\\', '/');
      // Hidden catalog entries (release-policy.json) are left out of the bundle entirely (packages/catalog/public-catalog.mjs).
      if (file.endsWith('/catalog/catalog.json')) return { code: JSON.stringify(publicCatalog(JSON.parse(code), catalogPolicy())), map: null };
      if (file.endsWith('/generated/header-art.json')) return { code: JSON.stringify({ sites: {}, envs: {} }), map: null };
      if (file.endsWith('/generated/mods.json')) {
        const j = JSON.parse(code) as { products?: Record<string, { icon?: string | null }> };
        for (const p of Object.values(j.products ?? {})) {
          if (p.icon?.startsWith('mod-icons/') && !OWN_MOD_ICONS.has(p.icon.slice('mod-icons/'.length))) p.icon = null;
        }
        return { code: JSON.stringify(j), map: null };
      }
      if (file.endsWith('/generated/art.json')) {
        const j = JSON.parse(code) as { titles?: Record<string, { files?: Record<string, unknown> }> };
        for (const e of Object.values(j.titles ?? {})) {
          if (e.files) delete e.files.cover;
        }
        return { code: JSON.stringify(j), map: null };
      }
      return null;
    },
    configResolved(c) { outDir = path.resolve(c.root, c.build.outDir); },
    // Catalog licence rules (packages/catalog/check-release.mjs): a violation fails the public build.
    buildStart() {
      const dir = path.resolve(__dirname, '../../packages/catalog');
      const v = checkRelease(JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8')), JSON.parse(fs.readFileSync(path.join(dir, 'release-policy.json'), 'utf8'))).concat(checkLauncherSources(__dirname));
      if (v.length) throw new Error('catalog release check failed: ' + v.join('; '));
      // The same reduced catalog for the Rust side (src-tauri/build.rs embeds it; cargo runs after this build).
      writePublicCatalog();
    },
    closeBundle() {
      // No made-up data in a public build (src/data/sample.ts is for the browser preview only).
      const assets = path.join(outDir, 'assets');
      for (const f of fs.existsSync(assets) ? fs.readdirSync(assets).filter((x) => x.endsWith('.js')) : []) {
        const js = fs.readFileSync(path.join(assets, f), 'utf8');
        const hit = SAMPLE_MARKERS.find((m) => js.includes(m));
        if (hit) throw new Error(`public build: sample data in ${f} ("${hit}", src/data/sample.ts)`);
      }
      // No URL of a hidden catalog entry may be in the bundle (unless a shown entry uses the same URL).
      const full = JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, 'catalog.json'), 'utf8'));
      const hide = catalogPolicy().hide as Record<string, string>;
      const shown = JSON.stringify(publicCatalog(full, catalogPolicy()));
      const hiddenUrls = new Set<string>();
      for (const e of full.entries) if (e.id in hide) for (const u of JSON.stringify(e).match(/https?:[^"\s]+/g) ?? []) if (!shown.includes(u)) hiddenUrls.add(u);
      for (const f of fs.existsSync(assets) ? fs.readdirSync(assets).filter((x) => x.endsWith('.js')) : []) {
        const js = fs.readFileSync(path.join(assets, f), 'utf8');
        for (const u of hiddenUrls) if (js.includes(u)) throw new Error(`public build: URL of a hidden catalog entry in ${f}: ${u}`);
      }
      for (const p of PREVIEW_ONLY) fs.rmSync(path.join(outDir, p), { recursive: true, force: true });
      const icons = path.join(outDir, 'mod-icons');
      if (fs.existsSync(icons)) for (const f of fs.readdirSync(icons)) if (!OWN_MOD_ICONS.has(f)) fs.rmSync(path.join(icons, f), { force: true });
      const store = path.join(outDir, 'store-art');
      if (!fs.existsSync(store)) return;
      for (const d of fs.readdirSync(store, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        for (const f of fs.readdirSync(path.join(store, d.name))) {
          if (COVER.test(f)) fs.rmSync(path.join(store, d.name, f), { force: true });
        }
      }
    },
  };
}

// Every build: the raw screenshots and the how-to of public/covers-own (tools/make-own-covers.py) stay out of dist.
function dropOwnCoverSources(): Plugin {
  let outDir = 'dist';
  return {
    name: 'tmhub-drop-own-cover-sources',
    apply: 'build',
    configResolved(c) { outDir = path.resolve(c.root, c.build.outDir); },
    closeBundle() {
      fs.rmSync(path.join(outDir, 'covers-own', 'drop'), { recursive: true, force: true });
      fs.rmSync(path.join(outDir, 'covers-own', 'README.md'), { force: true });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Launcher Preview release (TMHUB_RELEASE_PREVIEW=1 or `--mode release`): no hub features; implies the public build.
  const preview = process.env.TMHUB_RELEASE_PREVIEW === '1' || mode === 'release';
  const pub = preview || process.env.TMHUB_PUBLIC_BUILD === '1' || mode === 'public';
  return {
    base: './',
    define: { __PUBLIC_BUILD__: JSON.stringify(pub), __RELEASE_PREVIEW__: JSON.stringify(preview) },
    plugins: [react(), dropOwnCoverSources(), ...(pub ? [dropPreviewArt()] : [])],
    build: { target: 'es2022', chunkSizeWarningLimit: 900 },
    // Map details (packages/map-inspector): `gbx` imports the GPL-3.0 `lzo-ts` for map bodies; the package's own
    // LZO1X decompressor stands in, the same alias the website uses (see packages/map-inspector/src/index.ts).
    resolve: { alias: { 'lzo-ts': path.resolve(__dirname, '../../packages/map-inspector/src/lzo1x.ts') } },
    worker: { format: 'es' as const },
  };
});
