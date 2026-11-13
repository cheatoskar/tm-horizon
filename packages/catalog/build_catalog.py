#!/usr/bin/env python3
"""Seed list of catalog entries -> catalog.json (status 'unclear' until check_links.py runs)
and sources.json (id -> where the entry / claim comes from).
Entry tuple: id, name, category, games, url, api, description, maintainer, language, launcher, source
"""
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
AW = "https://github.com/EvoEsports/awesome-trackmania (README, master)"
MXAPI = "https://api2.mania.exchange (lists TMNF-X, TMUF-X, TM2.MX, TMX, SMX, ManiaPark, ItemExchange etc.)"

TM2 = ["tm2-canyon", "tm2-stadium", "tm2-valley", "tm2-lagoon"]
FOREVER = ["tmnf", "tmuf"]
OLD = ["tmo", "tms", "eswc"]
ALL = ["tmo", "tms", "eswc", "tmnf", "tmuf"] + TM2 + ["sm-storm", "tm2020", "turbo"]

E = []
def e(*a):
    E.append(a)

# ---------------- exchanges
e("tmnf-exchange", "TMNF Exchange (TMNF-X)", "exchange", ["tmnf"], "https://tmnf.exchange/", "https://api2.mania.exchange/",
  "Map and replay sharing site for TrackMania Nations Forever.", None, "en", "search and download maps/replays via API", MXAPI)
e("tmuf-exchange", "TMUF Exchange (TMUF-X)", "exchange", ["tmuf"], "https://tmuf.exchange/", "https://api2.mania.exchange/",
  "Map and replay sharing site for TrackMania United Forever.", None, "en", "search and download maps/replays via API", MXAPI)
e("tmnforever-tm-exchange", "TMX tmnforever.tm-exchange.com (legacy address)", "exchange", FOREVER, "https://tmnforever.tm-exchange.com/", None,
  "Old address of the TMNF exchange, listed in awesome-trackmania.", None, "en", "open in browser", AW)
e("tmx-original", "TMO Exchange (Original)", "exchange", ["tmo"], "https://original.tm-exchange.com/", "https://api2.mania.exchange/",
  "Map exchange for TrackMania Original.", None, "en", "open in browser", MXAPI)
e("tmx-sunrise", "TMS Exchange (Sunrise)", "exchange", ["tms"], "https://sunrise.tm-exchange.com/", "https://api2.mania.exchange/",
  "Map exchange for TrackMania Sunrise.", None, "en", "open in browser", MXAPI)
e("tmx-nations", "TMN Exchange (Nations ESWC)", "exchange", ["eswc"], "https://nations.tm-exchange.com/", "https://api2.mania.exchange/",
  "Map exchange for TrackMania Nations ESWC.", None, "en", "open in browser", MXAPI)
e("tmx-legacy-root", "TM-Exchange (legacy root)", "exchange", ALL[:5], "http://www.tm-exchange.com/", None,
  "Old root domain of the TrackMania Exchange family.", None, "en", "open in browser", AW)
e("mania-exchange-tm2", "ManiaExchange TM2 (tm.mania.exchange)", "exchange", TM2, "https://tm.mania.exchange/", "https://api2.mania.exchange/",
  "Map and replay sharing site for TrackMania 2 Canyon, Stadium, Valley and Lagoon.", None, "en", "search and download maps via API", MXAPI)
e("mania-exchange-sm", "ShootMania Exchange (sm.mania.exchange)", "exchange", ["sm-storm"], "https://sm.mania.exchange/", "https://api2.mania.exchange/",
  "Map sharing site for ShootMania Storm.", None, "en", "search and download maps via API", MXAPI)
e("trackmania-exchange", "Trackmania Exchange (trackmania.exchange)", "exchange", ["tm2020"], "https://trackmania.exchange/", "https://api2.mania.exchange/",
  "Map sharing site for Trackmania (2020), with the Random Map Challenge data.", None, "en", "search and download maps via API", MXAPI)
e("tmtas-exchange", "TMTAS Exchange", "exchange", ["tmnf", "tmuf", "tm2020"], "https://tmtas.exchange/", "https://tmtas.exchange/api",
  "Hub for Trackmania tool-assisted speedrunning: TAS leaderboards, replay downloads, TAS of the Day, events (TAS World Cup 2026), tools. Hosts TAS replays for Exchange tracks of Nations/United Forever and TM2020 events.", None, "en", "embedded in the launcher's TAS corner", "https://tmtas.exchange/ and https://tmtas.exchange/docs (API: tracks, replays, leaderboards, users, upload; HTTP 200 on 2026-11-10)")
e("mania-exchange-hub", "Mania Exchange (mania.exchange)", "exchange", ALL, "https://mania.exchange/", None,
  "Landing page of the Mania Exchange site family.", None, "en", "open in browser", MXAPI)
e("item-exchange", "Item Exchange (item.exchange)", "exchange", ["tm2020"], "https://item.exchange/", "https://api2.mania.exchange/",
  "Blocks and items for the map editor, from the Mania Exchange family.", None, "en", "search and install items via API", MXAPI)
e("item-exchange-tm2", "Item Exchange (item.mania.exchange)", "exchange", TM2 + ["sm-storm"], "https://item.mania.exchange/", "https://api2.mania.exchange/",
  "Blocks and items for ManiaPlanet titles.", None, "en", "search and install items via API", MXAPI)
e("mania-exchange-blog", "Mania Exchange blog", "exchange", ALL, "https://blog.mania.exchange/", None,
  "News and announcements of the Mania Exchange sites, including the ManiaPark rebuild.", None, "en", "news feed", "https://blog.mania.exchange/posts/new-maniapark-finished")
e("mx-api-docs", "Mania Exchange API documentation", "docs", ALL, "https://api2.mania.exchange/", "https://api2.mania.exchange/",
  "Official API docs for all Mania Exchange sites (maps, replays, search).", None, "en", "map search and download", MXAPI)
