# Outbound hosts of the Launcher Preview (0.5.0)

Status: 2026-11-12. Which hosts the release build (`TMHUB_RELEASE_PREVIEW=1`, see [docs/release.md](../release.md))
can contact, and why. Collected from the Rust sources (`apps/launcher/src-tauri/src`, every `net::` call and
every URL constant), the frontend (`apps/launcher/src`, picture URLs and links) and the bundled data
(`packages/catalog/catalog.json`, `apps/launcher/src/generated`). Every request is made only when the player
uses the feature (opens the page, clicks Install, starts a server); there is no background telemetry.

**Nothing goes to TM Horizon's own servers.** In this build `hubindex::hub_url_ok` refuses every hub address,
the hub login and hub requests return before any network call (`hublogin::call`), the hub data refresh and the
old update check are off (`commands::hub_data_refresh`, `check_update`), and the UI hides sign-in, claims,
server registration, the reachability test and the public server list, event and server submission, the hub
source setting and the hub address fields. The user agent names the GitHub page instead of the website.

## Allowed and used

| Host(s) | What for | Where in the code |
|---|---|---|
| `github.com`, `api.github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`, `raw.githubusercontent.com` | App updates (`releases/latest/download/latest.json` of cheatoskar/tm-horizon, signed installer), mod releases (catalog mods, ESWC proxy mods, TMVS, Horizon Client, browser add-on), READMEs, release notes and pictures of mod pages, update checks (ETag, 60/h budget) | `updater.rs`, `catalogmods.rs`, `eswcmods.rs`, `horizonhost.rs`, `updates.rs`, `repodoc.rs`, `gallery.rs`, `addons.rs`, `tmvscontent.rs` |
| `cheatoskar.github.io`, `bigbang1112.github.io` (GitHub Pages) | TMLoader mod servers of TM Vibrant Shaders, 100% TMX + Bingo and Always Official (index and files) | `modindex.rs` |
| `tmnf.exchange`, `tmuf.exchange`, `nations.tm-exchange.com`, `sunrise.tm-exchange.com`, `original.tm-exchange.com`, `tm.mania.exchange`, `sm.mania.exchange`, `trackmania.exchange`, `item.exchange`, `item.mania.exchange`, `images.mania.exchange` | Embedded Exchange sites (Maps page), their public APIs (news, map search for server map lists, records for the Horizon Client bridge), map and replay downloads on click, thumbnails | `web.rs`, `news.rs`, `hosting/tmx.rs`, `clientbridge.rs`, `maps.rs` |
| `tmtas.exchange` | TAS mode only: TMTAS Exchange in the embedded browser | `web.rs` |
| `maniapark.com` | Skins page (embedded), skin downloads on click | `web.rs`, `skins.rs` |
| `openplanet.dev`, `cdn.openplanet.dev` | Official Openplanet installer (download on click, then the official setup runs), the public plugin list with its pictures. From 0.5.1 a plugin's .op is downloaded from `cdn.openplanet.dev` on Install / Update (only that host, must be a zip) and saved into the game's Openplanet Plugins folder (`features::op_install`, `op_remove`) | `opsetup.rs`, `openplanet.rs` |
| `tomashu.dev`, `tomashu.pages.dev`, `modloader.tomashu.dev` | TMLoader installer (official page, on click) and the TMLoader indexes | `tmlsetup.rs`, `modindex.rs` |
| The servers in the player's own TMLoader `config.yaml` (by default also `unlimiter.net`, `donadigo.com`, `fullspeed.mooo.com`, `home.koyaanis.com`) | Their own `index.json` and the product files listed in it (installed with TMLoader's SHA-256 check, never re-hosted) | `modindex.rs`, `tmloader.rs` |
| `images.igdb.com`, `art.gametdb.com` (TrackMania Wii only), `shared.steamstatic.com`, `shared.cloudflare.steamstatic.com` | Game covers (setting "Download covers", on by default), cached on disk | `packages/shared/src/covers.ts`, `imgcache.rs` |
| Discord (local IPC pipe, no network) | Rich Presence, off by default | `discord.rs` |
| The game servers in the player's server list (their own query/game port, e.g. `game.100tmx.com:2350`) | Server name, players and map, the same query the game's server browser makes | `serverquery.rs` |

## Beyond the list in the brief (kept, all first-party sources of the software)

| Host(s) | What for | Why kept |
|---|---|---|
| `nadeo-download.cdn.ubi.com`, `files.trackmaniaforever.com` (http, SHA-256 pinned) | Official game setups (Nations Forever, United Forever, ManiaPlanet) on "Get" | Nadeo's own download servers; nothing is re-hosted |
| `files2.trackmaniaforever.com` (http, SHA-256 pinned) | United Forever Steam fix update, TMF dedicated server for server hosting | Nadeo's own files |
| `files.v04.maniaplanet.com` (http) | ManiaPlanet / Trackmania dedicated server for server hosting | Nadeo's own files |
| `slig.free.fr` (http, pinned) | 2006 dedicated server (Sunrise/Original hosting), a community mirror of Nadeo's file | Only source left; only when the player sets up such a server |
| `downloads.php.net`, `archive.mariadb.org` | PHP and MariaDB for a server controller (server hosting, on click) | Vendor downloads, checked against their SHA-256 lists |
| `dl.dolphin-emu.org` | Dolphin emulator for TrackMania Wii (on click) | Official Dolphin builds, SHA-256 pinned |
| `gbx.tools`, `100tmx.com`, `tmrpgtrial.com` | Map tools and leaderboards in the embedded browser (on click) | Public web tools; `100tmx.com` is my own site |
| Favicons of the embedded sites (same hosts as above) | Site switcher icons for sites without a bundled icon | Same host as the site itself |
| Any https picture host named by a mod page or plugin list (e.g. `i.imgur.com`, `avatars.githubusercontent.com`, `cdn.discordapp.com` for community icons) | Pictures on mod pages, showcases, plugin lists, community icons; fetched once, checked to be a raster image, cached | `imgcache.rs`; the hosts come from the authors' own pages |

