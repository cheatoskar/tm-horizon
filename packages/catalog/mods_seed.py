#!/usr/bin/env python3
"""Mods from the community Discord mod channel (export dated 2026-11-10) plus mods named by the owner.
Each item is a dict; build_catalog.py merges them into catalog.json.
Optional fields (only on these entries): author, modType, install, requires, hosting, urls (mirrors), note.
url is None when the file lives only in the Discord post (signed attachment links expire); status stays "unclear".
"""
TMF = ["tmnf", "tmuf"]
TM2 = ["tm2-canyon", "tm2-stadium", "tm2-valley", "tm2-lagoon"]
DISCORD_NOTE = "File lives only in the Discord post (mod-uploading channel); attachment links are signed and expire."
POST = "Discord mod-uploading channel export (posted by %s)"

M = []
def m(id, name, cat, games, url, desc, author, modType, install, hosting, requires=None, urls=None, note=None,
      maintainer=None, launcher="open download page; install into game folder", src=None, language="en", discord_id=None):
    # discord_id: poster's Discord user id (string of digits) from the export; the hub claims the project for that account at Discord login.
    # Never published in packages/api output. Can also be added later through PATCH[id]['authorDiscordId'].
    M.append(dict(id=id, name=name, category=cat, games=games, url=url, api=None, description=desc,
                  maintainer=maintainer, language=language, launcher=launcher,
                  author=author, modType=modType, install=install, requires=requires or [], hosting=hosting,
                  urls=urls or [], note=note or (DISCORD_NOTE if hosting == "discord-attachment" else None),
                  _source=src or (POST % author), **({"authorDiscordId": str(discord_id)} if discord_id else {})))

# ---- community environments (category "environment"); url None until the official source is known (hosting "pending")
m("env-tm-highlands", "TrackMania Highlands", "environment", ["tmuf"], "https://www.moddb.com/mods/trackmania-highlands",
  "The first community environment for TrackMania United Forever. TM Horizon installs the ZIP from ModDB.",
  "St1ngLeR & TrackMania Modding Community", "environment", "manual", "moddb", launcher=None,
  src="https://www.moddb.com/mods/trackmania-highlands (GET 200 on 2026-11-11: title \"TrackMania Highlands mod - ModDB\", description \"Highlands is the first ever brand new community environment for TrackMania United Forever.\")")

# ---- on Discord only
m("mod-simple-menu-enhance", "Simple menu enhance", "mod", ["tmuf"], None,
  "Replaces one menu texture to remove banding around the globe.", "marosis [TM]", "interface",
  "gamedata: TmUnitedForever\\GameData\\MenuForever\\Media\\Texture\\Image", "discord-attachment", launcher=None)
m("mod-bay-buildings", "Bay Buildings", "mod", TMF, None,
  "Bay buildings for all environments, usable at 1x or 0.75x scale.", "St1ngLeR", "block", "manual", "discord-attachment",
  requires=["TMInfinity"], launcher=None)
m("mod-turbo2-blocks-eswc", "Turbo2 Blocks for TMN ESWC", "mod", ["eswc"], None,
  "Working red turbo blocks for all road types in Nations ESWC.", "greffmaster", "block", "manual", "discord-attachment", launcher=None)
m("mod-medal-cars", "Medal Cars", "skins", ["tms"], None,
  "Adds the hidden medal car skins to Sunrise.", "Crigrey12C(18)", "skin", "skins", "google-drive")
m("mod-tm-advertisements", "TrackMania Advertisements by MaxNk_12", "skins", ["tmuf"] + TM2, None,
  "Simple custom advertisement textures made in GIMP.", "𝑵a𝒸𝗵𝙤.ʂ𐍈ℓ𝒾d.g𝔟𝐱 [TMX]", "blockskin", "manual", "discord-attachment", launcher=None)
m("mod-custom-led-font", "Custom Led Font Texture", "mod", ["tmuf", "eswc", "tms", "tmo", "tm1"], None,
  "Replaces the LED font texture, leaving a metallic look; back up first.", "𝑵a𝒸𝗵𝙤.ʂ𐍈ℓ𝒾d.g𝔟𝐱 [TMX]", "interface", "manual", "discord-attachment", launcher=None)
m("mod-island-helipad", "Island Helipad block", "mod", ["tmsx", "tmu2006", "tmnf", "tmuf"], None,
  "Helipad block for Island from TrackMania Wii with animated rotors; works without TMUnlimiter.", "St1ngLeR", "block",
  "manual", "discord-attachment", launcher=None)
m("mod-stadium-road-clip-removers", "Stadium Road Clip Removers", "mod", TMF,
  "http://maniacdn.net/greffmaster/TMF/Blocks/StadiumRoadClipRemovers_v1.0.0.zip",
  "Blocks that remove clips from main and tilted Stadium roads; only useful together with TMUnlimiter custom roads.",
  "greffmaster", "block", "unlimiter-required", "own-site", requires=["TMUnlimiter"])
