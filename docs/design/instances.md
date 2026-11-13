# Separate installations per profile (instances)

A profile can get its own game folder, like an instance in Modrinth: file mods (textures, sounds,
menus) go into that folder only, and the game keeps its user data (settings, replays, tracks) in a
user folder of its own. The original game stays as it is.

Code: `apps/launcher/src-tauri/src/instances.rs` (Rust, with tests), `src/ui/Instances.tsx`
(dialog and panel), `src/pages/Profiles.tsx`, `src/ui/CatalogInstall.tsx`.

## How it works

- **Where:** `%LOCALAPPDATA%\com.tmhorizon.launcher\instances\<id>\` (TM Horizon's data folder), list in
  `instances.json` next to it. Nothing is ever written into the original game folder.
- **Building the folder:** every file of the original is either
  - a **hard link** (NTFS): big files that games only read (packs, exe, dll, music). A hard link is
    the same file under a second name, so it takes no extra space;
  - a **real copy**: files under 64 KB, files games or mods write (`ini cfg txt log xml json yaml
    cache dat sav bak tmp sffs`), and for ESWC the folders `GameData\Profiles`, `Tracks`, `Scores`,
    `Cache`, `Races` (ESWC keeps its user data in the game folder).
  - `dinput8.dll` is never listed, linked or copied (fsx), so an ESWC instance starts without the
    proxy DLL. The StarForce folder `Program Files (x86)\TrackMania Nations ESWC` is refused.
  - Symbolic links and junctions in the original are skipped, not followed.
- **Copy-on-write:** writing into a hard link in place would change the original too. Before a
  catalog file mod writes into an instance, `instances::break_link(path)` replaces the link by a
  real copy inside the instance (copy to a temp file next to it, rename over the link name). The
  original file is only read. `fsx::write` (temp file + rename) does not write through a link
  either; `break_link` also covers writers that open files in place. Restores of a backup call it
  too.
- **No hard links possible** (game on another drive than the data folder, FAT/exFAT, network
  share): "Check" reports it with the size of a full copy; the dialog shows the size and the
  button becomes "Copy". Without that confirmation `instance_create` refuses (`needs-copy: <reason>`).
- **Own user folder** through the instance's own `Nadeo.ini` (a real copy, then edited):
  - Forever: `[TmForever] UserSubDir=TrackMania_<id>` → `Documents\TrackMania_<id>`
  - ManiaPlanet: `[ManiaPlanet] UserDir={userdocs}\ManiaPlanet_<id>`; `CommonDir` stays shared
    (download cache)
  - ESWC: no key; its data lives in the instance's copied `GameData` folders.
- **Play:** a profile with an instance is a profile of its own (`inst:<id>`). Play starts the
  instance's exe with the instance folder as working folder (`launch_game` with `instance`); join
  links and ManiaPlanet's `/title=` work as for the original. **Without TMLoader** (see below).
- **Catalog file mods** (`ui/CatalogInstall.tsx`): when the selected profile of that game has an
  instance, the install target is `<game>@<id>`. Base `game`/`gamedata` resolve to the instance
  folder, `documents` (Forever) to `Documents\TrackMania_<id>`. TMLoader products and TMInterface
  folders stay global. The install record keeps `<game>@<id>`, so update and rollback go to the
  same instance.
- **Duplicate:** builds a new instance from the instance folder (mod files included, links again),
  with a new `Nadeo.ini` user folder. The user data in Documents is not copied.
- **Delete:** only a folder that is exactly `<instances root>\<id>`, a real folder (no junction),
  whose resolved path is inside the root, and that is in `instances.json`. The folder is renamed
  first (fails while the game still runs from it), then removed. Removing a hard link never touches
  the original file. The user folder in Documents stays.
- **Disk use:** per file the link count and file id (`GetFileInformationByHandle`; Linux
  `nlink`/`ino`). Files with more than one name count as "Shared", the rest as "Own files"; each
  file id once.

## Nadeo.ini per game (read on my PC, read only)

| Game | Nadeo.ini | User folder key | In the exe |
|---|---|---|---|
| TMUF 2.11.26 (`Program Files (x86)\TmUnitedForever`) | `[TmForever] Version, WindowTitle, UserSubDir=TrackMania, Key, Distro=ASPUR, Language` | `UserSubDir` (folder under Documents) | `UserSubDir` next to `Nadeo.ini`; switches `/userdir /ini /config /useexedir /singleinst /file /url /title /profile /login` |
| TMNF 2.11.26 (`Program Files (x86)\TmNationsForever`) | `[TmForever] Version, Distro=APIJU, Language` | none set (default `TrackMania`); the instance adds `UserSubDir` | same exe build |
| Nations ESWC (unofficial copy, not the StarForce one) | `[TmNationsESWC] Version=0.1.7.9` | none; no `UserSubDir`/`UserDir` string in the exe | user data in `GameData\Profiles`, `Tracks`, `Scores`, `Cache`, `Default.SystemConfig.Gbx` |
| ManiaPlanet (standalone, `Distro=KOTOF`) | `[ManiaPlanet] WindowTitle, Distro, Language, UserDir={userdocs}\ManiaPlanet, CommonDir={commondata}\ManiaPlanet` | `UserDir` (placeholders `{userdocs}`, `{commondata}`, `{exe}` in the exe) | `/userdir /ini /config` |
| Trackmania 2020 (Ubisoft) | `[Trackmania] Updater=Uplay, Distro=UPLAY, UPlayAppId=5595, UserDir={userdocs}\Trackmania, CommonDir=...` | `UserDir` | `/userdir /ini /config` |
| Sunrise (community repack) | no Nadeo.ini | - | - |

Supported: TMNF, TMUF, ESWC, ManiaPlanet titles. Not supported: Trackmania 2020 (Ubisoft
Connect, Steam or Epic start it from the registered folder; an instance exe started directly would
most likely hand over to Ubisoft Connect), Turbo, Original, Sunrise.

## TMLoader (read only: `%LOCALAPPDATA%\TMLoader`, its `ui/layouts/loader.d.ts`, strings in TMLoader.exe)

- `config.yaml` has no game path (servers, `default_profiles`, `database: ./database`).
- The game folder is stored **once per product**:
  `database\TmForever\products\TmForever\settings.yaml` → `install: 'C:/Program Files (x86)/TmUnitedForever'`.
  `loader.d.ts` matches: `Settings { install }`, `Profile { program, args, mods }` (no path per
  profile), `ProcessInfo { exe, cwd, cmd, dlls, envpaths }`.
- TMLoader learns that path by watching the original game start once ("Please launch original game
  as you usually do ... This is required to know where your game is installed.").
- It starts its own modded exe from `products\TmForever\<version>\TmForever.exe` (that folder has
  no GameData), so the game data must come from the `install` folder, most likely as working folder
  (`ProcessInfo.cwd`). Not verified, because that needs a start.
- Environment it sets: `MODLOADER=1`, `MODLOADER_TITLE=`.
- "Integration" replaces the game's exe with `ShimRun.exe` (starts TMLoader with the default
  profile) and keeps the game as `*.bak.exe`. When an instance finds `TmForever.bak.exe`, it starts
  that one and says so (not tried).

**Result:** the installed TMLoader cannot point one profile at another game folder. More read on my
PC (read only): `config.yaml` has `portable: false` and `database: ./database`; TMLoader.exe holds the
strings `./config.yaml`, `./database`, `portable`, "Press Abort to install in portable mode" and
`CWD=` / `MODLOADER_TITLE=` (environment for the game). Its paths are relative to its own folder, so a
copy of TMLoader in another folder should use that folder's config and database.

**What I implemented (option 2, `src-tauri/src/instancetml.rs`):** a Forever instance can get a
"TMLoader mods" profile (instance panel on the Profiles page). Play then builds, inside the instance,
`<instance>\TMLoader\` with copies of `TMLoader.exe`, `sciter.dll` and `ui\`, a `config.yaml` with
`portable: true`, `auto_update: 'false'`, `auto_upgrade: 'false'` and the chosen profile as default,
and `database\TmForever\` with hard links to the installed products (small and writable files such as
mod ini files are real copies), its own `products\TmForever\settings.yaml` (`install:` = the instance)
and a copy of the profile. It starts `<instance>\TMLoader\TMLoader.exe run TmForever "<profile>"`.
The database is rebuilt before every start, so newly installed mods show up; the installed TMLoader is
only read (unit test compares every file before and after). Without a profile the instance still
starts its own exe without TMLoader.

Not verified (needs a start on my PC): that the copy really reads its own `config.yaml`, does not ask
for the game folder again, and starts the modded exe with the instance as working folder; whether it
tries to register `tmloader://` or Explorer integration on first start. If it reads
`%LOCALAPPDATA%\TMLoader` instead, the start would use the original folder: the panel says so.

