<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/brand/wordmark-dark.png"><img src="docs/brand/wordmark-light.png" alt="TM Horizon" width="520" height="114" /></picture></p>

# TM Horizon

One launcher for every TrackMania game, from TrackMania (2003) to Trackmania (2020): your library, mods,
maps, servers and statistics in one place, plus the Horizon Client, an in-game menu with modules for the old
games. Version 0.5.1 is the **Launcher Preview** for Windows: expect rough edges and tell me what breaks
(GitHub issues). Licence: AGPL-3.0 (`LICENSE`).

## Install (Windows)

Download `TM-Horizon_0.5.1_x64-setup.exe` from the newest release on
[GitHub Releases](https://github.com/cheatoskar/tm-horizon/releases) and run it. It installs for your user
only, no admin needed. `SHA256SUMS` in the release has the checksums if you want to check the download.

The installer is not code-signed (a certificate costs money), so SmartScreen shows "Windows protected your
PC". Click "More info", then "Run anyway". Updates come through the app (Settings > Updates) and are checked
against my signing key.

Linux packages exist in the build setup (`apps/launcher/docs/linux.md`, `packaging/arch/`) but are not part
of this preview.

## Privacy

No account, no telemetry. The launcher loads the mod list from tm-horizon.com (the hub's signed
index); that server sees your IP address. Everything else stays on your PC. Apart from that it only contacts the
services you use through it (GitHub, the Exchange sites and ManiaPark, Openplanet, the TMLoader mod servers,
Steam and IGDB for covers, Nadeo's download servers, the game servers in your list); like any website they see
your IP address. The full list: [docs/release/outbound-hosts.md](docs/release/outbound-hosts.md).

Not affiliated with Ubisoft or Nadeo. TrackMania is a trademark of Ubisoft.

## Screenshots

| | |
|---|---|
| Home | ![Home](docs/screenshots/home.png) |
| Library | ![Library](docs/screenshots/library.png) |
| Own server, console | ![Server console](docs/screenshots/server-console.png) |
| Statistics | ![Statistics](docs/screenshots/statistics.png) |

## Layout

| Folder | What | Stack |
|---|---|---|
| `apps/launcher` | The launcher: library of installed games, Play with TMLoader profiles, mod installs from the TMLoader servers, TMX / ManiaPark / TMTAS / RPG Trial inside the app, clips, servers and events, packs, problem reports, Discord status | Tauri 2 (Rust, `src-tauri/`) + React/Vite/TS |
| `apps/web` | The website (English, Deutsch, Polski, Français): games, mods, servers, events, communities, directory | Astro (static) |
| `packages/api` | Data pipeline: TMLoader indexes, GitHub, TMX, ManiaPlanet and trackmania.io servers, community server registry and event submissions (GitHub issue forms), Discord events, community Discord directory -> `dist/*.json` | Node 24 + TypeScript (runs `.ts` directly) |
| `packages/shared` | Hub data types (`src/types.ts`, the shapes of `packages/api/dist`) and design tokens (`tokens.css`, `src/tokens.ts`) used by launcher and website | TS |
| `packages/catalog` | Researched catalog of sites, mods, tools and communities (`catalog.json`, checker scripts) | JSON + Python |
| `docs/` | `mod-publishing.md` (design of mod publishing), `discord-presence.md` | |
| `.github/` | CI (`ci.yml`), release build (`release.yml`, see `docs/release.md`), daily mod link check (`links.yml`), hourly hub data build (`hub-data.yml`), issue forms for servers and events and the workflow that turns approved ones into pull requests (`registry.yml`) | |

npm workspaces tie it together: one `npm install` at the root, one `package-lock.json`.

## Build

Node 24, Rust (`%USERPROFILE%\.cargo\bin`), Python 3 for the art and catalog scripts.

```
npm install                              # all workspaces
npm run typecheck                        # shared, api, launcher
npm test -w @tm-hub/api                  # pipeline tests (parsers, registry files, dist against schemas)
npm run build -w @tm-hub/api             # -> packages/api/dist (network sources may fail; cached/sample data is used)
npm run hub-data                         # copies packages/api/dist into the launcher's bundled fallback

# website
python apps/web/scripts/fetch-game-art.py   # once: store/box art (not committed)
npm run build -w @tm-hub/web                # -> apps/web/dist

# launcher
cd apps/launcher
npm run build                            # web UI only (also runs in a normal browser as a preview), with the preview art
npm run build:public                     # same without the preview-only art (what releases use, docs/release.md)
cd src-tauri && cargo test               # Rust unit tests
cd .. && npx tauri build                 # -> src-tauri/target/release/bundle/nsis/TM Horizon_<version>_x64-setup.exe
# Linux (docs: apps/launcher/docs/linux.md, Arch: packaging/arch/)
npx tauri build --bundles appimage,deb,rpm
# a Tauri build runs `npm run build`; set TMHUB_PUBLIC_BUILD=1 to get the public art set,
# TMHUB_RELEASE_PREVIEW=1 for the Launcher Preview (public build without any hub feature, docs/release.md)
```

Testing against a copy of TMLoader instead of the real one: `TMHUB_TMLOADER_DIR=<copy>` (the
launcher then shows "Sandbox"), `TMHUB_SANDBOX=<copy> TMHUB_NET_TESTS=1 cargo test` for the
network tests.

## What is real

Everything the launcher shows comes from real sources: the games on this PC, TMLoader profiles and mods, the
TMLoader server indexes with SHA-256, GitHub releases, the Exchange sites, Openplanet's plugin list, the
catalog (link-checked, filtered by licence in public builds: `packages/catalog/release-policy.json`) and the
game servers' own answers. The sample data in `apps/launcher/src/data/sample.ts` is only for the browser preview;
a public build fails if any of it is in the bundle (`apps/launcher/vite.config.ts`).

## Launcher features at a glance

- Library, game pages, Play with a TMLoader profile, maps and skins saved straight into the game
  folders, clips.
- Languages: English, Deutsch, Polski, Français (Settings; default from Windows).
- Discord status for every game started from TM Horizon (`docs/discord-presence.md`, off by default).
- "Report" on each game page: logs of the profile's mods, newest crash logs and a system
  summary, redacted, zipped to the Desktop or Downloads; nothing is uploaded.
- Packs: share a profile as a `tmhub://pack/` link or `.tmhubpack` file; importing checks every
  mod against your TMLoader servers and installs with SHA-256.
- Servers: live list with players and maps (the servers' own query port), your own dedicated server in a few
  clicks (ports, UPnP, firewall rule, console).
- TAS mode, switched at the top of the sidebar ("Play / TAS"), with its own cyan accent and a
  "TAS · offline" badge. It shows only TAS things: TMInterface (Forever, started through a TMLoader
  profile with TMInterface + CoreMod, folder buttons and plugin list), ForeverTAS, a placeholder for
  the Trackmania 2020 tool "Tick", TAS profiles and TMTAS Exchange. No server joins in TAS mode;
  the first launch shows "Offline only". Play mode shows no TAS UI and never offers a TMInterface profile.
- Nations ESWC: "Get" explains and opens the community folder with the unofficial 1.80 patch
  (never downloaded by the app), and suggests ESWC Autosave.
- Competition Patch notice: TMX needs CP 2.0 for replay uploads to Nadeo/Classic tracks from
  2026-11-19; the Forever page offers the update when a profile uses an older one.

## Safety rules in the code

- Nothing inside `Program Files (x86)\TrackMania Nations ESWC` (StarForce) is ever opened,
  listed or started, and no `dinput8.dll` is ever touched (`apps/launcher/src-tauri/src/fsx.rs`,
  resolved paths, tested).
- TMLoader files are written only while TMLoader and the game are closed, with a backup first,
  atomically, one write at a time.
- Downloads: https only (TMUF's official setup is plain http and ships with its known SHA-256),
  mod zips checked against the index SHA-256, size caps.
- `tmhub://` links are registered only after the user agrees.