m("mod-stadiumcar-para-skin", "StadiumCar \"Pará\" skin", "skins", TMF, None,
  "Stadium car skin themed on the Brazilian state of Pará.", "𝑵a𝒸𝗵𝙤.ʂ𐍈ℓ𝒾d.g𝔟𝐱 [TMX]", "skin", "skins", "discord-attachment", launcher=None)
m("mod-rally-pc3-shader-fix", "Rally PC3 Shader Fix", "mod", ["tm1"], None,
  "Adds missing shaders for TM 1.0 Rally, with a fixed water shader (revision 3).", "greffmaster", "fix", "manual", "discord-attachment", launcher=None)
m("mod-tmo-online-patch", "TMO Online Patch (Fixed)", "mod", ["tmo"], None,
  "Redirects www.trackmania.com to game.trackmania.com for the online parts of TMO; the target server is offline, so it no longer works.",
  "greffmaster", "fix", "manual", "discord-attachment", launcher=None,
  note=DISCORD_NOTE + " The author notes the patch no longer works.")
m("mod-classic-advertising", "Classic Advertising", "skins", TMF, None,
  "Advertising textures like the old TMNF reflections (the post does not name the game version).", "Crigrey12C(18)", "blockskin",
  "manual", "discord-attachment", launcher=None)
m("mod-no-forever-in-medals", "No \"Forever\" in Medals", "mod", ["tmuf", "tmnf"], None,
  "Removes the word Forever from every medal.", "CROSSIGOSmurf", "interface", "manual", "discord-attachment", launcher=None)
m("mod-nadeo-cup-restoration", "Nadeo Cup Restoration Mod", "mod", ["tmsx"], None,
  "Non-destructive patch that brings back the unused Nadeo Cup in Sunrise eXtreme.", "greffmaster", "fix", "manual", "discord-attachment", launcher=None)
m("mod-rally-advertising-square-tower", "Rally Advertising Square Tower Block", "mod", ["tms", "tmo"], None,
  "Adds the scrapped Rally pillar advertisement block; TMO support is experimental. Models come from TrackMania Wii.",
  "greffmaster", "block", "manual", "discord-attachment", launcher=None)
m("mod-tmf-stadium-clouds-fix", "TMF_Stadium_Clouds_Fix", "mod", TMF, None,
  "Restores the Stadium cloud colours from TMU with two small files.", "Świeży", "fix", "manual", "discord-attachment", launcher=None)
m("mod-nando-banner", "NANDO banner", "skins", TMF, None,
  "Changes the checkpoint banner text to NANDO.", "SeeenW [TM]", "texturepack", "manual", "discord-attachment", launcher=None)
m("mod-tm-wii-skin-pack", "Trackmania Wii Skin pack", "skins", TMF, None,
  "Converted TrackMania Wii skins for Desert, Rally, Snow, Island, Coast and Stadium; the pack was re-uploaded as zip after a rar mistake.",
  "Xlizikk [かめりあ]", "skin", "skins", "discord-attachment", launcher=None,
  note=DISCORD_NOTE + " The post says to look in its thread or the mod-uploading channel for the current file.")
m("mod-champion-mod", "ChampionMod", "mod", ["tmuf"], None,
  "Adds Warrior and Champion medals above the author medal on 917 official tracks; writes nothing to game files.",
  "Paulo", "medals", "tmloader: copy ChampionMod folder to %LocalAppData%\\TMLoader\\database\\TmForever\\products", "discord-attachment",
  requires=["TMLoader"], launcher="install into TMLoader products folder", note=DISCORD_NOTE + " Version 1.0.1.")

# ---- hosted elsewhere
m("mod-old-in-one", "Old in One", "mod", ["tmu2006"], None,
  "Beta of a complete mod that restores the first seven environments of TrackMania United with all official vehicle skins.",
  "Deleted User", "standalone", "manual", "yandex", note="Beta only; the final release was not out at the time of the post.")
m("mod-trackmania-rtx-20th", "TrackMania RTX : 20th Anniversary", "mod", ["tm1"], None,
  "Pre-alpha (v0.3.0) complete mod for TrackMania (2003) by the author of TM SSU.", "Deleted User", "standalone", "manual", "yandex")
m("mod-mid-fight-masses", "Mid Fight Masses Songpack", "mod", TMF + TM2 + ["tm2020"],
  None,
  "Custom in-game music pack with Mid-Fight Masses converted to ogg.", "﹒ 𑣲　𓏼　stmekh   ⌣  . [SDVN]", "music", "manual", "google-drive")
m("mod-outrun-c2c-ost", "OutRun 2006 C2C OST for Trackmania", "mod", ["tms"] + TMF + TM2,
  None,
  "OutRun 2006 C2C soundtrack as MUX and OGG files for the in-game music folder.", "𝑵a𝒸𝗵𝙤.ʂ𐍈ℓ𝒾d.g𝔟𝐱 [TMX]", "music", "manual", "google-drive")