e("mx-api-old-docs", "Mania Exchange API docs (old host)", "docs", ALL, "https://api.mania-exchange.com/documents/changes", None,
  "Older API changelog host; route format {game}/{method}.", None, "en", None, "web search result for 'mania.exchange API documentation'")
e("steam-workshop-tm2-stadium", "Steam Workshop TM2 Stadium", "exchange", ["tm2-stadium"], "https://steamcommunity.com/app/232910/workshop/", None,
  "Steam Workshop for TrackMania 2 Stadium: tracks, skins, blocks.", None, "en", "open in browser", AW)
e("steam-workshop-tm2-canyon", "Steam Workshop TM2 Canyon", "exchange", ["tm2-canyon"], "https://steamcommunity.com/app/228760/workshop/", None,
  "Steam Workshop for TrackMania 2 Canyon.", None, "en", "open in browser", AW)
e("steam-workshop-tm2-valley", "Steam Workshop TM2 Valley", "exchange", ["tm2-valley"], "https://steamcommunity.com/app/243360/workshop/", None,
  "Steam Workshop for TrackMania 2 Valley.", None, "en", "open in browser", AW)
e("steam-workshop-tm2-lagoon", "Steam Workshop TM2 Lagoon", "exchange", ["tm2-lagoon"], "https://steamcommunity.com/app/600720/workshop/", None,
  "Steam Workshop for TrackMania 2 Lagoon.", None, "en", "open in browser", AW)
e("100tmx", "100% TMX project", "events", ["tmnf"], "https://100tmx.com/resources", None,
  "Community project to complete all TMX maps; resources page.", None, "en", "open in browser", "web search result 'Random Map Challenge' (100tmx.duckdns.org)")

# ---------------- mods / tools
e("tmloader", "TMLoader (TrackMania ModLoader)", "mod", FOREVER + OLD, "https://tomashu.pages.dev/software/tmloader", None,
  "Injects DLL mods into TrackMania Forever without patching the exe.", "Tomashu", "en", "install and launch mods through it", "https://tomashu.pages.dev/software/tmloader")
e("tmloader-site", "Tomashu software page", "mod", FOREVER, "https://tomashu.pages.dev/", None,
  "Home page of the TMLoader author with downloads.", "Tomashu", "en", "open in browser", "web search result for TMLoader")
e("tminterface", "TMInterface", "tool", FOREVER, "https://donadigo.com/tminterface", None,
  "TAS and scripting tool for TrackMania Nations/United Forever.", "Donadigo", "en", "TAS mode: started through a TMLoader profile with TMInterface + CoreMod; download via TMLoader (TMTAS Exchange links tomashu.dev/software/tmloader)", "https://lutris.net/games/install/38956/view (listed as launch option); donadigo.com")
e("forevertas", "ForeverTAS", "tool", FOREVER, "https://github.com/Skycrafter-dev/ForeverTAS", None,
  "Community TAS tool for TrackMania Nations/United Forever by Skycrafter (alpha): runs the game physics outside the game, input search on the GPU. Windows and Linux. Discord: https://discord.gg/9uN3x9tETR", "Skycrafter", "en", "TAS mode: detected from its uninstall entry, Start / Get (download page on TMTAS Exchange)", "https://tmtas.exchange/tas-tools (TAS tool list, read 2026-11-10)")
e("tick", "TICK", "tool", ["tm2020"], "https://tmtas.exchange/tas-tools", None,
  "Native TAS tool for Trackmania 2020 (early access, 2.2.0 on 2026-11-10): save states, input editing, bruteforce, revision history. Installer: https://tmtas.exchange/tas-tools/tick/download. Discord: https://discord.gg/bhRWXTSV8M", None, "en", "TAS mode: detected read-only (uninstall entry, %LOCALAPPDATA%\\Programs\\TICK or picked by hand), Start / Get (opens the tool page)", "https://tmtas.exchange/tas-tools (TAS tool list, read 2026-11-10)")
e("tm-competition-patch", "TrackMania Competition Patch", "mod", FOREVER, "https://donadigo.com/tmcp", None,
  "Patch for TMNF/TMUF adding anti-cheat fixes for competitions.", "Donadigo", "en", "install via launcher", "https://archive.org/details/trackmania-nations-forever (links donadigo.com/tmcp)")
e("tmunlimiter", "TMUnlimiter", "mod", FOREVER, "https://unlimiter.net/", None,
  "Lifts block and map limits in TrackMania Forever; version 2.0 adds AngelScript map scripts. Installed through TMLoader.", "Tomek0055", "en", "install via TMLoader",
  "https://unlimiter.net/ (title \"TMUnlimiter 2.0\"), docs https://github.com/tomek0055/TMUnlimiter/wiki and /wiki/AngelScript (GET 200 on 2026-11-11); TMLoader product TMUnlimiter 2.0.x by Tomek0055")
e("twinkie-forever", "TwinkieForever", "mod", FOREVER, "https://github.com/TwinkieTweaks/TwinkieForever", None,
  "Modular overlay and patch system for TrackMania Forever.", "TwinkieTweaks", "en", "install via TMLoader", "https://github.com/TwinkieTweaks/TwinkieForever")
e("twinkie-site", "Twinkie (TwinkieTweaks site)", "mod", FOREVER + OLD, "https://twinkietweaks.github.io/", None,
  "Project site for Twinkie and TwinkieX, mod systems for the TrackMania Forever line.", "TwinkieTweaks", "en", "open in browser", "https://github.com/TwinkieTweaks")
e("twinkie-org", "TwinkieTweaks GitHub organisation", "mod", FOREVER + OLD, "https://github.com/TwinkieTweaks", None,
  "Repos for TwinkieForever, TwinkieX and the Gecko AngelScript engine.", "TwinkieTweaks", "en", "release/version checks via GitHub API", "https://github.com/TwinkieTweaks")