Links that only open the player's browser (Steam store pages, ModDB, Discord invites, the ESWC community
Google Drive folder, wikis) are not requests of the launcher.

## Mod list (hub index)

| Host | Why | Where |
|---|---|---|
| `hub.tm-horizon.com` (production hub, `/v1/index.json`, `/v1/servers`, `/ext-img/` only, no login; key id `30e908dace1ecba8`) | Mod list: the hub's signed index, at start (cached copy first) and every 6 h; the server sees the IP address | `src-tauri/src/hubindex.rs` (`PRODUCTION_HUB`, `PRODUCTION_KEY`), `src/data/hubIndex.ts` |
| `hub.tm-horizon.com/v1/servers?game=tmnf|tmuf|eswc` | Live server list (read only) for Home and the Servers page, at most once a minute while they are open | `hubindex.rs` (`hub_live_servers`), `src/data/tmfServers.ts` |
| `hub.tm-horizon.com/ext-img/igdb/...`, `/ext-img/steam/...`, `/ext-img/gametdb/...` | Game covers through the hub's image proxy (the player's address does not reach IGDB, Valve or GameTDB); tried before the CDNs above, which are only asked when the proxy does not answer (then not again in that session) | `src/ui/common.tsx` (`useOnlineCover`) |
| `hub.tm-horizon.com/ext-img/tmx/<site>/<id>/thumbnail` | Statistics: map pictures of maps without a local file (campaign maps); the track id comes from the TMX lookup below. When the proxy does not answer, the picture comes straight from the exchange site | `src/pages/Stats.tsx` (`MapPic`), `src/data/statsView.ts` |
| `tmnf.exchange`, `tmuf.exchange`, `nations.`/`sunrise.`/`original.tm-exchange.com` `/api/tracks?uid=`, `tm.mania.exchange` and `trackmania.exchange` `/api/maps?uid=` (pictures from `/mapthumb/<id>`, no proxy) | Statistics: the exchange page of a map by its uid (most played maps and the visible rows of the map table), cached with "not found" for a week, one request per second (the TMX gate shared with the in-game TMX browser) | `stats.rs` (`stats_tmx`), `clientbridge.rs` (`shared_tmx`) |
| `hub.tm-horizon.com/v1/github-projects?game=<id>` | "More projects" on the game pages (link-only GitHub projects), at most every 12 h per game; nothing shown while the list asks for a login | `moreprojects.rs` |

The index is accepted only with the pinned Ed25519 key and a seq not older than the last one; otherwise the last
good copy or the bundled catalog is used. The URL and key are compiled in (no setting); a release build does not
compile while they are placeholders. A valid index with at least one project is the list (entries it does not
name disappear; the bundled catalog fills fields for the ids it names); an empty index keeps the bundled catalog. No GitHub mirror yet (possible later: the same signed bytes as a static file).
Settings > About says so.

## Removed from this build

- The staging hub, `130.61.136.54`, any hub other than the pinned production hub: no code path reaches them (see
  the check below). From the production hub only the signed index (mod list) above is read; logins, uploads, server
  registration and the hub's server list stay off.
- `cheatoskar.github.io/tm-hub/` (old hub data and `launcher.json`): refresh and update check are off; the
  bundled data is used.
- Google Drive and Yandex Disk downloads of catalog mods (`catalogmods.rs` only installs from `github.com` in
  this build; the entries are hidden or link-only, see `packages/catalog/release-policy.json`).
- Openplanet plugin downloads from `cdn.openplanet.dev` (on Install / Update only, from 0.5.1).

## Check

`grep` over the built frontend (`apps/launcher/dist`) and the Rust sources for `tm-horizon.com`,
`130.61.136.54` and `staging.`, 2026-11-12:

- Rust sources: `tm-horizon.com` only in the non-preview User-Agent (`net.rs`, the preview sends the GitHub URL) and
  `hubindex::PRODUCTION_HUB`. Release exe of 2026-11-12 (0b7db92): the only such string is `https://hub.tm-horizon.com`; `130.61.136.54` nowhere; `staging.` only as a local folder variable in
  `tmloader.rs`.
- Frontend (`dist` of the release build of 2026-11-12): `tm-horizon.com` only in the privacy line, no IP, no staging host; no
  third-party mod icons, no `tmx-capture`, no sample data (the build checks the markers itself).
- Hub calls in the preview: only `hub_index_refresh` with the pinned production hub; logins (`hublogin.rs`),
  `hub_data_*`, server registration, the hub server list and the update check refuse.