m("mod-nando-banners", "nando banners", "skins", TMF, "https://archive.org/details/ad-8x-1-d",
  "Replacement files that change the side Stadium and checkpoint banners to say nando.", "teout", "texturepack",
  "gamedata: GameData\\Interface\\Advertising", "archive.org")
m("mod-nf-to-mp3", "NF to MP3", "mod", ["tmnf"], None,
  "Makes Nations Forever feel like ManiaPlanet 3 with new sounds, reflections, brighter signals, sky colours and TM2 signs; based on TMUTP.",
  "SeeenW [TM]", "texturepack", "manual", "google-drive", urls=["https://tmnf.exchange/trackpackshow/12834275"],
  note="Companion TM2 map pack on TMNF-X is listed under urls.")
m("mod-tmutp", "TrackMania United Transformation Pack (TMUTP)", "mod", ["tmuf"],
  "https://pixelpickaxe.github.io/trackmania-united-transformation-pack/",
  "Unofficial visual enhancement mod for TrackMania United Forever.", None, "graphics", "manual", "github",
  src="Linked in the Discord NF to MP3 post; project page described there as an unofficial visual enhancement mod")
m("mod-snowy-highland", "Snowy Highland", "skins", TMF, "https://maniapark.com/mod/PK_t88ghE0i0VSysIFfQHg",
  "Texture mod for the Highlands environment folder with a snowy look.", "﹒ 𑣲　𓏼　stmekh   ⌣  . [SDVN]", "texturepack",
  "gamedata: Highlands folder", "maniapark")
m("mod-cinnaventurer-space-station", "Cinnaventurer Space Station", "skins", TMF, "https://maniapark.com/mod/pkjLI2Owd0-giDhjkk92FA",
  "Space-themed texture mod for the Highlands environment folder.", "﹒ 𑣲　𓏼　stmekh   ⌣  . [SDVN]", "texturepack",
  "gamedata: Highlands folder", "maniapark")
m("mod-newsnowcar", "NewSnowCar", "mod", ["tmuf"], "https://unlimiter.net/resources/NewSnowCar.zip",
  "Separate SnowCar vehicle with fixed collision spheres, selected in the editor, easiest through TMUnlimiter.", "Tomek0055", "vehicle",
  "unlimiter-required", "own-site", requires=["TMUnlimiter"])
m("mod-hitbox-highlandscar", "Hitbox-HighLandsCar", "skins", TMF, "https://maniapark.com/skin/uZUqKYk-kEOWUbSxbXuL-w",
  "Rebuilt Highlands car model with hitbox values supplied by Kim.", "Cely🍀nito [RDR]", "skin", "skins", "maniapark")
m("mod-openal-3d-audio", "OpenAL 1.25.1 with 3D audio", "mod", TMF, "https://files.3zet.net/Trackmania/OpenAL.zip",
  "Drop-in OpenAL replacement with 256 voices instead of 64 and native HRTF calibrated on a Neumann KU100.", "3z", "sound",
  "gamedata", "own-site")
m("mod-tm-wii-block-collection", "Trackmania Wii Block Collection", "mod", TMF, "https://supercoby.fr/Unlimiter/united",
  "All Wii-exclusive blocks, including extra hot air balloon variants.", "Xlizikk [かめりあ]", "block", "unlimiter-required", "own-site",
  requires=["TMUnlimiter"])
m("mod-centerspeed", "CenterSpeed", "mod", TMF, "https://fullspeed.mooo.com/mod",
  "HUD mod: speed in screen centre or on the plate, gear and RPM bars, live CP tracking, spectate info, audio tuning and skid swap.",
  "OneCredit", "hud", "tmloader: add https://fullspeed.mooo.com/modloader/ to config.yaml servers and install from the list", "own-site",
  requires=["TMLoader"], urls=["https://fullspeed.mooo.com/modloader/"], launcher="add its modloader server to TMLoader config",
  note="Version 1.4.3 at post time. The modloader URL answers 403 to browsers; it is meant for TMLoader.")
m("mod-kimmod", "KimMod", "mod", TMF, "https://home.koyaanis.com/modloader",
  "TMLoader mod with quality-of-life features and physics speed-ups; needs an AVX CPU.", None, "utility", "tmloader", "own-site",
  requires=["TMLoader"], launcher="install via TMLoader",
  src="https://home.koyaanis.com/modloader (page text: A mod for TrackMania Nations Forever and United Forever, requires TMLoader, latest 1.0.3)",
  note="Latest 1.0.3 on 2026-01-27 per its changelog; author not named on the page.")
m("mod-always-official", "Always Official", "mod", ["tmuf"], "https://github.com/BigBang1112/always-official",
  "Restarts solo runs in official mode without repeating the confirmation.", "BigBang1112", "interface", "tmloader or standalone (see repo guide)", "github",
  requires=["TMLoader"], maintainer="BigBang1112", launcher="install via TMLoader or GitHub release")
