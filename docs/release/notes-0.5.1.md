# TM Horizon 0.5.1 – Launcher Preview

One launcher for every TrackMania game on Windows. This is a preview: things will break, please report them
in the GitHub issues.

## Install

Download `TM-Horizon_0.5.1_x64-setup.exe` below and run it (no admin needed). The installer is not code-signed:
SmartScreen shows "Windows protected your PC", click "More info", then "Run anyway". Check the download against
`SHA256SUMS` if you like. Later updates install from inside the app (Settings > Updates).

## New in 0.5.1

- Statistics cover every copy of a game (Steam, Ubisoft, own folders, instances), with a filter per copy. Play
  time now also counts games you start without the launcher, as long as TM Horizon is open.
- Map table: "No respawns" filter, map pictures, also for campaign maps and ManiaPlanet maps; campaign maps are
  marked as such.
- Nations/United Forever: the play time the game counted in your profiles before TM Horizon is shown on the game
  tile.
- Server list: much faster, servers show up as they answer, the last list appears right away.
- Openplanet plugins: Install, Update and Remove with one click on the Mods page, the plugin page and the game page.
- Map details: open a map .Gbx offline and see medals, checkpoints, the block list, a 3D view and the build order.
  From Map tools, your downloaded maps and the Statistics table.
- Installed skins & mods: what ManiaPark put into your game folders, with On/Off and Remove.
- Skid marks on Nations/United Forever without admin rights: the clean marks come as a TMLoader product, the game
  folder stays as it is (experimental).
- Open .Gbx files with TM Horizon (off by default, in Settings): a double-click asks which copy of the game to start.
- Horizon Client for Nations/United Forever installs straight from its GitHub release.
- Game pages: "More projects" with other community projects for that game.
- Launcher updates install themselves (when you close it or at the next start, never while a game runs), with an
  update button in the title bar and a "What's new" note afterwards.
- New start screen while the launcher loads.
- Discord shows "In TM Horizon" while the launcher is open.
- Legacy Essentials is only offered for copies that do not have the Horizon Client.

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
covers and map pictures through its image proxy from tm-horizon.com; that server sees your IP address. Apart from that it only talks to the services you use through it
(GitHub, the Exchange sites, ManiaPark, Openplanet, the TMLoader mod servers, Steam/IGDB covers, Nadeo's download
servers, the game servers in your list); like any website they see your IP address.

Not affiliated with Ubisoft or Nadeo. TrackMania is a trademark of Ubisoft.

Built with Claude Code as a tool.
