# Changelog

## 0.5.2 "Launcher Preview" (2026-11-13)

Windows, plus Linux experimental (AppImage built on Ubuntu 22.04, Arch package), built with
`TMHUB_RELEASE_PREVIEW=1`. Release text: `docs/release/notes-0.5.2.md`.

- Linux (experimental): `latest.json` has a `linux-x86_64` entry for the signed AppImage, so the AppImage
  updates itself from inside the app (.deb, .rpm and the Arch package update through the package manager).
- Cpu/Gpu synchro (the game's GpuSync, default Immediate) on the Performance card and as a recommendation on every
  D3D9 game page: "Set 1 Frame" with backup and Undo, or the game's launcher where the file is not writable.
  Measured on TMNF with TM Vibrant Shaders: 50-70 FPS at Immediate, 90-105 FPS at 1 Frame.
- DXVK and skid marks in a Program Files game folder: one UAC prompt copies only the verified files
  (`elevate.rs`); the launcher itself stays unelevated.
- An open TMLoader window or tray icon no longer counts as a running game (DXVK, config, replays, Play state).
- TMNF/TMUF: "Start with the game's launcher" (TmForeverLauncher.exe), like ESWC.
- Performance card in the app's card and control style; Original gets the Cpu/Gpu synchro card; a line points to
  the in-game Smoothing switches of Horizon Performance.
- Skid marks show a game file that is already Clean as "Clean (game folder)" instead of "Classic".
- Servers: the ESWC master line says "Master server lists none · n known servers below" instead of "0 servers".
- Live servers: "Online only" on by default and remembered. Statistics: large play time as hours only.
- Communities: own 100% TMX / TM Horizon entry pinned for all five D3D9 games, all Discord invites refreshed.

## 0.5.1 "Launcher Preview" (2026-11-13)

Windows only, built with `TMHUB_RELEASE_PREVIEW=1`. Release text: `docs/release/notes-0.5.1.md`.

- Statistics and play time for every copy of a game (`copies.rs`): replays of all installs and instances, copy
  filter, play time from one watcher thread that also counts games started outside the launcher. Map table:
  "No respawns" filter, sort by respawns, map pictures from the own .Gbx or TMX through the hub image proxy.
- Openplanet plugins: Install, Update, Remove (only `<identifier>.op`, only from `cdn.openplanet.dev`) on the Mods
  list, plugin page, game page and "More projects"; undo entries in History.
- Map details (`packages/map-inspector`, `pages/MapDetails.tsx`, `mapinspect.rs`): local .Gbx offline, medals,
  checkpoints, blocks, 3D, top-down, height and build order. Reached from Map tools, the Maps shelf and the
  Statistics map rows.
- Installed skins & mods (`skinlib.rs`): ManiaPark downloads per game, On/Off, Remove to the recycle bin.
- Skid marks without admin: the TMLoader product "Skid Marks" (experimental; the game-file switch stays as fallback).
- .Gbx open-with (opt-in, `fileassoc.rs`, `gbxopen.rs`): per-user ProgID, copy picker, the old default put back
  when switched off.
- Horizon Client for TMNF/TMUF from the GitHub release (TMLoader product "Horizon Host"), checked against
  `manifest.json` and `SHA256SUMS.txt`; the Forever card reads status and updates from the manifest only.
- Game pages: "More projects" from the hub's link-only GitHub list (`/v1/github-projects`).
- Launcher updates: checks every 6 h, title bar pill, automatic install on close or at the next start (never
  while a game runs), "What's new" sheet, TM Horizon's own news pinned on the News page.
- Start screen until the app has painted; Discord "In TM Horizon" while only the launcher is open.
- Legacy Essentials: copy picker, never for StarForce copies or copies with Horizon Client, dinput8.dll only
  when the hub index names it. Versions 1.3.0 and 1.3.1 recognised by the DLL's SHA-256; release assets named
  `legacy-essentials-*` are accepted next to `eswc-autosave-*`.
- One control height per toolbar (`styles-controls.css`): buttons, selects, segmented toggles and chips in a page
  or section bar share `--bar-h`; `tools/shoot-051c.mjs` lists rows with mixed heights on every page.
- Statistics: the games' own campaign maps (author Nadeo) carry a "Campaign" badge; ManiaPlanet and Trackmania
  maps get their pictures and links from Mania Exchange / Trackmania Exchange; TMNF/TMUF play time from before
  TM Horizon comes from the game's own profile counter (chunk 0x0308C05F, only the player's own profiles).