e("bingoforever", "BingoForever", "mod", FOREVER, "https://github.com/manfromfms/BingoForever", None,
  "Fork of TwinkieForever (a TMLoader mod) adding a multiplayer Bingo mode: teams race maps from a shared board over TCP, 2 to 8 teams. Beta; it replaces TwinkieModloader.dll, so back that up first.", "manfromfms", "en", None, "https://github.com/manfromfms/BingoForever")
e("tm-vibrant-shaders", "TM Vibrant Shaders", "mod", ["tmnf", "tmuf", "eswc", "tm2-canyon", "tm2-stadium", "tm2-valley", "tm2-lagoon"], "https://github.com/cheatoskar/TM-Vibrant-Shaders", None,
  "Post-processing shader pack with presets and in-game menu.", "cheatoskar", "en", "install/update from GitHub releases", "local repo README (https://github.com/cheatoskar/TM-Vibrant-Shaders)")
e("tmfoxr", "TrackMania Forever OpenXR (TMFOXR)", "mod", ["tmuf"], "https://github.com/jiink/TrackManiaForeverOpenXR", None,
  "OpenXR VR support for TrackMania Forever.", "jiink", "en", "install/update from GitHub releases", "https://github.com/jiink/TrackManiaForeverOpenXR (found via GitHub API repo list of jiink)")
e("openplanet", "Openplanet", "mod", TM2 + ["sm-storm", "tm2020", "turbo"], "https://openplanet.dev/", None,
  "Plugin platform for Trackmania (2020), Turbo and ManiaPlanet titles.", "Openplanet team (codecat)", "en", "detect install, link to downloads", "https://openplanet.dev/plugins")
e("openplanet-plugins", "Openplanet plugin site", "mod", TM2 + ["sm-storm", "tm2020", "turbo"], "https://openplanet.dev/plugins", None,
  "Directory of Openplanet plugins with versions and download pages.", "Openplanet team", "en", "browse plugins, link to plugin pages", "https://openplanet.dev/plugins")
e("openplanet-docs", "Openplanet documentation", "docs", TM2 + ["sm-storm", "tm2020", "turbo"], "https://openplanet.dev/docs", None,
  "Plugin development docs and API reference for Openplanet.", "Openplanet team", "en", None, "https://openplanet.dev/docs/reference/nadeoservices (search result)")
e("openplanet-nl-old", "openplanet.nl (old address)", "mod", TM2 + ["tm2020"], "https://openplanet.nl/", None,
  "Former Openplanet domain, listed in awesome-trackmania.", None, "en", None, AW)
e("nations-converter", "Nations Converter", "tool", ["tmnf", "tmuf", "tm2020"], "https://bigbang1112.eu/nc/", None,
  "Converts old Nations/United maps to Trackmania (2020).", "BigBang1112", "en", "open in browser", "https://www.trackmania.com/clubs/21571/news/691778")
e("nations-converter-news", "Nations Converter 2 club news", "tool", ["tm2020"], "https://www.trackmania.com/clubs/21571/news/691778", None,
  "Trackmania club news post about Nations Converter 2.", "BigBang1112", "en", None, "https://www.trackmania.com/clubs/21571/news/691778")
e("gbx-net", "GBX.NET", "tool", ALL, "https://github.com/BigBang1112/gbx-net", None,
  "C# library for reading and writing GBX files (maps, replays, items).", "BigBang1112", "en", "parse maps/replays in launcher", "https://github.com/BigBang1112/gbx-net")
e("gbx-explorer", "GBX.NET Explorer", "tool", ALL, "https://gbxexplorer.net/", None,
  "Online tool to inspect GBX files.", None, "en", "open in browser", AW)
e("gbxdump", "GbxDump", "tool", FOREVER + TM2, "https://wiki.xaseco.org/wiki/GbxDump", None,
  "Windows tool to dump GBX headers.", None, "en", None, AW)
e("tmtelemetry", "TMTelemetry", "tool", FOREVER, "https://github.com/Electron-x/TMTelemetry", None,
  "Displays real-time telemetry from TrackMania.", "Electron-x", "en", None, AW)
e("vscode-maniascript", "VS Code ManiaScript", "tool", TM2 + ["sm-storm"], "https://github.com/MattMcFarland/vscode-maniascript", None,
  "Syntax highlighting and completion for ManiaScript in VS Code.", "MattMcFarland", "en", None, AW)
e("krzychor-campaign-maker", "Krzychor Campaign Maker", "tool", FOREVER, "https://wiki.xaseco.org/wiki/File:Krzychor-campaign-maker.zip", None,
  "Windows tool to build custom campaigns for TMNF/TMUF.", "Krzychor", "en", None, AW)
e("tmf-net", "TMF.NET (master server wrapper)", "tool", FOREVER, "https://github.com/Laiteux/TMF.NET", None,
  ".NET wrapper for the TMF master server API (accounts, server lists).", "Laiteux", "en", "possible server list source", "web search result 'TrackMania Forever server list'")
e("tmx-api-nuget", "TmExchangeApi.NET", "tool", ALL[:5], "https://www.nuget.org/packages/TmExchangeApi.NET", None,
  "Unofficial .NET wrapper for tm-exchange.com.", None, "en", None, "web search result 'mania.exchange API'")
e("nadeo-api-py", "nadeo-api (Python)", "tool", ["tm2020"], "https://pypi.org/project/nadeo-api/", "https://webservices.openplanet.dev/",
  "Python wrapper for Nadeo web services and the OAuth API.", None, "en", None, "web search result 'Trackmania.io API documentation'")
e("nadeo-api-docs", "nadeo-api docs", "docs", ["tm2020"], "https://nadeo-api.readthedocs.io/", None,
  "Documentation of the nadeo-api Python package.", None, "en", None, "web search result")
e("tmnf-plugins", "tmnf-plugins", "tool", ["tmnf"], "https://github.com/Delorean12DMC/tmnf-plugins", None,
  "Proof of concept for plugins in TMNF without patching the exe.", "Delorean12DMC", "en", None, "web search result for TMLoader")
