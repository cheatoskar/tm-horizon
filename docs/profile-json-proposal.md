# Horizon Host: files between TM Horizon and the host (launcher side)

Status 2026-11-11 evening. Started as a proposal while the host's spec did not exist; now aligned with
the host repo (horizon-host: `src/common/profile.cpp`, `src/loader/loader.cpp`, `tools/package.py`).
The host's own `docs/profile-json.md` wins where it differs. On the launcher side everything is in one
Rust module: `apps/launcher/src-tauri/src/horizonhost.rs` (`mod format` + the dist readers).

## Folder layout ("host root" = the folder that holds the host DLL)

| Game | Host root | Loader |
|---|---|---|
| Nations ESWC, Sunrise (Original later) | `<game folder>\horizon\` (`host.dll`) | `<game folder>\dinput8.dll` (Legacy Loader) |
| Nations/United Forever | `<TMLoader>\database\TmForever\products\Horizon Host\<version>\` (`HorizonHost.dll`) | TMLoader |

Inside the host root: `profile.json` (optional, below), `plugins\<id>\plugin.json` + DLL, `logs\*.log`
(TM Horizon shows the newest), `tmhorizon-install.json` (TM Horizon's own install record; the host
ignores it).

## Chaining an existing dinput8.dll

If a `dinput8.dll` is already next to the exe (ESWC Autosave's loader or anything else), TM Horizon does
not replace it: it keeps a backup copy, renames it to `dinput8.chain.dll` and puts the Legacy Loader in
place; the loader loads the chain DLL and forwards `DirectInput8Create` through it. Remove renames
`dinput8.chain.dll` back to `dinput8.dll`. If the chained DLL is ESWC Autosave, TM Horizon offers (optional)
"switch to the Autosave plugin": install `eswc-autosave`, copy `eswc_autosave.ini` to
`horizon\plugins\eswc-autosave\eswc_autosave.ini`, enable it, delete the chain file (backup first).

## profile.json (an override, written by TM Horizon only when needed)

Without `profile.json` the host loads every installed plugin whose `plugin.json` does not say
`"enabled_by_default": false`. TM Horizon writes the file only for "Start without mods" or after the user
switched a plugin in TM Horizon; otherwise it removes a `profile.json` it wrote earlier (one with
`written_by` "TM Horizon …"); a hand-written one stays.

```json
{
  "format": 1,
  "game": "eswc",
  "profile": "Default",
  "safe_mode": false,
  "plugins": [ { "id": "eswc-autosave", "version": "2.0.0", "enabled": true } ],
  "written_by": "TM Horizon 0.3.0-beta.1",
  "written_at": "2026-11-11T20:15:00.000Z"
}
```

`menu_key` is written only when set. Game keys: `eswc`, `sunrise`, `original`, `tmnf`, `tmuf`
(bits ESWC 0x01, SUNRISE 0x02, ORIGINAL 0x04, TMNF 0x08, TMUF 0x10).

## Build source (dev folder for tonight)

TM Horizon reads the host repo's `dist\manifest.json` (from `build.cmd package`):

- Legacy: the per-game zip of `packages[]` (`game` = eswc / sunrise). The zip's SHA-256 and every file's
  SHA-256 must match the manifest, else nothing is installed. `horizon/loader/dinput8.dll` becomes
  `dinput8.dll`; the package's own `Horizon-Install.cmd`, `install.ps1` and readme are left out.
- TMLoader: `tmloader_product.files` (`<version>/...` and the product's `description.yaml`), each file
  checked.
- Fallback (tests, hand-made builds): `<dist>\legacy\manifest.json` with `{version, files:[{path, sha256}]}`.
- GitHub releases of cheatoskar/horizon-host: not wired yet (TODO; same checks against the release's
  manifest).

## Open points for the host agent

1. Original: no package in `dist\manifest.json` yet; the launcher says "no build for this game yet".
2. Forever: plugins and logs inside the TMLoader version folder are lost when TMLoader replaces the
   version; maybe `Documents\TrackMania\Horizon\` later.
