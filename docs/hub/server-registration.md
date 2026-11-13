# Registering game servers

The launcher's live status (docs/design/server-query.md) only knows servers whose address it has.
This is how server operators (and players who know a good server) put a server on the list, and how the
server keeps its entry fresh. Two ways in:

- **Logged in (Discord or GitHub): checked by the hub, listed at once** when the server answers.
- **Anonymous: reviewed by hand**, as before.

## Flow

1. **Submit.** The operator opens the website page "Add your server" (`/add-server`, all four languages)
   and enters game (Nations Forever, United Forever, Nations ESWC, Sunrise, Original), address
   (`ip:port`, default port 2350), name, a contact (Discord name or e-mail, **never shown publicly**),
   optionally an https homepage. The form posts to the hub: `POST /v1/servers`.
   - **Anonymous:** stored as **pending**. Nothing is public, nothing reaches the launcher, the hub does not
     connect to the address. Name 3-80 characters and a contact are required.
   - **Logged in:** the hub asks the game port once (see "Verification" below). If the server answers as the
     chosen game, the entry becomes **verified** and is listed at once, with the name the server reports
     (the name in the form is not used). If it does not answer (or answers with a password and the submitter
     did not tick "my server"), the entry stays **pending** for an admin.
   - **My server:** the checkbox only announces the claim (and asks for a contact). It gives **no token and no
     owner status**. Every verified entry without proof is shown as **suggested by the community**
     (`suggested: true` in `GET /v1/servers` and in the signed index; the launcher shows a "Suggestion" label).
     Ownership is proven with a code, see "Ownership proof" below. Without proof the admins can still issue the
     token by hand ("Issue token" in the portal) after checking the contact.
   - Password-protected servers (the query tells: player password or both) stay pending until the operator
     proved ownership; the proof lists them.
   - Checks on the form: public addresses only (private, loopback, link-local and reserved ranges are
     refused), game from the fixed list, homepage https only, honeypot field, one open entry per game and
     address (a passed check settles an earlier pending entry of the same server).
   - Limits: 10 submissions per day per account, 5 per hour per address (anonymous and logged in), 20 checks
     per hour per address.
   - The moderation channel (Discord webhook) gets a notice "New game server to review" for pending entries
     (not for verified ones).