e("foreverrpc", "ForeverRPC", "mod", FOREVER, "https://github.com/AroPix/ForeverRPC", None,
  "Discord Rich Presence mod for Nations/United Forever via the ModLoader.", "AroPix", "en", "install via TMLoader", "web search result for TMLoader")
e("mania-server-manager", "mania-server-manager (Docker)", "tool", ALL, "https://hub.docker.com/r/bigbang1112/mania-server-manager", None,
  "Docker image to run Mania dedicated servers.", "BigBang1112", "en", None, "web search result 'server list'")

# dedicated servers and controllers
e("tm2020-dedicated", "Trackmania (2020) dedicated server", "tool", ["tm2020"], "http://files.v04.maniaplanet.com/server/TrackmaniaServer_Latest.zip", None,
  "Latest dedicated server build for Trackmania (2020), Windows and Linux.", "Nadeo", "en", "download server package", AW)
e("tm2-dedicated", "ManiaPlanet dedicated server", "tool", TM2 + ["sm-storm"], "http://files.v04.maniaplanet.com/server/ManiaplanetServer_Latest.zip", None,
  "Latest dedicated server build for ManiaPlanet titles.", "Nadeo", "en", "download server package", AW)
e("tm2-dedicated-docs", "ManiaPlanet dedicated server docs", "docs", TM2 + ["sm-storm"], "https://doc.maniaplanet.com/dedicated-server/getting-started", None,
  "How to set up a ManiaPlanet dedicated server.", "Nadeo", "en", None, AW)
e("tmnf-dedicated", "TMNF/TMUF dedicated server (forum post)", "tool", FOREVER, "http://www.tm-forum.com/viewtopic.php?t=14203", None,
  "Download and quick start for the TMU/TMNF dedicated server.", None, "en", "link to download", AW)
e("tmnf-dedicated-docs", "TMNF dedicated server readme", "docs", FOREVER, "http://www.gamers.org/tmf/docs/readme_dedicated.html", None,
  "Guide to TMU/TMNF dedicated servers.", None, "en", None, AW)
e("docker-tm2020", "evotm/trackmania Docker image", "tool", ["tm2020"], "https://hub.docker.com/r/evotm/trackmania", None,
  "Docker image for a Trackmania (2020) server.", "Evo Esports", "en", None, AW)
e("docker-tmnf", "lduriez/tmserver Docker image", "tool", FOREVER, "https://hub.docker.com/r/lduriez/tmserver", None,
  "Docker image for a TMU/TMNF server.", "lduriez", "en", None, AW)
e("xaseco", "XAseco", "tool", FOREVER + TM2, "https://www.xaseco.org/", None,
  "Server controller for TMN/TMNF/TMUF and TrackMania 2.", None, "en", None, AW)
e("uaseco", "UASECO", "tool", TM2 + ["sm-storm"], "https://www.uaseco.org/", None,
  "Server controller for ModeScript game modes on ManiaPlanet.", None, "en", None, AW)
e("evosc", "EvoSC", "tool", TM2 + ["tm2020"], "https://github.com/EvoEsports/EvoSC", None,
  "PHP server controller by Evo Esports.", "Evo Esports", "en", None, AW + " (listed as EvoTM/EvoSC)")
e("evosc-old", "EvoSC (EvoTM org address)", "tool", TM2, "https://github.com/EvoTM/EvoSC", None,
  "Old repo address of EvoSC as listed in awesome-trackmania.", None, "en", None, AW)
e("maniacontrol", "ManiaControl", "tool", TM2 + ["sm-storm"], "https://maniacontrol.com/", None,
  "Server controller for all ManiaPlanet games.", None, "en", None, AW)
e("pyplanet", "PyPlanet", "tool", TM2 + ["tm2020"], "https://pypla.net/en/latest/", None,
  "Python server controller for ManiaPlanet and Trackmania.", None, "en", None, AW)
e("expansion", "eXpansion", "tool", TM2 + ["sm-storm"], "https://mp-expansion.com/", None,
  "Modular controller for ManiaPlanet games.", None, "en", None, AW)
e("adminserv", "AdminServ", "tool", TM2 + FOREVER, "https://github.com/Chris92de/AdminServ", None,
  "Web interface for administering dedicated servers.", "Chris92de", "en", None, AW)
e("adminserv-neo", "AdminServ-Neo", "tool", TM2, "https://gitlab.com/Chris92de/AdminServ-Neo/", None,
  "Rewrite of AdminServ for ManiaPlanet titles.", "Chris92de", "en", None, AW)
e("fancymanialinks", "FancyManiaLinks", "tool", TM2, "https://github.com/steeffeen-zz/FancyManiaLinks", None,
  "PHP library to generate ManiaLinks.", "steeffeen", "en", None, AW)
e("tm-disassembler", "TrackMania Disassembler", "tool", FOREVER, "http://micolous.id.au/pages/disasm.html", None,
  "Disassembler page for TrackMania data, listed in awesome-trackmania.", "micolous", "en", None, AW)
e("trackstudio", "TrackStudio (archive)", "tool", FOREVER, "https://web.archive.org/web/20160319194133/http://tossha.ru/trackstudio/", None,
  "Track editing tool, archived copy.", None, "en", None, AW)
e("gbxedit", "GBXEdit", "tool", TM2, "https://forum.maniaplanet.com/viewtopic.php?t=19432", None,
  "GBX editing tool announced on the ManiaPlanet forum.", None, "en", None, AW)
e("mapedit", "MapEdit", "tool", TM2, "https://forum.maniaplanet.com/viewtopic.php?t=19890", None,
  "Map editing tool announced on the ManiaPlanet forum.", None, "en", None, AW)
e("gbx-tools-wolfgang", "Wolfgang Rolke GBX tools", "tool", FOREVER, "http://www.wolfgang-rolke.de/gbxdump/gbxconv.zip", None,
  "ReplayToChallenge converter and other GBX utilities.", "Wolfgang Rolke", "en", None, AW)