m("mod-eswc-autosave", "ESWC Autosave", "mod", ["eswc"], "https://github.com/cheatoskar/eswc-autosave/releases/latest",
  "Saves every finish as a validable replay automatically and fixes the online login error 12157.", "cheatoskar [TMX]", "utility",
  "gamedata: dinput8.dll and eswc_autosave.ini next to TmNationsESWC.exe", "github",
  requires=["unofficial StarForce-free ESWC 1.80 patch"], maintainer="cheatoskar", launcher="install from GitHub release")

# existing catalog entry gets the new optional fields
PATCH = {
    "tm-vibrant-shaders": dict(author="cheatoskar [TMX]", modType="graphics",
                               install="tmloader on TMNF/TMUF; d3d9.dll next to TmNationsESWC.exe (ESWC); d3d11.dll next to ManiaPlanet.exe (TM2, 64-bit)",
                               installs={"tmnf": "tmloader", "tmuf": "tmloader", "eswc": "proxy:d3d9.dll", "tm2-canyon": "proxy:d3d11.dll", "tm2-stadium": "proxy:d3d11.dll", "tm2-valley": "proxy:d3d11.dll", "tm2-lagoon": "proxy:d3d11.dll"},
                               requires=[], hosting="github", urls=[], note=None),
    "mod-eswc-autosave": dict(installs={"eswc": "proxy:dinput8.dll"}),
    "bingoforever": dict(installs={"tmnf": "tmloader", "tmuf": "tmloader"}),
}

# ---- install specs (verified by downloading the file and listing its layout, 2026-11-10)
# installSpec.download.asset is a case-insensitive glob ("*" only). base: game = next to the game exe.
def _files(games, download, base="game", strip=0, include=None, requires=None, note=None):
    s = dict(kind="files", download=download, base=base, strip=strip, games=games)
    if include:
        s["include"] = include
    if requires:
        s["requires"] = requires
    if note:
        s["note"] = note
    return s

SPECS = {
    "tmfoxr": dict(spec=dict(kind="tmloader-product", download=dict(github="jiink/TrackManiaForeverOpenXR", asset="TMFOXR-*-for-TMLoader.zip"),
                             games=["tmuf"], requires=["TMLoader"],
                             note="TMLoader product TMFOXR/<version>; needs a VR headset with an OpenXR runtime.")),
    "mod-always-official": dict(spec=_files(["tmuf"], dict(github="BigBang1112/always-official", asset="AlwaysOfficial-standalone*.zip"),
                                            note="Standalone build (AlwaysOfficial.dll + d3d9.dll proxy); it can collide with other d3d9 mods. The TMLoader server install is the recommended one.")),
    "mod-stadium-road-clip-removers": dict(spec=None, note="The only download is http://maniacdn.net/... (no valid https certificate); open the page and merge the GameData folder by hand."),
    "mod-newsnowcar": dict(spec=_files(["tmuf"], dict(url="https://unlimiter.net/resources/NewSnowCar.zip"), include=["GameData/"],
                                       requires=["TMUnlimiter"], note="Merges a GameData folder into the game folder; easiest to select with TMUnlimiter.")),
    "mod-openal-3d-audio": dict(spec=_files(["tmnf", "tmuf"], dict(url="https://files.3zet.net/Trackmania/OpenAL.zip"),
                                            note="Replaces OpenAL32.dll next to the game exe (backed up first); adds alsoft.ini and the HRTF file D1.mhr.")),
    "mod-nf-to-mp3": dict(spec=None, note="Only shared on Google Drive; no installable public file."),
    "mod-tmutp": dict(spec=None, note="1.7 GB zip (pre-release, 4682 files) that replaces most of GameData; too large for the installer (limit 400 MB). Install by hand per its README."),
    # no file that can be installed
    "tmloader": dict(spec=None, note="TMLoader is the loader itself; install it from its page."),
    "tm-competition-patch": dict(spec=None, note="Competition Patch 2 only exists as a TMLoader mod: tick it in the TMLoader list."),
    "tmunlimiter": dict(spec=None, note="TMUnlimiter is a TMLoader mod: install it from the TMLoader list."),
    "twinkie-forever": dict(spec=None, note="The release is a Windows installer (.exe) plus loose DLLs (TwinkieModloader.dll, LuaEngine2.dll, lua54.dll), not a zip."),
    "bingoforever": dict(spec=None, note="No release on GitHub; the DLL has to be built from source (needs the Twinkie files)."),
    "foreverrpc": dict(spec=None, note="The release zip holds only ForeverRPC.dll without a TMLoader product folder; install it from the TMLoader list."),
    "mod-eswc-autosave": dict(spec=None, note="Installed from the ESWC page (ESWC mods), because it writes dinput8.dll."),
    "mod-centerspeed": dict(spec=None, note="TMLoader mod: add the author's modloader server to config.yaml, then install from the list."),
    "mod-kimmod": dict(spec=None, note="TMLoader mod: add the author's modloader server, then install from the list."),
    "mod-old-in-one": dict(spec=None, note="Yandex Disk file is a 1.3 GB Windows installer (.exe); run it yourself."),
    "mod-trackmania-rtx-20th": dict(spec=None, note="The Yandex Disk link is dead (404)."),
    "mod-mid-fight-masses": dict(spec=None, note="The Google Drive file is gone (404)."),
    "mod-outrun-c2c-ost": dict(spec=None, note="The Google Drive file is gone (404)."),
    "mod-tm-wii-block-collection": dict(spec=None, note="The page lists no direct file; open it and download from there."),
}
for _i in ["mod-simple-menu-enhance", "mod-bay-buildings", "mod-turbo2-blocks-eswc", "mod-custom-led-font", "mod-island-helipad",
           "mod-rally-pc3-shader-fix", "mod-tmo-online-patch", "mod-no-forever-in-medals", "mod-nadeo-cup-restoration",
           "mod-rally-advertising-square-tower", "mod-tmf-stadium-clouds-fix", "mod-champion-mod"]:
    SPECS[_i] = dict(spec=None, note="No download link: the file only lives in the Discord post.")

