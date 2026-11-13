# TM Horizon 0.5.2 – Launcher Preview

One launcher for every TrackMania game on Windows, and experimentally on Linux. This is a preview: things will
break, please report them in the GitHub issues.

## Install

**Windows:** download `TM-Horizon_0.5.2_x64-setup.exe` below and run it (no admin needed). The installer is not
code-signed: SmartScreen shows "Windows protected your PC", click "More info", then "Run anyway". Check the download
against `SHA256SUMS` if you like. If you already have 0.5.0 or 0.5.1, the app updates itself (Settings > Updates).

**Linux (experimental):** download `TM-Horizon_0.5.2_linux-x86_64-experimental.AppImage`, check it against
`SHA256SUMS-linux`, make it executable and start it. Needs glibc 2.35 or newer (Ubuntu 22.04 and newer, Fedora,
current Arch). Arch Linux: `tm-horizon-0.5.2-1-x86_64-experimental.pkg.tar.zst` (`sudo pacman -U <file>`). The
games run through Wine or Proton. Not tested on real Linux hardware yet, only in WSL.

## New in 0.5.2

- Cpu/Gpu synchro: the older games (Nations/United Forever, ESWC, Sunrise, Original) ship with "Immediate", which
  makes the CPU wait for the graphics card every frame. The game page now recommends "1 Frame" and sets it with one
  click (backup and Undo included). Measured on Nations Forever with TM Vibrant Shaders: 50-70 FPS at Immediate,
  90-105 FPS at 1 Frame. The setting is also on the Performance card.
- DXVK and skid marks also work when the game is in Program Files: Windows asks once for admin rights to copy the
  checked files. TM Horizon itself keeps running without admin rights.
- Nations/United Forever: "Start with the game's launcher" (TmForeverLauncher.exe), like ESWC.
- An open TMLoader window or tray icon no longer counts as a running game, so DXVK, settings and Play are no
  longer blocked by it.
- Performance card redesigned in the app's usual card and control style; Original gets the Cpu/Gpu synchro
  setting too, and a line points to the Smoothing switches of the Horizon Client.
- Live servers: "Online only" is on by default and remembered.
- Communities: the 100% TMX / TM Horizon Discord is pinned on the pages of the five older games, and many more
  community entries show their icon.
- Servers: the ESWC master server line no longer reads as "0 servers" when known servers are listed below it.
- Skid marks: a game file that is already clean shows as "Clean (game folder)" instead of "Classic".
- Statistics: large play times show as hours only, the exact value is in the tooltip.
- Linux (experimental): the AppImage now updates itself from inside the app, signed with the same key as the
  Windows build. The Arch package updates through pacman.

## What it does

**All games**
- Library of the TrackMania games on your PC (Steam, Ubisoft Connect, Epic, own folders, drive scan), game pages,
  Play with one click.
- Mods page: TMLoader mods, mods from their authors' GitHub releases, Openplanet plugins, browser add-on.
- Maps and skins: the Exchange sites and ManiaPark inside the app; downloads go straight into the game folders.
- News from the Exchange sites and mod releases, statistics from your own replays, clips and screenshots.
- Server list with players and maps, read from the servers themselves.

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