# ---------------- skins
e("maniapark", "ManiaPark", "skins", ALL[:5] + FOREVER + TM2 + ["tm2020"], "https://maniapark.com/", "https://api2.mania.exchange/",
  "Hub for car skins, texture mods and car models, rebuilt by Mania Exchange.", "Mania Exchange team", "en", "browse and download skins/mods", "https://blog.mania.exchange/posts/new-maniapark-finished")
e("maniapark-old", "ManiaPark (old www address)", "skins", TM2, "http://www.maniapark.com/", None,
  "Old address listed in awesome-trackmania.", None, "en", None, AW)
e("trackmania-carpark", "Trackmania Carpark", "skins", FOREVER + OLD, "http://www.trackmania-carpark.com/", None,
  "Former car skin host; reported closed.", None, "en", None, AW + "; Steam thread says closed")
e("southmoon-cars", "TM Southmoon cars", "skins", OLD, "http://trackmania.southmoon.net/cars/", None,
  "Skins for TM Original, Sunrise and ESWC.", None, "en", None, AW)
e("marie-stuff", "Marie's Trackmania Stuff", "skins", FOREVER + TM2, "https://mariejuku.github.io/", None,
  "Skins, mods and signs collection.", "mariejuku", "en", "open in browser", AW)
e("tmnf-tracksigns", "TMNF Exchange track signs", "skins", ["tmnf"], "https://tmnf.exchange/tracksigns", None,
  "Track sign textures hosted on TMNF-X.", None, "en", "open in browser", "web search result 'ManiaPark skins'")
e("skin-uploads-doc", "Trackmania skin uploads (club docs)", "docs", ["tm2020"], "https://doc.trackmania.com/club/activities/skin-uploads/", None,
  "Official docs for uploading skins in Trackmania clubs.", "Nadeo", "en", None, "web search result")
e("trackmania-skins-revamped", "TrackMania Skins Revamped", "skins", FOREVER, "https://forums.pixeltailgames.com/t/trackmania-skins-revamped/34737", None,
  "Forum thread about reworked skins.", None, "en", None, "web search result 'ManiaPark skins'")
e("tmr-remastered", "Trackmania Remastered (TMUF)", "skins", ["tmuf"], "https://www.patreon.com/posts/154048727", None,
  "Unofficial visual mod for TMUF focused on UI textures.", None, "en", None, "web search result 'TwinkieTweaks KimMod'")

# ---------------- leaderboards
e("trackmania-io", "Trackmania.io", "leaderboard", ["tm2020"], "https://trackmania.io/", "https://webservices.openplanet.dev/",
  "Player, map, club and totd leaderboards for Trackmania (2020).", None, "en", "link to player/map pages", AW + "; discordbotlist trackmaniaio bot")
e("tm-rpg-trial", "TM RPG Trial", "leaderboard", ["tm2020"], "https://tmrpgtrial.com", None,
  "The official Trackmania Trial website: Trial leaderboard, map lists, profiles, replay upload.", None, "en", "embedded next to TMX on the Maps page (Trackmania)", "https://tmrpgtrial.com (HTTP 200 on 2026-11-10)")
e("nadeo-webservices-docs", "Openplanet webservices docs", "docs", ["tm2020"], "https://webservices.openplanet.dev/", "https://webservices.openplanet.dev/",
  "Community docs for Nadeo Core/Live/Meet and the official OAuth API (leaderboards, maps, clubs).", "Openplanet community", "en", "leaderboards and map data", "https://webservices.openplanet.dev (search result)")
e("nadeo-live-leaderboards", "Live API: leaderboards", "docs", ["tm2020"], "https://webservices.openplanet.dev/live/leaderboards", "https://webservices.openplanet.dev/live/leaderboards",
  "Docs for leaderboard endpoints of the Nadeo live services.", "Openplanet community", "en", "records lookup", "search result")
e("nadeo-oauth-docs", "Official Trackmania OAuth API docs", "docs", ["tm2020"], "https://webservices.openplanet.dev/oauth/summary", "https://webservices.openplanet.dev/oauth/summary",
  "Documentation of the official OAuth2 API of Trackmania.", "Openplanet community", "en", "account and map data with user consent", "https://webservices.openplanet.dev/oauth/reference/clubs (search result)")
e("dedimania", "Dedimania", "leaderboard", FOREVER + TM2, "http://dedimania.net/", None,
  "Global track records used by thousands of servers.", None, "en", "show records", AW)
e("speedrun-tmnf", "speedrun.com TMNF", "leaderboard", ["tmnf"], "https://www.speedrun.com/tmnf", "https://github.com/speedruncomorg/api",
  "Speedrun leaderboards for TrackMania Nations Forever.", None, "en", "open in browser; public API", "https://www.speedrun.com/ru-RU/tmnf/forums (search result)")
e("speedrun-api", "speedrun.com API", "docs", ["tmnf", "tmuf", "tm2020"], "https://github.com/speedruncomorg/api", "https://github.com/speedruncomorg/api",
  "REST API docs for speedrun.com leaderboards.", "speedrun.com", "en", "WR lookup", "https://github.com/speedruncomorg/api")
e("speedrun-tmuf", "speedrun.com TMUF", "leaderboard", ["tmuf"], "https://www.speedrun.com/tmu", None,
  "Speedrun leaderboards for TrackMania United Forever.", None, "en", "open in browser", "https://www.speedrun.com/api/v1/games?name=trackmania (speedrun.com API game list)")
e("speedrun-tm2020", "speedrun.com Trackmania", "leaderboard", ["tm2020"], "https://www.speedrun.com/tm", None,
  "Speedrun leaderboards for Trackmania (2020).", None, "en", "open in browser", "https://www.speedrun.com/api/v1/games?name=trackmania (speedrun.com API game list)")
e("tm-ladder", "TM Ladder", "leaderboard", FOREVER, "http://en.tm-ladder.com/", None,
  "Ladder site listed in awesome-trackmania.", None, "en", None, AW)
