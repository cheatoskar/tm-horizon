# TM Horizon Hub: architecture

The hub is the one place where mod authors publish, so the launcher reads one consistent, signed
source instead of crawling GitHub repositories, Drive links and TMLoader servers itself. This is
"Weg B" from `docs/mod-publishing.md`. Status: runs locally, not deployed.

## Parts

| Part | Folder | What |
|---|---|---|
| Hub server | `apps/server` | Node 24 + TypeScript (run directly, no build), Fastify, Kysely (SQLite via `node:sqlite` in development, PostgreSQL in production), zod validation, Ed25519 via `node:crypto` |
| Developer portal | `apps/portal` | React + Vite SPA: my projects, "paste a URL" import, project editor, versions, sources, team, analytics, tokens, keys, claims, admin queue, public project page with "Report", legal pages |
| Shared types | `packages/shared/src/hub.ts` | Signed index format, API objects, install types (additive; nothing existing changed except an optional `sha256` on `InstallSpec`) |
| Launcher data source | `apps/launcher/src/data/hubIndex.ts`, `src/ui/HubSourceSetting.tsx`, `src-tauri/src/hubindex.rs` | Downloads the signed index, verifies it in Rust against pinned keys, maps projects onto the existing catalog install path (`installSpec` with `sha256`); off by default |
| Legal drafts | `docs/hub/legal/*.md` | Impressum, Datenschutzerklärung, Nutzungsbedingungen (drafts, placeholders) |
| Deployment | `apps/server/deploy/` | systemd unit, nginx server block, docker-compose, backup and logrotate, optional GitHub Action |

## Data flow

```
author ──paste GitHub/TMLoader URL──▶ portal ──▶ server: preview (repo, releases, README, screenshots, asset, install type)
                                               └▶ import: project + source + first release
crawler (every 20 min active / 4 h quiet, ETag, shared GitHub budget; GitHub App webhook = instant)
   └▶ new release ─▶ download (https, size cap) ─▶ checks ─▶ immutable copy files/<sha256>/<name> in storage
upload (portal or API token) ─────────────────────▶ checks ─▶ same
checks verdict: rejected (statement of reasons) | review (new project / flagged) | held 60 min ─▶ published
published/revoked ─▶ rebuild index ─▶ Ed25519-signed /v1/index.json (seq, expires, revocations)
launcher ─▶ /v1/index.json ─▶ verify (pinned key, rollback by seq) ─▶ catalog entries with installSpec{url=/dl/…, sha256}
          ─▶ /dl/<version>/<file> (counted per day) ─▶ 302 ─▶ /files/… (nginx cache ─▶ Object Storage)
```

## Publishing model

- Every version is an immutable hub copy, stored by content (`files/<sha256>/<file>`); the same
  version number can never be uploaded twice. DLL-only uploads and TMLoader server zips (files at the
  root) are wrapped into `<Product>/<version>/` with `description.yaml`, deterministically, so the
  launcher's `tmloader-product` installer takes them.
