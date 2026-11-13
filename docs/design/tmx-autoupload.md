# TMX replay auto-upload

Off by default. Settings → "TMX replay upload": one switch per game ("Upload new personal bests to TMX"),
a confirm dialog on the first switch-on, "Upload replay…" for a single file, the queue and a plain history
(map, time, site, result, link). Code: `apps/launcher/src-tauri/src/tmxupload.rs`, UI `src/ui/TmxUpload.tsx`.

## Flow

```
100% TMX mod (127.0.0.1:27311-27315)  ─┐
replay folder / Horizon Host log       ─┼─> queue ─> hidden webview on https://<exchange>/replayupload
"Upload replay…"                        ─┘            (EmbeddedWeb profile) ─> GET /replayupload (token)
                                                                            ─> POST /api/replays/upload
```

1. **Sources**
   - **TMNF / TMUF: the 100% TMX mod's bridge.** Same protocol as the browser extension (bridge.js):
     `GET /v1/ping`, `POST /v1/pair` (the mod shows "A browser wants to connect – Allow / No"; F9), then
     `GET /v1/next?wait=25` with `X-TMX-Key`, `GET /v1/file?id=`, `POST /v1/result`. The result goes back to the
     mod so its overlay says what happened. Jobs the mod could not match to the map (`verified:false`), jobs
     for a game whose switch is off and unknown sites are answered with a reason and not uploaded.
   - **TMNF / TMUF without the mod: the Forever replay folder** (`Documents\TrackMania\Tracks\Replays\Autosaves`
     and the top level of `...\Replays`; `Downloaded` is never read), same switch, same queue. Which files are
     "mine" (`tmxfolder.rs`):
     1. `Autosaves\` holds what the game itself saves for the active profile (`<profile>_<map>.Replay.gbx`,
        one file per profile and map, overwritten by the next best). These count as the player's own; their
        driver login (read from the replay header, chunk 0x03093000 via `gbx::replay_head`) is remembered
        as one of "my logins" (`logins` in `tmx-upload.json`, at most 8).
     2. Replays in the top level of `Replays\` (saved by hand, ghosts saved from a leaderboard, files copied
        in from others) count only when their driver login is one of "my logins"; otherwise they are skipped
        with "Not your replay (driver ...)" in the history. No header or no login: skipped.
     3. Only files written after the switch was turned on, at least 2 s old.
     4. Exchange: environment other than Stadium goes to tmuf.exchange; Stadium goes to tmnf.exchange when that
        switch is on, else tmuf.exchange (TMNF and TMUF share the folder). A Stadium map that exists only on
        tmuf.exchange is refused with TMX's normal answer.
     5. Duplicates: a replay offered by the mod and found in the folder uploads once. The queue and the
        handled list compare the SHA-256 and also the run (map uid + time from the header), so a re-written
        copy of the same run counts as the same.
   - **ESWC / Sunrise / Original: new replay files.** `<game>\GameData\Tracks\Replays` and `…\Replays\Autosaves`
     (where Horizon Host's ESWC Autosave plugin and the old ESWC Autosave save), plus the host's
     `REPLAY_SAVED` events from its newest log (`<game>\horizon\logs\*.log`, line
     `event: replay saved by <source>: <path>`). Only files written after the switch was turned on, at least
     2 s old (finished writing). Replays whose header says `validable="0"` (several ghosts of a network race)
     are skipped with a reason; the autosave plugin's single-ghost "… TMX.Replay.Gbx" copy is the one that goes.
   - **"Upload replay…"**: any .Replay.Gbx, sent to the chosen game's exchange.
2. **Queue rules**: one upload at a time, at least 2 s between uploads, the same replay (SHA-256) never
   twice (a list of handled replays is kept). Transient errors (network, timeout, 429, 5xx) are retried
   after 10 s, 30 s, 2 min, 5 min, 15 min, then the job fails. TMX's refusals (e.g. "not faster than your
   record", wrong track) are final. Not signed in: the job waits, the UI shows "Sign in to <site>" and the
   job is tried again every 90 s or right after a successful check.
3. **Upload**: a hidden child webview with the label `tmxupload` on the embedded browser's WebView2 profile
   (`<local app data>\EmbeddedWeb`, same environment options as the visible one) loads
   `https://<exchange>/replayupload`. A script then does exactly what bridge.js does: fetch `/replayupload`
   for the `data-antiforgery` token, POST the file as `file` with `__RequestVerificationToken` to
   `/api/replays/upload`. It reports back by navigating to `tmhub-upload:<nonce>#<json>` (caught and
   cancelled by the webview's navigation handler) with only: stage, HTTP status, "has token", track id/name and
   TMX's error text. Link in the history: `https://<exchange>/trackshow/<id>`.
4. **Signed out**: TMX answers `/replayupload` with **401** but the page still carries an antiforgery token,
   so "no token" alone is not the sign-in test; 401/403 is.

## Queue survives a restart

`<local app data>\tmx-upload\queue.json` (job metadata: game, map, time, state, attempts, next try, the mod's
job id) and `cache\<sha256>.Replay.Gbx` (a copy of every waiting replay, so jobs the mod handed over through
its bridge, which exist only in memory, can continue without the mod). Written whenever the queue changes. At
start the jobs come back: an interrupted upload waits again, a retry keeps its attempts and time, a mod job is
not taken a second time when the mod re-offers it, and the mod hears the result once the job is done. Limits:
100 jobs, 256 MB of replays, 7 days; what falls out (also a missing or changed cache file) is dropped with a
"skipped" line in the history. Finished jobs delete their copy.

## Handover with the browser extension (TMX Universal Track Downloader)

While at least one switch is on, TM Horizon serves `GET /v1/uploader` on the first free port of
127.0.0.1:27321–27325:

```json
{ "app": "tm-horizon", "version": "0.3.0-beta.1", "uploading": true,
  "sites": ["tmnf.exchange"], "last": { "at": 0, "map": "A01", "site": "tmnf.exchange", "ok": true,
  "result": "ok", "detail": "Uploaded to A01-Race", "link": "https://tmnf.exchange/trackshow/1" } }
```

Loopback only, `Host` must be 127.0.0.1/localhost (a DNS-rebound page carries its own domain), no CORS
header. With every switch off the port is closed. The extension's bridge probes these ports before it
talks to the mod: when TM Horizon answers `uploading:true` it does not pull jobs from the mod, and its
/replayupload card says "Connected via TM Horizon". Without TM Horizon it works standalone as before. So
exactly one of them pulls jobs and nothing is uploaded twice.

## Competition Patch 2.0

TMX requires Competition Patch 2.0 for TMNF/TMUF replays from 2026-11-19. CP 2.0 stores a server-signed,
encrypted block inside the replay, and TMX checks it on upload (donadigo.com/tmcp: "The input and
signature validation is performed on TMX when the replay is uploaded"). The format is not documented, so
TM Horizon **cannot tell from the file** whether a run was driven with CP 2.0 and does not skip anything for
it; the UI says so, and TMX's refusal text lands in the history. A safe pre-check would need donadigo to
document a marker.

## Privacy

- No passwords, cookies or tokens leave WebView2. Rust never reads cookies; the antiforgery token is read
  and used only by the script inside the exchange page and is not sent back.
- The replay file itself goes only to the exchange the game belongs to (https, its own origin).
- Stored in `<config>\tmx-upload.json`: the switches, the mod's pairing key (a loopback secret the mod hands
  out after Allow, like the extension keeps it), the history (last 100) and SHA-256 hashes of handled
  replays. Nothing goes to any TM Horizon server.

## Tests

`cargo test tmx` (tmxupload, tmxfolder, tmxqueue): queue (gap, one at a time, backoff, sign-in wait, dedupe), answer classification,
replay header, folder scan and host-log parsing, the handover endpoint (rebinding refused, closes when off),
a fake mod bridge (pairing with Allow, 401 re-pair, jobs, results) and a fake exchange (401 signed out,
503 then success, "not faster" refusal). No test talks to a real exchange.