e("statsmania", "Statsmania", "leaderboard", TM2, "http://www.statsmania.net/pages/editor", None,
  "Stats site with a nickname editor.", None, "en", None, AW)
e("ultimate-medals", "Ultimate Medals (Openplanet plugin)", "leaderboard", ["tm2020", "turbo"] + TM2, "https://openplanet.dev/plugin/ultimatemedals", None,
  "Shows PB and all medals for a track.", None, "en", None, "web search result")
e("tm-masters", "TM Masters", "events", TM2, "http://www.tm-masters.com/", None,
  "Home of the True Talent Cup and other competitions.", None, "en", None, AW)
e("tm-live", "TM Live (Mania-Actu)", "leaderboard", TM2, "https://trackmania.mania-actu.com/", None,
  "Live standings of current competitions.", "Mania-Actu", "fr", None, AW)

# ---------------- servers
e("servers-tmf-wrapper", "TMF master server wrapper (list)", "servers", FOREVER, "https://github.com/Laiteux/TMF.NET", None,
  "Only programmatic route found for the TMNF/TMUF server list.", "Laiteux", "en", "possible live server list", "web search result")
e("steam-tmnf-discussion-servers", "Steam thread on server list filters", "servers", FOREVER, "https://steamcommunity.com/app/7200/discussions/0/1729828401698331345", None,
  "Steam thread explaining the in-game 'Only United servers' filter.", None, "en", None, "web search result")
# ---------------- community
e("trackmania-official", "Trackmania official site", "community", ["tm2020"], "https://www.trackmania.com/", None,
  "Official site of Trackmania, news and clubs.", "Nadeo / Ubisoft", "en", "open in browser", AW)
e("maniaplanet-official", "ManiaPlanet", "community", TM2 + ["sm-storm"], "https://www.maniaplanet.com/", None,
  "Central hub of ManiaPlanet titles.", "Nadeo", "en", None, AW)
e("maniaplanet-forum", "ManiaPlanet forum", "community", TM2 + ["sm-storm"], "https://forum.maniaplanet.com/", None,
  "Official forum for ManiaPlanet titles.", "Nadeo", "en", None, AW)
e("tm-forum", "TrackMania Forums (tm-forum.com)", "community", ALL, "http://www.tm-forum.com/", None,
  "Large unofficial forum for all TrackMania games.", None, "en", None, AW)
e("reddit-trackmania", "r/trackmania", "community", ALL, "https://www.reddit.com/r/trackmania", None,
  "Subreddit for the Trackmania series.", None, "en", None, AW)
e("reddit-tmnf", "r/TMNF", "community", ["tmnf"], "https://www.reddit.com/r/TMNF", None,
  "Subreddit for TrackMania Nations Forever (existence unverified).", None, "en", None, "guess")
e("liquipedia", "Liquipedia Trackmania", "docs", ALL, "https://liquipedia.net/trackmania/Main_Page", None,
  "Wiki for competitions, results, teams and players.", None, "en", None, AW)
e("liquipedia-tournaments", "Liquipedia tournaments", "events", ALL, "https://liquipedia.net/trackmania/Portal:Tournaments", None,
  "Lists of upcoming and past Trackmania tournaments.", None, "en", None, AW)
e("evo-wiki", "Evo Wiki", "docs", ALL, "https://evotm.com/wiki", None,
  "Information and tutorials about the Trackmania games.", "Evo Esports", "en", None, AW)
e("xaseco-wiki", "Mania Tech Wiki", "docs", ALL, "https://wiki.xaseco.org/wiki/Main_Page", None,
  "Technical wiki, including GBX file format notes.", None, "en", "link for file format docs", AW)
e("gbx-wiki-gbx", "GBX format (Mania Tech Wiki)", "docs", ALL, "https://wiki.xaseco.org/wiki/GBX", None,
  "Description of the GBX file format.", None, "en", None, AW)
e("tmnf-hub-gamers", "TMNF Hub (gamers.org)", "docs", FOREVER, "http://gamers.org/tmf/", None,
  "Hub and wiki for TMNF with a server setup tutorial.", None, "en", None, AW)
e("maniascript-ref", "ManiaScript reference", "docs", TM2 + ["sm-storm", "tm2020"], "https://maniaplanet.github.io/maniascript-reference/", None,
  "Generated reference of ManiaScript modules.", "Nadeo", "en", None, AW)
e("maniaplanet-doc", "ManiaPlanet docs", "docs", TM2 + ["sm-storm"], "https://doc.maniaplanet.com/manialink", None,
  "Docs for ManiaLink, dedicated servers and scripting.", "Nadeo", "en", None, AW)
e("trackmania-doc", "Trackmania documentation", "docs", ["tm2020"], "https://doc.trackmania.com/", None,
  "Official player and club documentation for Trackmania.", "Nadeo", "en", None, "https://doc.trackmania.com/club/activities/skin-uploads/ (search result)")
e("mania-actu", "Mania-Actu", "community", ALL, "http://mania-actu.com/", None,
  "French news site on Trackmania events and the game.", None, "fr", None, AW)
e("maniacalendar", "ManiaCalendar", "events", ALL, "https://maniacalendar.com/", None,
  "Calendar of events and competitions.", None, "en", None, AW)
e("huntmania", "HuntMania", "events", ALL, "http://huntmania.net/", None,
  "Organises many Trackmania events.", None, "en", None, AW)
e("trackmania-open", "TrackMania Open", "events", ALL, "https://trackmaniaopen.com/", None,
  "Individual-style competitions (fullspeed, dirt, tech).", None, "en", None, AW)
e("trackmaniastars", "TrackManiaStars", "events", ALL, "https://trackmaniastars.org/", None,
  "Original creators of the competition title pack.", None, "en", None, AW)
e("smurfen", "Smurfen", "events", TM2, "https://www.smurfen.net/", None,
  "Organises cups in Canyon and Valley.", None, "en", None, AW)