- Server list: all servers asked at once (32 at a time, 1.5 s connect and 2.5 s answer), rows appear as servers
  answer, the last good answers show at once from disk; 94 servers in 3 s instead of 28 s.
- Own server, 100% TMX: the card names the real map modes, presets with readable names.

## 0.5.0 "Launcher Preview" (2026-11-12)

First public release, Windows only, published on GitHub and Discord. Built with `TMHUB_RELEASE_PREVIEW=1`.

- Release mode: no feature needs the TM Horizon Hub or my servers. Sign-in, claims, uploads to the hub, server
  registration, the reachability test and the public server list, event and server submission, the hub source
  and hub address settings are hidden; the Rust side refuses hub addresses and never calls them, the old hub data
  refresh and update check are off. Every host the build can contact: `docs/release/outbound-hosts.md`.
- Catalog filtered by licence in public builds (`packages/catalog/release-policy.json`): 17 Discord-only mods,
  8 mods from Google Drive / Yandex / archive.org shares without a licence and 5 GitHub entries without a licence
  are hidden; NewSnowCar and OpenAL 3D Audio are link-only; the Transformation Pack showcase (pictures without
  permission) is not used. Bundled logos of third-party mods and the Exchange screenshots are left out (the mods'
  own server icons are used). Openplanet plugins are linked, not downloaded.
- Horizon Client 0.3.0 on Nations/United Forever: its `settings`, `logs` and `data` folders next to the version
  folders were taken for versions ("settings" sorted last), so the card showed "No modules installed or available
  yet". Version folders now need their description.yaml; settings and logs are read where 0.3.0 writes them; the
  in-game menu's switch decides when TM Horizon has no own choice. "Applies from the next start" only shows for
  clients before 0.3.0 or modules marked `startup_only`.
- Settings > About: privacy note (no account, no telemetry, nothing sent to me, which services see your IP),
  trademark line, contact through GitHub issues (English, German, Polish, French).
- Updater: public key in `tauri.conf.json`, endpoint `releases/latest/download/latest.json` of cheatoskar/tm-horizon.
- Home: Play starts the game at once with the selected profile; the chevron next to it shows profile, installation
  and warnings first (the "Start directly from Home" setting is gone).
- Server hosting: busy default ports (the running game holds 2350/3450/5000) move the server to the next free set
  and the card says so; router ports are mapped before the server starts, the result (or the exact error) is shown,
  a failed mapping falls back to the server's own UPnP and is removed again when the start fails; a server found
  running after a launcher restart shows its renewed mapping; the firewall row says when the rules are missing.
- Pictures from the disk cache appear at once (no skeleton, no fade); only real downloads fade in.
- Site switcher: the bundled site icon first, the fetched one only for sites without it, .ico converted to PNG in
  the backend, and a fallback at every step.
- ManiaPlanet titles without their title pack: one hint card with Folder and Scan instead of the same text twice.
- No sample data in public builds (Profiles footer, Skins preview cards, overlay prototype, the host's example
  plugin); the build fails if sample strings end up in the bundle.
- Install dialogs: games a mod supports but that are not installed are shown greyed with "Not installed"; the
  download dialog says why a target is fixed.
- Spacing between text and buttons in emulator, classic and hint cards.
- Module icons: the Distinct set is the default (Saturn stays selectable; only a stored Saturn choice keeps it).
- Skid marks Classic/Clean switch for Nations and United Forever (merged from `skidmarks`).
- Openplanet counts as installed when Openplanet.dll is next to the game exe (the user folder only appears after
  the first start); the Mods card says "Installed" per game and leaves the top of "Installable first".
