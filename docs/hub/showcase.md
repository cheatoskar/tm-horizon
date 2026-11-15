# Mod showcase pages

Every mod author can design a page for their mod: header image, features, screenshots, video, hotkeys, compatibility, FAQ and buttons.
The launcher shows it at the top of the mod page, above the usual sections (README, changelog, versions). The website renders the same page statically.
Without a showcase, the mod page looks as before.

A showcase is **data, not HTML**: an ordered list of blocks. There is no HTML, CSS or JavaScript from the author.
Everything is drawn by the same React components (`packages/showcase-ui`). Text is always text, and links are `https` only.

### Where the page comes from

| Source | How |
|---|---|
| Mod repository | `showcase.json` in the root folder (default branch) or the key `showcase` in `plugin.json`. The hub reads it again on import and on every source check. |
| Developer portal | The **Showcase** tab in the project: a block list with add, remove, reorder and a live preview (the same renderer as in the launcher). Saving replaces the repository copy; the hub then no longer re-reads it. |
| Catalog (examples) | `packages/catalog/showcases/*.json`, registered in `SHOWCASES` in `packages/catalog/mods_seed.py` (`build_catalog.py` writes them to `catalog.json`). Today: TM Vibrant Shaders, 100 TMX Bingo Plugin, ESWC Autosave. The hub finds the matching template by catalog ID, name or repository (`apps/server/src/services/catalog-seeds.ts`). Catalog projects get it as their page right at catalog import (`showcase_from = 'catalog'`); a `showcase.json` in the repository replaces it. |

In the portal:

