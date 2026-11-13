# TM Horizon on Linux

The launcher builds and runs on Linux (Tauri 2 with WebKitGTK). The games stay Windows games:
they run through Wine or Proton, and TM Horizon finds them inside Wine/Proton prefixes. I build
and test it in WSL (Arch Linux, WSLg) on my Windows PC; a real Linux desktop with games
installed is not tested yet (see "Not tested yet").

## Packages

| What | Where |
|---|---|
| AppImage, .deb, .rpm | `npx tauri build --bundles appimage,deb,rpm` in `apps/launcher` (CI: `.github/workflows/release.yml` on ubuntu-22.04) |
| Arch, from source | `packaging/arch/tm-horizon/PKGBUILD` (`makepkg -si`) |
| Arch, binary | `packaging/arch/tm-horizon-bin/PKGBUILD` (repacks the release .deb) |

Build dependencies on Arch:

```
sudo pacman -S --needed base-devel webkit2gtk-4.1 gtk3 librsvg openssl xdotool rustup nodejs npm
```

Runtime: `webkit2gtk-4.1`, `gtk3`; for the games `wine`, or `umu-launcher`, or Steam with Proton.

Only the AppImage updates itself (Settings > Updates); .deb, .rpm and the Arch packages update
through the package manager.

## How the games are found

Code: `src-tauri/src/platform/wine.rs` (prefix logic, compiles and is unit tested on every OS)
and `platform/linux.rs` (plugs it into the scanner). Prefixes, first one wins when a folder is
found twice:

1. Settings > Linux (main prefix, per-game prefix, added prefixes)
2. `$WINEPREFIX`
3. Steam (native `~/.local/share/Steam`, `~/.steam/steam`, Flatpak `~/.var/app/com.valvesoftware.Steam/...`,
   Snap): `steamapps/compatdata/<appid>/pfx` for TMNF 11020, TMUF 7200, ManiaPlanet 228760,
   TM² Stadium 232910, Valley 243360, Lagoon 600720, ShootMania 229870, Trackmania 2225070,
   Turbo 375900, in every Steam library from `libraryfolders.vdf`
4. TM Horizon's own `~/.local/share/com.tmhorizon.launcher/prefixes/*`
5. Lutris (`game: prefix:` in `~/.config/lutris/games/*.yml`, `~/.local/share/lutris/games/*.yml`,
   Flatpak Lutris), Bottles (native and Flatpak), Heroic (`~/Games/Heroic/Prefixes`)
