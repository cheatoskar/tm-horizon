import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";

// Public build (TMHUB_PUBLIC_BUILD=1, `npm run build:public`): the store and box art fetched into
// public/img/games for the local preview is not ours to rehost. Pages then point at Steam's CDN and our
// own covers (src/data/games.ts gameArt), and this hook deletes the fetched files from dist as a guard.
const PUBLIC_BUILD = process.env.TMHUB_PUBLIC_BUILD === "1";
const dropPreviewArt = {
  name: "tmhub-drop-preview-art",
  hooks: {
    "astro:build:done": ({ dir }) => {
      const games = path.join(fileURLToPath(dir), "img", "games");
      if (!fs.existsSync(games)) return;
      for (const f of fs.readdirSync(games)) if (f !== "SOURCES.md") fs.rmSync(path.join(games, f), { force: true });
    },
  },
};

const locales = ["en", "de", "pl", "fr"];
// /mods and /servers redirects exist in every language
const redirects = {};
for (const l of locales) {
  const p = l === "en" ? "" : `/${l}`;
  redirects[`${p}/mods`] = `${p}/discover/mods/`;
  redirects[`${p}/servers`] = `${p}/discover/servers/`;
}
// English names for the legal pages (the pages keep their German names in every language)
Object.assign(redirects, { "/imprint": "/impressum/", "/privacy": "/datenschutz/", "/terms": "/nutzungsbedingungen/" });

export default defineConfig({
  output: "static",
  trailingSlash: "always",
  // English at the root, the others under /de/, /pl/, /fr/ (pages come from src/pages/[...slug].astro)
  i18n: { defaultLocale: "en", locales, routing: { prefixDefaultLocale: false } },
  redirects,
  integrations: PUBLIC_BUILD ? [dropPreviewArt] : [],
  // developer docs: code blocks in a light and a dark theme (the page picks one with CSS variables, see DevDoc.astro)
  markdown: { shikiConfig: { themes: { light: 'github-light', dark: 'github-dark' }, defaultColor: false, langAlias: { angelscript: 'cpp', as: 'cpp' } } },
  // the legal pages read docs/hub/legal/*.md from the repository root
  vite: { server: { fs: { allow: ["../.."] } } },
});
