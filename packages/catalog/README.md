# TM Horizon catalog

Verified list of external TrackMania resources, as data for a launcher and a website.
Checked on 2026-11-10 with plain GET requests (`check_links.py`). Re-run: `PYTHONIOENCODING=utf-8 python check_links.py`
(optionally `--only id1,id2`). `build_catalog.py` plus `mods_seed.py` (mods from the Discord mod channel) hold the hand-written seed list and rebuilds `catalog.json` with all statuses reset,
so run the checker after it.

Files: `catalog.json` (schema as agreed; dead entries carry an extra `archive` field with a Wayback link where one exists),
`sources.json` (id -> where the entry or claim comes from), `checks.json` (HTTP code, final URL, Discord invite names and member counts per entry).

## Counts (208 entries)
alive 153, dead 27, unclear 28.
community 44, mod 40, tool 35, docs 20, exchange 19, skins 18, leaderboard 16, events 14, servers 2.

Added 2026-11-10 (both answered HTTP 200 that day): TMTAS Exchange (`tmtas-exchange`, exchange, API documented at /docs, no public events feed) and TM RPG Trial (`tm-rpg-trial`, leaderboard).

Four dead 2020 Discord invites were replaced by the current invite of the same server from mx_eyebo's Discord server list (public Google Sheet, read by `packages/api` as `communities.json`; matched by name, in `build_catalog.py` as `SHEET_INVITE`): Trackmania community hub, Evo Esports, Trackmania Nascar and Maji's community (its old discovery page too). Catalog community entries that are not in the sheet stay as they are.

Status rules: 2xx = alive; 404/410 or no DNS answer on the system and on 8.8.8.8 = dead; everything else (403 bot blocks, 3xx without result, timeouts, 5xx, TLS) = unclear.
Discord invites are checked through the public invite API (`discord.com/api/v9/invites/<code>`), speedrun.com pages through its public API (the site returns 403 to scripts).

## Browser add-ons (added 2026-11-11)
Category `browser-addon`, entries carry an `addon` object (install `github` or `store`, GitHub repo and asset glob, licence,
whether redistribution is allowed, reviewed permissions and host patterns, store links, icon, compatibility). The launcher's
embedded browser installs only `install: "github"` entries, from the author's own release (`apps/launcher/src-tauri/src/addons.rs`
bundles this file and refuses any other id). Research (GitHub repo/code search, addons.mozilla.org API, web search) found only
two other TrackMania browser extensions besides the TMX Universal Track Downloader. Listed: TMIOSkinPreview (Firefox only,
WTFPL, no source; store link only, the launcher shows it without an install button). The old TMX downloader extension
(Manifest V2, old TMX domain) was removed on 2026-11-11: the TMX Universal Track Downloader replaces it. The entries were
edited in catalog.json directly (with `status`/`checked` set) instead of a full rebuild, which would reset every status.

2026-11-11: TrackMania Highlands points to its ModDB page (`hosting: moddb`); the "For 100% TMX" collection was removed
(only the 100% TMX + Bingo plugin belongs to the 100% TMX project).

2026-11-11 (showcase seeds): 24 mods got a showcase page (`showcases/*.json`, listed in `SHOWCASES` in `mods_seed.py`). Pictures only from files in the author's own repository (the validator allows raw.githubusercontent.com, release assets and i.imgur.com; openplanet.dev, ModDB and ManiaPark pictures are rejected), the rest are text-only. Five entries of the owner's repositories were added to catalog.json directly (`100tmx-bingo-plugin`, `100-tmx-server`, `nostalgic-completionist`, `deltazero`, `trackmania-map-mcp`); a full rebuild with `build_catalog.py` would drop them, so add them to `mods_seed.py` first.

## Most useful APIs for a launcher
- Map search/download: Mania Exchange API, https://api2.mania.exchange/ (redirects to api.mania.exchange). It covers TMNF-X, TMUF-X, TMO/TMS/TMN-X, TM2 (tm.mania.exchange), ShootMania, Trackmania Exchange, ItemExchange and ManiaPark (source: the docs page lists these sites; I did not call endpoints).
- Records and map data for Trackmania (2020): Openplanet webservices docs, https://webservices.openplanet.dev/ (Nadeo Core/Live/Meet and the official OAuth API; needs a Ubisoft/Nadeo account token, community docs, many endpoints undocumented).
- Speedrun records: https://github.com/speedruncomorg/api (public REST, game ids confirmed: tmnf, tmu, tm, tmo, tm2canyon, tm2stadium, tm2valley, tm2lagoon, tmturbo).
- Server lists: no public web API found. Only lead is the TMF master server wrapper https://github.com/Laiteux/TMF.NET (code reference for the protocol, not verified to work).
- Mod updates: GitHub releases API for TwinkieForever, TMFOXR (jiink/TrackManiaForeverOpenXR), TM Vibrant Shaders, GBX.NET.