- Back on mod pages returns to the page you came from (with its scroll position); Mods only without one.
- TMX Play on tmnf/tmuf.exchange while the game runs: the site's own trackplay link goes to the running game.
- Scan drives: a folder counts only with the game's data next to the exe (GameData, or Packs for ManiaPlanet and
  Trackmania); exe-only folders (extracted patches, copies) are no longer listed, also from earlier scans.
- ESWC Autosave: the released DLL (no version resource) is recognised by its SHA-256, so 1.1.0 shows as current
  instead of an endless Update; an unknown build offers Reinstall.
- Get dialog: game picture on top, one full-width row per source (store, official download, community folder)
  with a short subtitle, same layout for every game; Trackmania Turbo also lists Ubisoft Connect.
- Add folder starts in the last added folder, else in C:\Program Files (x86).
- Installations: Hide per folder (remembered), "Hidden (n)" shows them again.
- New app icon D6a (centred Saturn): with TM from 64 px up (exe, installer, shortcuts), without TM at 48 px and
  below and inside the launcher.
- TrackMania Wii cover from GameTDB, TrackMania Turbo (DS) cover from IGDB (loaded once and kept, credited in Settings).
- Nations ESWC background: my own screenshot, now also in public builds.
- Horizon Client pairing: a game that was allowed once is accepted again without a new Allow (also when it lost
  its key); Remove in Settings ends it.
- Catalog release check (packages/catalog/check-release.mjs) runs in every public build.
- Name: the program is tm-horizon.exe and its data folders com.tmhorizon.launcher; the first start moves the old
  app.tmhub.launcher folders (settings, backups, instances, browser logins) and repoints the server autostart task
  and tmhub:// links. The installer closes and removes an old tm-hub.exe and repoints the shortcuts.
- Installer: installs over an older or the same version without uninstalling (data stays), asks once before a
  downgrade; finish button Fertigstellen / Finish / Terminer / Zakończ with "Start TM Horizon"; French and Polish.
- First start finds copies in Games folders (home, Documents, drive roots; two levels, exe plus game data), so
  Sunrise, Original and ESWC copies show up without a drive scan. The personal ESWC path is gone.
- Auto-upload also watches GameData\Tracks\Replays\My Replays (ESWC Autosave 1.2.0 saves Sunrise/Original bests there).
- Nations ESWC "Get": no link to patched exes; not sold anymore, Add folder.
- Mod list from the production hub's signed index on hub.tm-horizon.com (on by default in this build, checked with
  the pinned key, cached, every 6 h). With at least one project the index is the list (the bundled catalog fills
  fields for the ids it names); empty, invalid or offline: the bundled catalog. Settings > About says so.
  Withdrawn ids stay hidden, entries without a bundled match use the index's own catalog entry, browser add-ons
  never get a game install from the index (tested against the production index, seq 18).
- Catalog audit: 28 dead entries removed, 10 duplicates merged into their main entry, 16 Discord-only mods hidden,
  new addresses for GBX Explorer, TrackMania Hub and the MX API docs, Linesight is a Nations Forever tool,
  Ultimate Medals and RMC are mods.
- ManiaPlanet titles not added yet: one hint card with Open ManiaPlanet (starts it without a title; the page
  scans again when it closes) and Scan.
- Map tools: gbx.tools was only a placeholder page; the switcher now lists GBX Explorer, the 3D viewer,
  Revalidate and Nations Converter (subdomains of gbx.tools).
- Horizon Client releases are read from cheatoskar/horizon-client (the old repository name never existed on
  GitHub); without a release the switch says so instead of doing nothing.

## 0.4.0 release candidates (test builds, not published; all of it is in 0.5.0)

