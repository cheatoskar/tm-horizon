# TM Vibrant Shaders content in the launcher (presets, looks, packs)

On the mod page of TM Vibrant Shaders, three tabs: **Presets**, **Looks** (colour look-up tables) and **Packs** (environment mod zips).
Code: `apps/launcher/src-tauri/src/tmvscontent.rs` (all checks and file writes, with tests), `apps/launcher/src/ui/TmvsContent.tsx` (the tab).

## What is shown

- Presets: the 14 built-in presets (name, line, GPU load, picture; `src/data/tmvs-builtin.json` and `public/tmvs/builtin/`) and the community entries.
  Built-in presets are part of the mod, so they have no Install button: they are picked in the game on the Shaders page.
- Looks and Packs: community entries only.
- Search, Built in / Community / Installed, tag chips. Entries marked `example` carry an "Example" badge.
- Source: default `https://raw.githubusercontent.com/cheatoskar/tmvs-presets/main/` (not published yet: the tab says it is unreachable);
  or a folder with an `index.json` (Source, Browse). Stored per viewer in the browser storage of the app.

The index format is in the README of the `tmvs-presets` repository (`items` with `kind`, `files` with `sha256`).

## Generated data

`apps/launcher/tools/gen-tmvs-data.py <TMVS repo> [<tmvs-presets repo>]` reads the TMVS source and writes
`src-tauri/data/tmvs-fields.json` (every preset key with its slider range and whether it is an installation setting),
`src/data/tmvs-builtin.json` (menu.cpp's built-in list) and the pictures; with the second path also the example presets
(made from the built-in presets' values in `config.cpp`). Run it again when TMVS gets new settings or presets.

## Install

1. The index is read (https: only the index's own host may serve files; folder: paths stay inside the folder).
2. Every file is downloaded with a size cap and compared with the index's SHA-256.
3. Content is validated before anything is written:
   - preset `.ini`: at most 16 KB, UTF-8 text, sections `[Preset]` and `[Info]` only, each key one of TMVS's preset keys with a value inside its
     range (bool 0/1, number, `r,g,b`), no installation settings (video, render scale, trail, VR, game integration), no duplicates.
   - preset `.jpg`: a real JPEG (markers, end marker, frame header), 16:9 within 6 %, at most 4096 px, at most 1 MB.
   - look `.cube`: 3D table, size 2 to 64, exactly SIZE^3 rows of three numbers, input range 0..1, at most 8 MB.
   - pack `.zip`: readable zip, at most 64 MB, 5000 entries, 256 MB unpacked, no `..`/absolute/drive paths, no executables or nested archives, at least one texture.
4. Files go to (Documents through the known-folder API; `TMHUB_DOCUMENTS_DIR` overrides it for tests and screenshots):
   - presets: `Documents\TrackMania\TMVS\presets` (Nations, United, ESWC share it), `Documents\ManiaPlanet\TMVS\presets` (TM2)
   - looks: `...\TMVS\luts`
   - packs: `Documents\TrackMania\Skins\<Environment>\Mod` (Nations/United; the folder is shared by all profiles)
   The dialog offers the families of the entry's games; installed ones are ticked.
5. A file with the same name that TM Horizon did not install is never overwritten. Installing again over our own file updates it.

The manifest `tmvs-content.json` in the app's data folder lists every file written, with its hash. **Remove** deletes only those files, and only
while their hash is unchanged.

## Share codes

`TMVS1:...` is TMVS's own format (compressed, decoded by the mod). The launcher does not decode it: the box finds the code in a pasted chat
message (also one broken over lines), checks its shape and length (at most 4000 characters) and copies it, with the hint to press
*Paste share code* in TMVS's Shaders page.

## Share my preset

Lists the presets in the folder that TM Horizon did not install, shows the `.ini` and `.jpg` (Show opens the folder) and opens a prefilled GitHub
issue of `cheatoskar/tmvs-presets` in the browser. Nothing is uploaded.
