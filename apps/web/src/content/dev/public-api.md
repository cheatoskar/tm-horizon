---
title: "Public API"
group: "api"
order: 1
synced: false
editUrl: "https://github.com/cheatoskar/tm-horizon/edit/main/apps/web/src/content/dev/public-api.md"
note: "The API is young. Fields get added, but a field that exists is not removed or changed without a new schema version. Everything under /v1/me and /v1/admin, and the write calls of the dev portal, is not public and can change at any time."
---

TM Horizon has two public data sources: the **hub server** (live, JSON over HTTPS) and the **static data files** (rebuilt every hour, served from GitHub Pages). The launcher and this website read the same ones.

In the examples `$HUB` is the base URL of the hub server, the same host the dev portal runs on. The hub's public address is not fixed yet. Until it is, run the server yourself (`apps/server`, see its README) or use the static files.

## Hub server

No key and no login for the read calls. Every answer is JSON. Errors have one shape, `{ "error": "<code>", "message": "..." }`, with the matching HTTP status.

| Call | What it returns | Cache |
|---|---|---|
| `GET /v1/projects` | Search the listed projects | none |
| `GET /v1/projects/:slug` | One project: description, gallery, links, showcase, latest version | none |
| `GET /v1/projects/:slug/versions` | Published and revoked versions of a project | none |
| `GET /v1/index.json` | The signed index the launcher reads | 60 s |
| `GET /v1/index/keys` | The public key(s) that sign the index | none |
| `GET /v1/servers` | Approved game servers with their last announcement | 60 s |
| `POST /v1/servers` | Submit a game server for review (public form, CORS open) | none |
| `POST /v1/servers/announce` | Announce players and map of an approved server (token) | none |
| `POST /v1/reports` | Report content (DSA notice) | none |
| `GET /v1/github-projects` | TrackMania repositories found on GitHub and accepted by the hub (`game`, `language`, `q`, `page`, `limit`) | none |
| `GET /v1/openapi.json` | All of this as OpenAPI 3.1 | none |

The full list, including the author calls (`/v1/me/...`, uploading a version, API tokens), is in `/v1/openapi.json`. Author calls need a login session or an API token with the right scope (`projects:read`, `versions:write`).

### API reference (OpenAPI)

`GET /v1/openapi.json` is the complete, machine-readable reference: every call with its parameters, request bodies and the auth it needs (OpenAPI 3.1). Open it on the hub's own address (`$HUB/v1/openapi.json`). It is plain JSON, so import it into Postman, Insomnia or any OpenAPI viewer (for example the Swagger or Redoc online viewers) for a readable page. The hub does not serve a Swagger page of its own.

### Search projects

```bash
curl "$HUB/v1/projects?q=shader&game=tmnf&sort=popular&limit=5"
```

All parameters are optional: `q` (text, up to 100 characters), `game` (a game id such as `tmnf`, `tmuf`, `eswc`, `tm2-stadium`), `category`, `tag`, `install` (install type), `sort` (`popular`, `updated`, `new`, `name`), `page` (from 1), `limit` (1 to 100).

```json
{
  "total": 1,
  "page": 1,
  "items": [
    { "id": "p_...", "slug": "tm-vibrant-shaders", "name": "TM Vibrant Shaders", "summary": "...",
      "author": "...", "claimed": true, "categories": ["graphics"], "tags": [], "games": ["tmnf", "tmuf"],
      "downloads": 0, "updated": "2026-11-10T12:00:00Z", "latest": "1.4.2", "icon": null }
  ]
}
```

Values are shortened. The types are in `packages/shared/src/hub.ts` (`SearchResult`, `HubProject`, `HubVersion`).

### The signed index