# ---- TAS mode store (category "tas-plugin": TMInterface plugins/scripts and other TAS tools; shown in TAS mode only).
# Research 2026-11-10 with the GitHub releases API; plugin zips listed and read (a plugin is a folder or single .as file in Documents/TMInterface/Plugins).
SAIMOEN = "https://github.com/Sai-Moen/TMInterface-AS-SaiMoen"
SHW = "https://github.com/Shweetz/TMInterfaceAngelScript"
def tas(id, name, games, url, desc, author, modType, install, src, requires=None, urls=None, note=None, launcher="open page"):
    m(id, name, "tas-plugin", games, url, desc, author, modType, install, None, requires=requires, urls=urls, note=note, launcher=launcher, src=src)
    M[-1]["modType"] = modType

tas("tas-saimoen-incremental", "Incremental", TMF, SAIMOEN,
    "TMInterface plugin: validation handler with input simplifier, SD railgun and steer-max helpers.", "Sai-Moen", "plugin",
    "plugin: folder incremental into Documents/TMInterface/Plugins", SAIMOEN + " (release incremental_v3.3.0, zip read)", requires=["TMInterface"],
    urls=["https://sai-moen.github.io/TMInterface-AS-SaiMoen"])
tas("tas-saimoen-finetuner", "Finetuner", TMF, SAIMOEN,
    "TMInterface bruteforce evaluation plugin with its own settings tab.", "Sai-Moen", "plugin",
    "plugin: folder finetuner into Documents/TMInterface/Plugins", SAIMOEN + " (release finetuner_v2.1.1m, zip read)", requires=["TMInterface"],
    urls=["https://sai-moen.github.io/TMInterface-AS-SaiMoen"])
tas("tas-saimoen-site", "TMInterface-AS-SaiMoen plugin list", TMF, "https://sai-moen.github.io/TMInterface-AS-SaiMoen",
    "Sai-Moen's list of AngelScript plugins (modules and single-file plugins) for TMInterface.", "Sai-Moen", "docs", "see the page",
    SAIMOEN + " README (\"Where to find plugins\")", requires=["TMInterface"])
tas("tas-shweetz-nosepos", "Nosepos+ / AirTime bruteforce", TMF, SHW,
    "TMInterface bruteforce plugins: Nosepos+ and AirTime evaluation modes with conditions and simulation rules.", "Shweetz", "plugin",
    "plugin: folder Shweetz into Documents/TMInterface/Plugins", SHW + " (README, release v1.0.6 Shweetz.zip read)", requires=["TMInterface"])
tas("tas-shweetz-drawfuture", "DrawFuture", TMF, SHW,
    "TMInterface plugin that draws the simulated path of a replay into a second running instance (needs two TMI instances).", "Shweetz", "plugin",
    "plugin: folder DrawFuture into Documents/TMInterface/Plugins", SHW + " (README, release v1.0.6 DrawFuture.zip read)", requires=["TMInterface"])
tas("tas-shweetz-lowinputbf", "LowInputBf", TMF, SHW,
    "TMInterface validation plugin that bruteforces for fewer inputs.", "Shweetz", "plugin",
    "plugin: single file LowInputBf.as in Documents/TMInterface/Plugins", SHW + " (release v1.0.6.1 LowInputBf.as read)", requires=["TMInterface"])
tas("tas-tminterface-public", "TMInterfacePublic", ["tmnf"], "https://github.com/donadigo/TMInterfacePublic",
    "donadigo's public TMInterface sources (bruteforce and simulation controller headers); a reference, not a plugin.", "donadigo", "docs", "none",
    "https://github.com/donadigo/TMInterfacePublic (repo listing; no releases)", requires=["TMInterface"])
tas("tas-plugin-docs", "TMInterface plugin API docs", TMF, "https://donadigo.com/tminterface/plugins/api/all",
    "Full reference of TMInterface's AngelScript plugin API (functions, classes, events).", "donadigo", "docs", "none",
    "https://donadigo.com/tminterface/plugins/api/all (page answered 200)")
