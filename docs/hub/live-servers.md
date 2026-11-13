# Live server list

The hub keeps a live list of TrackMania game servers (Nations Forever, United Forever, Nations ESWC; Sunrise and
Original work the same way). It asks every listed server **directly on its own public game port**, the same query the
launcher uses (`apps/server/src/services/tmquery.ts`, port of `serverquery.rs`). It never logs in to a Nadeo or Ubisoft
master server, uses no account or game key, and only stores what a server tells everybody who asks.

## Poller (`apps/server/src/services/serverpoll.ts`)

- Started from `main.ts` (a tick every 10 s; switch `SERVER_POLL=0` turns it off). Each listed server (`approved` or
  `verified`, address known) is asked **once every 90 s**.
- Timeout 3 s, no second connection after a timeout, 5 queries at a time at most, own pacing (not the 30-per-minute
  cap of the submission checks).
- Failures back off: 3 min, 6 min, then 10 min. After 3 failures in a row the server shows as `offline`. It stays in
  the list and is polled every 10 min; when it answers again it is `online` at once. The 14-day soft removal of the old
  re-check job does not apply to seeded servers; nothing is ever deleted.
- Servers with nobody on them are asked every 5 min instead (back to 90 s at the first poll that sees a player).
- The next poll time is written to the database *before* the query (`game_servers.next_poll_at`), so restarts and
  crashes never cause extra queries.
- `141.144.230.233` (the separate 100% TMX box) is never contacted, whatever name leads to it (`NEVER_QUERY` in
  `tmquery.ts`). `game.100tmx.com` currently resolves to that address, so the two 100% TMX entries are listed
  without live data (Join works by login).
- Stored per server: name, map, mode, players / max, spectators, password flag, ping from the hub (connect + answer),
  last time it answered (`last_ok_at`), country (from the seed, the query has none). The query does not return a zone.
- TMNF or TMUF: both answer alike except for the title pack in the answer (`Stadium` = Nations, `United`); the poller
  sets `game` from it.

## API

`GET /v1/servers[?game=tmnf|tmuf|eswc|tms|tmo]`, public, no login, `Cache-Control: public, max-age=60`, CORS open.
On production nginx the exact path `/v1/servers` is open without the password. Array, online servers first, most
players first, then unknown (no live data), then offline. Fields: `game, address (null = unknown), login, name,
homepage, state (online|offline|unknown), online, players, maxPlayers, spectators, map, mode, password, country, zone,
pingMs, lastSeen, announcedAt, suggested`. A newer announcement of the operator's plugin wins over the poll.

## Seed list

`apps/server/seeds/server-seeds.json` (made from the owner's list `seed-2026-11-12.md`: 103 TMNF/TMUF servers with
`ip:port` and login, 16 Nations ESWC servers, 15 of them by login only). Import (idempotent, matched by login, entries
somebody else already owns are left alone):

```sh
scripts/deploy-prod.sh <branch> --no-web --seed-servers      # on production
npm run import-server-seeds -w @tm-hub/server                # local
```

Seeded entries are `approved`, without owner or token, contact `seed`, `source=seed`. ESWC entries without an address
have `address = ''`: the website shows name, login and country with the text "In-game: Internet -> search <login>".
Not imported: `nsf_luckylol` (shares the port `5.175.222.165:7012` with `nsf_fullspeed`).

## Website and launcher

- Website: `/servers/` (all four languages; the old redirect to /discover/servers is gone), fetches the list when it opens and then every 60 s. Filter per game,
  search, `tmtp://#join=<login>` button for TMNF/TMUF, JoinGuide text for ESWC. Build time `PUBLIC_HUB_URL`.
- Launcher: the release build (Launcher Preview) now reads this list, read only (list and Join, no registration), from
  the production hub through the Rust command `hub_live_servers`. The direct per-server query of the launcher stays.

Tests: `apps/server/test/serverpoll.test.ts` (fake servers on 127.0.0.1), `tmquery.test.ts`.