## Gaps and what I could not verify
- Server lists for TMNF/TMUF/TM2/TM2020 live servers: none found. Dedimania (alive) shows records, not a server browser.
- CenterSpeed and KimMod are now in the catalog (URLs from the owner; KimMod description from its page).
- TMUnlimiter links to the old TMX forum thread only; Competition Patch is at donadigo.com/tmcp (source: archive.org listing). TMInterface description is from general knowledge plus the Lutris installer listing.
- TrackMania Turbo: only speedrun.com and Openplanet cover it; no Turbo-specific exchange or tools found.
- Skin sites: ManiaPark is alive (rebuilt by the Mania Exchange team, maniapark.com). Trackmania Carpark and TM Southmoon are listed in awesome-trackmania; see status in the catalog. No texture-mod/sound site for TMNF found beyond those.
- Discord: only invites from the awesome-trackmania README (2020-era) and public discovery pages. 12 are dead or expired. The 2026 official invite is not published anywhere I could reach; no per-language servers found (all `language: en` except French/German named sites).
- Entries "unclear" are mostly bot blocks (liquipedia, patreon, speedrun-like) or timeouts from this machine's network; open them in a browser before judging.
- Descriptions are one-liners written from the sources in `sources.json`; maintainers are filled only when a source named them.
- A transient network fault on the checking machine caused many false "dead" results in a first run; the shipped results are from a second run with curl as fallback.
- Reddit, YouTube, Twitch, Steam return 200 for any path, so "alive" there only proves the page loads (youtube handle and twitch channel names are guessed from the official brand; status confirms they resolve).

## Mods from the Discord mod channel (added 2026-11-10)
Source: the owner's export of the channel (37 mod posts incl. CenterSpeed, KimMod, Always Official, ChampionMod, OpenAL, NF to MP3 + TMUTP, Wii skins and blocks,
NewSnowCar, ESWC Autosave; TM Vibrant Shaders was already listed and got the new fields). Personal remarks of the posters are left out.

Extra optional fields on these entries: `author` (Discord display name as posted), `modType` (interface, sound, block, skin, texturepack, blockskin, standalone,
fix, music, vehicle, medals, utility, graphics, hud), `install` (tmloader, gamedata + target path, skins, unlimiter-required, manual), `requires` (list),
`authorDiscordId` (optional, string of digits: the poster's Discord user id from the export; the hub claims the project for that account at Discord login, see docs/hub/architecture.md; not published by packages/api; the committed export contains display names only, so no id is filled in yet), `hosting` (github, own-site, maniapark, archive.org, google-drive, yandex, discord-attachment), `urls` (mirrors / companion links) and `note`.

New game ids (used only by these entries): `tm1` (TrackMania 2003 incl. Power-Up/Speed-Up, "TM 1.0"), `tmsx` (Sunrise eXtreme), `tmu2006` (TrackMania United 2006).
Mapping: "Forever", "Nations/United Forever" -> `tmnf`,`tmuf`; "ManiaPlanet" -> the four TM2 ids; "Nations ESWC" -> `eswc`; "TMSU" (scrapped Sunrise/United) -> `tms`.
The Highlands environment mods are filed under `tmnf`,`tmuf`.

Only on Discord (`url: null`, status `unclear`, `hosting: discord-attachment`; the attachment links are signed and expire, so the file exists only in the post): 17 mods
Bay Buildings, ChampionMod, Classic Advertising, Custom Led Font Texture, Island Helipad block, Nadeo Cup Restoration Mod, NANDO banner (SeeenW), No "Forever" in Medals,
Rally Advertising Square Tower Block, Rally PC3 Shader Fix, Simple menu enhance, StadiumCar "Pará" skin, TrackMania Advertisements, Trackmania Wii Skin pack,
TMF_Stadium_Clouds_Fix, TMO Online Patch (no longer works per its author), Turbo2 Blocks for TMN ESWC.
A launcher cannot download these without the files being re-hosted (ask the authors, or mirror them with permission).

Dead links among the hosted ones (returned 404 to an anonymous GET; the files may have been removed or made private): Mid Fight Masses songpack (Google Drive),
OutRun 2006 C2C OST (Google Drive), TrackMania RTX 20th Anniversary (Yandex), Snowy Highland and Cinnaventurer Space Station (ManiaPark mod pages).
Google Drive and Yandex return 200 for a JS page, so "alive" there only means the link is not a 404.

## Types (2026-11-11)
`types.json` sets `category` and `modType` per entry after a review (many "mods" were skins or texture packs).
`category: mod` changes how the game works or sounds (code, blocks, sounds, music, vehicles, fixes, HUD); `skins` changes only
how things look (car skins, texture packs `modType: texturepack`, block skins `blockskin`) plus the skin sites; `docs` holds
sites and pages about something. Tools carry a `modType` too: `tas`, `editor` (map and GBX file tools), `library` (for developers),
`server` (dedicated servers, controllers, admin panels), `utility`. Openplanet plugins in other categories have `modType: plugin`;
TMLoader and Openplanet themselves are `platform`. `node reclassify.mjs` applies the file to catalog.json in place
(`--check` exits 1 when catalog.json is behind); `build_catalog.py` applies it after a rebuild.
