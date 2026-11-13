# TM Horizon launcher (apps/launcher)

Part of the TM Horizon monorepo (see the root README). One launcher for every TrackMania: library, game pages with Play and profiles,
mod browser (real TMLoader data), TMX maps and ManiaPark skins inside the app, clips,
profiles, servers and events, community, and a mock of an in-game overlay.
A Windows app (Tauri 2, `src-tauri/`) around the same UI; in a normal browser the UI runs
as the clickable prototype (preview backend). Nothing is pushed or published.

## Native app (Tauri 2)

```
npm install                   # at the repo root (npm workspaces)
npx tauri dev                 # in apps/launcher: dev window (Vite on :5173)
npx tauri build               # src-tauri/target/release/tm-horizon.exe + bundle/nsis/TM Horizon_0.3.0-beta.1_x64-setup.exe
cd src-tauri && cargo test    # guards, argument building, SHA-256, TMLoader writes, packs, reports, presence
```

Rust is needed (`%USERPROFILE%\.cargo\bin`), the Tauri CLI is a local devDependency.
The NSIS setup installs per user (no admin) to `%LOCALAPPDATA%\TM Horizon`. It is not code-signed, so SmartScreen
shows "Windows protected your PC": More info, Run anyway. Install steps for all systems are in the root README.
`npm run build` keeps the preview-only art (TMX header contest banners, box covers); `npm run build:public`
(or `TMHUB_PUBLIC_BUILD=1` for `tauri build`) leaves it out, see `../../ART_CREDITS.md`.

The UI talks to `window.tmHubNative` (`src/data/native.ts`), which calls the Rust commands in
`src-tauri/src/commands.rs`. OS-specific code is in `src-tauri/src/platform/` (Windows; a Linux
stub, see [docs/linux.md](docs/linux.md)).