2. **Review.** An admin looks at the pending entries (portal > Admin > Servers, or
   `GET /v1/admin/servers?status=pending`; contact included, last answer of the game port shown), and:
   - **approves**: `POST /v1/admin/servers/:id/approve` answers with the **announce token** (`tmhs_...`),
     shown once, only its SHA-256 hash is stored. The admin sends it to the operator over the given
     contact. Calling approve on an approved entry issues a new token and kills the old one.
   - **rejects**: `POST /v1/admin/servers/:id/reject {note}`.
   - later **removes**: `POST /v1/admin/servers/:id/remove {note}` (token stops working, entry leaves the index).
   - **restores** removed or rejected entries: `POST /v1/admin/servers/:id/restore` (back to where an
     automatic removal took it, else verified if it passed a check once, else pending).
   - **re-checks** one entry (`POST /v1/admin/servers/:id/recheck`) or all listed ones
     (`POST /v1/admin/servers/recheck-all`, runs in the background).
   Decisions go into the audit log. Statuses: `pending`, `verified` (listed by the hub's own check),
   `approved` (listed, announce token issued), `rejected`, `removed`. The portal screen (Admin > Servers) has
   a tab per status with Approve, Issue token, New token, Reject, Remove, Restore, Re-check, Re-check all.
3. **Index.** Verified and approved servers are part of the signed hub index (`payload.servers`: game, address, name,
   homepage, `suggested` when true; no contact, no token). The launcher reads them with the rest of the index and adds them to
   its server registry as **Community** entries (replaced on every index refresh, cannot be deleted one
   by one; they disappear when the hub removes them). The launcher then asks each server directly.
4. **Announce (optional).** A plugin on the server posts name, players, slots, spectators, map and mode to
   the hub every 5 minutes: `POST /v1/servers/announce` with `Authorization: Bearer tmhs_...`. The hub
   uses it for `GET /v1/servers` (public list with `online`, `players`, `map`; online = announced in the
   last 15 minutes). It does not change the address or the name in the index.

## Verification (what the hub does with a submitted address)

Code: `apps/server/src/services/tmquery.ts` (TypeScript port of the launcher's `serverquery.rs` and
`lzo1x.rs`; protocol in docs/design/server-query.md), tests `test/tmquery.test.ts` (the real captures of the
launcher's tests, MIT notice in that file's header comment) and `test/servers-verify.test.ts`.

- The hub sends the two query messages to the **game port** (TCP) and reads the server info. A reply counts only
  with the right HMAC-MD5 checksum for the game (that is the proof that a TrackMania server answered), then
  LZO1X, then the game tag. TMNF/TMUF share one protocol and Original/Sunrise another, so the query cannot tell
  TMNF from TMUF or Original from Sunrise; it does tell Forever, Original/Sunrise and ESWC apart.
- **Never Nadeo's master server.** One target per call, taken from the submission. The name is resolved by the
  hub and the connection goes to the resolved public address (private, loopback, link-local, reserved ranges
  and anything the name resolves to besides public addresses are refused). Ports 1024 to 65535 only.
- **Strict limits:** 3 seconds for the whole connection, answers above 1 MiB refused, one connection per
  submission and at most one retry (after a timeout or a reset, or once when a legacy server wants the other
  protocol version). **Global cap: 30 queries per minute** for the whole hub (503 `busy` for people, the
  re-check job waits for a free slot). "Check" is for logged-in users only (an anonymous caller cannot make the
  hub open connections).
- **Re-check job:** every 6 hours (own timer in `main.ts`, time of the last run in table `kv`, key
  `servers.recheck_at`) the hub asks every listed server again, one after another. A pass clears the offline
  mark and refreshes the name of verified entries; a failure sets `offline_since`. Offline servers stay in
  the list (shown offline by the launcher). After **14 days offline** the entry is removed softly
  (`status=removed`, note `auto:offline:<old status>`, token kept but dead); an admin can restore it.
- `online` and players/map in `GET /v1/servers` come from the announce (if newer than 15 minutes) or from the
  last passed hub check (if newer than 8 hours).
- Tests run against fake TrackMania servers on 127.0.0.1; the hub only reaches loopback when
  `queryTestFlags.allowLocal` is set in code (tests), there is no environment switch.

## Ownership proof (claim)

A checkbox must not be enough: anybody could otherwise take over a stranger's entry and post fake live data
with its token. So the operator proves control of the server:

1. Logged in, `POST /v1/servers/:id/claim-code` gives a short code like `hz-7K3Q` (valid 30 minutes; the same
   person asking again gets the same code, another person replaces it). The website shows it after sending the
   form with "my server" ticked.
2. The operator puts the code **into the server name or the server comment** (both come back from the game
   query for all five games) and presses "Check code" (`POST /v1/servers/:id/claim`).
3. The hub asks the game port once. If the code (any case) is in the name or the comment: the caller becomes the
   owner (`owner=1`, no longer suggested), gets a **new announce token (shown once)**, the code is used up, a
   pending entry becomes verified, and the stored name is the server's name **with the code stripped** (the
   operator can remove the code afterwards; the next 6-hourly re-check refreshes the name anyway). An
   admin-approved name stays.
4. Errors: `no_code` (none asked, or already used, or asked by someone else), `code_expired` (400),
   `code_not_found` (422, the code stays valid until it expires), plus the query errors (`no_answer`, `busy`, ...).
   Each call is one hub query and counts against the global cap; 20 calls per hour per address.

Tests: `test/servers-verify.test.ts` (success in name and in comment, wrong code, expired code, reuse, another
account, no token from the checkbox).

## Login from the website