tas("tas-tminterface-client-python", "TMInterface Python client", TMF, "https://github.com/donadigo/TMInterfaceClientPython",
    "Legacy Python client for the TMInterface server API (TMInterface below 2.0.0 only); pip install tminterface.", "donadigo", "library", "pip install tminterface",
    "https://github.com/donadigo/TMInterfaceClientPython (README: legacy, TMI < 2.0.0)", requires=["TMInterface 1.4.3"])
tas("tas-forevertas", "ForeverTAS", TMF, "https://github.com/Skycrafter-dev/ForeverTAS/releases/latest",
    "Community TAS tool for TrackMania Nations/United Forever: runs the game physics outside the game and searches inputs on the GPU (v0.2.7 on 2026-10-05).", "Skycrafter", "standalone",
    "Windows installer from the release (pick the GPU package in the app)", "https://github.com/Skycrafter-dev/ForeverTAS/releases/latest (assets read via the API)")
tas("tas-linesight", "Linesight", ["tm2020"], "https://github.com/Linesight-RL/linesight",
    "AI that learns to drive Trackmania with reinforcement learning (Python, v3.0.0); it runs from source and is not installed into the game.", "Linesight-RL", "ai",
    "Python project; follow its README", "https://github.com/Linesight-RL/linesight (releases API: v3.0.0, no assets)")

SPECS["tas-saimoen-incremental"] = dict(spec=dict(kind="files", download=dict(url="https://github.com/Sai-Moen/TMInterface-AS-SaiMoen/releases/download/incremental_v3.3.0/incremental.zip"),
    base="tmi-plugins", strip=0, games=["tmnf", "tmuf"], requires=["TMInterface"], note="Pinned to incremental_v3.3.0; open the page for newer versions."))
SPECS["tas-saimoen-finetuner"] = dict(spec=dict(kind="files", download=dict(url="https://github.com/Sai-Moen/TMInterface-AS-SaiMoen/releases/download/finetuner_v2.1.1m/finetuner.zip"),
    base="tmi-plugins", strip=0, games=["tmnf", "tmuf"], requires=["TMInterface"], note="Pinned to finetuner_v2.1.1m; open the page for newer versions."))
SPECS["tas-shweetz-nosepos"] = dict(spec=dict(kind="files", download=dict(url="https://github.com/Shweetz/TMInterfaceAngelScript/releases/download/v1.0.6/Shweetz.zip"),
    base="tmi-plugins", strip=0, games=["tmnf", "tmuf"], requires=["TMInterface"], note="Pinned to v1.0.6 (newer releases only carry other plugins)."))
SPECS["tas-shweetz-drawfuture"] = dict(spec=dict(kind="files", download=dict(url="https://github.com/Shweetz/TMInterfaceAngelScript/releases/download/v1.0.6/DrawFuture.zip"),
    base="tmi-plugins", strip=0, games=["tmnf", "tmuf"], requires=["TMInterface"], note="Pinned to v1.0.6; needs two TMInterface instances."))
SPECS["tas-shweetz-lowinputbf"] = dict(spec=dict(kind="files", download=dict(url="https://github.com/Shweetz/TMInterfaceAngelScript/releases/download/v1.0.6.1/LowInputBf.as"),
    base="tmi-plugins", strip=0, games=["tmnf", "tmuf"], requires=["TMInterface"], note="Single plugin file, pinned to v1.0.6.1."))
for _i, _n in [("tas-saimoen-site", "A list of plugins, nothing to install itself: pick a plugin there."),
               ("tas-tminterface-public", "No release; source headers only. Get it from GitHub."),
               ("tas-plugin-docs", "Documentation page."),
               ("tas-tminterface-client-python", "Python package for a legacy API; install with pip, not into the game."),
               ("tas-forevertas", "The release is a Windows installer (.exe) per GPU generation; run the setup from the release page."),
               ("tas-linesight", "Python project (AI), runs from source; not installed into the game.")]:
    SPECS[_i] = dict(spec=None, note=_n)

SPECS["env-tm-highlands"] = dict(spec=None, note="Download the installer from the ModDB page.")
# ZIP install in the launcher (game page "Recommended" card): expected ModDB file, filled once checked on its ModDB file page.
# Empty values: the launcher shows the file's own size/MD5 and asks before unpacking. root = folder inside the ZIP that maps to the game folder.
ZIP_INSTALL = {"env-tm-highlands": dict(page="https://www.moddb.com/mods/trackmania-highlands/downloads", fileName="TmHighlands.zip",
    size=677976654, md5="7fb28369f4cc5e1e32b2b9f7468c4c50", sha256="60e7cd8d74b71313fbbf318993976161547a782da0d2fba4acb1dcf35bee091e",
    root="", only="GameData/",
    note="TmHighlands.zip from ModDB, checked 2026-11-11: 2,752 entries, about 1.55 GB unpacked, no programs. GameData/ is merged into the "
         "TMUF game folder; Highlands README.txt and Highlands Credits.txt stay in the ZIP and are shown. It overwrites "
         "GameData/Game.FidCache.Gbx and GameData/Tracks/Campaigns/BaseEditorSimple/BaseEditorSimple.ConstructionCampaign.Gbx; the "
         "History entry keeps both, Undo restores them. Off without uninstalling: the environment collection and HighlandCar are renamed "
         "to *.disabled (as the readme describes).")}

