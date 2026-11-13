---
title: "Registering game servers"
group: "publish"
order: 4
synced: true
sourceRepo: "cheatoskar/tm-horizon"
sourceBranch: "integration-1111"
sourceCommit: "78d69f7164"
sourcePath: "docs/hub/server-registration.md"
editUrl: "https://github.com/cheatoskar/tm-horizon/edit/integration-1111/docs/hub/server-registration.md"
---
The launcher's live status (docs/design/server-query.md) only knows servers whose address it has.
This is how server operators put their server on the list themselves, and how the server keeps its
entry fresh. Everything here is opt-in and reviewed by hand.

## Flow

1. **Submit.** The operator opens the website page "Add your server" (`/add-server`, all four languages)
   and enters game (Nations Forever, United Forever, Nations ESWC, Sunrise, Original), address
   (`ip:port`, default port 2350), name, a contact (Discord name or e-mail, **never shown publicly**),
   optionally an https homepage. The form posts to the hub: `POST /v1/servers`.
   - Stored as **pending**. Nothing is public, nothing reaches the launcher.
   - Checks: public addresses only (private, loopback, link-local and reserved ranges are refused), game
     from the fixed list, name 3-80 characters, contact required, homepage https only, honeypot field,
     5 submissions per hour per IP, one open entry per game and address.
   - The moderation channel (Discord webhook) gets a notice "New game server to review".
2. **Review.** An admin looks at the entries (`GET /v1/admin/servers?status=pending`; contact included),
   optionally queries the address with the launcher or `cargo test live_seed_servers`-style check, and:
   - **approves**: `POST /v1/admin/servers/:id/approve` answers with the **announce token** (`tmhs_...`),
     shown once, only its SHA-256 hash is stored. The admin sends it to the operator over the given
     contact. Calling approve on an approved entry issues a new token and kills the old one.
   - **rejects**: `POST /v1/admin/servers/:id/reject {note}`.
   - later **removes**: `POST /v1/admin/servers/:id/remove {note}` (token stops working, entry leaves the index).
   Decisions go into the audit log. The portal has no screen for this yet (open point); until then use
   the API with an admin session, or `curl` with the session cookie, as for other admin calls.
3. **Index.** Approved servers are part of the signed hub index (`payload.servers`: game, address, name,
   homepage; no contact, no token). The launcher reads them with the rest of the index and adds them to
   its server registry as **Community** entries (replaced on every index refresh, cannot be deleted one
   by one; they disappear when the hub removes them). The launcher then asks each server directly.
4. **Announce (optional).** A plugin on the server posts name, players, slots, spectators, map and mode to
   the hub every 5 minutes: `POST /v1/servers/announce` with `Authorization: Bearer tmhs_...`. The hub
   uses it for `GET /v1/servers` (public list with `online`, `players`, `map`; online = announced in the
   last 15 minutes). It does not change the address or the name in the index.

## Hub API

| Call | Who | Notes |
|---|---|---|
| `POST /v1/servers` | anyone (CORS open for this one route) | body: `game`, `address`, `name`, `contact`, `homepage?`; 200 `{id, received}`; 409 `exists`; 400 `bad_address`, `private_address` |
| `GET /v1/servers` | anyone | approved servers, cached 60 s |
| `POST /v1/servers/announce` | server with token | at most one per 4 minutes per server (429 `too_soon` with `Retry-After`), 60 per hour per IP; 401 for unknown tokens |
| `GET /v1/admin/servers?status=` | admin | pending, approved, rejected, removed |
| `POST /v1/admin/servers/:id/approve` | admin | returns `{token}` once |
| `POST /v1/admin/servers/:id/reject`, `/remove` | admin | `{note}` |

Table `game_servers` (migration `0003-game-servers`). Code: `apps/server/src/services/gameservers.ts`,
`routes/servers.ts`; tests `apps/server/test/servers.test.ts` (no live hub, in-memory database).

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
- The hub never connects to the submitted address (no scan, no reflection); only the launcher of a player does.
- Spam is limited by the form rate limit, the honeypot, the review and the public-address rule; a flood
  of pending entries does not reach players because nothing is public before approval.