The website page is on another origin than the hub. Set `HUB_WEB_URL` (the website's address) on the hub: then
`/add-server` may call `GET /v1/me`, `GET /v1/config` and the `/v1/servers*` calls with the visitor's session
cookie (CORS with credentials, only for that origin; other origins still get the open anonymous CORS without
cookies). The login buttons go to `/auth/<provider>/start?next=web:/<page>`, and the OAuth callback returns to
the website. The session cookie is `SameSite=Lax`, so the website and the hub must be on the same site
(for example `example.org` and `hub.example.org`). Without `HUB_WEB_URL` the page works as before
(anonymous). `PUBLIC_HUB_URL` (build time) is the hub address the page calls.

## Hub API

| Call | Who | Notes |
|---|---|---|
| `POST /v1/servers` | anyone (CORS open); logged in = checked at once | body: `game`, `address`, `name?` (needed when anonymous), `contact?` (needed when anonymous or `owner`), `owner?`, `homepage?`; 200 `{id, status: pending or verified, reason?, info?}`; 409 `exists`; 429 `limit`; 400 `bad_address`, `private_address`, `bad_port`, `contact_needed`; 503 `busy` |
| `POST /v1/servers/check` | logged in (session) | body `game`, `address`; 200 `{address, info: {name, players, maxPlayers, spectators, map, mode, password}}`; 422 `no_answer`; 400/503 as above; 20 per hour per address |
| `POST /v1/servers/:id/claim-code`, `/claim` | logged in (session) | ownership proof: get a code; query once and get the announce token if the code is in the name or comment (see above) |
| `GET /v1/servers` | anyone | verified and approved servers (with `suggested`), cached 60 s |
| `POST /v1/servers/reachability` | anyone (the launcher's "Check") | body `{port}` 2350-2399; connects back to the **caller's own address** only; `{ip, port, tcp: open\|closed\|timeout}`; 12 per hour per IP, one at a time per IP; 400 `private_address`, `invalid_body` |
| `POST /v1/servers/announce` | server with token | at most one per 4 minutes per server (429 `too_soon` with `Retry-After`), 60 per hour per IP; 401 for unknown tokens |
| `GET /v1/admin/servers?status=` | admin | pending, verified, approved, rejected, removed; includes contact, submitter, owner flag, last answer, offline mark |
| `POST /v1/admin/servers/:id/approve` | admin | body `{owner?}`; returns `{token}` once |
| `POST /v1/admin/servers/:id/reject`, `/remove` | admin | `{note}` |
| `POST /v1/admin/servers/:id/restore`, `/recheck` | admin | restore a closed entry; ask the server now (`{result: online, offline or skipped}`) |
| `POST /v1/admin/servers/recheck-all` | admin | starts the re-check of all listed servers in the background |

Table `game_servers` (migrations `0003-game-servers`, `0005-server-verify`, `0006-server-claim`). Code: `apps/server/src/services/gameservers.ts`,
`routes/servers.ts`, `tmquery.ts`; tests `apps/server/test/servers.test.ts`, `servers-verify.test.ts`, `tmquery.test.ts` (no live hub, in-memory database).

## From the launcher ("My servers")

Players who host a server with the launcher (docs/design/server-hosting.md) use the same flow without the website:

1. **Self-test first.** "Check" in the launcher's Internet tab calls `POST /v1/servers/reachability {port}`. The hub
   opens a plain TCP connection to the address the request came from, on that port, closes it at once and answers
   open / closed / timeout. Rules, so the hub cannot be used as a port scanner or to attack others:
   - the target address is never taken from the request body, only from the connection (`req.ip`; behind the
     proxy `TRUST_PROXY` decides);
   - only game ports 2350-2399 (the XML-RPC port 5000 and anything else is refused before any connect);
   - private, loopback and CGNAT senders are refused (`private_address`);
   - 12 tests per hour per IP, one running test per IP, 4 s connect timeout, no data sent.
   Code: `apps/server/src/services/reachability.ts`, route in `routes/servers.ts`, tests `test/reachability.test.ts`.
2. **Submit.** Only after the player ticked "my public IP address and the server name are shown publicly" and the
   self-test said "open", the launcher posts `POST /v1/servers` with game, `ip:port` (the address the hub saw), the
   plain server name and the contact. Same review as the form.
3. **Token.** The admin sends the token as usual; the player pastes it into the launcher. It is stored in the
   Windows Credential Manager, not in a file.
4. **Announce.** While the server runs, the launcher posts name, players, max players, spectators, map and mode
   every 5 minutes (read from the local dedicated server over XML-RPC). "Unlist" in the launcher forgets the token
   and the listing; the hub entry is removed by an admin (or on request).

TM2 and Trackmania (2020) servers cannot be listed yet: the list's games are the ones the launcher's server
query speaks (TMNF, TMUF, ESWC, Sunrise, Original).

## What the token can do

Only announce for its own server. It cannot list, approve or edit anything. A leaked token: the admin
issues a new one (approve again) or removes the entry.

## Plugins

### XAseco 1.x

`packages/server-plugins/xaseco/plugin.horizon_announce.php` and `horizon_announce.xml`.
Copy the PHP file to `xaseco/plugins/`, the XML to the `xaseco/` folder, put `hub_url` and `token` into the
XML, add `<plugin>plugin.horizon_announce.php</plugin>` to `plugins.xml`, restart XAseco. With no valid token
the plugin stays off. It sends name, players, max players, spectators, map and mode, once every 5 minutes
(longer pauses after failures, at most one request per 4 minutes is accepted anyway). The request has a
4 second timeout because XAseco's main loop waits for it. **Not run and not even syntax-checked**
(no PHP and no XAseco on the machine it was written on); the first run on a real server is the real test.

### FAST (TMF) and ManiaControl

Neither has a plugin from me yet; the hub call is one HTTPS POST, so a plugin is short:

- **FAST** (TMF): I do not know FAST's scripting well enough to promise a plugin. If its script can call a
  URL, a timed command every 300 s with the JSON below does it; otherwise run XAseco or the cron job below.
- **ManiaControl** (ManiaPlanet, not TMF): a plugin that registers a timer (`TimerManager`) with a
  300 s interval and posts the same JSON with `Authorization: Bearer <token>`. Servers of TM2 are not
  part of this list yet (the launcher's query is for TMNF/TMUF and the old games).
- **Any other tool**: a cron job and `curl` are enough:

```
curl -s -X POST https://<hub>/v1/servers/announce \
  -H "Authorization: Bearer tmhs_..." -H "Content-Type: application/json" \
  -d '{"name":"My server","players":3,"maxPlayers":40,"spectators":0,"map":"A01-Race","mode":"TimeAttack"}'
```

## Privacy and abuse

- The contact is stored for the review and for sending the token; it is shown to admins only and deleted
  with the entry's removal request (ask the hub operator). It is not in the index and not in `GET /v1/servers`.
- The server address is public server data. About the sender the hub stores the account id (logged in) and a
  **salted hash of the IP address** (HMAC-SHA-256 with a random salt kept in `kv`, key `servers.ip_salt`, cut to
  32 hex characters) only for the limits of 5 per hour and address. The raw address is not stored and not
  logged by this code. The privacy text (docs/hub/legal/datenschutz.md, section 4) has a row for this.
- **The hub is not a port scanner.** It connects only after a logged-in person submits or checks one address,
  one address per call, to its game port in the range 1024-65535, never to private ranges, with a 3 second
  limit, at most 30 queries a minute for everybody together, plus the re-check of already listed servers every
  6 hours. Anonymous callers cannot trigger any connection. One more exception: the self-test of
  launcher-hosted servers (`/v1/servers/reachability`) connects only back to the caller, only on 2350-2399.
- Spam is limited by the limits above, the honeypot, the public-address rule and the check itself: a server
  that does not answer as a TrackMania server is never listed without an admin. Pending entries are not public.