e("tm-world-team-cup", "TrackMania World Team Cup", "events", ALL, "https://tm-worldteamcup.de/", None,
  "National team world cup.", None, "de", None, AW)
e("tm-grand-league", "TrackMania Grand League", "events", ALL, "https://www.trackmania-grand-league.com/", None,
  "World cup with Nadeo local finals.", None, "en", None, AW)
e("zrt-tmcup", "ZeratoR TM Cup", "events", ALL, "http://tmcup.fr/", None,
  "Yearly competition run by streamer ZeratoR.", "ZeratoR", "fr", None, AW)
e("trackmania-rpg", "TrackMania RPG", "community", ALL, "http://www.trackmania-rpg.com/", None,
  "Forum for RPG racing style.", None, "en", None, AW)
e("rmc-openplanet", "ManiaExchange Random Map Picker (RMC plugin)", "events", ["tm2020"] + TM2, "https://openplanet.dev/plugin/mxrandom", None,
  "Openplanet plugin that runs the Random Map Challenge on random TMX maps.", None, "en", "link plugin", "https://openplanet.dev/plugin/mxrandom")
e("rmct-weekly", "RMCT Weekly (Liquipedia)", "events", ["tm2020"], "https://liquipedia.net/trackmania/RMCT/2", None,
  "Weekly tournament based on the Random Map Challenge plugin.", None, "en", None, "https://liquipedia.net/trackmania/RMCT/2")
e("kacky", "Kacky", "events", TM2 + ["tm2020"], "https://discordbotlist.com/servers/the-kacky-discord-615881817081249851", None,
  "Listing of the Kacky community Discord, a hard-map competition.", None, "en", None, "discordbotlist search result")
e("youtube-trackmania", "Trackmania on YouTube", "community", ["tm2020"], "https://www.youtube.com/@trackmania", None,
  "Official Trackmania YouTube channel (handle unverified).", "Nadeo / Ubisoft", "en", "open in browser", "guess")
e("twitch-trackmania", "Trackmania on Twitch", "community", ["tm2020"], "https://www.twitch.tv/trackmania", None,
  "Official Trackmania Twitch channel.", "Nadeo / Ubisoft", "en", "open in browser", "guess")
e("ubisoft-nadeo-medium", "Ubisoft Nadeo blog", "community", ALL, "https://medium.com/ubisoft-nadeo", None,
  "Developer blog posts from Nadeo.", "Nadeo", "en", None, "https://medium.com/ubisoft-nadeo/special-trackmania-10th-anniversary-car-models-for-canyon-stadium-valley-95fbe1558c97")
e("awesome-trackmania", "awesome-trackmania list", "docs", ALL, "https://github.com/EvoEsports/awesome-trackmania", None,
  "Curated list of Trackmania resources.", "Evo Esports", "en", None, AW)
e("kackiest-kacky-awesome", "Marie's Trackmania Stuff", "docs", [], "https://mariejuku.github.io/", None, "dup", None, "en", None, "dup")
E.pop()

# Discord (invite codes from awesome-trackmania; verified through the public invite API)
DISC = [
 ("discord-trackmania-hub", "Trackmania (community hub)", "https://discord.gg/sj3KUp8", "en", ALL),
 ("discord-evo", "Evo Esports", "https://discord.gg/evotm", "en", ALL),
 ("discord-openplanet", "Openplanet", "https://discordapp.com/invite/6JesQ6h", "en", ["tm2020"] + TM2),
 ("discord-mania-exchange", "Mania Exchange", "https://discordapp.com/invite/uRwvByS", "en", ALL),
 ("discord-maniapark", "ManiaPark", "https://discordapp.com/invite/GudjUf9", "en", ALL),
 ("discord-developers", "ManiaPlanet Creators' place / Developers", "https://discordapp.com/invite/kG9TjxF", "en", TM2),
 ("discord-speedrunning", "Trackmania Speedrunning", "https://discordapp.com/invite/yJ4G4r6", "en", ALL),
 ("discord-news", "Trackmania News / Player Transfers", "https://discordapp.com/invite/wCmsgSm", "en", ALL),
 ("discord-rpg-trial", "RPG and Trial", "https://discordapp.com/invite/TrD3HXE", "en", ALL),
 ("discord-smurfen", "Smurfen.net", "http://discord.smurfen.net/", "en", TM2),
 ("discord-fullspeed", "FullSpeed League", "https://discord.gg/6zGZU9P", "en", TM2),
 ("discord-tm-open", "TrackMania Open", "https://discord.gg/qC5684m", "en", ALL),
 ("discord-liquipedia", "Trackmania Liquipedia", "https://discord.gg/dMaeEQE", "en", ALL),
 ("discord-tm-one", "TrackMania One", "https://discordapp.com/invite/9w2uggH", "en", ["tmo"]),
 ("discord-pursuit", "TrackMania2 Pursuit", "https://discord.gg/BBHC3sT", "en", TM2),
 ("discord-esac", "ESAC", "https://discord.gg/UrxH2SP", "en", ALL),
 ("discord-united-unicorns", "United Unicorns", "https://discord.gg/457Bxpf", "en", ["tmuf"]),
 ("discord-united-designers", "United Designers", "https://discord.gg/v96Xq25", "en", ["tmuf"]),
 ("discord-nascar", "Trackmania Nascar", "https://discord.gg/v3eWrzh", "en", ["tmnf"]),
 ("discord-grand-league", "TrackMania Grand League", "https://discord.gg/BnKX24m", "en", ALL),
 ("discord-tm-open-comp", "TrackMania Open (competition server)", "https://discord.gg/QNmVbws", "en", ALL),
 ("discord-dirt-league", "Trackmania Dirt League", "https://discord.gg/VhFWRcb", "en", ALL),
 ("discord-tmcs", "TrackMania Championship Series", "https://discord.gg/zvSXSXM", "en", ALL),
 ("discord-world-team-cup", "World Team Cup", "https://discord.gg/nyZRqnH", "en", ALL),
 ("discord-tmx-allround", "TMX AllRound Competition", "https://discord.gg/SmdrVHt", "en", FOREVER),
 ("discord-kackiest-kacky", "Kackiest Kacky", "https://discord.gg/VV46BqA", "en", ALL),
 ("discord-planet-dirt-cup", "Planet Dirt Cup", "https://discord.gg/Uy2qhYf", "en", ALL),
 ("discord-spawncup", "SpawnCup", "https://discord.gg/c2z23tk", "en", ALL),
]
# Dead 2020 invites replaced by the current invite of the same server in mx_eyebo's Discord server list
# (public Google Sheet, read by packages/api as communities.json; matched by server name, 2026-11-10).
SHEET = "https://docs.google.com/spreadsheets/d/1Rr581P5Icd5_-bYypVLaUDqi1pdMGbBNM-E7Bapz_ME/ (list by mx_eyebo / Mania Exchange)"
SHEET_INVITE = {
 "discord-trackmania-hub": "https://discord.gg/trackmania",
 "discord-evo": "https://discord.gg/evoesports",
 "discord-nascar": "https://discord.gg/xjBcAEM",
}
for i, n, u, l, g in DISC:
    if i in SHEET_INVITE:
        e(i, n + " (Discord)", "community", g, SHEET_INVITE[i], None, "Discord server; the 2020 invite from awesome-trackmania is dead, this is the current invite from the community server list by mx_eyebo.", None, l, "open invite link", AW + "; " + SHEET)
        continue
    e(i, n + " (Discord)", "community", g, u, None, "Discord server listed in awesome-trackmania; invite checked via the public invite API.", None, l, "open invite link", AW)