# ---- Browser add-ons for the launcher's embedded browser (category "browser-addon"; Add-ons panel in the Maps/Skins browser).
# Research 2026-11-11: GitHub search (repos, topics, manifest.json code search), addons.mozilla.org API, web search.
# Besides the TMX Universal Track Downloader only TMIOSkinPreview is listed (store link only). The old TMX downloader extension
# is superseded by the TMX Universal Track Downloader and is not listed.
# addon.install: "github" = downloaded from the author's own GitHub release (https, SHA-256 from GitHub's asset digest
# or a SHA256SUMS file), "store" = only the store/source page is offered. permissions/hosts = what was reviewed; the
# launcher warns when a manifest asks for more.
TMX_HOSTS = ["*://tmnf.exchange/*", "*://tmuf.exchange/*", "*://original.tm-exchange.com/*", "*://sunrise.tm-exchange.com/*",
             "*://nations.tm-exchange.com/*", "https://100tmx.com/*", "http://127.0.0.1/*"]
def addon(id, name, games, url, desc, author, spec, src, launcher):
    m(id, name, "browser-addon", games, url, desc, author, "browser-addon", "browser add-on (embedded browser)", spec.get("hosting"),
      launcher=launcher, src=src)
    M[-1]["maintainer"] = author
    M[-1]["addon"] = {k: v for k, v in spec.items() if k != "hosting"}

addon("tmx-universal-track-downloader", "TMX Universal Track Downloader", ["tmnf", "tmuf", "eswc", "tmo", "tms"],
      "https://github.com/cheatoskar/TMX-Downloader",
      "Bulk downloads of TMX search results and trackpacks (ZIP or single files), search statistics, track and user insights, "
      "100% TMX project badges and cheated-map warnings on the five TM-Exchange sites.", "cheatoskar",
      dict(install="github", github="cheatoskar/TMX-Downloader", asset="TMX-Downloader-*-chrome.zip", hosting="github",
           licence="MIT", redistribution=True, manifestVersion=3, browsers=["chrome", "edge", "firefox"],
           permissions=["storage", "alarms"], hosts=TMX_HOSTS,
           permissionsSummary="Reads and changes pages on the five TM-Exchange sites, loads 100tmx.com project status, "
                              "talks to the 100% TMX game mod on 127.0.0.1 (replay bridge, off by default), stores its settings.",
           stores={"chrome": "https://chromewebstore.google.com/detail/hplkjclpiopmjlpejpgkoobghlpbjopp",
                   "firefox": "https://addons.mozilla.org/firefox/addon/tmx-track-downloader/"},
           icon="https://raw.githubusercontent.com/cheatoskar/TMX-Downloader/main/TMX-Downloader2.1/icons/icon128.png",
           compatible=True, devInstall=True,
           note="The toolbar popup (replay bridge switch) has no button in the embedded browser; its card on /replayupload works."),
      "https://github.com/cheatoskar/TMX-Downloader (MIT, releases v2.7.1 with TMX-Downloader-1.7.1-chrome.zip, GitHub sha256 digest per asset)",
      "install from the author's GitHub release into the embedded browser")
addon("tmio-skin-preview", "TMIOSkinPreview", ["tm2020"], "https://addons.mozilla.org/firefox/addon/tmioskinpreview/",
      "Adds a Preview button to trackmania.io skin pages (Firefox only, version 0.1 from 2023).", "Trackmania Skin Viewer Extension",
      dict(install="store", hosting="amo", licence="WTFPL", redistribution=False, manifestVersion=None, browsers=["firefox"],
           permissions=["webNavigation", "tabs", "scripting"], hosts=["https://trackmania.io/*"],
           permissionsSummary="Reads and changes trackmania.io pages; sees your tabs' addresses.",
           stores={"firefox": "https://addons.mozilla.org/firefox/addon/tmioskinpreview/"},
           compatible=False, note="Firefox-only package without a source repository; WTFPL is not an OSI licence, so it is not re-hosted."),
      "https://addons.mozilla.org/api/v5/addons/addon/tmioskinpreview/ (version 0.1, licence WTFPL, permissions listed on AMO, updated 2023-03-31)",
      "open store page")

# ---- curated collections (chips at the top of the launcher's Mods page); ids are catalog entry ids or TMLoader product ids
# Picture overrides for mods whose homepage is another project's repository (keyed by TMLoader
# product name). repo None = no README/pictures from the homepage; gallery/banner = own pictures;
# homepage = shown instead of the index one; project None = no GitHub project (stars, downloads) from the homepage.
PICTURES = [
    {"mod": "TM Clips", "repo": None, "gallery": [],
     # Own homepage (the clips page in the TMVS repo; it may not exist yet) and no TMVS stars/link.
     "homepage": "https://github.com/cheatoskar/TM-Vibrant-Shaders/blob/main/docs/clips.md", "project": None,
     "note": "Its homepage is the TM Vibrant Shaders repository; those screenshots are not TM Clips."},
]

