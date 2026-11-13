# Roadmap

## Phase 1: what exists now

- **Launcher** (`apps/launcher`, Tauri): games, mods (TMLoader repositories), maps from the Exchange sites,
  servers, settings; reads the hub data with a bundled copy for offline starts.
- **Website** (`apps/web`, Astro): games, directory of community projects, mods, events, launcher page, Discord communities tab (mx_eyebo's list).
- **Data pipeline** (this repository): hourly GitHub Action builds static JSON (mods with checked
  SHA-256, GitHub projects, maps, ManiaPlanet and TM2020 servers, Discord events, the catalog) and
  publishes it on GitHub Pages. No server of our own. Not deployed yet.
- **TM Vibrant Shaders 1.5.0** for TMNF/TMUF and TM2, with clip recording.

## Phase 2: community services (in progress)

- **Community server registry**: owners add a server once (issue form or pull request); every build
  checks whether the game port answers. Done in the pipeline; buttons in launcher and website open.
- **Event submissions**: issue form, approved events in `events.json`, past ones drop out. Done in the
  pipeline; buttons open.
- **Master server lists**: ESWC rooms with player counts (getservers.php, needs one live test by me);
  TMNF/TMUF and the ESWC game server list need a traffic capture first
  (`docs/tmf-masterserver.md`, `docs/eswc-masterserver.md`).
- **"Host a server" wizard in the launcher**, built on my Randomizer Anywhere fork
  (`100_server/randomizer-anywhere`), which already downloads, configures and starts dedicated servers
  for TMNF, TMUF, ESWC, Sunrise and Original. The wizard asks game, name and ports, starts it, and offers
  to register the server.
- **Clip recap montage** in the launcher: join the TMVS clips of a session into one video.

## Later

- Accounts and friends (who plays what, invites).
- ManiaLink in-game store for mods and skins.
- Linux / Arch package of the launcher.

## Before the public release

- Ask mx_eyebo (Mania Exchange) whether syncing his Discord server list (`communities.json`, built from the public Google Sheet, with daily invite lookups) is fine, and whether the credit line and the "contact mx_eyebo" note are what he wants.
- Contact the operators of TMTAS Exchange (tmtas.exchange) and TM RPG Trial (tmrpgtrial.com), which the launcher embeds (TAS mode, Maps page), the same way as TMX and ManiaPark.
- TMTAS Exchange has no public events feed yet. Once it has one, wire the events as source `tmtas` in `events.json`.

## Needs permission from others

| Who | For what |
| --- | --- |
| Mania Exchange team | Hourly map lists, hotlinked thumbnails and download links in a public launcher |
| trackmania.io (maintainer) | Using its undocumented club room API publicly |
| Tomashu (TMLoader) | Mirroring the mod index, hashing downloads, installing mods from the launcher |
| Nadeo / Ubisoft | Cover art and logos in launcher and website; polling the old ESWC/TMF master servers |