- 0.4.0-rc.4 (feedback on rc.3):
  - Statistics redesigned: one tile per game on its cover (click filters the page), a year calendar of saved runs or
    play time, runs and new bests per month next to play time per day or week, the most played maps with their TMX
    picture (click opens the map on TMX), the map table. Map names taken from file names lose the driver suffix
    (`Dirt cut track_cheatoskar`). The replay reader no longer runs at launcher start before Statistics was opened
    once; it uses one thread (two on 8+ cores), pauses between files, and remembers folder listings (a folder is
    listed again only when it changed; Reload lists everything).
  - Horizon Host is called Horizon Client everywhere players see it (TMLoader shows "Horizon Client"; its folder stays
    "Horizon Host"). The Horizon modules view starts with the client's logo, text and menu pictures.
  - TMX Play on Nations ESWC and Sunrise: the map is saved under Downloaded and a running game with Horizon Client
    opens it from its main menu (bridge event play_map); a running game without it is never started twice; Original
    saves and says where. The Play button on the exchanges looks like the site's own buttons and says "Play in TM
    Horizon".
  - Site switcher on the Maps page: every site once, in Exchanges, Tools, Community and skins; sites for several games
    get game chips. GBX tools and Map Inspector have own icons when the site gives none; a site without an icon is
    asked again after a week, not on every start.
  - Signing in on an embedded site reloads pages of that site family that were loaded before (no manual reload).
  - All toolbars (servers, news, mods) use one control height; the Maps browser bar has one height too.
  - TM Vibrant Shaders page: the black hole loop picture as cover, the rain pictures in, older comparisons and the old
    menu out; the README picture strip is left out when a showcase has its own gallery.
  - "Recommended for your game" hides what is done already: Highlands in the TMUF folder (or installed through TM
    Horizon), Horizon Client on for the game or profile, the Steam fix applied.
  - Horizon Client card on the game page in one row with an on/off switch; modules and "Advanced" fold out. Module
    switches react at once (the save runs in the background and springs back on an error). Slow commands (folder
    scans, hashing, downloads, dialogs) no longer hold the launcher's command threads.
  - Module icons: our Saturn set (default) or a distinct set (Settings, Look).
  - TrackMania Highlands: TM Horizon checks TmHighlands.zip from ModDB (size, MD5, SHA-256), shows its readme and
    credits, checks free space, unpacks only GameData and keeps the two game files it replaces (Undo restores them).
    Highlands is detected by its environment collection and car (also after the official installer) and can be switched
    off and on without uninstalling.
  - TrackMania Original: TMORIGINAL.EXE names the folder (no second entry for a TrackMania.exe beside it); the Online
    Patch v2 exe is the one Horizon Client supports, other Original exes are play-only; TMX Play sends the map to a
    running Original with Horizon Client too.
  - Picture cache (covers, thumbnails, icons): at most 300 MB, least recently used out first; pictures older than 30
    days are fetched again in the background; Settings shows the size with a Clear button.
  - The Autosave module is called "Autosave & Login-Fix" on the game page card, in the Horizon modules list and in
    messages, also when an older client install still says "ESWC Autosave". TM Horizon's own TMLoader product shows as
    "Horizon Client" with the client logo in the Mods list, also for older installs named "Horizon Host".
  - Website: TM Vibrant Shaders, TMFOXR and Twinkie pages with their showcase pictures (TMVS: the catalog's ten pictures,
    my four photos first, also in the Gallery tab), Horizon Client name and icon, TrackMania DS, Turbo (DS) and Wii game
    pages, download badges.
