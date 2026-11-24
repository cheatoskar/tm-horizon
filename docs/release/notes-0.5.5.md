# TM Horizon 0.5.5 – Launcher Preview

One launcher for every TrackMania game on Windows, and experimentally on Linux. This is a preview: things will
break, please report them in the GitHub issues.

## Install

**Windows:** download `TM-Horizon_0.5.5_x64-setup.exe` below and run it (no admin needed). The installer is not
code-signed: SmartScreen shows "Windows protected your PC", click "More info", then "Run anyway". Check the download
against `SHA256SUMS` if you like. If you already have 0.5.0 to 0.5.4, the app updates itself (Settings > Updates).

**Linux (experimental):** 0.5.5 is Windows only for now. The experimental Linux build is still 0.5.3, from the [v0.5.3 release](https://github.com/cheatoskar/tm-horizon/releases/tag/v0.5.3).

## New in 0.5.5

- **TMX replay upload, Original and Sunrise:** the game's own autosave of a run has no inputs inside, and TMX
  refuses many of those. The launcher now waits up to 20 seconds for the full copy of the same run (Horizon
  Client's copy in My Replays, or one you saved yourself) and uploads that one instead.
- **Upload by hand:** a replay goes to the Exchange of the game whose folder it is in, even if another site was
  picked in the list.
- **Sign-in on the Exchange sites:** the page could hang on "Loading..." after signing in. It now goes to the
  site's home page after a few seconds, signed in.
- **Play on a map brings the game to the front**, and on TrackMania Original it starts the game if it is not running.
- **Horizon Client modules** switched on in the in-game menu show as on in the launcher.
- **Report a problem** now collects the Horizon Client logs of every install, crash files and the upload history,
  with keys and logins removed.
- Mods with one file per game install the right one; install folders are shown by their folder name.

Works best with **Horizon Client 0.3.3** (the launcher offers the update on the game page).

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