- Checks (`apps/server/src/checks/`), the same for uploads and crawled releases:
  - own strict ZIP reader: no encryption, symlinks, absolute/drive/`..` paths, alternate data streams,
    reserved device names, duplicate (case-insensitive) names, overlapping entries, odd compression,
    lying sizes or CRCs; entry ratio limit, total unpacked limit including nested zips (depth 2),
    5000 files (the launcher's limit);
  - file types per install type (`filetypes.ts`): scripts, shortcuts, installers are never accepted;
    programs are detected by content (an EXE named `.dds` is refused); executables only for
    `tmloader-product`, `files:game` (proxy DLLs) and TMInterface plugins; `dinput8.dll` is refused
    (StarForce games, the launcher never writes it);
  - PE inspection of every DLL/EXE: 32/64-bit, DLL flag, imports incl. delay-loaded, exports,
    packer sections; EXEs and packed files are flagged; wrong architecture for the game warns;
  - diff against the previous version: new or renamed executables, newly imported network /
    process / crypto / keyboard-hook APIs, install type change, size jump, other uploader, owner
    change in the last 14 days, missing or changed author signature, source repository changed;
  - author signature (Ed25519 over `tmhub-author-v1\n<slug>\n<version>\n<sha256>`) must match a key
    of a project member, otherwise the version is rejected; valid ones get "Verified";
  - VirusTotal hash lookup (optional upload of unknown files), asked again before a held version
    goes live.
- Status: `rejected` (automatic statement of reasons) / `review` (first version of a project or any
  `flag` finding) / `held` for `HOLD_MINUTES` (60) with a Discord webhook notice, cancellable by the
  author / `published` / `revoked` (in the index's revocation list; launchers refuse it and offer to
  remove it).

## Connected sources ("paste the URL once")

- GitHub: the hub reads public releases with its own token (`GITHUB_TOKEN`), conditional requests
  with ETag (304 answers cost no rate limit), a shared budget that pauses all GitHub checks when
  fewer than 50 requests are left. Adaptive interval: sources with a release in the last 60 days
  every `CRAWL_ACTIVE_MIN` (20) minutes, quiet ones every `CRAWL_QUIET_MIN` (240); errors back off up
  to a day; "Check now" in the portal; optional GitHub App webhook (`/hooks/github`, HMAC) for
  instant checks.
- Asset choice: the only `.zip`/`.dll` of a release (sources, PDBs, checksums ignored; a zip wins
  over a loose DLL), else the remembered pattern (version numbers replaced by `*`, learned from the
  first release), else the author picks once in the portal.
- Changelog from the release notes; README (links made absolute) as the description and up to six
  screenshots from the README and `docs/images` as the gallery on the first import.
- First check of a new source imports only the newest release (and a newer beta); later checks import
  every release not seen yet, oldest first.
- TMLoader servers: `<server>/index.json` with ETag, one product per source; the version's
  `hash_sha256` must match the download.
- Unclaimed projects: `npm run import-catalog` creates projects from `packages/catalog/catalog.json`
  (mods, tools, skins, TAS plugins) and the TMLoader mods of the bundled hub data, credited to the
  original author with a link to the source; GitHub repositories and TMLoader servers are attached as
  sources (checked only with `--crawl` or "Check now"). Claims: GitHub login that shows repo admin
  rights (token used once, not stored), a token file on the TMLoader server, or manual review.
  Discord-only mods: a catalog entry may carry `authorDiscordId` (the poster's Discord user id, a
  string of digits; set in `packages/catalog/mods_seed.py` or its PATCH list). The import stores it
  in `projects.claim_discord_id` (never published in the index or the public API, only a
  `discordClaimable` flag). A Discord login with that id claims the unclaimed project at once
  (`project.claim` audit entry, `how` names the id); a claimed project is never touched. Needs
  Discord OAuth (`DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`); without it the public page offers
  the other claim paths only. The committed export has display names only, so ids must be added.

## Signed index

`/v1/index.json` is a `SignedHubIndex` envelope: `payload` = base64 of the JSON `HubIndexPayload`,
`sig` = Ed25519 over `"tmhub-index-v1\n" + payload bytes`. The payload has `seq` (rising with every
build; the launcher refuses an older one than it has), `expires` (7 days; after that the launcher
shows the data as stale), all listed projects with their published versions (installs per game,
files with sha256 and size, author keys and signatures) and the revocation list. The private key is
only in `HUB_INDEX_SIGNING_KEY`; the launcher pins the public key in `PINNED_KEYS` (several allowed
for a key change). Development generates a key in `apps/server/data/` (gitignored) and prints it; the
launcher accepts it only in debug builds through `TMHUB_HUB_DEV_PUBKEYS`.

Shared test vectors: `apps/launcher/src-tauri/tests/fixtures/hub/` (written by
`apps/server/scripts/make-index-fixtures.ts` with the RFC 8032 test keys) are verified by the Node
tests and the Rust tests.

## Security

- Login only Discord/GitHub OAuth (state cookie + server-side state), no passwords. Session: random
  token in an httpOnly, Secure, SameSite=Lax cookie (`__Host-` prefix in production), stored as
  SHA-256. CSRF token per session in `X-CSRF-Token` plus an Origin check on every changing request.
- API tokens `tmh_…`: SHA-256 stored, scopes (`versions:write`, `projects:read`), optional project
  list, expiry, revocable; tokens can only do what their scope allows, never session-only actions.
- Launcher login (`desktop` scope, `apps/launcher/src-tauri/src/hublogin.rs`): the launcher listens on
  `127.0.0.1:<random port>` and opens `/auth/<provider>/start?desktop=1&port&state&challenge` in the system
  browser (RFC 8252, no custom URL scheme). Discord/GitHub still redirect to the hub's registered callback;
  for a desktop login the hub sets no cookie and redirects to `http://127.0.0.1:<port>/callback?code&state`
  with a one-time code (2 minutes, memory only). `POST /auth/desktop/token {code, verifier}` checks the PKCE
  S256 challenge and returns a 90-day `tmh_` token with the scope `desktop` (stored as SHA-256 like every
  token; the launcher keeps it in its data folder). It works for `/v1/me`, server submission (the account is
  the contact) and the claim routes only. `POST /auth/desktop/revoke` logs out. A logged-in launcher links a
  GitHub claim to its account with `POST /auth/desktop/ticket` (single use, 2 minutes) passed as `ticket=`.
  Tests: `apps/server/test/desktop-login.test.ts`.
- Admins from `HUB_ADMINS` (provider ids), never from the database.
- zod on every input; Markdown is stored raw and sanitised on display (DOMPurify in portal and
  launcher); pictures are checked by their bytes, size-limited and stripped of EXIF/text chunks.
- Rate limits in Fastify (global and per route) and nginx; upload and picture size limits.
- CSP: `default-src 'none'` on API answers, strict CSP for the portal in nginx, `sandbox` on files.
- Download counting: the client address only as a salted hash in memory for one day; stored are
  daily totals per version.
- Dependencies: `npm audit` (see the report for the state at hand-over).

## Database

Tables: users, identities, sessions, author_keys, projects, members, images, versions, sources,
source_seen, tokens, claims, reports, downloads_daily, revocations, audit, kv. Migrations in
`apps/server/src/db/migrations.ts` (Kysely schema builder, both dialects). JSON columns as text,
times as ISO strings. Search: token match over a lower-cased `search_text` (name, slug, author,
summary, tags, start of the description) with filters for game, category, tag and install type;
fine for a few thousand projects. Postgres can get a `pg_trgm` GIN index on `search_text` later.

## What is not done (see the hand-over report)

Real OAuth apps, the production key, bucket and DNS; Postgres and the S3 adapter are not tested
against real services (no Docker/Postgres on the development PC); e-mail answers to reports;
account self-deletion in the portal; DSA transparency database submissions.