`GET /v1/index.json` returns `{ "format": "tmhub-signed-index", "v": 1, "alg": "ed25519", "keyId": "...", "payload": "<base64>", "sig": "<base64>" }`. The payload is the base64 of a JSON document (`format: "tmhub-index"`, `schemaVersion`, `seq`, `generated`, `expires`, `projects`, `servers`, `revoked`). The signature is Ed25519 over the bytes `tmhub-index-v1\n` followed by the decoded payload.

To check it, fetch the keys from `/v1/index/keys` once and pin them. Do not trust a key that arrives in the same answer as the index. Every file of a version carries its `sha256`; a download with another hash must be refused. The launcher also refuses an index whose `seq` is lower than the last good one.

### Game servers

```bash
curl "$HUB/v1/servers"
```

```json
[
  { "game": "tmnf", "address": "203.0.113.5:2350", "name": "Example server", "homepage": "https://example.org",
    "online": true, "announcedAt": "2026-11-11T18:00:00Z", "players": 12, "maxPlayers": 32, "map": "A01" }
]
```

`online` is true when the server announced itself in the last 15 minutes. Otherwise `players`, `maxPlayers` and `map` are `null`. Contacts are never part of the answer.

Announcing from the server (token from the approval, see [Registering game servers](/dev/docs/server-registration/)):

```bash
curl -X POST "$HUB/v1/servers/announce" \
  -H "Authorization: Bearer tmhs_..." -H "Content-Type: application/json" \
  -d '{"name":"Example server","players":12,"maxPlayers":32,"map":"A01","mode":"TimeAttack"}'
```

### Limits

- 300 requests per minute and IP for everything. Over that the answer is `429` with `Retry-After`.
- Announce: one call per 4 minutes per server, 60 per hour per IP.
- Server submission: 5 per hour per IP.
- Project creation: 10 per hour per account.

Use the cache headers, poll the index at most once a minute, and send a User-Agent that says who you are (`my-tool/1.0 (+https://example.org)`).

## Static data files

A scheduled GitHub Action builds these files every hour and publishes them on the GitHub Pages site of the repository (`https://<owner>.github.io/<repo>/`, reachable once the repository is public). GitHub Pages sends `Access-Control-Allow-Origin: *`, so a browser can fetch them directly.

| File | Content |
|---|---|
| `hub.json` | Index: when it was generated, counts, one line per file, warnings. Fetch this first. |
| `mods.json` | TMLoader mods from the public mod servers: versions, dependencies, download URL, size, SHA-256 |
| `projects.json` | GitHub repositories of mods: stars, licence, newest release |
| `maps.json` | Newest and awarded maps per game from the Exchange sites |
| `events.json` | Community events (Discord scheduled events, submitted events) |
| `servers.json` | Servers per game: ManiaPlanet, Trackmania club rooms, registered community servers, ESWC master server rooms |
| `catalog.json` | The researched catalog: where to get each game, mods, tools, sites |
| `communities.json` | Discord communities of the directory: region, invite, members, alive or expired |
| `schema/<file>.json`, `types.ts` | JSON Schema and TypeScript types of all files |

Every list file has `schemaVersion`, `generated` and `sources` (one status per source: `ok`, `count`, `sample`, `cached`, `error`). Items marked `"sample": true` are placeholders and must not be shown as real data.

```ts
const BASE = 'https://<owner>.github.io/<repo>/';
const hub = await (await fetch(BASE + 'hub.json', { cache: 'no-cache' })).json();
const servers = await (await fetch(BASE + 'servers.json')).json();
```

Fetch `hub.json` first (half a kilobyte) and load only the files you need. Keep the last good copy for offline use.

## Stability

- The hub index has `schemaVersion` and a version of the signed envelope (`v`). New fields are added without a version change. An incompatible change gets a new version, and the old one stays up for a while.
- The static files have `schemaVersion` too. The JSON Schema files in `schema/` are the contract, and the tests check the output against them.
- Everything not listed on this page can change without notice.
- Sources of truth: types in `packages/shared/src/hub.ts` and `packages/shared/src/types.ts`, routes in `apps/server/src/routes/`.