# Related links of mods ("Dazu gehört" on the mod page; the companion link gets the "Open ..." button on the game page).
# Keyed by TMLoader product name or catalog id; only https URLs that answered GET 200 on 2026-11-11.
# TM Clips has none yet: docs/clips.md is not on the TMVS main branch (404).
MOD_LINKS = [
    {"mod": "TMUnlimiter", "links": [
        {"kind": "docs", "label": "AngelScript docs", "url": "https://github.com/tomek0055/TMUnlimiter/wiki/AngelScript"},
        {"kind": "docs", "label": "Wiki", "url": "https://github.com/tomek0055/TMUnlimiter/wiki"},
    ]},
    {"mod": "100% TMX + Bingo", "links": [
        {"kind": "companion", "label": "Bingo-Board", "url": "https://100tmx.com/events/bingo/new"},
        {"kind": "source", "label": "Source", "url": "https://github.com/cheatoskar/100-TMX-Bingo-Plugin"},
    ]},
    {"mod": "TM Vibrant Shaders", "links": [
        {"kind": "docs", "label": "Settings", "url": "https://github.com/cheatoskar/TM-Vibrant-Shaders/blob/main/docs/settings.md"},
        {"kind": "docs", "label": "Release notes", "url": "https://github.com/cheatoskar/TM-Vibrant-Shaders/releases"},
    ]},
    {"mod": "mod-eswc-autosave", "links": [
        {"kind": "docs", "label": "README", "url": "https://github.com/cheatoskar/eswc-autosave/blob/main/README.md"},
    ]},
]

# Showcase pages (packages/shared/src/showcase.ts, docs/hub/showcase.md): mod key as in MOD_LINKS -> file in showcases/.
SHOWCASES = [
    ("TM Vibrant Shaders", "tmvs.json"),
    ("100% TMX + Bingo", "bingo.json"),
    ("mod-eswc-autosave", "eswc-autosave.json"),
    ("tmfoxr", "tmfoxr.json"),
    ("twinkie-forever", "twinkie-forever.json"),
    ("twinkie", "twinkie-forever.json"),
    ("openplanet", "openplanet.json"),
    ("tmloader", "tmloader.json"),
    ("tm-competition-patch", "tm-competition-patch.json"),
    ("tminterface", "tminterface.json"),
    ("tmunlimiter", "tmunlimiter.json"),
    ("mod-kimmod", "kimmod.json"),
    ("mod-centerspeed", "centerspeed.json"),
    ("mod-always-official", "always-official.json"),
    ("forevertas", "forevertas.json"),
    ("env-tm-highlands", "tm-highlands.json"),
    ("mod-tmutp", "tmutp.json"),
    ("nations-converter", "nations-converter.json"),
    ("tmx-universal-track-downloader", "tmx-downloader.json"),
    ("mod-champion-mod", "champion-mod.json"),
    ("mod-openal-3d-audio", "openal-3d-audio.json"),
    ("foreverrpc", "foreverrpc.json"),
    ("gbx-net", "gbx-net.json"),
    ("ultimate-medals", "ultimate-medals.json"),
    ("rmc-openplanet", "mxrandom.json"),
    ("100-tmx-server", "100-tmx-server.json"),
    ("nostalgic-completionist", "nostalgic-completionist.json"),
    ("deltazero", "deltazero.json"),
    ("trackmania-map-mcp", "trackmania-map-mcp.json"),
    ("competition-patch", "tm-competition-patch.json"),
    ("tas-forevertas", "forevertas.json"),
]

COLLECTIONS = [
    dict(id="graphics", name="Graphics", description="Shaders, texture packs and visual fixes.",
         entries=["TM Vibrant Shaders", "mod-tmutp", "mod-nf-to-mp3", "mod-custom-led-font", "mod-tmf-stadium-clouds-fix", "mod-simple-menu-enhance", "mod-snowy-highland", "mod-cinnaventurer-space-station"]),
    dict(id="tas", name="TAS", description="TMInterface and its plugins, ForeverTAS and related tools (TAS mode).",
         entries=["TMInterface", "tas-saimoen-incremental", "tas-saimoen-finetuner", "tas-shweetz-nosepos", "tas-shweetz-drawfuture", "tas-shweetz-lowinputbf",
                  "tas-forevertas", "tas-plugin-docs", "tas-tminterface-public", "tas-tminterface-client-python", "tas-linesight"]),
    dict(id="environments", name="Environments", description="Community environments for the Forever games.",
         entries=["env-tm-highlands"]),
    dict(id="qol", name="QoL", description="Small quality-of-life mods for the Forever games.",
         entries=["Competition Patch", "CenterSpeed", "KimMod", "twinkie-forever", "mod-always-official", "foreverrpc", "mod-champion-mod"]),
]
