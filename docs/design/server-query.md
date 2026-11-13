# Live server status (game query)

The launcher can show who is on a TrackMania server (name, players, mode, current map, password,
ping) without any login and without Nadeo's master server. It asks each server directly with the
game's own server query, the same one the game's server browser uses.

Code: `apps/launcher/src-tauri/src/serverquery.rs` (query, parser, list of known servers, rate limits,
commands), `lzo1x.rs` (decompressor), `src/data/serverQuery.ts` and `src/ui/LiveServers.tsx` (UI).
Shown on the Servers page, on the Nations ESWC, Sunrise and Original game pages, and switched on or
off in Settings > Servers.

## What it does and what it does not

- It gives the **status of servers whose address I already know**. It cannot find servers.
  Discovery needs a list of addresses: the hub list, a player pasting an address, or the
  seed servers that come with the launcher (five public TMNF servers seen in a server list on
  2026-11-11, marked "seed (may be outdated)").
- Real discovery: server operators register their server on the website ("Add your server"), an admin
  approves it, the signed hub index carries it and the launcher shows it as "Community" (and an optional
  XAseco plugin announces the server every 5 minutes). See docs/hub/server-registration.md. Without a hub the
  list is what the player adds plus the seeds.
- Games: TMNF and TMUF (protocol "TmForever"), Nations ESWC, Sunrise and Original (the older protocol).
  The registry says which game a server belongs to; the launcher does not guess (Original and Sunrise
  answer the same way and only differ in how map decorations are named).

## Protocol in short

TCP to the game port (default 2350). All integers are little-endian.

1. Send two messages in one write: ConnectionAdmin (message type 3) with subtype 8 (query mode) and
   subtype 7 (info request with a random request id). Each message is `u32 length`, flags `0x82`,
   type, `u32 checksum`, payload `u32 version, u32 subtype [, u32 request id]`.
   Version is 7 for TMNF/TMUF, 4 for Original and Sunrise, 5 for Nations ESWC. A legacy server that
   refuses our version answers with subtype 1 and its own version; we ask once more with that.
2. Read frames by their length prefix until type 3, subtype 6 with our request id (other frames are
   skipped; request id `0xFFFFFFFF` with no data means the server has no game info yet).
3. Checksum: `HMAC-MD5(key, message with the checksum field zeroed)` as four `u32` words.
   TMNF/TMUF: key `b89dd780726b21ba98954315fa1cece1`, checksum = sum of the four words.
   Legacy games: key `08c481303a1226abaf1d6ae4fb65fbc9`, checksum = words 0 + 1 + 2 + the first key word.
   A reply without a valid checksum is rejected. That is the main proof that the other side is a
   TrackMania server.
4. Flag `0x01`: the payload is `u32 size` + an LZO1X stream. `lzo1x.rs` decompresses it (every read and
   copy is bounds-checked, output capped at 4 MiB).
5. Server info: game tag (`0x2D` Forever, `0x07`/`0x09` legacy), reported address, host login,
   `#SRV#` plus password flag (`p` player, `s` spectator, `f` both), player and spectator counts and
   slots, ladder mode, server name (TM format codes, UTF-8, BOM when not ASCII), comment, players,
   game mode (1 TimeAttack, 3 Rounds, 6 Team, 7 Laps, 8 Stunts, 9 Cup) with its limit (ms, laps or
   points) and a window of at most 20 maps starting with the **current** map. Map names are cut to 15
   characters by the server. Forever adds pack mask and environment names; legacy maps carry a
   decoration index that becomes environment and mood by a fixed table per game.

Limits that come from the protocol, not from my code: at most 20 maps, 15 characters per map name,
`nbMaps` capped at 255, the host login is what `tmtp://#join=` takes for dedicated servers (on LAN
servers it is the computer name), no player list beyond the nicknames the server sends.

## Joining

- TMNF/TMUF: Join starts the game with `tmtp://#join=<host login>` (the login the server reports),
  only when the login is a plain login string. A server with a password asks for it in the game.
- Original, Sunrise, Nations ESWC: the launcher has no way to start the game on a server. The row
  shows "Copy" for the address, like the existing community entries.

## Load on the servers and on the network

- At most 4 connections at once (all games together, one poll at a time).
- Never more than one query per server per 30 s, even when the player presses refresh.
- The page asks every 60 s while it is open and the window is visible; nothing runs in the background.
- A server that fails once is asked again next round; after two failures in a row it is left alone for
  10 minutes (refresh by hand ignores the pause, not the 30 s gap).
- Timeouts: 3 s to connect, 4 s for the answer; frames above 1 MiB are refused.
- The servers see the player's IP address, like with a join. The setting in Settings > Servers turns
  the whole thing off; the setting and the list of servers are stored in `server-registry.json` in
  the launcher's data folder. Nothing is sent to Nadeo or to a hub.

## Known servers

`server-registry.json`: `{ enabled, servers: [{ game, address, name, source }], seedsRemoved }`.
Add by pasting `ip`, `ip:port`, `host:port` or a `tmtp://#join=...` link. A link or text that holds only a
server login is refused with the message that the address is needed. Export and import use a plain JSON
text (`format: "tm-horizon-servers"`), at most 500 servers. A removed seed does not come back until
"Restore defaults".

## Tests

`cargo test --lib serverquery lzo1x` (in `apps/launcher/src-tauri`): MD5/HMAC known answers, the two
request messages byte for byte against the game client's, the real captures (TMNF in-game server, TMNF
dedicated server, Sunrise server with 54 maps) through checksum, LZO and parser, built legacy
infos with all password flags and wrong tags, corrupted and truncated input, fake TCP servers (extra
frames, stale answers, no game info, version switch, silent server, dead port, garbage), the scheduler
(parallel limit, 30 s gap, 10 minute pause) and the address and registry rules.
`cargo test --lib live_seed_servers -- --ignored --nocapture` asks the five seed servers once each over
the real network (not part of CI).

## Sources and licences

- Protocol notes (reverse engineering of the dedicated server binaries, with byte examples):
  `lan-dot-party/game-protocols`, files `Trackmania-Nations.md` (TmForever) and `Trackmania-Sunrise.md`
  (Original, Sunrise, ESWC). The repository has **no licence**, so nothing was copied: the query,
  parser and LZO decompressor are written from the description, and the byte examples serve as
  tests (facts about the protocol).
- opengsq-python (`opengsq/opengsq-python`, MIT, Copyright (c) 2021 OpenGSQ): test vectors (real
  captures) and test scenarios were taken over into `serverquery_vectors.rs` and the tests, with
  this notice. Permission is granted by the MIT licence to use, copy and modify the software and
  associated files, provided the copyright notice and permission notice are included. Its code was
  read as a cross-check, not ported.
- LZO1X is a public format; the decompressor is my own implementation and shares no code with the
  GPL `liblzo2`.
- `docs/legal/permissions.md` has the rows for both sources and for querying game servers.
