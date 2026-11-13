# Third parties and permissions

Status: 2026-11-11, written by me for my own release decision. This is not legal advice. Every row
says what I **verified** (with a link or a file in this repo) and what I only **assume**. "Ask" means
a person or team I should write to before a public release.

The hub's own legal texts (Impressum, privacy, upload terms, all drafts) are in
[docs/hub/legal](../hub/legal/): [impressum.md](../hub/legal/impressum.md),
[datenschutz.md](../hub/legal/datenschutz.md), [nutzungsbedingungen.md](../hub/legal/nutzungsbedingungen.md).
Art sources and artists: [ART_CREDITS.md](../../ART_CREDITS.md). Master-server bot: [docs/tmf-master/risks.md](../tmf-master/risks.md).

Ways of using something, used in the table:

- **embed**: the site is shown inside the launcher (native webview), the user browses it as in a browser.
- **API**: the launcher or hub service calls a public API or reads a public page.
- **mirror**: the hub stores a copy of a file and serves it.
- **link**: the launcher only opens the original page or download.
- **bundled**: the file ships inside the launcher.

## Table

| Third party | What I use | How | Licence or terms status | Risk | Ask before release |
|---|---|---|---|---|---|
| **TMLoader / Tomashu** | The TMLoader installer (found on the official page `tomashu.dev/software/tmloader/`, downloaded on the user's click), his server indexes (`tomashu.dev`, `tomashu.pages.dev`) as the list of loader mods, the product layout of TMLoader (`%LOCALAPPDATA%/TMLoader`, `config.yaml` read only) | API (indexes), link + download (installer), reads its folder layout | **Verified:** code in `src-tauri/src/tmlsetup.rs` (page, hosts) and `packages/api/config/hub.config.json`. **Not found:** a licence or terms text for the indexes or the installer. **Assumed:** public and meant to be used by launchers. | med: I depend on one person's hosting and format, and I mirror metadata of his mods (not the files) | **Yes**, Tomashu: OK to read the indexes, to start his installer, and to list his mods |
| **Mania Exchange / TMX** (tmnf.exchange, tmuf.exchange, tm-exchange.com sites, tm.mania.exchange, sm, trackmania.exchange, item exchange) | Sites embedded on the Maps page, the public API (api2.mania.exchange, redirects to api.mania.exchange) for search and the news feed, map and replay downloads into the game folder on the user's click | embed, API | **Verified:** the API docs page exists and answers (catalog README says "I did not call endpoints"; the news module does). **Not verified:** written API terms or a rate limit. **Assumed:** the API is public for tools. | med: embedding their whole site and showing their news makes me look official | **Yes**, TMX team (mx_eyebo and team): embedding, news excerpts, the site icons in `public/site-icons` |
| **TMX Headers Contest 2022 art** (artists **shortz** and **Dule**) | Header banners and environment backgrounds in the launcher (`public/header-art`) | bundled | **Verified:** ART_CREDITS.md lists every file and artist and says "local/preview only until TMX and the artists agree". No licence was given. | **high** for a public release: art by named people, used without a licence | **Yes**, shortz and Dule directly, and TMX (contest organiser). Until then: remove or keep the build private |
| **ManiaPark** | Embedded on the Skins page, skin and mod downloads into skin folders | embed | **Verified:** the site is alive (catalog README: rebuilt by the Mania Exchange team). **Not found:** terms. Per-upload licences are the uploaders'. | med: same as TMX; files are third-party | **Yes**, ManiaPark / TMX team |
| **Openplanet** (Miss, codecat) | Plugin list API `openplanet.dev/api/plugins` and plugin pictures, plugin downloads from `cdn.openplanet.dev` on the user's click, the Openplanet installer download from openplanet.dev | API, link + download | **Verified:** the calls are in `src-tauri/src/openplanet.rs`; `webservices.openplanet.dev` is community-written docs (catalog README). **Not found:** API terms on openplanet.dev (the `/terms` path I tried answers 404). **Assumed:** the plugin list is public, plugins keep their authors' licences. | med: plugins are third-party files; Openplanet is closed source | **Yes**, Miss (Openplanet): API use and installing the Openplanet installer for the user |
| **trackmania.io** (Miss) | Public API for competitions and rooms (`trackmania.io/api/...`) as a data source in the hub service | API | **Verified:** the endpoints are in `packages/api` (`/api/competitions`, `/api/rooms`). **Not found:** written terms. **Assumed:** public, reasonable use. | med: unofficial API of a community site | **Yes**, Miss: read-only use at a low rate |
| **mx_eyebo's Discord community sheet** | His public Google Sheet of Discord servers, read as `communities.json`; invites that matched replaced dead ones in the catalog | API (sheet export) | **Verified:** sheet id in `packages/api` config, export works without login. **Not found:** a licence on the data. | low-med: community-made list, public, but a copy is a derivative | **Yes**, mx_eyebo: OK to republish names and invites, credit him |
| **Modding Discord, mod-uploading channel** | 37 mod entries in the catalog (names, authors as posted, descriptions, links; no personal remarks) | link; files only if the licence says so | **Verified:** `packages/catalog/mods_seed.py` lists author and hosting for each. **No licence is stated in the posts.** Rule I use: **no licence = link only, no mirror.** Signed Discord attachment links expire, so those entries have no download. | med: authors may not want to be listed; mirroring without a licence would be copying | **Yes**, the channel moderators, and each author for any mirror. Add a "remove my mod" contact |
| **Hub mirroring of mods** | Hub-hosted copies of mods (docs/mod-publishing.md: uploads by authors, 1 h hold, signed index) | mirror, only for uploads by the author | **Verified:** upload terms draft in docs/hub/legal. Forks only with a licence or written permission (mod-publishing.md). | med: the legal texts are drafts with placeholders | **Yes**, a lawyer (or at least a careful read) before accepting uploads |
| **TAS and tool repos** (TMInterface and plugins, ForeverTAS, linesight, TMFOXR, others) | Catalog links; the hub reads GitHub release data (projects.json); some installs download the release asset on the user's click | link, API (GitHub), download | **Verified today via the GitHub API:** ForeverTAS MIT, TMInterface-AS-SaiMoen MIT, always-official MIT, TMInterfaceClientPython GPL-3.0, TMF.NET MIT. **No licence file found:** donadigo/TMInterfacePublic, Shweetz/TMInterfaceAngelScript, Linesight-RL/linesight, donadigo's TMInterface itself (closed source, site `donadigo.com/tminterface`). | low for links; med for downloading and re-serving a file with no licence | **Yes**, donadigo for TMInterface (his installer/zip must not be mirrored without his OK); others: link only |
| **BigBang1112** (GBX.NET, Always Official, gbx.tools) | Map tools page opens `gbx.tools` (explorer, 3d, io) in the embedded browser; GBX.NET is the **reference** for my own header reader (`src-tauri/src/gbx.rs`, no code copied); Always Official is a catalog mod | embed (gbx.tools), link, reference | **Verified:** GBX.NET 2 README says it is distributed under the MIT licence; the LZO part is GPL v3, and reading only the header does not need LZO (README quote: reading only the header does not infect you with GPL v3). Always Official: MIT (GitHub API). **Verified:** gbx.tools home page lists explorer, 3d, io, nc, revalidate, envimix, uotd. **Not found:** terms for embedding the web tools. | low (MIT) for the code; low-med for embedding his site | **Yes**, BigBang1112: courtesy ask for embedding gbx.tools; keep the GBX.NET credit in the About page |
| **100tmx.com** (my own site) | Map Inspector (`https://100tmx.com/tools/map-inspector`) embedded, and its 100% TMX pages | embed | **Verified:** path exists (found in the site's own nav). Own site: no third-party consent needed. The inspector page says it reads TM2 and 2020 files too. | low | no |
| **Box covers, Steam store art, game screenshots** (Ubisoft, Nadeo, Valve) | Store art in `public/store-art` (covers, heroes), ESWC box scan, Steam links | bundled, link | **Verified:** ART_CREDITS.md: the ESWC hero is a copyrighted screenshot "local test build only", author unknown. Steam art is Valve's store material for those games. **Assumed:** using publisher box art to identify the game in a launcher is common practice but not a licence. | **high** for the screenshot with unknown author; med for box art | **Yes**: replace the unknown-author screenshot; for covers either get Ubisoft/Nadeo OK or load them live from the store instead of shipping them |
| **Nadeo / Ubisoft trademarks and name** | "TrackMania", "Nations", "United", "Sunrise", "ManiaPlanet", game logos in the UI | name use to say what the tool is for | **Not verified:** I read no Ubisoft brand policy for fan tools. **Assumed:** naming the games is needed; implying official status is not allowed. | med | **Yes**, Ubisoft/Nadeo community contact (or accept the risk with the disclaimer). Suggested text below |
| **Game installer links** | Official installers from the Nadeo CDNs (`nadeo-download.cdn.ubi.com` for TMNF and ManiaPlanet, `files.trackmaniaforever.com` for TMUF over plain http, SHA-256 pinned), Steam and Ubisoft Connect store links | download on the user's click, link | **Verified:** `src-tauri/src/gameinstall.rs`. The patched ESWC exe is **only a community link** (`ESWC_COMMUNITY_URL`, a Google Drive folder), the app never downloads it. | low-med: the app starts the official setups, does not host them | Optional courtesy mail to Nadeo; no for ESWC because there is no download |
| **TMF master-server bot** | A dedicated bot account asks Nadeo's TrackMania Forever master server for the server list | undocumented protocol | **Verified:** docs/tmf-master/risks.md: no published interface, automated access not allowed by any document I know, worst case bot account ban or IP block. Off by default (`TMF_ENABLED=0`, `TMF_LIVE=0`). | **high** | **Yes**, Nadeo/Ubisoft before switching it on; otherwise keep it off and use the community list |
| **opengsq-python** (OpenGSQ) | Test vectors (real server captures and the fake-server scenarios) in `src-tauri/src/serverquery_vectors.rs` and the tests of `serverquery.rs`; its TrackMania Nations and Sunrise modules were read as a cross-check. The protocol code in `serverquery.rs` and `lzo1x.rs` is my own, written from the protocol notes below | test data, reference | **Verified:** repository `opengsq/opengsq-python`, file `LICENSE` is the MIT licence, "Copyright (c) 2021 OpenGSQ" (GitHub API, 2026-11-11). The copyright and permission notice is kept in the header of `serverquery_vectors.rs` and in docs/design/server-query.md. | low (MIT) | No; keep the notice when the test data is redistributed |
| **lan-dot-party/game-protocols** (protocol notes for TrackMania Forever, Original, Sunrise, ESWC) | The written protocol: ports, framing, checksum keys, LZO1X, server info layout, byte examples. I implemented the query from this description and used its byte examples as tests; no code was copied | reference (spec) | **Verified:** the repository has **no licence file**, so its text and code are not mine to copy. Facts about a network protocol are not copyrightable, so a clean implementation from the description is what I rely on; the Python reference in the notes was not copied. **Assumed:** that is fine. | low-med: the author could object to how I used the notes | **Yes**, courtesy: tell the author the launcher uses the notes, ask for a licence on the repository and offer a credit |
| **TrackMania game servers (queried directly)** | The launcher opens a TCP connection to the game port of each server in the player's own list and asks for the server info the game's own server browser asks for (name, players, map). No account, no Nadeo master server | direct query, reads a public status | **Verified:** the query needs no credentials (protocol notes, and live check of five public servers on 2026-11-11). The servers see the player's IP address, as with any join. **Not found:** terms of the server operators. | low: one short connection per server and 30 s at most; paused for dead servers | No; the privacy text should say that the launcher contacts the listed game servers |
| **Fonts in the logo (Bahnschrift)** | The wordmark image `docs/brand/wordmark.png` and the app logo | rendered image | **Not verified:** I found no script or file in the repo that names the font, so I cannot say for certain that Bahnschrift is used; if it is: Bahnschrift ships with Windows 10/11 under Microsoft's font licence, which (as I understand it) allows using a font to create images and documents but not redistributing the font file. **A rendered image is different from shipping the font file**; I ship no Bahnschrift file. I did not read the licence text today. | low-med | Check the Microsoft font licence page once; or redraw the logo with an open font (the web fonts below) and drop the doubt |
| **Web fonts** | Inter (variable) and Barlow / Barlow Semi Condensed / Barlow Condensed through the `@fontsource` npm packages, bundled into launcher, portal and web (`apps/*/package.json`) | bundled (self-hosted, no Google Fonts requests at runtime) | **Verified:** the packages are in the three package.json files and imported in `main.tsx` and `Layout.astro`; no `fonts.googleapis.com` link found in the apps. **Assumed from general knowledge, not re-read today:** Inter and Barlow are under the SIL Open Font License, which allows bundling with an app. | low | no; keep the licence texts in the release notices (OFL asks for the notice) |
| **GitHub** | Release data, repository READMEs and pictures for news covers | API | **Verified:** `projects.json` pipeline. Pictures come from the authors' own release notes. **Assumed:** public API use within the rate limits. | low | no |

## Suggested disclaimer

Put this in the Impressum, the About page, the website footer and the store listing:

> TM Horizon is a fan project. It is not affiliated with, endorsed by or sponsored by Ubisoft
> Entertainment or Nadeo. TrackMania, ManiaPlanet, Nations, United and other game names and logos are
> trademarks of their owners. Mods, maps, skins and other files shown here belong to their authors.

German version for the Impressum: "TM Horizon ist ein Fanprojekt. Es steht in keiner Verbindung zu
Ubisoft Entertainment oder Nadeo und wird von ihnen weder unterstützt noch gefördert. TrackMania,
ManiaPlanet, Nations, United und weitere Spielnamen und Logos sind Marken ihrer Inhaber. Mods, Maps,
Skins und andere gezeigte Dateien gehören ihren Autoren."

## Launcher Preview 0.5.0 (2026-11-12)

The 0.5.0 build follows these rows without waiting for the answers: no hub and no mirror (nothing of mine is
contacted, `docs/release/outbound-hosts.md`), the TMX Headers Contest art, box covers, the ESWC hero, the TMX
site screenshots and bundled logos of other people's mods are not in the build, and the catalog is filtered by
`packages/catalog/release-policy.json` (no licence or Discord-only: hidden; author's own site without a licence:
link only; GitHub mods with an OSI licence: download from the author's release; TMLoader mods: from their own
server index; ModDB/Highlands: the player downloads, the launcher installs). Openplanet plugins are only linked.
The mails in "Ask before release" are still open; the site icons of the Exchange sites are still bundled.

## What blocks a public release

1. TMX Headers Contest art (shortz, Dule, TMX): no permission yet. Ask, or remove.
2. ESWC hero screenshot with unknown author: replace.
3. Written OK from Tomashu, TMX/ManiaPark and Miss (Openplanet, trackmania.io): one short mail each.
4. The TMF master-server bot stays off until I decide about Nadeo's terms.
5. Hub upload terms: lawyer read, placeholders filled.

## What I did not check

- Terms of service text of tomashu.dev, TMX, ManiaPark, openplanet.dev, trackmania.io: I found none and did not ask anyone.
- Ubisoft's current rules for fan projects and brand use.
- The Microsoft Bahnschrift licence and the exact OFL notice text (see rows above).
- Licences of each single catalog mod (about 40 entries): link-only unless an author gives a licence.