# Discord via discovery pages / bot list (found directly in search)
DISC2 = [
 ("discord-trackmania-discovery", "Trackmania (Discord discovery page)", "https://discord.com/servers/trackmania-158349559959912448", "Community-run main Trackmania server, public discovery page."),
 ("discord-evo-discovery", "Evo Esports (Discord discovery page)", "https://discord.com/servers/evo-esports-384138149686935562", "Event organiser server, public discovery page."),
 ("discord-tma-discovery", "TMA Trackmania Mapping Assembly (Discord discovery page)", "https://discord.com/servers/tma-trackmania-mapping-assembly-838391457688846337", "Server for mappers, public discovery page."),
 ("discord-maji-discovery", "Maji's community (Discord)", "https://discord.gg/maji", "Community server; the old discovery page is gone, this is the invite from the community server list by mx_eyebo."),
 ("discord-openplanet-botlist", "Openplanet (Discord Bot List)", "https://discordbotlist.com/servers/openplanet", "Listing page of the Openplanet server."),
]
for i, n, u, d in DISC2:
    e(i, n, "community", ALL, u, None, d, None, "en", "open in browser", "discord.com / discordbotlist search results")

for slug, nm, gm in [("tmo","TrackMania Original",["tmo"]),("tm2canyon","TM2 Canyon",["tm2-canyon"]),("tm2stadium","TM2 Stadium",["tm2-stadium"]),
                     ("tm2valley","TM2 Valley",["tm2-valley"]),("tm2lagoon","TM2 Lagoon",["tm2-lagoon"]),("tmturbo","Trackmania Turbo",["turbo"])]:
    e("speedrun-"+slug, "speedrun.com "+nm, "leaderboard", gm, "https://www.speedrun.com/"+slug, "https://github.com/speedruncomorg/api",
      "Speedrun leaderboards for "+nm+".", None, "en", "open in browser; public API", "https://www.speedrun.com/api/v1/games?name=trackmania (speedrun.com API game list)")

def showcases():
    import mods_seed
    out = []
    for mod, f in mods_seed.SHOWCASES:
        doc = json.load(open(os.path.join(HERE, "showcases", f), encoding="utf-8"))
        doc.pop("$schema", None)
        out.append({"mod": mod, "showcase": doc})
    return out

def main():
    seen = set()
    entries, sources = [], {}
    for (i, name, cat, games, url, api, desc, maint, lang, launcher, src) in E:
        assert i not in seen, i
        seen.add(i)
        entries.append(dict(id=i, name=name, category=cat, games=games, url=url, api=api,
                            description=desc, maintainer=maint, language=lang, status="unclear",
                            checked=None, launcher=launcher))
        sources[i] = src
    import mods_seed
    for d in mods_seed.M:
        assert d["id"] not in seen, d["id"]
        seen.add(d["id"])
        src = d.pop("_source")
        d.update(status="unclear", checked=None)
        if d["note"] is None:
            del d["note"]
        entries.append(d)
        sources[d["id"]] = src
    byid = {x["id"]: x for x in entries}
    for i, extra in mods_seed.PATCH.items():
        byid[i].update({k: v for k, v in extra.items() if v not in (None, [])})
    for i, x in mods_seed.SPECS.items():
        byid[i]["installSpec"] = x["spec"]
        if x["spec"] is None:
            byid[i]["downloadNote"] = x["note"]
    for i, z in getattr(mods_seed, "ZIP_INSTALL", {}).items():
        byid[i]["zipInstall"] = z
    # Type review (types.json): category / modType per entry, also applied in place by reclassify.mjs.
    types = json.load(open(os.path.join(HERE, "types.json"), encoding="utf-8"))["entries"]
    for i, t in types.items():
        if i in byid:
            byid[i].update({k: v for k, v in t.items() if k in ("category", "modType")})
    json.dump({"updated": None, "collections": mods_seed.COLLECTIONS, "pictures": mods_seed.PICTURES, "modLinks": mods_seed.MOD_LINKS, "showcases": showcases(), "entries": entries}, open(os.path.join(HERE, "catalog.json"), "w", encoding="utf-8"), indent=1, ensure_ascii=False)
    json.dump(sources, open(os.path.join(HERE, "sources.json"), "w", encoding="utf-8"), indent=1, ensure_ascii=False)
    print(len(entries), "entries")

if __name__ == "__main__":
    main()
