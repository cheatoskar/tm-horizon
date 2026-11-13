# TM Horizon data pipeline (packages/api)

The data behind the TM Horizon launcher and website: one script gathers mods, GitHub projects,
exchange maps, live servers, community events and the resource catalog from their real
sources into static JSON files. No server runs; a scheduled GitHub Action rebuilds the files
every hour and publishes them on GitHub Pages. Server owners and event hosts add their entries
through GitHub issue forms (see [Community registry](#community-registry)).

```
npm ci
npm run build      # -> dist/hub.json, mods.json, projects.json, maps.json, events.json, servers.json, catalog.json, communities.json
npm test           # parser tests on recorded fixtures, plus dist/ against schema/ when it exists
```

Node 24 runs the TypeScript directly (type stripping), so there is no compile step;
`npm run typecheck` runs `tsc --noEmit`. Other scripts: `npm run schema` (regenerate
`schema/*.json` from `packages/shared/src/types.ts`), `npm run record-fixtures` (re-record `test/fixtures/`).
Build flags: `--pretty`, `--strict` (exit 1 on warnings), `--offline` (cache only).

Every source is optional. A failing source becomes a warning (in the console, in
`hub.json` `warnings` and in each file's `sources`), and the other files still build. Only
when every network source comes back empty does the build exit 3, so CI keeps the last
published data.

## Output

| File | Content | Real or sample |
| --- | --- | --- |
| `hub.json` | Index: `generated`, counts, players online, per file `count` and `sample`, warnings | |
| `mods.json` | TMLoader mods: id, name, author, description, homepage, icon, games, category, versions with changelog, dependencies, download URL, size, SHA-256 | real |
| `projects.json` | GitHub repositories: stars, forks, licence, newest release with assets | real |
| `maps.json` | Per game the 8 most recently awarded and the 8 newest maps from the Exchange sites | real |
| `events.json` | Discord scheduled events of member communities, approved event submissions | real with `DISCORD_BOT_TOKEN` or submissions, else sample |
| `servers.json` | ManiaPlanet servers, Trackmania (2020) club rooms, registered community servers (all old games) with reachability, ESWC master server rooms | real; sample Forever servers only while none is registered |
| `catalog.json` | The researched catalog (`packages/catalog/catalog.json`), normalised | real |
| `communities.json` | Discord servers of the community directory (Google Sheet by mx_eyebo): group, region, invite, members, online, alive or expired, credit line | real |

Every list file has `schemaVersion`, `generated` and `sources` (one status per source:
`ok`, `count`, `sample`, `cached`, `error`). Sample items always carry `"sample": true`;
sample events and servers also start their name with "Sample:".

Types: `packages/shared/src/types.ts` (`@tm-hub/shared`; the launcher and the website import it). JSON Schema:
`schema/<file>.json`, generated from the types (`npm run schema`); the tests validate the
parsers' output and `dist/` against them.

## Sources

### 1. Mods: TrackMania ModLoader (TMLoader) repositories

- Repository list: `config/hub.config.json` `modloader.servers`, plus the `servers:` of
  `%LOCALAPPDATA%\TMLoader\config.yaml` when it exists (read only), plus the list the
  TMLoader masterserver publishes (`https://modloader.tomashu.dev/modloader/v1/index.json`).
- Format: `GET <server>/index.json` →
  `{ "api": 1, "game": "TmForever", "products": { "<id>": { name, author, type, description, icon_link, homepage, external?, versions: { "<version>": { executable, dependencies: [{ id, version? }], download_link, hash_sha256, changelog, priority? } } } } }`.
  The masterserver's index has `servers` and TMLoader's own `versions` instead of `products`.
- Mods listed by mirrors (Tomashu's two hosts) are merged; `repositories` lists all of them.
- Category: derived from type, id, name and description (VR, TAS, competition, editor,
  graphics, HUD, library, else tools); `modloader.overrides` sets category or games by hand.
  Games come from the index's `game` (`TmForever` → tmnf, tmuf) unless overridden.
- SHA-256 and size: the newest version of each mod is downloaded once and hashed while
  streaming (nothing is stored). The result is cached by URL; after `fileRecheckHours` (24)
  the file is revalidated with `If-None-Match` / `If-Modified-Since`, and a 304 keeps the
  hash. A hash that differs from the index's `hash_sha256` sets `hashMismatch` and warns.
  First build: about 21 MB for 8 files; later builds: at most one small request per file a day.

### 2. Projects: GitHub

- Repositories: every GitHub link in the catalog plus `github.repos` in the config.
- Two requests per repository: `GET /repos/{owner}/{repo}` and
  `GET /repos/{owner}/{repo}/releases?per_page=10` (newest non-draft release; a stable one
  wins over prereleases). Renamed repositories (redirects) are merged.
- Limits: without a token 60 requests/hour per IP; responses are cached for 3 hours and
  revalidated with ETags, and the source stops asking (cached copies only) when fewer than 6
  requests remain. With `GITHUB_TOKEN` (set automatically in Actions, 1,000 requests/hour per
  repository) the cache time drops to 55 minutes.
- Docs: https://docs.github.com/en/rest/repos/repos, https://docs.github.com/en/rest/releases/releases

### 3. Maps: Trackmania Exchange family

- API v2, docs at https://api2.mania.exchange (method list as JSON:
  https://api.mania.exchange/api/methods). Track sites (TMO-X, TMS-X, TMN-X, TMNF-X, TMUF-X)
  use `GET https://<site>/api/tracks?fields=...&count=8&order1=...`, map sites (TM2.MX per
  title pack, SM.MX, TMX for Trackmania 2020) `GET https://<site>/api/maps?...`. `fields=` is
  required; `/api/tracks/fields` lists the fields, `/api/meta/trackorders` and
  `/api/meta/maporders` the orders.
- Lists: `awarded` = most recently awarded (tracks `order1=26`, maps `order1=40`), `latest` =
  newest uploads (tracks `order1=2`, maps `order1=6`). The Exchange API has no "featured"
  filter that I found, so there is no featured list.
- Links built per map: page `/trackshow/{id}` or `/mapshow/{id}`, thumbnail
  `/trackshow/{id}/image/1` or `/mapthumb/{id}`, download `/trackgbx/{id}` or `/mapgbx/{id}`.
  Launchers and the website should link to or download from the Exchange directly; this
  build copies no map files or images.
- Etiquette: a descriptive `User-Agent` (`TM-Horizon-hub (+https://tm-horizon.com)`, no
  email or personal data; the API requires one), 22 requests per build, sequential and one
  second apart, cached for 55 minutes. The docs give no numeric rate limit and ask for
  caching and for only the fields needed.
- **Ask the Mania Exchange team before this goes public** (hourly polling from a public
  project, hotlinked thumbnails, download links in a launcher). Terms: https://mania.exchange/tac

### 4. Events: Discord scheduled events

- `GET https://discord.com/api/v10/guilds/{id}/scheduled-events?with_user_count=true` with
  `Authorization: Bot <DISCORD_BOT_TOKEN>`, one request per guild listed in
  `discord.guilds`, cached 25 minutes. Docs: https://discord.com/developers/docs/resources/guild-scheduled-event
- A `tmtp://#join=login[:password]`, `tmtp://#join=ip:port` or
  `maniaplanet://#join=login@Title@author` link in the location (or the description) becomes
  `join` (scheme, action, target, title, password).
- Creator ids are dropped; only scheduled and running events are kept.
- Without a token or guilds: four sample events (`"sample": true`).
- How a community adds the bot, the minimal invite (scope `bot`, permissions `0`) and what
  is read: [docs/discord-bot.md](docs/discord-bot.md).

### 5. Servers

| Game | Source | Status |
| --- | --- | --- |
| All old games (Original, Sunrise, ESWC, TMNF, TMUF, TM2, ShootMania) | Community registry `data/servers/*.yaml`, see below | real; TCP connect to the game port each build, `online` / `lastSeen` |
| Nations ESWC | `GET https://game.trackmanianations.com/online_game/getservers.php?ver=0.1.7.9&lang=en` (no login, TLS 1.0) | master server rooms with player and server counts in `masterServers`; **off** until a live test, see [docs/eswc-masterserver.md](docs/eswc-masterserver.md) |
| TM2 Canyon/Stadium/Valley/Lagoon, ShootMania, custom titles | `GET https://www.maniaplanet.com/webservices/servers/online?length=100&offset=0` (public, sorted by players) | real, 1 request, cached 10 min; join link `maniaplanet://#join=<login>@<title>` |
| Trackmania (2020) | `GET https://trackmania.io/api/rooms/0` (club rooms, 50 per page) | real, 1 request, cached 10 min; undocumented API, **ask the trackmania.io maintainer before going public** |
| Trackmania (2020), first hand | Nadeo Live Services, https://webservices.openplanet.dev/live/clubs | not used: needs a Ubisoft or dedicated-server account token |
| TMNF / TMUF | Forever master server (`request.php`, after github.com/Laiteux/TMF.NET) | needs `TMF_LOGIN`/`TMF_PASSWORD` **and** a confirmed list request; envelope, session and parser are built, nothing is requested yet, see [docs/tmf-masterserver.md](docs/tmf-masterserver.md) |
| Original / Sunrise | none | no online service known to work (game.trackmania.com is reported offline; I found no dated confirmation either way); community registry only |

`servers.json` `notAvailable` says the same for the UI.

### Community registry

Server owners and event hosts add entries themselves; no server of ours is involved.

- **Issue forms**: `.github/ISSUE_TEMPLATE/server.yml` ("Add your server": game, name, address
  `host:port` or server login, mode, language, description, Discord, website) and `event.yml`
  ("Submit event": name, games, date, time, time zone, duration, host community, join link or
  address, description, link). The launcher and website open them prefilled, see
  [docs/integration.md](docs/integration.md).
- **Approval**: a maintainer adds the label `approved`. `.github/workflows/registry.yml` runs
  `scripts/issue-to-yaml.ts` (parses the form, validates, picks a free id) and opens a pull request
  with `data/servers/<id>.yaml` or `data/events/<id>.yaml`. Invalid input gets a comment on the issue.
  Repository setting needed: Settings > Actions > General > "Allow GitHub Actions to create and
  approve pull requests". Merging the pull request publishes the entry with the next hourly build.
- **By pull request**: add the YAML file directly; the root `ci.yml` and the tests check every file.

```yaml
# data/servers/100-tmx-eswc.yaml
id: 100-tmx-eswc            # = file name; lowercase, digits, dashes
game: eswc                  # tmo, tms, eswc, tmnf, tmuf, tm2-canyon/-stadium/-valley/-lagoon, sm-storm
name: 100% TMX ESWC
address: 203.0.113.40:2352  # required for tmo, tms, eswc (join by address); public addresses only
login: null                 # TMNF/TMUF/ManiaPlanet server login, gives tmtp://#join=login
mode: TimeAttack
language: en                # code or "multi"
description: Random unfinished TMX maps.
contact: https://discord.gg/xxxx   # optional, public
homepage: null
```

```yaml
# data/events/2026-11-21-forever-night-cup.yaml
id: 2026-11-21-forever-night-cup
title: Forever Night Cup
games: [tmnf, tmuf]
start: 2026-11-21T19:00:00+01:00   # ISO 8601 with offset (the form converts zone names)
durationMinutes: 120
host: Night Racers
hostLink: https://discord.gg/xxxx
join: tmtp://#join=nightcup        # or host:port
description: Five night maps.
link: https://example.org/rules
```

- **Reachability** (`src/sources/community.ts`): one TCP connect to the game port per server and
  build, 3 s timeout, 16 at a time; nothing is sent, no login. Host names are resolved first and
  private, loopback and reserved addresses are never contacted (they are also refused when the entry
  is validated). `lastSeen` survives between builds in `.cache/community-seen.json`. Login-only
  entries are not checked (`online: null`). The TrackMania dedicated servers have no unauthenticated
  info query that I could confirm (gamedig's `nadeo` protocol logs in on the XML-RPC port), so player
  counts stay 0.
- **Join links**: TMNF/TMUF `tmtp://#join=<login>` or `tmtp://#join=<ip>:<port>`; TM2/ShootMania
  `maniaplanet://#join=<login>@<title>`; ESWC, Sunrise, Original: no link (the ESWC exe has no
  `tmtp://` handler), `address` instead.
- **Events**: `source: "submitted"`, `end = start + durationMinutes`; ended events are left out at
  build time. Sample events are only used while there is no real event.

### 6. Catalog

`packages/catalog/catalog.json` passed through: known keys only, unknown game ids dropped, empty
strings to `null`, entries without id, name or a known category dropped (a missing url is only
allowed for files that live in a Discord post, `hosting: "discord-attachment"`), the mod fields
(`author`, `modType`, `install`, `requires`, `hosting`, `urls`, `note`) kept, and `github`
(`owner/repo`) added when the url or api is a repository. The build reads the first file
that exists of `catalog.paths` (`../catalog/catalog.json`, the catalog package of this monorepo),
then `catalog.url`.

### 7. Communities: Discord server directory

- List: the public Google Sheet kept by mx_eyebo (Mania Exchange),
  https://docs.google.com/spreadsheets/d/1Rr581P5Icd5_-bYypVLaUDqi1pdMGbBNM-E7Bapz_ME/ ("To add servers to the list
  contact mx_eyebo on Discord"). The build downloads its xlsx export (`.../export?format=xlsx`, which keeps the
  hyperlinks), cached 24 hours, and reads it with `src/lib/zip.ts` + `src/lib/xlsx.ts` (no dependency).
- Layout: sheet "Active Servers" has one column group per category (Official, Countries & Regions with Europe /
  North America / ..., Communities, Teams, People, Creators, Events, Projects), each with sub-sections headed
  "Checked on <date>"; sheet "The Archive" holds Retired / Completed / OnHiatus and Inactive Servers
  (`active: false`). Cells with a hyperlink are servers, cells without one are ignored. If the layout changes so that
  no link is found, the source fails with a warning instead of writing an empty list.
- Per Discord invite: `GET https://discord.com/api/v10/invites/<code>?with_counts=true` (public, no token), one
  request per second, sequential, 429 waits for `Retry-After`. 200 gives `guildName`, `members`
  (`approximate_member_count`), `online` (`approximate_presence_count`); 404 means the invite expired
  (`alive: false`). Answers are kept 24 hours in `.cache/discord-invites.json`; each build looks up at most
  `communities.maxLookupsPerBuild` (150) invites, oldest first, so the first run fills the cache over a few hourly builds
  and no build runs long. Entries without an answer have `alive: null`.
- Output `communities.json`: `communities[]` (shape `Community` in `packages/shared/src/types.ts`), `credit`
  (`List by mx_eyebo / Mania Exchange` and the sheet link) and `suggest` ("To add a server, contact mx_eyebo on Discord.").
  Show the credit and the note wherever the list is shown.
- The catalog keeps its own community entries (including some not in the sheet). Where a catalog entry's old invite
  was dead and the sheet has the same server, the catalog's invite was replaced by the sheet's one (in
  `packages/catalog/build_catalog.py` and `catalog.json`), so a catalog rebuild keeps it.
- **Ask mx_eyebo before this goes public**, see [docs/ROADMAP.md](docs/ROADMAP.md).

## Secrets and permissions

| What | Needed for | Without it |
| --- | --- | --- |
| `GITHUB_TOKEN` | higher GitHub limit | set by Actions automatically; locally optional (60 requests/hour, cached) |
| `DISCORD_BOT_TOKEN` + `discord.guilds` | real events | sample events (or only submitted events) |
| `TMF_LOGIN` + `TMF_PASSWORD` | TMNF/TMUF master server list (not active until the list request is confirmed) | skipped, log line |
| `ESWC_LOGIN` (+ `ESWC_PASSWORD`, unused so far) | `&login=` on getservers.php, as the game sends it | getservers.php without login (it needs none) |
| `servers.eswcMaster.enabled` (config) | ESWC master server rooms | off; turn on after the live test in docs/eswc-masterserver.md |
| Permission from Nadeo/Ubisoft (or at least no objection) | polling the old ESWC/TMF master servers hourly | keep both off |
| Permission from the Mania Exchange team | going public with `maps.json` | keep it private / local |
| Permission from trackmania.io | going public with TM2020 rooms | set `servers.trackmaniaIo.enabled` to false |
| Nadeo account token | first-hand TM2020 rooms | trackmania.io mirror |

No source needs a login otherwise; all requests are plain GETs with the TM-Horizon User-Agent, plus
one TCP connect per registered community server.

## Requests and cache

A cold build makes about 80 requests (8 TMLoader indexes + 1 masterserver, 8 mod
downloads, about 36 GitHub, 22 Exchange, 2 servers; my first run: 79) and downloads about 21 MB of mod files.
The cache in `.cache/` (git-ignored; restored between Actions runs with `actions/cache`)
keeps response bodies with their ETag / Last-Modified and the download hashes. Each source
has a time to live (`ttlMinutes`); within it no request is made, after it the request is
conditional. When a request fails, the last cached copy is used and the status says
`cached: true`. An hourly build in Actions makes about 70 requests: the GitHub and TMLoader ones mostly
answer 304, the 22 Exchange ones (no ETag) a few kilobytes each, the mod files are rechecked
once a day. A rerun within the cache times makes none.

## Publishing

`.github/workflows/hub-data.yml` (repository root) runs hourly (minute 17), on pushes to `main` and by hand.
The root `ci.yml` typechecks and tests every pull request; `registry.yml` turns approved issues into
pull requests. It
typechecks, builds, runs the tests (which validate `dist/` against the schemas), adds
`schema/` and `types.ts` to `dist/` and deploys `dist/` to GitHub Pages. Repository setting
needed: Settings > Pages > Source: GitHub Actions. Optional secrets: `DISCORD_BOT_TOKEN`,
`TMF_LOGIN`/`TMF_PASSWORD`, `ESWC_LOGIN`. Labels to create: `server`, `event`, `approved`.
Nothing of this has been deployed yet.

## Using the data

Base URL once published: `https://<owner>.github.io/tm-hub/`. GitHub Pages sends
`Access-Control-Allow-Origin: *` and ETags, so browsers and the launcher can fetch directly.

Launcher (Tauri / React):

```ts
import type { HubIndex, ModsFile } from '@tm-hub/shared'; // workspace package in this monorepo

const BASE = 'https://<owner>.github.io/tm-hub/';
const hub: HubIndex = await (await fetch(BASE + 'hub.json', { cache: 'no-cache' })).json();
if (hub.generated !== localStorage.getItem('hub.generated')) {
  const mods: ModsFile = await (await fetch(BASE + 'mods.json')).json();
  // compare installed TMLoader versions with mods[].latest, verify downloads with versions[].sha256
}
```

- Fetch `hub.json` first (half a kilobyte), then only the files whose data you show.
- Keep the last good copy and a copy bundled with the release, for offline starts.
- Hide or label items with `sample: true`; `hub.files.<name>.sample` says whether a file has any.
- Mod downloads: use `versions[].download` and check the file against `sha256`
  (computed here) and `sha256Index` (stated by the repository).
- Join buttons: `servers[].join` and `events[].join.raw` are game links (`tmtp://`, `maniaplanet://`);
  without one, show `address` (ESWC, Sunrise, Original join by address).
- Community servers, submitted events and the "Add your server" / "Submit event" buttons:
  [docs/integration.md](docs/integration.md).

Website (Astro): fetch the JSON at build time (or in the browser for live counts) and import
the types the same way; `catalog.json` replaces the copy in `src/data/`.

## Layout

```
config/hub.config.json   sources, repositories, overrides, cache times
src/build.ts             entry point (npm run build)
src/types.ts             re-export of @tm-hub/shared (output shapes, imported by launcher and website)
src/lib/http.ts          GET client with disk cache, ETag revalidation, download hashing
src/sources/*.ts         one module per source: a pure parse function + a build function
src/lib/registry.ts      validation of registry entries, join links, time zones
src/lib/issue-form.ts    issue form body -> registry entry
scripts/issue-to-yaml.ts approved issue -> data/servers or data/events (registry.yml)
schema/*.json            JSON Schema per output file (generated)
test/fixtures/           small recorded real responses (Discord, ESWC, TMF, issues: hand-written)
data/catalog.json        catalog snapshot for CI
data/servers/, data/events/  community registry (one YAML file per entry)
.github/ISSUE_TEMPLATE/  "Add your server" and "Submit event" forms
docs/discord-bot.md      bot setup for communities
docs/eswc-masterserver.md, docs/tmf-masterserver.md  master server findings and the owner's test steps
docs/integration.md      notes for the launcher and the website
docs/ROADMAP.md          phases and permissions
```