- The **Showcase** tab is always there, also for visitors of a catalog project that has not been claimed yet (then it is view-only, with the note "Claim the project to change it").
- Without a page, it explains in two sentences what a showcase is and offers **Start from template** (header, three features, the project's images, compatibility, latest changes, install button; not saved yet), **Copy from catalog** (if there is a template) and **Use showcase.json** (if a GitHub repository is connected). API: `POST /v1/projects/<slug>/showcase/adopt` with `{"from":"catalog"}` or `{"from":"repo"}`.
- When importing from a link, the author chooses between the page from the repository, the catalog template, or none.
- The public project page in the portal (`/p/<slug>`) shows the showcase above the description.
- **Remove page** removes the page permanently; a `showcase.json` in the repository only comes back via "Use showcase.json".

In `showcase.json`, images may be given as a path in the repository (`docs/images/a.png`); the hub turns that into `https://raw.githubusercontent.com/<owner>/<repo>/HEAD/docs/images/a.png`.

### Format

```json
{
  "$schema": "https://raw.githubusercontent.com/cheatoskar/tm-horizon/main/packages/shared/showcase.schema.json",
  "version": 1,
  "theme": { "accent": "orange" },
  "blocks": [
    { "type": "hero", "title": "My Mod", "tagline": "One sentence about it.", "image": "docs/images/hero.jpg", "badges": ["TMNF", "Open source"] },
    { "type": "features", "items": [{ "icon": "sun", "title": "Light", "text": "Sun and shadows." }] },
    { "type": "hotkeys", "rows": [{ "keys": "F8", "action": "Menu" }] },
    { "type": "cta", "buttons": [{ "kind": "install", "label": "Install" }] }
  ]
}
```

`theme.accent`: `blue`, `cyan`, `green`, `lime`, `amber`, `orange`, `red`, `pink`, `violet`, `slate`. Each colour has a light and a dark variant; the page follows the theme of the launcher or the website.

`icon` (optional, since 2026-11-12): project icon, square, PNG or WebP, at most 512 KB, `https` on `raw.githubusercontent.com` or as a GitHub release attachment (a repository path such as `docs/logo/logo-256.png` works too). Without `icon`, the hub uses `docs/logo/logo-256.png` or `docs/logo/logo-512.png` from the repository, if present. Older files without `icon` stay valid; older launchers ignore the field.

**What the hub takes from it (claimed projects):** on claiming via GitHub, on every check of the GitHub source (only if `showcase.json` changed) and with "Refresh from GitHub" in the portal: name = `hero.title`, summary = `hero.tagline`, banner = `hero.image`, gallery = images of the first `gallery` block, games = `compat` rows with `works` or `partial`, icon = `icon` or `docs/logo/`. The repository wins over the catalog data. Code: `apps/server/src/services/repo-sync.ts`.

| Block (`type`) | Fields | Limits |
|---|---|---|
| `hero` | `title`, `tagline`, `image`, `video`, `badges` | Title 60, tagline 140, up to 3 badges of 24 characters each. At most one hero. |
| `features` | `title`, `items[]` with `icon`, `title`, `text` | Up to 9 items, title 40, text 140 characters. `icon` from a fixed Lucide list (see the schema, e.g. `sun`, `droplets`, `camera`, `film`, `palette`). |
| `gallery` | `title`, `images[]` with `url`, `caption`, `alt` | Up to 12 images, caption 120 |
| `compare` | `before`, `after`, each with `url`, `label`; `caption` | Two images with a slider, label 24 |
| `video` | `url`, `caption`, `poster` | YouTube, Vimeo, Streamable |
| `text` | `title`, `markdown` | 4000 characters, limited Markdown (below) |
| `compat` | `rows[]` with `game`, `status`, `note` | Up to 14 rows; `game` as in the hub (`tmnf`, `tmuf`, `eswc`, `tm2-stadium`, ...), `status`: `works`, `partial`, `planned`, `no` |
| `hotkeys` | `rows[]` with `keys`, `action` | Up to 20 rows, `keys` such as `Ctrl+F5` (24), `action` 80 |
| `changelog` | `count` (1 to 3) | Fetches the notes of the latest versions; without notes the block is dropped |
| `faq` | `items[]` with `q`, `a` | Up to 12, question 120, answer 600 |
| `cta` | `text`, `buttons[]` with `kind`, `label`, `url`, `style` | Up to 3 buttons, label 30. `install` starts the installation, `companion` opens the mod's companion link (see `related-links.md`) or its own `url`, `link` needs a `url`. |

In total at most **30 blocks** and 60,000 characters.

### Images and videos

- Images: `https`, extension `.png`, `.jpg`, `.jpeg`, `.webp` or `.gif`, no query and no credentials. Allowed hosts: the hub's storage (upload an image in the portal or pick one from the project images), `raw.githubusercontent.com`, GitHub release attachments (`github.com/<owner>/<repo>/releases/download/...`) and `i.imgur.com`.
- Recommended: at most 5 MB and 3840 pixels on the long edge. The hub checks images from other hosts with a HEAD request; anything that is not an image or is over 5 MB is left out.
- Videos: `youtube.com/watch?v=`, `youtu.be/`, `youtube.com/embed/` (Shorts too), `vimeo.com/<id>`, `streamable.com/<id>`. Embeds are privacy-friendly (`youtube-nocookie.com`, Vimeo with `dnt=1`) and load only **after a click**. Before that there is no request to the video site, not even for a thumbnail; if you want one, give a `poster` from the image list.

### Markdown in `text`

Headings (`#` to `####`, rendered as subheadings inside the block), paragraphs, lists (`-` and `1.`), `**bold**`, `*italic*`, `` `code` ``, code blocks with three backticks and `[links](https://...)`.
Everything else stays plain text: raw HTML, images, tables, quotes. Links that are not `https` lose the link and keep the text.

### Validation

The same check (`packages/shared/src/showcase.ts`, `validateShowcase`) runs in the hub server, in the portal (live while typing) and in the launcher.
The portal and `PUT /v1/projects/:slug/showcase` reject a page with errors (400 with the list `details.issues`, path and message per error).
On import from the repository and in the launcher the check is lenient: what is wrong is dropped, the rest stays. Unknown fields count as errors (typos should be noticed).
`showcase.schema.json` (`packages/shared`) is the JSON Schema for editor hints; the validator is authoritative.

### Implementation

- Schema and validator: `packages/shared/src/showcase.ts`, `showcase-md.ts`, `showcase.schema.json`.
- Renderer: `packages/showcase-ui` (React; in the launcher, in the portal preview and, for the website, as static markup via `react-dom/server`, plus a small script for the slider and the video click).
- Hub: columns `projects.showcase` and `projects.showcase_from` (`repo`, `portal` or `catalog`), field `showcase` in the project response and in the signed index.
- Launcher: in the Tauri window the CSP allows `frame-src` only for `youtube-nocookie.com`, `player.vimeo.com` and `streamable.com`.