Other options I did not take:
1. **Swap `install` for the start** in the installed TMLoader's `settings.yaml`: writes the real
   TMLoader folder (global state, crash leaves it pointing at the instance).
2. **Profile `args: /userdir=<folder>`:** own user folder only, not own GameData.

## Linux

Same code: hard links with `std::fs::hard_link`, link count and inode from `MetadataExt`. When the
game sits in a Wine/Proton prefix, the instances root is `<prefix>/drive_c/TM Horizon instances`,
so the links stay on the same file system and `wine::prefix_of(exe)` picks the same prefix (and
`{userdocs}` in Nadeo.ini resolves inside it). Delete accepts that root as well. Not tried on a
Linux machine; the unit tests are platform-neutral.

## Limits

- Games on another drive than `%LOCALAPPDATA%` need a full copy (warning with size first). A root
  per drive would fix that later.
- Not instance-aware yet: TMLoader product installs (they go to the installed TMLoader; the
  instance's copy links them at the next start), ESWC proxy DLL mods (`eswcmods`), Openplanet plugins,
  maps opened from the instance's user folder, skins downloaded in the embedded browser (they go to
  the original's folders).
- Editing files in the instance by hand (Explorer, a text editor that saves in place) can write
  through a link into the original. Only TM Horizon's installers do copy-on-write.
- A game's own updater (ManiaPlanet) writing in place into an instance would change the linked
  original as well. TMF and ESWC have no updater.
- A catalog mod with base `documents` needs `Documents\TrackMania_<id>` to exist, which the game
  creates on its first start from the instance.

## Verified vs. untested

Verified by unit tests on fake game folders in temp dirs (`cargo test instances`,
`catalogmods::install_into_an_instance_leaves_the_original_alone`):
- create with hard links (same file id, link count 2), small and writable files as copies, ESWC
  user folders as copies, StarForce folder refused;
- Nadeo.ini of the instance gets its own `UserSubDir`, the original's stays as it was;
- `break_link` and `fsx::write` leave the original's bytes untouched; a catalog install and its
  restore inside an instance leave the original untouched;
- disk use (own vs. shared bytes, before and after copy-on-write);
- full-copy fallback refused without confirmation, done with it;
- duplicate (links again, new user folder, source stays the original game);
- delete removes only the instance; a tampered `instances.json` pointing at the game folder or a
  foreign root is refused;
- the start command of an instance (own exe, own working folder).

Untested (needs my test round, no game was started for this):
- that TMUF/TMNF really use `Documents\TrackMania_<id>` (key read from the installed TMUF ini and
  found in the exe, so very likely);
- that ManiaPlanet accepts `UserDir={userdocs}\ManiaPlanet_<id>` and runs from another folder
  (Steam/Ubisoft builds may hand over to their launcher);
- Steam TMNF started from an instance exe instead of `steam://rungameid/11020`;
- ESWC started from an instance (no proxy DLL there);
- the TMLoader integration case (`TmForever.bak.exe`);
- Linux.

Test round I plan: TMNF instance → Play → check `Documents\TrackMania_<id>` appears and the normal
`Documents\TrackMania` is unchanged; install a texture mod into it and compare the original's
file hash before and after; delete the instance and check the original still starts.