| Part | Where | What it does |
|---|---|---|
| Scan | `scan.rs` | Known folders, Steam (`libraryfolders.vdf`), Ubisoft Connect (registry `Launcher\Installs`), Epic manifests, the system's uninstall list, "Scan drives" (all fixed drives, skips Windows/ProgramData/AppData/system folders) and "Add folder". |
| Guard | `fsx.rs` | Nothing inside `Program Files (x86)\TrackMania Nations ESWC` (StarForce) is read, listed or started; no `dinput8.dll` is ever touched. Tested. |
| Launch | `launch.rs` | Argument building per game (table below), unit tested; Wine/umu runner wrapping for Linux. |
| Mods | `tmloader.rs`, `modindex.rs` | Index from TMLoader's servers, zip download, SHA-256 against the index, extraction into `database\TmForever\products\<Mod>\<version>\`, missing dependencies too, profile switch in `profiles\<name>.yaml` (same format TMLoader writes). Refused while TMLoader.exe, TmForever.exe or ShimRun.exe runs. Every replaced file is copied to `%LOCALAPPDATA%\com.tmhorizon.launcher\backups\<time>\` first. |
| Maps, Skins | `web.rs`, `maps.rs`, `skins.rs` | TMX and ManiaPark in a child webview (they forbid frames). `.Gbx` and ManiaPark zips are saved into the game's folders; the shelf below offers Play and Folder. Logins persist in its own WebView2 profile (`%LOCALAPPDATA%\com.tmhorizon.launcher\EmbeddedWeb`), "Sign out" in Settings clears it. |
| Add-ons | `addons.rs`, `ui/AddonsPanel.tsx` | Puzzle button in the embedded browser: curated browser add-ons from the catalog (category `browser-addon`). Installable ones come from the author's GitHub release (https, SHA-256 from GitHub's asset digest or a SHA256SUMS file), permissions are shown before install, files go to `%LOCALAPPDATA%\com.tmhorizon.launcher\BrowserAddons`, and they load into the embedded browser's WebView2 profile only (Windows; WebKitGTK has no add-on support). Updates from the same release feed. `TMHUB_ADDON_DEV=<id>=<folder>` allows installing a local build. |
| Clips | `clips.rs` | Videos in `Documents\TrackMania\Clips`, first-frame thumbnails, player, Show in folder. |
| Get | `gameinstall.rs` | Official setups only (TMNF, TMUF, ManiaPlanet), https or a known SHA-256 (TMUF), Authenticode with a Nadeo/Ubisoft signer check, hashed again right before running, the setup runs with its own UI (ShellExecuteEx, UAC); store pages for Trackmania and Turbo; ESWC: a note and the community folder with the unofficial 1.80 patch in the browser (never downloaded by the app); nothing for Original/Sunrise. |
| Presence | `discord.rs` | Discord status over the local IPC pipe, off without an application id (docs/discord-presence.md at the repo root), skipped when TMInterface is on. |
| Reports | `report.rs` | Logs of the profile's mods, newest crash logs, system summary; redacted, zipped to Desktop/Downloads. |
| Horizon Host | `horizonhost.rs`, `horizoncmds.rs`, `src/ui/HorizonHost.tsx` | In-game menu (docs/design/horizon-host.md). ESWC/Sunrise/Original: `dinput8.dll` + `horizon\` after a confirmed file list, any old `dinput8.dll` backed up with one-click put-back; plugins in `horizon\plugins\<id>\`; `horizon\profile.json` written before each start (safe mode = no plugins); newest `horizon\logs\*.log`. Forever: TMLoader product "Horizon Host" (experimental). Source: a local build folder (`dist`, SHA-256 from its `manifest.json`); GitHub releases later. Formats: `docs/profile-json-proposal.md`. |
| Packs | `packs.rs` | `tmhub://pack/<base64url(deflate(json))>` and `.tmhubpack`; checked against the user's TMLoader servers, installed with SHA-256, becomes a TMLoader profile (Forever) or a pack in TM Horizon's data. |
| TAS | `tas.rs` | TMInterface folders and plugins (detected, never created), ForeverTAS from its uninstall entry. |
| History | `history.rs`, `ui/History.tsx` | Before every write to a game or user folder (TMLoader installs, profiles, packs, catalog/ESWC mods, updates, rollbacks, Horizon Host, plugins, TMVS content, Openplanet plugins) the watched files are hashed and copied into `%LOCALAPPDATA%\com.tmhorizon.launcher\history\blobs\<sha256>`; afterwards the differences become one entry. Game page "History": Undo restores exactly, refuses when a file changed since or the game runs. Store capped at 2 GB, oldest entries expire first. Tested with temp folders. |
| Statistics | `stats.rs`, `pages/Stats.tsx` | Play time and sessions from the launcher's own tracking (`playsessions.json`), best times and saved runs from the player's own replays (gbx headers, TMX ghosts left out), Horizon Host events from `host-stats\<game>\*.jsonl` (docs/design/host-stats-channel.md). Game profile statistics are not used. |
| Media | `media.rs`, `pages/Media.tsx` | Screenshots, clips, TMVS photos and video exports of all games in one grid; delete goes to the recycle bin and only inside those folders. |
| Classics, consoles | `consoles.rs`, `classiccmds.rs`, `ui/Classics.tsx` | TrackMania (2003) found by its 32-bit `TrackMania.exe` (file version below 1.5; 1.5+ is Original), started directly, no mods or Horizon Client. TrackMania DS / Turbo (DS) in melonDS, TrackMania Wii / Build to Race in Dolphin: the emulator is an existing install (picked, or Dolphin's install folders and the program list) or downloaded on Play's card from the official release (Dolphin 2609b 7z from dl.dolphin-emu.org, SHA-256 pinned because Dolphin publishes none; melonDS 1.1 from GitHub, GitHub's digest) through `hosting::deps` into `<data>\emulators\`; Dolphin portable. The player's own dump is checked by its header (DS game code + header CRC; Wii game id in ISO/WBFS/RVZ/WIA/CISO/GCZ). Start: `Dolphin.exe -b -e <file> [-C Graphics.Settings.InternalResolution=n] [-C Graphics.Settings.HiresTextures=True]`, `melonDS.exe <file>`. Never downloads or links games. |
| Steam fix | `steamfix.rs`, `ui/Classics.tsx` | Steam installs of TMNF/TMUF only: `Distro=MILIN` in Nadeo.ini (backup `Nadeo.ini.horizon-backup` + History, undo), then Nadeo's update `TmUnitedForever_Update_2010-03-15_Setup.exe` from files2.trackmaniaforever.com after the click, size + SHA-256 checked, run with `/SILENT /SUPPRESSMSGBOXES /DIR="<game>"`. |
| Recommended | `suggest.rs`, `ui/Classics.tsx` | "Recommended for your game": Steam fix, TrackMania Highlands (TMUF; ZIP from ModDB found in Downloads or picked, checked against `zipInstall` in the catalog, unpacked with History/undo, programs refused), Horizon Client. Nothing ticked or installed by itself; each item can be hidden. |
| Setup | `ui/SetupWizard.tsx` | First-run wizard (fresh install only, `setupDone`), also Settings > Setup. |
| Links | `platform/windows.rs` | `tmhub://` under `HKCU\Software\Classes`, only when you agree (Home banner or Settings). |

Dev settings: `TMHUB_TMLOADER_DIR=<copy of TMLoader>` points every TMLoader read/write at a copy
(Settings shows "Sandbox"); `TMHUB_CLIPS_DIR` another clips folder. `TMHUB_DOCUMENTS_DIR` stands in for Documents, `TMHUB_NO_INSTALL_DIRS=1` keeps Statistics and Media out of game install folders; the updater test hooks are in docs/release.md. Tests against a copy:
`TMHUB_SANDBOX=<copy> TMHUB_NET_TESTS=1 cargo test`.

## Run

```
npm ci
npm run scan          # read-only scan of this PC -> src/generated/snapshot.json
npm run fetch-mods    # GET the TMLoader repository indexes -> src/generated/mods.json + public/mod-icons
npm run art           # Steam store art -> public/store-art, then trims logos and crops my screenshots
npm run hub-api       # copy packages/api/dist (servers, events, GitHub projects, mods with SHA-256) -> src/generated/hub
node tools/capture-tmx.mjs   # static captures of the TMX sites for the Maps page
npm run build && npm run preview   # http://localhost:4173
npm run shots         # Playwright screenshots at 1440x900 -> screens/ (preview must be running)
```

## What is real, what is sample

Real (from this PC or public sources):
- Library: installed titles (Program Files, Steam `libraryfolders.vdf` + `appmanifest_*.acf`,
  Ubisoft Connect folder, Epic manifests, ManiaPlanet `Documents\ManiaPlanet\Packs\*.Title.Pack.gbx`).
- The StarForce ESWC folder in Program Files is only checked for existence and listed as
  unsupported; `scanner/scan.mjs` refuses to read or list anything inside it.
- TMLoader profiles, installed mod versions and the program version, read from
  `%LOCALAPPDATA%\TMLoader` (read only).
- Mod browser: the 7 servers in TMLoader's `config.yaml` (`<server>/index.json`, api 1), icons,
  changelogs, dependencies; download size and date from a HEAD request on the latest zip.
  Products only in the local TMLoader database (100% TMX + Bingo, TMFOXR, Twinkie) are marked
  "Not on a server".
- Openplanet: `~/OpenplanetNext` found (no plugins), `~/Openplanet4` not found.
- Recent replays and maps from the Documents folders.
- Servers: 100 ManiaPlanet servers and 50 Trackmania club rooms from the hub data
  (ManiaPlanet web services, trackmania.io) and community-registered servers (issue form).
  Forever's sample rows show only while no Forever server is registered.
- Events: events.json from the hub data (Discord scheduled events, submitted events); samples
  only while there is no real event.
- Mod browser stats: GitHub stars and release downloads, SHA-256 of the latest zip (hub API).
  The Tools tab lists GitHub projects that are not TMLoader mods.

Sample (marked with a "Sample data" badge): news, events until real ones exist, Forever servers, communities,
Openplanet plugin tiles, profiles for non-Forever games, and in the browser preview the skin and
pack cards (the native app shows ManiaPark instead). The friends panel is gone: there is no
account system. Categories in
the mod browser are hand-picked (`MOD_CATEGORIES` in `src/data/catalog.ts`).

## Launching

Built in `src-tauri/src/launch.rs` (unit tested, never run during development):

| Game | Play | Open a downloaded map |
|---|---|---|
| Forever, TMLoader profile | `"%LOCALAPPDATA%\TMLoader\TMLoader.exe" run TmForever "<profile>"` | same + `"/file=<map>"` (the form the TMVS dev loop uses) |
| Forever, "No mods" | `TmForever.exe` from the game folder; Steam installs `steam://rungameid/11020` / `7200` | `TmForever.exe /useexedir /singleinst /file="<map>"` (the game's own `.Gbx` association) |
| Nations ESWC 1.80 | `TmNationsESWC.exe` (working dir = game folder). Settings switch: `TmNationsESWCLauncher.exe`, Nadeo's 2007 launcher that the desktop shortcut uses; it is a settings dialog (graphics, benchmark, dead online account pages) that then starts `TmNationsESWC.exe`. | none: saved to `GameData\Tracks\Challenges\Downloaded`, the game starts, "Find it under Downloaded" |
| ManiaPlanet titles | `ManiaPlanet.exe /title=<TitleId>` | `ManiaPlanet.exe /useexedir /singleinst /title=<TitleId> /file="<map>"` (`/title` + `/file` untested) |
| Trackmania (2020) | Ubisoft Connect `uplay://launch/5595/0` (id 5595 from `HKLM\...\Ubisoft\Launcher\Installs`), Steam `steam://rungameid/2225070`, Epic `com.epicgames.launcher://apps/<ns>%3A<item>%3A<app>?action=launch&silent=true` | `Trackmania.exe /useexedir /singleinst /file="<map>"` (untested, needs Ubisoft Connect) |
| Turbo, Original, Sunrise | store URL or exe | none |

TMLoader's command parser has `uri`, `admin`, `run`, `rundbg`, `register` (read from the exe);
`make_shortcut_on_desktop` writes `run <game> "<profile>"`, and the Lutris TMUF installer uses
the same `run TmForever <profile>`. Join links (sample events): Forever `/url=tmtp://...`,
ManiaPlanet `/url=maniaplanet://...` (not verified).

## Maps and skins inside the launcher

TMX (tmnf/tmuf.exchange, nations/original/sunrise.tm-exchange.com, tm/sm.mania.exchange,
trackmania.exchange) and ManiaPark send `X-Frame-Options: SAMEORIGIN`, so the native app shows
them in a child webview (in the browser preview: a static capture). Downloads are caught:

| Game | Maps / replays | ManiaPark skins, models | ManiaPark texture mods |
|---|---|---|---|
| Nations / United Forever | `Documents\TrackMania\Tracks\Challenges\Downloaded` (`Tracks\Replays\Downloaded`) | `Documents\TrackMania\Skins\Vehicles\CarCommon` | `Documents\TrackMania\Skins\<Env>\Mod` (Stadium unless the file names another environment) |
| Nations ESWC | `<game>\GameData\Tracks\Challenges\Downloaded` (its own data folder, profiles live there too) | - | - |
| ManiaPlanet titles | `Documents\ManiaPlanet\Maps\Downloaded` | `Documents\ManiaPlanet\Skins\Models\<StadiumCar/CanyonCar/ValleyCar/LagoonCar/ArenaPlayer>` | `Documents\ManiaPlanet\Skins\<Env>\Mod` |
| Trackmania (2020) | `Documents\Trackmania2020\Maps\Downloaded` if that folder exists, else `Documents\Trackmania\...` | `...\Skins\Models\CarSport` | `...\Skins\Stadium\Mod` (not confirmed) |

ManiaPark downloads are `https://maniapark.com/{skin|model|mod}/<id>/download` (zip). The Mania
Exchange API does not cover ManiaPark, so there is no native list; the embedded site is the store.
Other files go to the normal Downloads folder.

## Art sources

Covers (`library_600x900.jpg`), heroes (`library_hero.jpg`) and logos (`logo.png`) per Steam
app id, verified with `store.steampowered.com/api/appdetails`. TMNF (11020) and TMUF (7200)
were copied from the local Steam cache `Steam\appcache\librarycache\<appid>\`; the others
come from the Steam CDN (`shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/<appid>/`).
ESWC, Sunrise and Original have no Steam page: their covers are a box scan on archive.org
(Original) and the small Wikipedia infobox covers (ESWC, Sunrise; non-free, fair use there),
Sunrise's wide picture is a CC BY 4.0 screenshot by OrangeAedan on Wikimedia Commons. Each
file's source is listed in `src/generated/art.json`. These three must be cleared or replaced
before anything is published. News, event, skin and overlay pictures are my own screenshots
(`tools/make-assets.py`). Local build only.

## Layout

- `scanner/` Node scripts (scan, fetch-mods, fetch-art)
- `src/data/backend.ts` the interface the UI talks to (`window.tmHubNative`), `src/data/native.ts` its Tauri implementation
- `src-tauri/` the Rust side (commands, scanner, TMLoader, launch, embedded browser), `docs/linux.md` the Linux plan
- `src/data/model.ts` view model, `src/data/sample.ts` all sample data
- `src/pages/` one file per page, `src/ui/` shell and shared parts
