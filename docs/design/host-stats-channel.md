# Horizon Host to launcher: play events for the statistics page

Status: launcher side done (reader in `apps/launcher/src-tauri/src/stats.rs`, `stats_dir` in
`profile.json`), host side open. Written 2026-11-11 for launcher 0.4.

## Why

The Statistics page counts play time from the launcher's own process tracking and best times from
the replays in the game folders. Replays only exist for runs the player (or the game's autosave)
kept, so finishes, restarts and respawns are missing. TMNF/TMUF's own profile statistics are often
wrong, so the launcher does not use them. The host already sees every `MAP_LOADED`, `RACE_START`,
`RESPAWN` and `FINISH` (docs/plugin-abi.md in horizon-host); writing them down is all that is needed.

There was no channel from the host to the launcher before. The TMX Upload plugin's HTTP bridge
(127.0.0.1:27311-27315) is plugin-specific and needs pairing; a file is simpler, works when the
launcher is closed and needs no port.

## The channel: JSON lines in a folder the launcher names

1. Before each start the launcher writes `profile.json` (docs/profile-json.md) with one new key:

   ```json
   "stats_dir": "C:\\Users\\me\\AppData\\Local\\com.tmhorizon.launcher\\host-stats\\tmn-eswc"
   ```

   Unknown keys are ignored by older hosts, so this is additive. Without the key (started without
   the launcher, or an older launcher) the host writes nothing.

2. The host appends one line per event to `<stats_dir>\<yyyy-mm>.jsonl` (UTF-8, `\n`, one JSON object
   per line, file opened in append mode, flushed after each line). It creates the folder if missing.
   It never reads, rewrites or deletes these files; the launcher only reads them.

3. Lines (format version `v` = 1; `t` = Unix time in milliseconds):

   | `ev` | When | Fields besides `v`, `t`, `ev`, `uid` |
   |---|---|---|
   | `map` | `MAP_LOADED` | `name`, `author` (optional), `env` (optional) |
   | `start` | `RACE_START` (each start and restart) | |
   | `respawn` | `RESPAWN` | `respawns` (counter of this run) |
   | `finish` | `FINISH` | `time_ms`, `respawns`, `local` (`is_local_player`), `pb` (`is_pb`), `mode` (`play_mode`) |

   Example:

   ```
   {"v":1,"t":1794326400123,"ev":"map","uid":"7GK45NEyMOif7S9jicImvQNz7gf","name":"A01-Race"}
   {"v":1,"t":1794326401000,"ev":"start","uid":"7GK45NEyMOif7S9jicImvQNz7gf"}
   {"v":1,"t":1794326446230,"ev":"finish","uid":"7GK45NEyMOif7S9jicImvQNz7gf","time_ms":45230,"respawns":0,"local":true,"pb":true,"mode":"solo"}
   ```

   `uid` is the map uid; a line without it is skipped by the launcher. Lines the launcher cannot
   parse are skipped, so a half-written last line after a crash does no harm.

## Rules for the host

- Only the local player's own events (`local` false finishes may be written, the launcher ignores
  them). Replay viewing and the editor write nothing (the host gives no run events there anyway).
- Online: the events are statistics only, nothing is sent anywhere, and nothing is read from or
  written to game memory beyond what the host already reads. Writing is done off the game thread
  or buffered (one small append per event is fine; never block a frame on disk).
- A safe-mode start (`safe_mode: true`) writes nothing.
- Size: about 100 bytes per line; a month of heavy play stays well under a few MB. The launcher may
  later delete files older than a year; the host does not need to care.

## What the launcher does with it

Per map: finishes, starts ("attempts"), respawns and the best finish time from events, next to the
replay-based runs and best times. Per game: total finishes and respawns. Forever (TMLoader) uses the
same key; the game folder `stats_dir` names the launcher game id (`tmnf`, `tmuf`, `tmn-eswc`,
`tm-sunrise`, `tm-original`).

## Open for the host agent

- Implement the writer in horizon-host (`next`): read `stats_dir` from profile.json, append lines on
  the events above, guard every write, no writes in safe mode.
- Forever delivers `FINISH` by polling and has no `RESPAWN`; that is fine, those maps then show
  finishes and starts only.
- Add the key to docs/profile-json.md in horizon-host.
