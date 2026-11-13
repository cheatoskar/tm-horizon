---
title: "Third-party APIs"
group: "api"
order: 2
synced: false
editUrl: "https://github.com/cheatoskar/tm-horizon/edit/main/apps/web/src/content/dev/third-party-apis.md"
---

TM Horizon does not keep its own copy of the Trackmania world. These are the outside services it reads, what for, and where their docs are. If you build on the same services, follow their rules. Most of them ask for a User-Agent that names your tool.

| Service | What TM Horizon uses it for | Docs and rules |
|---|---|---|
| **Trackmania Exchange (MX) API** | Map search and downloads in the launcher; newest and awarded maps per game in the data files (one request per list, one second apart). User-Agent: `TM-Horizon/<version> (+https://tm-horizon.com)` from the launcher, `TM-Horizon-hub (+https://tm-horizon.com)` from the data build. | [api2.mania.exchange](https://api2.mania.exchange) (API v2, one site per game), [method list](https://api.mania.exchange/api/methods). Keep request rates low and ask the MX team before heavy use. |
| **Openplanet** | Links to plugin pages and downloads for Trackmania (2020) and the ManiaPlanet games. The catalog points to them, nothing is mirrored. | [openplanet.dev](https://openplanet.dev/), [plugin list](https://openplanet.dev/plugins), [plugin docs](https://openplanet.dev/docs) |
| **Nadeo Live Services** | Reference for the official Trackmania (2020) services. First-hand data needs the account of a game owner, so TM Horizon does not use it without one. | [webservices.openplanet.dev](https://webservices.openplanet.dev/) |
| **trackmania.io** | Competitions and club rooms of Trackmania (2020) for the events and servers lists. The API is not documented and not an official service. Use it only with a descriptive User-Agent and ask its maintainer before going public. | [trackmania.io](https://trackmania.io/) |
| **GitHub** | Releases and metadata of mod repositories (`api.github.com`), raw files such as `plugin.json` and `showcase.json` (`raw.githubusercontent.com`), GitHub Pages for the data files, issue forms for servers and events. Calls without a token are rate limited per IP. | [REST API](https://docs.github.com/rest), [rate limits](https://docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api) |
| **Steam CDN** | Cover art of the games that are on Steam, fetched once at build time by app id and stored with the site. Visiting the site requests nothing from Steam. | [Steam store assets](https://partner.steamgames.com/doc/store/assets) |
| **Discord** | Invite status of the community directory (`GET /invites/<code>?with_counts=true`, no token) and scheduled events of member servers (a bot with read access). Invite codes are public. The bot token stays in the data build. | [Discord API](https://discord.com/developers/docs/intro), [Invite](https://discord.com/developers/docs/resources/invite), [Scheduled events](https://discord.com/developers/docs/resources/guild-scheduled-event) |
| **TMLoader indexes** | Mod lists with versions, dependencies, download links and SHA-256, read from the TMLoader master server (`https://modloader.tomashu.dev/modloader/v1/index.json`) and from the public mod servers. The format is `GET <server>/index.json`. Run your own server and the hub can use it as a source. | See [Publishing mods](/dev/docs/publishing/) for how the hub reads a server. |
| **ESWC master server** | Rooms of Trackmania Nations ESWC, read once an hour with the game's own protocol (TLS 1.0). | Not documented. Protocol notes: `packages/api/docs/eswc-masterserver.md` in the repository. |

What we do when we call these services:

- Send a User-Agent that names the tool, not a browser string. The one exception is fetching site icons, where some sites turn away unknown clients.
- Cache. Lists are fetched at most once an hour, files are hashed once, and the launcher keeps the last good copy.
- Send no personal data.
- Treat a failing service as a warning. The rest of the data still builds.