- Media page no longer freezes the launcher with many screenshots: the grid shows small JPEG previews made in a
  background thread (cached under the app's cache folder, cleaned when files go, 300 MB cap) instead of the 11 MB
  TMVS BMPs, and only the rows near the view are drawn. BMP and TGA open in the viewer as a JPEG copy (TGA had no
  preview before). Each section says which key or mod makes the files, with a link to TM Vibrant Shaders and to the
  clip setup.
- 0.4.0-rc.3: classic and console games. TrackMania (2003) is found and started directly (no mods, card says why);
  TrackMania Turbo also in Ubisoft Connect folders; TrackMania DS / Turbo (DS) in melonDS and TrackMania Wii / Build to
  Race in Dolphin (emulator picked, found or downloaded on demand with a pinned checksum; your own dump, never a ROM
  download, with a step-by-step dump guide). Steam fix for Steam TMNF/TMUF (Nadeo.ini with backup and undo, Nadeo's
  2010 update checked and run). "Recommended for your game" (Steam fix, TrackMania Highlands ZIP, Horizon Client;
  nothing installed by itself). TrackMania United hint on the TMUF page and in the wizard.
- Server hosting after the first LAN test: only real maps (name and GBX class checked; replays never become server
  maps, old server.json cleaned with a backup), maps without author time marked "Nicht validiert", new map step with
  sources and server list side by side, TMX map/pack import into the server's own folder, recent players with their
  last nickname, and a console tab for a running server (players kick/ban/spectator, chat, next/restart/jump, time
  limit, live log).
- User agent everywhere `TM-Horizon/<version> (+https://tm-horizon.com)`; privacy pages and the third-party API page say so.
- Statistics, replay archive search and the TMX folder upload read TMNF/TMUF replays again: most of them carry the old
  class id 0x2407E000 in the file header and were skipped (statistics showed almost nothing for Forever). The header
  cache is rebuilt once (version 4).
- Website: new launcher pictures in the home carousel (English and German), taken from rc.3.

- 0.4.0-rc.2 fixes: the game strip on the dashboard shows covers for ESWC, Sunrise and Original (cropped box art);
  the news date chips are as tall as the search field; the Servers button is one control height; sidebar labels over the
  embedded TMX page are drawn in a small native tooltip window (the page no longer shifts); TMX "Play" says where the
  map is when the game has no /file switch.
- Statistics: replay headers are cached on disk (path, size, time; versioned, corruption-safe) and read in a background
  thread (low priority, started after the launcher is up); the page shows cached numbers at once with an "updating" line.
  A game selector with "All games" (the same run in several folders counts once), TrackMania format codes in map names,
  a source line per section, 30/90-day play time, runs and new bests per month, most-run maps. Your own replays are
  found by the autosaves' logins and by the dominant driver login (before, replays saved under another login than the
  autosaves' counted as foreign: mostly 0).
- Horizon Client card: modules and mods are listed separately (modules = the ten built into the client, rule in
  packages/shared/src/horizon.ts), the folder is named, the source is one small line, no greyed "Clips"/"Randomizer"
  rows; TMX upload settings are linked from the Maps page and the card.
- Showcase pages for mods: an author designs a page from blocks (hero, feature grid, gallery, before/after slider, video,
  text, compatibility, hotkeys, latest changes, FAQ, buttons) with an accent colour. It shows above the usual sections of
  the mod page in the launcher and on the website; no showcase, same page as before. From `showcase.json` in the
  repository (or `showcase` in `plugin.json`) or from the Showcase tab of the dev portal with a live preview. No HTML or
  scripts from authors; videos load only after a click. Examples: TM Vibrant Shaders, 100 TMX Bingo Plugin, ESWC Autosave.
  See docs/hub/showcase.md.
- Related links per mod ("Dazu gehört"): companion page, docs, Discord, source, website on the mod page (companion first,
  as a big button). Installed mods with a companion page get an "Open <label>" button on the game page, in the embedded
  browser when the site is one it lists. Field `links` in the catalog, `links.related` in the hub (portal form, API,
  import from `plugin.json`). See docs/hub/related-links.md.
- TM Vibrant Shaders page: tabs Presets, Looks and Packs. Built-in presets with their pictures plus a community list
  (a GitHub repository or a folder on this PC): install with SHA-256 and content checks, remove only what TM Horizon
  installed, check a share code, prepare a GitHub issue to share a preset. See docs/hub/tmvs-content.md.
- Portal: importing a repository with several release files needs a choice (also checked on the server); a repository
  that already is a hub project (catalog entry) offers "Claim this project" instead of creating a second one.

- TMX replay auto-upload (off by default): per-game switch "Upload new personal bests to TMX" in Settings.
  TMNF/TMUF finishes come from the 100% TMX mod (Allow in the game once), ESWC/Sunrise/Original replays from
  the replay folder and Horizon Host. Uploads run in a hidden page of the embedded browser with the TMX login
  there; no password or cookie leaves it. Queue with retries, history with links, "Upload replay…" by hand.
  The TMX Universal Track Downloader extension hands over to TM Horizon while this is on, so nothing is
  uploaded twice. See docs/design/tmx-autoupload.md.

## 0.3.0-beta.1

First public beta. The launcher was local only before; this is the first build I publish.
Not code-signed on Windows yet (SmartScreen: More info, Run anyway), see the README.

### Launcher

- I renamed the app to TM Horizon and gave it a new logo, a Game/TAS switch and a light theme.
- Home follows the game I picked; Play opens its start panel first. Home shows Discord communities, live
  servers and upcoming events of that game.
- News page with exchange news, mod releases and recording cards. Mod pages render the README as Markdown and
  show GitHub releases.
- Pages are fluid and full width, images show a skeleton and retry, and a page error shows a message instead of
  a black window.
- Settings: game shown at start, start directly from Home (off by default), language, theme.
- Separate installations per profile: hard-linked game folders with copy-on-write.
- Drive scan starts with the known game places, shows a count and can be cancelled; "Add game" is on Library.

### Mods

- One mod list with install types (TMLoader products, plain files, TMInterface plugins and scripts, ESWC proxy
  DLLs), fuzzy search, sorts, collections and icons.
- Installer for catalog mods with backups and restore; missing requirements (TMUnlimiter, CoreMod, ...) are
  installed and ticked in the chosen profiles. "Install into" picks the profiles a new mod is switched on in.
- Updates for mods installed outside TMLoader (install records, GitHub checks), Update all, auto-update and
  rollback, warnings about file conflicts.
- Guided TMLoader setup: the official installer link is read from tomashu.dev and downloaded from his hosts
  only, after I agree.
- `tmhub://install` and mod links open the catalog entry; ESWC Autosave on the ESWC page.

### Hub

- TM Horizon Hub as a data source: signed index checked in Rust, hub badge on entries, revoked versions are
  never updated and a banner offers Remove.
- Server for the hub and a developer portal (projects, import, editor, account, public page) with upload checks,
  moderation and a statement of reasons for suspended accounts. Not deployed yet.
- TMNF/TMUF master server client in `packages/tmf-master` (no live requests yet).
- Exchange event posts show up as events on Servers and Home.

### Linux

- Linux platform layer: Wine and Proton prefixes, Steam game exes in their own Proton prefix, self-update for
  the AppImage.
- Packages: AppImage, .deb, .rpm and two PKGBUILDs (`packaging/arch/`).
- Website with a download page and the new branding.

### Safety

- Nothing inside the ESWC StarForce folder is opened or started and no `dinput8.dll` is touched; ESWC proxy-DLL
  mods are installed with backups.
- Every replaced file is backed up first; downloads are https only and checked against SHA-256.
- Hub installs record the real version; the hub server blocks private-range and redirecting URLs (SSRF) and
  uses a strict CSP.
- The public build leaves out art I may not ship (TMX header contest banners, box covers, ESWC hero).

### Added in the last round

- Mods: the list sorts "Installable first" by default (Openplanet on top, then what TM Horizon installs itself,
  "open page only" last). Every card opens a mod page, also catalog mods and Openplanet plugins.
- Always Official installs as a TMLoader mod: TM Horizon also reads BigBang1112's TMLoader server. The standalone
  build stays an option on its page, which shows which type is installed.
- ESWC Autosave installs and updates from its mod page through the ESWC dialog (confirmation, backup); an
  existing install is recognised.
- Openplanet for Trackmania (2020) and ManiaPlanet: detection with version, update hint, and a guided install with
  the official installer from openplanet.dev after I agree. Plugin installs offer Openplanet first. Plugins are
  now looked for in the right folder (user profile, not Documents).
- News: one filter per game, mod releases sorted to the games they work with, an honest empty state.
- Maps: "Play in <game>" buttons on the TM-Exchange sites in the embedded browser; map tools (100tmx Map Inspector,
  gbx.tools) and a file info card for local .Gbx files.
- Separate installations of Forever can start with a TMLoader profile through their own TMLoader copy (not tested
  with a real start yet).
- Servers: the TMNF/TMUF list can come from the hub (`/tmf/servers`, off unless the hub turns it on).
- Hub: Discord-only mods can be claimed with a Discord login once their poster's id is known.
- Catalog: TrackMania Highlands (download link still missing) and an Environments collection; TM Clips no longer
  shows the TMVS repository's stars as its own.
- `docs/legal/permissions.md`: every third party I use, with licence status and whom to ask before a release.