6. `~/Games/*` (Lutris' default install place, also `<game>/prefix` and `/pfx`) and `~/.wine`

What the scanner then sees:

- "Program Files" = the `Program Files` and `Program Files (x86)` of every prefix, so the normal
  scan finds TMNF/TMUF/ManiaPlanet/Original/Sunrise folders in all of them.
- "Installed programs" = the Uninstall keys in each prefix's `system.reg`
  (`InstallLocation` mapped from `C:\...` into the prefix); Ubisoft Connect installs from the
  same file.
- Steam games come from the Steam libraries like on Windows; Steam starts them.
- Documents and %LOCALAPPDATA% (TMLoader) come from the main prefix: the one picked in Settings,
  else the first prefix with TMLoader, then one with `Documents/TrackMania`, then one with a
  Forever install, then the first one. The user folder is `$USER`, else `steamuser` (Proton),
  else the first one that is not `Public`. Old prefixes (`My Documents`,
  `Local Settings/Application Data`) work too. `TMHUB_TMLOADER_DIR` still overrides TMLoader.
- Windows paths map into the prefix: `C:\x` -> `<prefix>/drive_c/x`, `Z:\x` -> `/x`, other letters
  through `dosdevices/`. Host paths handed to a game become `C:\...` or `Z:\...`.
- Letter case: every file access of the launcher (`fsx`) goes through `platform::ci`, which on
  Linux finds `GameData`, `Skins`, `TrackMania` and so on in whatever case they exist on disk
  (new files keep the given case below the last existing folder). On Windows it does nothing.
- Not read yet: Epic/Heroic manifests (Trackmania 2020 from Epic), Openplanet folders inside a
  prefix (the scanner looks in the Linux home).

## How the games start

`platform::spawn` wraps every `.exe` (Windows itself is unchanged):

| Runner | When (Auto) | Command |
|---|---|---|
| Proton | the exe is in a Steam prefix (`compatdata/<id>/pfx`) | `<Proton>/proton run <exe> ...` with `STEAM_COMPAT_DATA_PATH`, `STEAM_COMPAT_CLIENT_INSTALL_PATH`, `SteamAppId` |
| Wine | every other prefix | `WINEPREFIX=<prefix> wine <exe> ...` |
| umu-run | only umu installed, or chosen | `WINEPREFIX=<prefix> GAMEID=umu-<steam id> [PROTONPATH=...] umu-run <exe> ...` |

The prefix is the one the exe lives in; an exe outside any prefix (a game copied to
`~/Games/TMNF`) uses the game's prefix from Settings, then the main prefix. Settings > Linux
sets the runner for all games and per game (TMNF, TMUF, Nations ESWC, ManiaPlanet,
Trackmania), the Proton version (newest found by default: GE-Proton, then numbered Proton,
then Experimental) and the prefixes.

TMLoader runs exactly like on Windows: `TMLoader.exe run TmForever "<profile>"` inside the
prefix, through the runner. Steam links (`steam://rungameid/<id>`) start `steam -applaunch <id>`,
or `flatpak run com.valvesoftware.Steam -applaunch <id>`, else `xdg-open`.

`tmhub://` links: after the user agrees (same question as on Windows) a desktop file
`~/.local/share/applications/tm-horizon-url-handler.desktop` is written and made the default with
`xdg-mime`. The packages themselves do not register the scheme.

## Guided game setup (TMNF, TMUF)

On Linux the game page of TMNF and TMUF and Settings > Linux have "Set up": TM Horizon builds a
prefix for the game and installs it there. Code: `src-tauri/src/linuxsetup.rs` (steps, downloads,
commands), the fixes in `platform/wine.rs` (`PrefixOptions`), UI in `src/ui/LinuxGameSetup.tsx`.
Windows is unchanged (the commands answer "Only on Linux").

| Step | What happens |
|---|---|
| Wine/Proton | Uses Wine, wine-staging or umu-run (+ Proton from Steam, `compatibilitytools.d` or TM Horizon's own). Without them the dialog shows the install command for the distribution (pacman, apt, dnf, zypper, or Steam as Flatpak); TM Horizon never runs sudo. No-root path: download umu-launcher (zipapp, needs python3) and GE-Proton from their GitHub releases into `~/.local/share/com.tmhorizon.launcher/runners/` |
| Wine prefix | `~/.local/share/com.tmhorizon.launcher/prefixes/<game>`, `wineboot -u` (64-bit prefix; TMNF/TMUF are 32-bit programs and run in it, Mono/Gecko dialogs switched off), then the registry fixes (`tmhub.reg` through `regedit /S`) |
| DXVK | Plain Wine only (Proton has its own): latest `doitsujin/dxvk` release, DLLs into `system32`/`syswow64` |
| winetricks | Optional `corefonts`, `d3dx9`; only when winetricks is installed (umu: its `winetricks` verb) |
| Game | Official setup (`gameinstall::source`), its SHA-256 must be the pinned one (TMNF `2f659138…f6355`, TMUF the existing pin), because Linux has no Authenticode check. Both setups are Inno Setup 5, so Inno's documented `/SILENT /SUPPRESSMSGBOXES /NORESTART /SP-` are used; other installers would get their own window. TMUF asks for its key on the first start |
| TMLoader | The guided TMLoader setup (`tmlsetup::download_with`, link from tomashu.dev), installer (NSIS) runs visibly in the same prefix: Tomashu documents no silent switch |
| Add to library | Settings > Linux gets runner + prefix for the game (and the prefix becomes the main one when none was picked), then a rescan. Starting works as before: `TMLoader.exe run TmForever "<profile>"` through the runner |

Every download from GitHub must carry GitHub's `sha256:` asset digest and must match it before it
is unpacked (GNU `tar`, which refuses absolute and `..` names). Downloads can be cancelled; a
cancel also ends the running Wine processes (`wineserver -k`, process group). Log:
`~/.local/share/com.tmhorizon.launcher/logs/linux-setup-<game>.log`. "Repair" runs Wine/Proton,
prefix, DXVK and "Add to library" again on the existing prefix. ESWC, Sunrise and Original get
"Add folder" only (no download), ManiaPlanet/TM2/Trackmania/Turbo a hint to use Steam with Proton.

Fixes, saved per prefix in `<prefix>/tmhub.json` (prefixes without it start exactly as before):

| Fix | Default | How | Why |
|---|---|---|---|
| DXVK | on | Wine: `WINEDLLOVERRIDES=d3d8,d3d9,d3d10core,d3d11,dxgi=n,b` (off: `=b`, wined3d); Proton/umu: off = `PROTON_USE_WINED3D=1` | D3D9 over Vulkan is the usual fast path; wined3d for GPUs without Vulkan 1.3 |
| Fast sync | on | wine-staging: `WINEESYNC/WINEFSYNC=1`; Proton/umu: off = `PROTON_NO_ESYNC/FSYNC=1` | Upstream Wine 10+ uses ntsync by itself |
| Keep mouse in window | on | `HKCU\Software\Wine\X11 Driver\GrabFullscreen=Y` | Cursor leaving the fullscreen game |
| PulseAudio sound | off | `HKCU\Software\Wine\Drivers\Audio=pulse` | Crackling or missing sound when Wine picks ALSA ([Wine bug 20915](https://bugs.winehq.org/show_bug.cgi?id=20915): TrackMania choppy with OpenAL) |
| 4 CPU cores | off | Wine: `taskset -c 0-3`; Proton/umu: `WINE_CPU_TOPOLOGY=4:0,1,2,3` | Wine/Proton have trouble with very many logical cores (reports of 32/64-core limits; `WINE_CPU_TOPOLOGY` is a Proton variable) |
| Virtual desktop | off | `wine explorer /desktop=TMHorizon,WxH <exe>` (plain Wine) | Resolution switches and window managers that fight fullscreen |
| Windows version | win10 | `HKCU\Software\Wine\Version` | |

Known and not fixable from outside: [Wine bug 25381](https://bugs.winehq.org/show_bug.cgi?id=25381)
(TMNF crashes when a map loads with sound on; still reported on Wine 10): the dialog says to turn
off sound in the game's launcher if it happens. Lutris' TMNF script uses the same official setup
with `/silent` and no other tweaks.

## Safety

- The StarForce folder rule also holds on Linux: any path with `Program Files (x86)/TrackMania
  Nations ESWC` (any case, any mount, e.g. `/mnt/c/...` in WSL, or inside a prefix) is never
  opened, listed or started (`fsx::other_os_protected`, tested). `dinput8.dll` stays blocked.
- Under WSL, "Scan drives" leaves out `/mnt/<letter>` (the Windows drives).

## Tested

- Unit tests (`cargo test`, Linux and Windows): prefix search with fake Steam, Lutris, Bottles,
  Heroic, `~/Games`, `~/.wine`; folders inside prefixes; path mapping both ways and letter case;
  `system.reg` parsing; runner choice; wrapped commands; settings validation.
- `fake_home_scan` (ignored by default): a fake home with four prefixes, scanned end to end
  (`HOME=<fake home> USER=tester cargo test fake_home -- --ignored --nocapture`); prints what is
  found and how TMLoader would start. Nothing is started.
- The app starts in WSLg with that fake home.
- Guided game setup, `e2e_setup` (ignored by default; WSL Arch, Wine 11.21, throwaway HOME):
  `HOME=/tmp/tmh-e2e USER=tester TMHUB_E2E=tmnf TMHUB_E2E_SETUP=<tmnationsforever_setup.exe> TMHUB_E2E_TMLOADER=1 cargo test e2e_setup -- --ignored --nocapture`.
  Creates the prefix, imports the registry fixes, downloads and checks DXVK 3.1.1, installs TMNF
  with the Inno switches unattended (about 11 minutes in WSL), installs TMLoader (NSIS `/S`, test
  only), runs "Repair", checks Settings > Linux, the scanner and the start command
  (`WINEPREFIX=… WINEDLLOVERRIDES=d3d8,d3d9,d3d10core,d3d11,dxgi=n,b wine …/TMLoader.exe run TmForever Default`).
  Started by hand afterwards: TMLoader runs in the prefix (answers "profile 'Default' not found",
  as a fresh TMLoader has no profiles), `TmForever.exe` starts with DXVK 3.1.1 loaded and shows its
  first-start network dialog. No GPU in WSL, so not played.

## Not tested yet

- Real games: TMLoader, TMNF/TMUF, ManiaPlanet under Wine 9/10, Proton and umu-run; TMLoader's
  DLL mods (TMInterface, CoreMod, TM Vibrant Shaders) with DXVK and wined3d.
- Guided setup with umu-run + GE-Proton (downloads and commands are unit tested, the run is not),
  TMUF (same path as TMNF, 1.2 GB setup not run), the TMLoader installer clicked through by hand,
  the fixes on a real desktop (mouse grab, PulseAudio, CPU limit, virtual desktop).
- Wayland vs X11 for the embedded TMX / ManiaPark view (a child webview; Wry documents child
  webviews on Linux as X11-only). If it misbehaves, open the exchanges in a separate window on Linux.
- "Get" on a game page outside the guided setup: the Authenticode check does not exist on
  Linux, so setups count as unsigned there (the guided setup pins the SHA-256 instead).

## Notes on D3D9 mods

DXVK (D3D9 -> Vulkan, Proton's default) implements the same COM interfaces, so mods that hook the
D3D9 device should work; wined3d (`PROTON_USE_WINED3D=1`) is the fallback for old GPUs.
Openplanet documents Wine support with a `dinput8` DLL override (https://openplanet.dev/docs/help/linux).
Lutris' TMUF installer uses TMLoader with the same `run TmForever <profile>` command.
