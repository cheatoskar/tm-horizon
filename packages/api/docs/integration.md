# Integration notes: community servers, submitted events, master server data

For the launcher (`apps/launcher`, Tauri/React) and the website (`apps/web`, Astro). Both already read
`servers.json`; these are the additions and the buttons that link to the issue forms.
Base URL once published: `https://cheatoskar.github.io/tm-hub/` (nothing is deployed yet).
Types: `packages/shared/src/types.ts` (`@tm-hub/shared`; the launcher and the website import it, no copies).

## What changed in the data

`servers.json`

- `servers[].source` can now be `"community"` (registered by the owner, `data/servers/`) or
  `"tmf-master"` (not active yet). Community servers have extra fields:
  - `address`: `"host:port"`; for ESWC, Sunrise and Original this is how players join (no join link).
  - `online`: `true` = the game port answered this hour, `false` = it did not, `null` = not checked
    (login-only entries).
  - `lastSeen`: ISO time of the last build in which the port answered.
  - `language`, `contact` (Discord invite or user name, published by the owner), `homepage`.
  - `players` and `maxPlayers` are `0` for community servers: the check is a TCP connect, the game
    servers have no public info query. Show "online" / "last seen 3 h ago" instead of a player count.
- `masterServers`: ESWC rooms from getservers.php (`name`, `level`, `players`, `servers`, `buddies`).
  Empty until the owner turns the source on (`docs/eswc-masterserver.md`).
- `notAvailable` now has entries for `forever`, `eswc`, `tmo`, `tms`; the launcher's Social page
  reads the `forever` one. Its fixed line "No public server list for Nations and United Forever" should
  change to: community servers are listed, the master server list needs a login.
- Sample Forever servers only appear while no TMNF/TMUF server is registered.

`events.json`

- `events[].source`: `"discord"`, `"submitted"` (issue form) or `"sample"`.
- Submitted events: `community.name` is the host, `community.invite` its link, `url` the event link,
  `join` the parsed join link, `address` set when the event is on an ESWC/Sunrise/Original server.
  Past events are gone after the next hourly build.
- Sample events only appear while there is no real event at all.

`hub.json`: `counts.playersOnline` includes the ESWC room players once that source is on.

## Buttons: "Add your server" and "Submit event"

Both open a GitHub issue form in the browser (a GitHub account is needed; nothing runs on our side).
Issue forms take query parameters named after the field ids, so the launcher can fill in what it knows:

```
https://github.com/cheatoskar/tm-horizon/issues/new?template=server.yml&title=Server%3A%20<name>&name=<name>&address=<ip:port>&login=<login>&mode=<mode>&language=<code>
https://github.com/cheatoskar/tm-horizon/issues/new?template=event.yml&title=Event%3A%20<name>&name=<name>&date=2026-11-21&time=19%3A00&timezone=Europe%2FBerlin&duration=2h&host=<community>&join=<link>
```

| Form | Field ids |
| --- | --- |
| `server.yml` | `game` (dropdown), `name`, `address`, `login`, `mode`, `language`, `description`, `contact`, `homepage` |
| `event.yml` | `name`, `games` (dropdown, several), `date`, `time`, `timezone`, `duration`, `host`, `host_link`, `join`, `description`, `link` |

- Encode every value with `encodeURIComponent`. Text fields and text areas take prefilled values; whether
  a dropdown accepts one (`game=TrackMania%20Nations%20Forever%20(tmnf)`) must be checked once the
  repository is public. If not, leave it to the user.
- `title` is the issue title (the forms start it with "Server: " / "Event: "); the event's own name is `name`.
- `timezone`: `Intl.DateTimeFormat().resolvedOptions().timeZone` gives the user's zone name.
- Launcher "Host a server" wizard (roadmap phase 2): after the server is up, the wizard can open the
  server form with `address`, `login`, `name` and `mode` filled in.
- Website: a "Submit event" button on `/events/` next to "Run events? Add your Discord", and an
  "Add your server" button on the servers section. Say in one line that entries are checked by hand
  and appear after a maintainer approves them (usually within a day, depends on us).

## Showing community servers

- Join button: `servers[].join` when it is set (`tmtp://`, `maniaplanet://`). For ESWC, Sunrise and
  Original show `address` with a copy button and a short hint ("Join by address in the game's network
  menu"; exact menu path still to confirm, see `docs/eswc-masterserver.md`).
- Status dot: green `online: true`, grey `online: false` with "last seen …" from `lastSeen`,
  no dot for `null`.
- Label: "Community" for `source: "community"`, so nobody expects live player counts.
- `contact` and `homepage` are owner-supplied links: open in the system browser, never inside the app's
  webview, and show the domain.
