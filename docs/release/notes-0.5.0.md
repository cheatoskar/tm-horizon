# TM Horizon 0.5.0 – Launcher Preview

One launcher for every TrackMania game on Windows. This is a preview: things will break, please report them
in the GitHub issues.

## Install

Download `TM-Horizon_0.5.0_x64-setup.exe` below and run it (no admin needed). The installer is not code-signed:
SmartScreen shows "Windows protected your PC", click "More info", then "Run anyway". Check the download against
the `.sha256` file if you like. Later updates install from inside the app (Settings > Updates).

## What it does

**All games**
- Library of the TrackMania games on your PC (Steam, Ubisoft Connect, Epic, own folders, drive scan), game pages,
  Play with one click.
- Mods page: TMLoader mods, mods from their authors' GitHub releases, Openplanet plugins (linked), browser add-on.
- Maps and skins: the Exchange sites and ManiaPark inside the app; downloads go straight into the game folders.
- News from the Exchange sites and mod releases, statistics from your own replays, clips and screenshots.
- Server list with players and maps, read from the servers themselves.

**Nations Forever / United Forever**
- TMLoader profiles: create, switch and start them; install mods from the TMLoader servers with their checksums.
- Horizon Client (experimental): in-game menu with modules, as a TMLoader mod.
- Steam fix for United Forever, TrackMania Highlands from ModDB (you download it, the launcher installs it).
- Your own dedicated server: ports, router (UPnP), firewall rule, console with players, chat and maps.

**Nations ESWC, Sunrise, Original**
- Horizon Client: in-game menu and modules (autosave and login fix, input display, TMX browser, WR hunter,
  scripts, performance) for games that never had mods.
- Play maps from the Exchange sites directly in the game.

**TrackMania² / ShootMania, Trackmania (2020), Turbo**
- Start through ManiaPlanet title packs or the store, Openplanet setup with the official installer.

**TrackMania (2003), Wii, DS**
- Where to get them, emulator setup for your own copies.

Horizon Client installs from its GitHub releases (github.com/cheatoskar/horizon-client) once a release is
published there; until then its switch says "No release published yet".

## Privacy

No account and no telemetry. TM Horizon loads the mod list from tm-horizon.com (the hub's signed index); that
server sees your IP address. Apart from that it only talks to the services you use through it
(GitHub, the Exchange sites, ManiaPark, Openplanet, the TMLoader mod servers, Steam/IGDB covers, Nadeo's download
servers, the game servers in your list); like any website they see your IP address.

Not affiliated with Ubisoft or Nadeo. TrackMania is a trademark of Ubisoft.

Built with Claude Code as a tool.
