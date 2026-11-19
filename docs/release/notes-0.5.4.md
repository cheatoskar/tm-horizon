# TM Horizon 0.5.4 – Launcher Preview

One launcher for every TrackMania game on Windows, and experimentally on Linux. This is a preview: things will
break, please report them in the GitHub issues.

## Install

**Windows:** download `TM-Horizon_0.5.4_x64-setup.exe` below and run it (no admin needed). The installer is not
code-signed: SmartScreen shows "Windows protected your PC", click "More info", then "Run anyway". Check the download
against `SHA256SUMS` if you like. If you already have 0.5.0 to 0.5.3, the app updates itself (Settings > Updates).

**Linux (experimental):** 0.5.4 is Windows only for now. The experimental Linux build is still 0.5.3, from the [v0.5.3 release](https://github.com/cheatoskar/tm-horizon/releases/tag/v0.5.3).

## New in 0.5.4

- **Play button:** a loading bar at the bottom of the button, with short hangs like a real loading screen; full and
  still as soon as the game is open.
- **Pages:** choose which pages the sidebar shows, when you set up and later in Settings > Pages (presets Play,
  Modding and Everything). Home, Library and Mods always stay; links and tiles still open the hidden pages.
- **Statistics:** extra replay folders per game (Settings > Statistics folders), so autosaves you moved are still
  counted.
- **Communities:** the 100% TMX Project Discord has its right name, and the list is sorted by size instead of
  pinning entries.
- **TMX replay upload, Original / Sunrise / ESWC:** replays are no longer skipped with "TMX would refuse it". Every
  autosave of these games carries a header flag the launcher took for "not valid", but TMX accepts them. If you had
  automatic upload on, most of your runs were never sent; after the update they are. TMX still has the last word and
  its refusals show in the history. A replay file that is not readable when found is tried again for two minutes.
- **TMX replay upload, own maps:** a run on your own map is skipped only when TMX does not know the map (a test or
  validation drive). Your own maps that are on TMX still upload.

## What it does

**All games**
- Library of the TrackMania games on your PC (Steam, Ubisoft Connect, Epic, own folders, drive scan), game pages,
  Play with one click.
- Mods page: TMLoader mods, mods from their authors' GitHub releases, Openplanet plugins, browser add-on.
- Maps and skins: the Exchange sites and ManiaPark inside the app; downloads go straight into the game folders.
- News from the Exchange sites and mod releases, statistics from your own replays, clips and screenshots.
- Server list with players and maps, read from the servers themselves; Join on Nations/United Forever.

**Nations Forever / United Forever**
- TMLoader profiles: create, switch and start them; install mods from the TMLoader servers with their checksums.
- Horizon Client (experimental): in-game menu with modules, as a TMLoader mod, installed from its GitHub release.
- Steam fix for United Forever, TrackMania Highlands from ModDB (you download it, the launcher installs it).
- Your own dedicated server: ports, router (UPnP), firewall rule, console with players, chat and maps.

**Nations ESWC, Sunrise, Original**
- Horizon Client: in-game menu and modules (autosave and login fix, input display, TMX browser, WR hunter,
  scripts, performance) for games that never had mods.
- Play maps from the Exchange sites directly in the game.
- Legacy Essentials (autosave, controller fix, login fix, game settings) without the Horizon Client.

**TrackMania² / ShootMania, Trackmania (2020), Turbo**
- Start through ManiaPlanet title packs or the store, Openplanet setup with the official installer.

**TrackMania (2003), Wii, DS**
- Where to get them, emulator setup for your own copies.

## Privacy

No account and no telemetry. TM Horizon loads the mod list (the hub's signed index), the "More projects" lists and
covers and map pictures through its image proxy from tm-horizon.com; that server sees your IP address. Apart from
that it only talks to the services you use through it (GitHub, the Exchange sites, ManiaPark, Openplanet, the
TMLoader mod servers, Steam/IGDB covers, Nadeo's download servers, the game servers in your list); like any website
they see your IP address.

Not affiliated with Ubisoft or Nadeo. TrackMania is a trademark of Ubisoft.

Built with Claude Code as a tool.
