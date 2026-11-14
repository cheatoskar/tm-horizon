# TM Horizon 0.5.3 – Launcher Preview

One launcher for every TrackMania game on Windows, and experimentally on Linux. This is a preview: things will
break, please report them in the GitHub issues.

## Install

**Windows:** download `TM-Horizon_0.5.3_x64-setup.exe` below and run it (no admin needed). The installer is not
code-signed: SmartScreen shows "Windows protected your PC", click "More info", then "Run anyway". Check the download
against `SHA256SUMS` if you like. If you already have 0.5.0, 0.5.1 or 0.5.2, the app updates itself (Settings > Updates).

**Linux (experimental):** download `TM-Horizon_0.5.3_linux-x86_64-experimental.AppImage`, check it against
`SHA256SUMS-linux`, make it executable and start it. Needs glibc 2.35 or newer (Ubuntu 22.04 and newer, Fedora,
current Arch). Arch Linux: `tm-horizon-0.5.3-1-x86_64-experimental.pkg.tar.zst` (`sudo pacman -U <file>`). The
games run through Wine or Proton. Not tested on real Linux hardware yet, only in WSL.

## New in 0.5.3

- Joining a Nations/United Forever server with a TMLoader profile works in one click. With the game already
  running, the server goes to that game; no second copy starts. With the game closed, TMLoader starts it and
  TM Horizon sends the server once the game is ready ("Joining when the game is ready", with "Join now" and
  "Cancel"). Before, the join came right at start, before the game was logged in, and the game said it could not
  connect.
- United servers are offered for United Forever only; with only Nations Forever installed the Join button says why
  it is off.
- Game page: the Performance card is in the main column now, so the right column is no longer twice as long as
  the left one.
- Servers page: room above the Events section. ESWC servers in the server list show players and mode as soon as
  the server list has live data for them.
- Legacy Essentials installs from its renamed repository (cheatoskar/legacy-essentials).

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
