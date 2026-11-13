# Performance panel (game page: TMNF, TMUF, ESWC, Sunrise)

One panel with four tabs. Code: `optimize.rs`, `syscfg.rs`, `perfbench.rs`, `replayarchive.rs`,
`startwatch.rs`, UI `src/ui/PerfPanel.tsx`. Everything is per user, no admin, and every write can be undone.

## Optimize (Windows settings per exe)

Exe per game: `TmForever.exe` (TMNF, TMUF), `TmNationsESWC.exe`, `TmSunrise.exe`, the one of the install
the launcher found. Nothing is written for a game inside `Program Files (x86)\TrackMania Nations ESWC`.

| Switch | Registry value (name = full exe path) | Data |
|---|---|---|
| Fullscreen optimisations off | `HKCU\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers` | `~ DISABLEDXMAXIMIZEDWINDOWEDMODE` |
| DPI scaling by the app | same value | `HIGHDPIAWARE` added to the same string |
| High performance GPU | `HKCU\Software\Microsoft\DirectX\UserGpuPreferences` | `GpuPreference=2;` |

Flags and `key=value;` parts that are already there stay. Apply shows old value -> new value in a dialog first.
Each write goes to `optimize-journal.json` (launcher data folder) with the previous value or "absent" before
it happens. Undo puts exactly those values back (an absent value is deleted again) and marks the entry done.
Turning a switch off removes only my flag.

## Game graphics config

File: `Default.SystemConfig.Gbx` (TMNF/TMUF: `Documents\TrackMania\Config\`, ESWC/Sunrise: next to the exe).

- Binary GBX v6 `BUCR`, class `0x0B005000`, body LZO1X. The display settings are a node inside chunk
  `0x0B005020`; its chunk `0x0B013001` holds eight u32: width, height, window preset, colour depth,
  antialiasing (0 off, 1 2x, 2 4x, 3 6x, 4 8x, 5 16x), refresh rate, V-Sync, fullscreen.
  Chunk `0x0B013022`: textures quality (index 3) and shadows (index 5).
- ESWC and Sunrise write a text GBX (`TUUE`, CRLF, one value per line, chunk size = byte length of its lines).
- Evidence: GBX.NET's chunk list (reference only), my own file and `Bench.SystemConfig.Gbx` (differ exactly in
  antialiasing 5, V-Sync 1, fullscreen 1), the text files (`False`/`True` for the last two values).
- Read: all of it, both formats. Write: only fullscreen, V-Sync and antialiasing, only binary files. Textures and
  shadows are shown, never written (not confirmed in the game). Text files are read only.
- Write steps: diff dialog, copy the original to `backups\<time>\SystemConfig\`, journal entry
  (`syscfg-journal.json`), body changed in place (same size), compressed again as a literal-only LZO1X stream,
  read back and compared before the file is written. Refused while the game runs. Undo copies the original back.
- Not tested in the game yet. Read, round trip and back-up/undo are tested against the real files (read only) and
  with temp files.

## Benchmark

Hand-over to the in-game module `performance` of Horizon Host. The launcher writes
`<horizon data root>\data\performance\bench-request.json`
(`{"version":1,"mode":"map"|"replay","map":...,"seconds":30,"warmup":5,"label":...,"runs":3,"returnToMenu":true}`),
then starts the game like Play does. Nothing starts by itself. Horizon data root: legacy games `<game>\horizon\`,
Forever: the newest installed version folder of the TMLoader product `Horizon Host` (where `profile.json` is).
Results are read from `...\data\performance\bench\*.json` (summaries only, every field optional); the table shows
the newest 12, the comparison shows the mean per label and the difference to the label `baseline` in percent.
The last picked map is kept in `perf-prefs.json`.

## Replay archive

The game parses every replay under `Tracks\Replays` when its list is refreshed, and it scans recursively, so the
archive is outside the user folder: `<Documents>\TM Horizon\Replay-Archiv\<game id>\`, same sub-path as below
`Replays`. Archive moves replays older than N days (default 60) and/or beyond the newest N (default 300);
`Autosaves` only with the checkbox. The dialog shows count, size and names first. Refused while the game runs.
`replay-archive-journal.json` records from, to, size, time of every move. "Undo last archive" skips files that are
gone, changed in size or whose old place is taken, and never overwrites. Name clash in the archive: `name (2).Replay.Gbx`.
Search reads only the GBX header (first 64 KB, `gbx::replay_head`) and caches it in `replay-index.json` by
path + size + mtime. Replay contents are never changed.

## Record start

Per game checkbox, off by default. For 120 seconds after the game process starts (when started from the
launcher) it records every 250 ms: window title, hung state, CPU time, I/O counters, thread count; file events in
the user folder per top-level folder and second plus the 20 most touched files; size and time of
`Config\User.FidCache.Gbx` and `C:\ProgramData\TrackMania\Game.FidCache.Gbx` before and after. No hooks, no
injection. Output: `startwatch\<time>_<game>.json` and `.txt` in the launcher data folder; the tab shows the
newest two. Windows only. The launch path of a separate instance is not covered.


## DXVK (Vulkan)

Optional switch per game (experimental, not tested in the game). On puts two files next to the game exe:
`d3d9.dll` (the 32-bit DXVK 3.1.1 dll, pinned download from the doitsujin/dxvk release, archive SHA-256
`40565b4a...e608` checked, else nothing is written; only `dxvk-3.1.1/x32/d3d9.dll` is read out of the archive)
and `dxvk.conf` (`d3d9.maxFrameLatency = 1`). The archive is cached in `<launcher data>\dxvk\`. The dialog lists
the files first. `dxvk-journal.json` records path, SHA-256 and what was there before (always nothing).

Refused, nothing written: the game runs; the folder is protected or not writable (Program Files without admin);
a `d3d9.dll` is already there (TM Vibrant Shaders or the Sunrise repack's own proxy load the system d3d9 by full
path, so DXVK cannot sit behind them); a `dxvk.conf` that I did not write.

Off removes exactly my two files, each only while its SHA-256 still matches the journal; a changed file stays
and the panel says so (it then also blocks switching on again until I remove it by hand).

Whether the Competition Patch accepts DXVK is unknown, I do not claim it is allowed. Online it changes only
how the image is drawn, not tested in the game.

## Not tested

- Writing the game config in the game itself.
- DXVK in the game itself (the dll swap ran only in unit tests with temp folders).
- Benchmark with a real Horizon Host module (the module side is not part of this change).
- Record start against a real hanging start; the sampling code ran only in unit tests (aggregation, parsing).
- The panel in the preview backend: it is hidden there (native only).
