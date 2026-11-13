# TM Horizon site (local prototype)

Static Astro site for TM Horizon: discover mods, servers, events and community sites for every TrackMania game.
Local only. Nothing is deployed.

## Run

```
python scripts/fetch-game-art.py   # once: store/box art into public/img/games (PYTHONIOENCODING=utf-8 on Windows)
npm ci
npm run build                      # runs scripts/build-data.mjs, then astro build
npx serve dist                     # or: npm run dev
node scripts/shoot.mjs http://localhost:3000 screens/v2   # Playwright screenshots (Playwright from %USERPROFILE%\tools\playwright)
```

## Data (scripts/build-data.mjs -> src/data/site.json)

| What | Source | Real or sample |
|---|---|---|
| Mods (TMLoader) | `packages/api/dist/mods.json` (versions, download URLs, SHA-256), merged with the local TMLoader index (`%LOCALAPPDATA%\TMLoader`, read only) for mods the API config does not list (Twinkie, 100% TMX + Bingo, TMFOXR) and for version dates | real |
| Mod stars / downloads | GitHub API for mods with a GitHub repository (cached in `.cache/github.json`, token from `gh auth token` if present) | real |
| Projects | `packages/api/dist/projects.json` (stars, latest-release downloads) | real |
| Servers | `packages/api/dist/servers.json`: ManiaPlanet master server, trackmania.io rooms and community servers (`source`, `address`, `online`, `lastSeen`, `language`, `contact`, `homepage` are passed through); Forever rows without a community entry are sample | mixed, marked |
| Events | `packages/api/dist/events.json`: Discord events and submitted events (`source`, `address`, `community`); no Discord bot yet | sample, marked |
| Catalog mods | Catalog entries with `modType` (Discord mod channel) plus Openplanet, BingoForever and ForeverRPC. Install types come from `installs` / `install` / `installSpec`: TMLoader, Proxy DLL (`proxy:<dll>`), GameData files, Openplanet, Manual, Discord only. An entry that is the same as a TMLoader mod is merged into it. Game ids tm1 and tmsx show under Original and Sunrise | real |
| READMEs | GitHub README of each mod repository, fetched by build-data.mjs (cached a day in `.cache/readmes.json`, written to `src/data/readmes/`, fails softly), rendered by `mdDoc` in `src/lib/md.ts` (HTML stripped, links http(s), images https) | real |
| Directory | `packages/catalog/catalog.json` (entries with `url: null` are shown as "Only on Discord"; game ids the site does not know are ignored) | real |
| Communities | `packages/api/dist/communities.json` (mx_eyebo's Discord server list with member and online counts, expired invites marked, archive hidden by default; credit line and "contact mx_eyebo" note on the page). Without the file the tab shows the catalog's community entries | real |
| Maps | not listed; the Maps tab links to each game's exchange | - |
| "Allowed online" | editorial, in `modMeta` in build-data.mjs; my reading of the TMX rules, not checked by TMX | editorial |

Without `packages/api/dist` the script falls back to the TMLoader index, the catalog, the GitHub API and `src/data/events.ts` (sample).

## Game art

Public build (`npm run build:public`, i.e. `TMHUB_PUBLIC_BUILD=1`): no rehosted art in the build, and visitors' browsers
never load pictures from third parties. Covers of every game come from IGDB (one 3:4 source, ids in
`packages/shared/src/covers.ts`), the other Steam pictures (hero, header, logo) from Steam; both are referenced same-origin as
`/ext-img/igdb/<image>.<ext>` and `/ext-img/steam/<appid>/<file>`, and nginx on our server fetches and caches them from a strict
allowlist (`deploy/ext-img.conf`, set up in `docs/hub/deploy-oracle.md`). Showcase, gallery and README pictures from GitHub
and Imgur go the same way (`webImg()` of `@tm-hub/shared/extimg`); pictures from other hosts are not shown. Without that proxy (astro dev) the browser falls back
to our own covers from `public/img/covers/` (`node scripts/make-covers.mjs`). Optional override: my own screenshots composed
into `public/img/covers-own/` (`apps/launcher/tools/make-own-covers.py`, see `apps/launcher/public/covers-own/README.md`).
`gameArt()` in `src/data/games.ts` picks the source, and `astro.config.mjs` deletes anything fetched into `public/img/games`
from `dist` as a guard. A normal `npm run build` uses the local files from `scripts/fetch-game-art.py` when they exist
(local preview only, kept out of git; see `public/img/games/SOURCES.md`), else the same public sources.

Other pictures, all fetched at build time and served from this site (cached in the git-ignored `public/img/icons/`):
Openplanet plugin thumbnails (the 200 most downloaded; the list itself comes from openplanet.dev's public plugin API, cached a
day in `.cache/openplanet.json`), and the logos of directory entries listed in `src/data/entry-art.json`
(`node scripts/fetch-entry-art.mjs`: TMLoader index icon, ManiaPark preview, Discord server icon from the public invite API,
the site's apple-touch-icon, GitHub organisation avatar). Anything without a picture gets the generated type icon.

Servers: without `packages/api/dist`, the copy the launcher bundles (`apps/launcher/src/generated/hub`) is used, plus the
registered servers in `packages/api/data/servers/*.yaml` (the 100% TMX servers), so the Servers tab is never empty.

## Design

Dark asphalt with one orange accent; light theme with the same structure (theme switch in the gear menu, default follows the system). Inter for text, Barlow Condensed italic for display. Icons: Lucide, rendered to inline SVG at build time (`src/components/Icon.astro`). Mods without an icon get a generated tile (gradient, speed stripes, category glyph; `src/components/Thumb.astro`). Server names keep their TrackMania `$` colour codes (`tmName` in `src/lib/fmt.ts`).

Pages (each also under `/de/`, `/pl/`, `/fr/`): `/`, `/discover/<type>/` (mods, maps, skins, texture-packs, tools, projects, servers, events, communities), `/mod/<id>/`, `/game/<id>/`, `/games/`, `/directory/`, `/events/`, `/launcher/`, `/download/`, `/authors/`. `/mod/<id>/` is a TMLoader mod (versions, SHA-256) or a catalog mod (README, gallery, install per game, mirrors).

## Launcher links and downloads

Every install button is built by `src/lib/links.ts` (`installLink(id)` = `tmhub://install/<id>`; `modLink`, `gameLink`). Only mods the launcher can install (TMLoader, proxy DLL, catalog `installSpec`) get an Install button; the others show the download page. File names and URLs of a release are in `src/data/download.ts` (version from `apps/launcher/src-tauri/tauri.conf.json`); while `REPO.public` is false the download buttons are disabled.

## Languages

English (unprefixed), Deutsch (`/de/`), Polski (`/pl/`), Francais (`/fr/`). Messages are flat JSON files in `src/i18n/` (`en.json` is the reference and the fallback); `t(lang, key, vars)` in `src/i18n/index.ts` looks them up, `lh(lang, path)` adds the prefix. Page bodies are in `src/views/`, and `src/pages/[...slug].astro` is the only route file: it lists every path for every language and renders the view. Add a language by adding a JSON file, an entry in `src/i18n/index.ts` and in `astro.config.mjs`.

The header has a language menu (choice saved in `localStorage` key `lang`). On an English URL a small inline script sends the visitor to the saved language, or to the first de/pl/fr in `navigator.languages`. `<html lang>` and hreflang links are set per page; the alternates are relative until the site has a public URL (`site` in `astro.config.mjs`). Dates, numbers and relative times use `Intl` with the page language. Data (mod descriptions, names, changelogs, server names) is not translated; game prices, notes and "where to get it" are (`game.<id>.*`, `price.*`).

Check that all languages have the same keys: every key of `en.json` must exist in the others (missing ones fall back to English silently).

## Community services

The events page has a "Submit event" button and the servers page and a game's empty server tab an "Add your server" button. Both open the GitHub issue forms of the repository in a new tab (`src/data/links.ts`, repository constant `REPO` in `packages/shared/src/repo.ts`); while `REPO.public` is false the buttons are disabled with the note "Available after the first release"; entries are checked by hand and appear after approval. Community servers show a "Community" chip, a status dot (green online, grey "last seen ...", none when unknown), the address with a copy button when there is no join link (ESWC, Sunrise, Original), and the owner's contact and homepage as plain external links showing the domain (only http/https links become links).
