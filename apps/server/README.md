# TM Horizon Hub server

Backend of the hub where mod authors publish and from which the launcher reads one signed index.
Design: `docs/hub/architecture.md`. Deployment: `docs/hub/deploy-oracle.md`. Secrets:
`docs/hub/secrets.md`. Moderation: `docs/hub/moderation.md`.

## Local development

```
cp apps/server/.env.example apps/server/.env      # dev login on, SQLite, files in apps/server/data/
npm run seed -w @tm-hub/server -- --fresh          # ~100 unclaimed catalog projects + a demo project in every state
npm run dev -w @tm-hub/server                      # API on http://127.0.0.1:8787 (watch mode)
npm run dev -w @tm-hub/portal                      # portal on http://localhost:5174 (proxies /v1, /auth, /dl, /files)
```

Or all at once (API, portal and website, own SQLite file, demo data on the first run, no `.env` read):
`npm run dev:hub` in the repository root; step by step in German: `docs/hub/local-test.md`.

The dev login ("Development login" in the portal, `POST /auth/dev/login {as}`) gives the accounts
`admin`, `author`, `author2` and `user`. It exists only with `HUB_DEV_LOGIN=1`, `NODE_ENV=development`
(or `test`) and `HOST` on loopback (127.0.0.1, ::1, localhost); otherwise the server refuses to start.
It also answers only requests from this machine. No real OAuth app is needed for local work.

At start the server prints the development index key. To try the launcher against it (debug build
only): set `TMHUB_HUB_DEV_PUBKEYS=<that key>` before `npx tauri dev`, then Settings > TM Horizon Hub
with `http://localhost:5174/`.

## Commands

| Command | What |
|---|---|
| `npm test -w @tm-hub/server` | check pipeline (incl. hostile zips, PE files), signing, API end-to-end with a fake GitHub |
| `npm run typecheck -w @tm-hub/server` | TypeScript |
| `npm run import-catalog -w @tm-hub/server [-- --crawl]` | unclaimed projects from the catalog and the TMLoader mods |
| `npm run generate-key -w @tm-hub/server [-- --author]` | new Ed25519 key pair (index key or author key), printed once |
| `node apps/server/scripts/sign-version.ts <slug> <version> <file>` | author signature (key in `TMHUB_AUTHOR_KEY`) |
| `node apps/server/scripts/make-index-fixtures.ts` | rewrites the shared index test fixtures for the Rust tests |
| `GET /v1/openapi.json` | the API as OpenAPI 3.1 |
| `GET /tmf/servers?game=tmnf\|tmuf` | live TMNF/TMUF server list from `packages/tmf-master`; off (503 `tmf-disabled`) unless `TMF_ENABLED=1` and `TMF_LIVE=1`; see below |

## Layout

```
src/main.ts            start: HTTP + publish job + crawler (every minute)
src/app.ts             Fastify: helmet/CSP, rate limits, cookies, multipart, error format, webhook
src/config.ts          environment (zod), production guards
src/ctx.ts             db, storage, signing key, VirusTotal, Discord webhook notices, audit
src/db/                Kysely (node:sqlite or pg), migrations
src/storage.ts         fs and S3 (Oracle Object Storage) adapters, content-addressed, immutable
src/checks/            zip reader, file types, PE parser, VirusTotal, pipeline, zip writer (TMLoader wrap)
src/index/sign.ts      Ed25519 index and author signatures
src/services/          users, projects, images, versions (ingest, hold, publish, revoke), hub index, claims
src/sources/           GitHub, crawler, "paste a URL" import, catalog import
src/http/              route helper (zod + OpenAPI registry), auth (OAuth, sessions, CSRF, tokens, dev login)
src/routes/            public, author, admin
deploy/                systemd, nginx, docker-compose, backup, logrotate, optional GitHub Action
```

## TMNF/TMUF server list

`GET /tmf/servers` serves the list that `packages/tmf-master` polls from the Nadeo master server. It is
off unless **both** `TMF_ENABLED=1` and `TMF_LIVE=1` are set; otherwise it answers `503
{"error":"tmf-disabled"}` and nothing is requested. Requests only read the service's cache (one bot
session per game, a poll every `TMF_POLL_SECONDS`, at most `TMF_MAX_REQ_PER_MIN` requests per minute
in total), so many launchers never raise the load on the master server. Needs `TMF_BOT_LOGIN` and
`TMF_BOT_PASSWORD` (secret); the other `TMF_*` keys are in `packages/tmf-master/src/config.ts`.
Responses: 200 `TmfServersResponse` (`status` ok/stale/unavailable), 400 bad `game`, 503 disabled.
Tests use a stub service and never contact the master server.
