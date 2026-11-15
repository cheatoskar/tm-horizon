# Hosting a server: design and status

State 2026-11-11, branch `server-host`. Part 1 (findings) comes from the first round of research and is extended with the checks
of this round; part 2 says what is built. Every statement is either "verified" (primary source read, file
downloaded and hashed, HEAD/GET made) or "not verified". I ran none of this on this PC:
no dedicated server, no PHP, no MariaDB, no router port, no firewall rule, no scheduled task.

## 0. Summary

- **Built:** page "Server" › "Own server": list, wizard (game, name with colour codes and preview, access,
  maps and mode, lists, internet), start/stop, players with kick/ban, guest/ban/admin list, log,
  internet steps with "Check" (account, UPnP, firewall, reachability, hub list), autostart, tray, prompt
  on close, orphan detection. Hub: `POST /v1/servers/reachability` with tests.
- **Engines:** (a) plain dedicated server: built. (b) 100% TMX randomizer: built, needs a GitHub release
  in the repo `cheatoskar/100-TMX-Server` (does not exist yet, see 4.2). (c) XAseco with Dedimania: **blocked**,
  XAseco 1.16 needs PHP 5 (see 4.3); Dedimania itself is running.
- **Games:** TMNF/TMUF fully built (status "Built"); ESWC/Sunrise/Original, TM2 and TM2020 as "experimental"
  (download with pinned SHA-256, config from the real template in the zip, start command, tests against the templates;
  never run against the real server).
- **The first real run** is the test plan in section 8 (me, LAN, then internet with my server login).

## 1. Findings

### 1.1 Dedicated server per game (verified 2026-11-11)

| Game | Download | Size / date | SHA-256 (pinned in the launcher) | Windows exe | Config | Account |
|---|---|---|---|---|---|---|
| TMNF / TMUF | `http://files2.trackmaniaforever.com/TrackmaniaServer_2011-02-21.zip` | 13,075,571 B, 2011-02-21 | `dd021f49…6550c0b` | yes (`TrackmaniaServer.exe`) + Linux ELF | `GameData/Config/dedicated_cfg.txt`, MatchSettings under `GameData/Tracks/MatchSettings/` | LAN none; internet with server login (+ validation key for United) |
| Nations ESWC / Sunrise / Original | `http://slig.free.fr/TM/dedicated/TmDedicatedServer_2006-05-30.zip` (mirror by Slig, Nadeo's original host is gone) | 8,284,536 B, 2006 | `28d79550…bf783d` | yes (`TrackManiaServer.exe`) + Linux | `dedicated.cfg` next to the exe, `/game=nations\|sunrise\|original`, LAN via `<connection_type>LAN`, internet with `/internet` | Master server account with `<nation>` |
| TrackMania² (ManiaPlanet) | `http://files.v04.maniaplanet.com/server/ManiaplanetServer_Latest.zip` | 165,248,842 B, Last-Modified 2019-10-24 | `7ef745e0…02e5f` | yes (`ManiaPlanetServer.exe`) | `UserData/Config/dedicated_cfg.default.txt` (template), script modes `TimeAttack.Script.txt` etc. | Login at maniaplanet.com/account/dedicated-servers (page exists, 302 to login) |
| Trackmania (2020) | `https://nadeo-download.cdn.ubi.com/trackmania/TrackmaniaServer_Latest.zip` | 253,509,378 B, build 2026-05-16 | `5379519e…df1a` | yes (`TrackmaniaServer.exe`) | `UserData/Config/dedicated_cfg.default.txt`; example MatchSettings with `<script_name>Trackmania/TM_TimeAttack_Online</script_name>`; no P2P port | Login at trackmania.com/player/dedicated-servers (302 to login), **also for LAN** (not verified, from the guides) |

License: none of the four zips contains a license text (verified: TMF zip read completely, readme and
CommandLine.html without any license statement; 2006, TM2 and TM2020 zips by file list). We do not redistribute anything; the
launcher downloads from the original location (2006: mirror) and checks the hash.

**TM2020 pin:** Nadeo only has the "Latest" URL; dated names give 403. The pin breaks with the next
server update: the launcher then rejects the download until a launcher update brings the new hash. That is
intended (never run unchecked), but it means: a launcher patch after every TM2020 server update.

Side finding: Git Bash `unzip` extracts the TMF zip wrongly (the Linux file `TrackmaniaServer` overwrites
`TrackmaniaServer.exe` because MSYS treats both names as the same). The launcher extracts with the `zip` crate, so
it is not affected; anyone extracting by hand should know.

### 1.2 Start switches and config (TMF, verified in CommandLine.html and readme)

- TMF 2011: `/lan` makes it LAN, without a switch it goes to the internet (the 2008 readme still says `/internet`,
  the 2009 CommandLine.html says `/lan`). The 2006 server is the other way round: LAN without a switch, `/internet` for online.
- Names with spaces do not work on the command line (readme "Known issues"); name and comment are therefore in
  the config.
- `xmlrpc_allowremote False` = XML-RPC only from this machine. It is like that in the template; the launcher sets it
  anyway, every time.
- Guest/ban list: `guestlist_filename` / `blacklist_filename` in the config (folder `GameData/Config`), at
  runtime via XML-RPC `AddGuest`, `BlackList`, `BanAndBlackList`, `SaveGuestList`, `SaveBlackList` (ListMethods.html).

### 1.3 Controllers per game (verified via GitHub API and README, 2026-11-11)

| Game | Controller | Language | License | Latest state | Dependencies | Assessment |
|---|---|---|---|---|---|---|
| TMF | XAseco 1.16 (xaseco.org) | PHP | GPL-2.0+ | Release 2013-07-26; site maintained (news 2025-11) | PHP 5.2/5.3, MySQL 5 (570 `mysql_*` calls, no `mysqli`) | does not run on PHP 7/8, see 4.3 |
| TMF | Forks "xaseco-php8" (nilakite2), tmu-xaseco-php73-fix | PHP | GPL | 2024 / 2021 | – | no usable fork (a single file, or TMU only, abandoned) |
| TMF | tmserver-docker (pscriptos) | PHP 8.4 | NOASSERTION | 2026-11 | Docker | patches XAseco 1.16 at container start; shows it can be done, but "may still contain errors" |
| TMF | **PyXaseco** (nilakite2) | Python 3.12 | GPL-3.0 | 2026-11-08, v1.6 | MariaDB/MySQL, pip | maintained, Dedimania optional, TMNF/TMUF only; young (since 2026-04) |
| TMF | Trakman (lythx) | TypeScript | MIT | 2026-11-11 | Node 18.20+, **PostgreSQL 12+** | best architecture, but Postgres |
| TMF, 2006 | **100% TMX server** (cheatoskar, fork of BigBang1112/randomizer-anywhere) | C# .NET 10 | AGPL-3.0 | active | none (self-contained publish 101 MB) | built as engine (b) |
| TM2 | PyPlanet | Python 3.8 | GPL-3.0 | 2026-10-29 | MySQL/Postgres (SQLite is the code default, not supported according to the docs), old pins (peewee 2.10) | later |
| TM2 | ManiaControl | PHP 5.4+ | GPL-3.0 | 2025-01-01 | MySQL | later, check PHP version |
| TM2020 | PyPlanet | Python | GPL-3.0 | 2026-10-29 | as above | later |
| TM2020 | EvoSC (PHP) | PHP 7.4 | unclear | 2025-01 | MySQL | do not bundle (license unclear, PHP 7.4 unsupported) |
| TM2020 | **EvoSC#** | C# .NET | GPL-3.0 | 2026-11-10 | **SQLite** possible, but no release assets (Docker/source only) | candidate once there is a release or we build it ourselves |
| 2006 | nothing else found besides the 100% TMX server | | | | | |

### 1.4 Dedimania (TMF, verified 2026-11-11)

- `http://dedimania.net/` responds (Last-Modified 2026-11-09): "Dedimania service for TMF dedicated server
  scripts: seems ok", signed Slig.
- Endpoint `http://dedimania.net:8002/Dedimania`: XML-RPC `system.listMethods` returns the Dedimania methods
  (`Authenticate`, `ValidateAccount`, `PlayerArrive`, `ChallengeRaceTimes`, ...). **The service is running.**
- What it needs (XAseco `dedimania.xml`): server login plus its password or "community code", nation. No
  separate registration with Dedimania, no key.

### 1.5 Runtimes for later controllers (verified, pinned in the launcher in `hosting/deps.rs`)

| Package | URL | SHA-256 | Source of the hash |
|---|---|---|---|
| PHP 8.4.27 NTS x64 | downloads.php.net/~windows/releases/php-8.4.27-1-nts-Win32-vs17-x64.zip | `dbae154a…b63ab7` | sha256sum.txt from windows.php.net = own hash |
| MariaDB 11.8.9 (LTS until 2030) | archive.mariadb.org/mariadb-11.8.9/winx64-packages/mariadb-11.8.9-winx64.zip | `830c4672…1963f5` | sha256sums.txt = own hash |
| Python 3.12.10 embeddable | python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip | `4acbed6d…25a3c3` | own hash (python.org has .sigstore next to it) |

The launcher already has the parts for this: download with pin, unpacking into the data folder, `my.ini` bound to 127.0.0.1 only with
its own port, and `mariadb-install-db` with a generated root password (both only as builders with tests, never started).

## 2. What is built

### 2.1 Structure

| Part | File | What |
|---|---|---|
| Game table | `src-tauri/src/hosting/kinds.rs` | `GameServerKind` per game: package (URL, pin, size), exe, config dialect, template, tracks/list folders, start switches, login required for LAN/internet, login page, query, GBXRemote version, TMX site, allowed engines, status |
| Stored server | `hosting/model.rs` | `server.json` (no secrets), validation with i18n error codes |
| Config | `hosting/config.rs` | Patch the template from the zip (unknown tags stay), MatchSettings (legacy numbers or script + `mode_script_settings`), guest/ban list, start arguments, ports, passwords |
| Engines | `hosting/engines.rs` | `Engine` trait (`prepare` -> start plan, `after_start`); `Plain`, `Randomizer` |
| Processes | `hosting/procs.rs` | Start hidden, output to `console.log`, one job object per server (KILL_ON_JOB_CLOSE), PID file, orphan detection with name check, permissions for the user only (`icacls`) |
| XML-RPC | `hosting/xmlrpc.rs` | GBXRemote 1 and 2, own small parser, fake server for tests (and the demo mode) |
| Maps | `hosting/mapfiles.rs` | real maps only: extension `.Challenge.Gbx`/`.Map.Gbx` AND GBX class `0x03043000` (old `0x24003000`); only the header is read; header data (name with colour codes, author, environment, author time, validated) with cache; embedded thumbnail; migration of old `server.json` |
| TMX | `hosting/tmx.rs` | ID, map link, pack ID/link, search link or name -> preview; download to `servers/<id>/maps/tmx-<id>.Gbx` with class check; at most one request at a time, 350 ms spacing, retry on 429/5xx |
| Players | `hosting/players.rs` | seen logins with last nickname (`servers/<id>/players.json`, at most 500) |
| Console | `hosting/console.rs` | Players (kick, ban, guest, force spectator/player), read/send chat, maps (next, restart, jump), time limit, pause (script modes only) |
| Demo | `hosting/demo.rs` | debug builds only with `TMHUB_HOST_DEMO=1`: "Start" does not start a server, a fake answers XML-RPC (screenshots) |
| Network | `hosting/netops.rs` | UPnP (`igd-next`, MIT): game and P2P port only, TCP+UDP, 1 h lease with renewal, removed on stop; firewall `netsh` command and start with UAC; reachability verdict; hub entry and report |
| Autostart | `hosting/autostart.rs` | one scheduled task "TM Horizon\Servers" from XML (logon trigger for this user only, LeastPrivilege, no admin), starts `--start-servers` |
| Secrets | `hosting/secrets.rs` | Windows Credential Manager (`TM Horizon/server/<id>/…`), Linux/tests: file with 0600 |
| Downloads | `hosting/deps.rs` | Pin check before unpacking, cache, zip path check, randomizer from GitHub release with digest, hard link of the 101 MB exe per server, runtime pins |
| Flow | `hosting/mod.rs`, `hosting/app.rs` | Start in the background with steps ("downloading", "waiting for the server", ...), watchdog (crash, UPnP renewal, hub report every 5 min), stop (`QuitGame`, kill job after 10 s), Tauri commands, tray, close prompt |
| UI | `src/pages/HostServers.tsx`, `src/data/hosting.ts`, `src/ui/hosting/*` | List, wizard, detail tabs; colour code parser `src/data/tmformat.ts` with preview |
| Hub | `apps/server/src/services/reachability.ts`, `routes/servers.ts` | Self test |

Folder per server: `<data folder>/servers/<id>/` with `server.json`, `run.json` (PID, UPnP entries),
`console.log`, `dedicated/` (own copy of the server) or `randomizer/`. Shared: `servers/_cache/`
(verified zips), `servers/_tmx/` (old TMX cache, read only now), `servers/_tools/randomizer/<tag>/`. New per
server: `maps/` (TMX maps, downloaded on add), `players.json` (seen players), `server.json.bak` (after the
migration).

### 2.2 Security

- XML-RPC: always `xmlrpc_allowremote False` in the config; never in UPnP, never in the firewall rule (tests
  check both). Level passwords (SuperAdmin/Admin/User) random, 24 characters, in the Credential Manager; the
  config file gets user-only permissions. Exception randomizer: it logs in with a hard-coded `SuperAdmin/SuperAdmin`
  (its code); it stays local, but any process on the PC could connect. Suggestion to myself:
  `SuperAdminPassword` as a config key in the randomizer.
- Server account password: Credential Manager; it goes into the config file because the server only reads it from there; for the
  randomizer via the environment variable `RANDANY_SERVER_PASSWORD`. Never on the command line, never in the log.
- Downloads only with a pinned SHA-256 (GitHub digest for the randomizer); wrong hash = file deleted, nothing
  executed. Zip entries with `..` are rejected.
- Nothing against Nadeo's master server: the launcher builds no login, no connect, no account creation.
  A button opens account pages in the browser.
- Firewall rule only on click, with UAC confirmation, command visible beforehand; paths with `& | ^ % "` are
  rejected instead of escaped.
- Orphans: the PID file only counts if the process with that PID has the same program name (PID reuse).

### 2.3 Lifetime

- Servers run as children of the launcher, each in its own job object. Closing the game: irrelevant. Closing the
  window with running servers: prompt "Keep running / Stop and quit / Cancel"; "Keep running"
  hides the window and a tray icon appears ("Open TM Horizon", "Stop servers and quit").
- Launcher crash: the job object ends the servers too (intended: no invisible servers). On the
  next start: check the PID file, "Still running from last time" with Stop/Keep (Linux, or if the
  assignment to the job failed); UPnP entries from `run.json` are removed on stop.
- Autostart per server; the one scheduled task exists as long as at least one server wants it. If the
  launcher is already running, the second call (`--start-servers`) only starts the servers.

### 2.4 Internet steps in the wizard and in the "Internet" tab

1. Server account: TMF text (own account, not the game account), TM2/TM2020 button "Open page" to the
   official page; enter login + password (+ validation key for United). "Check": format immediately; whether the
   master server accepts the account only shows on the running server (note in the UI).
2. Router: UPnP on/off; result with mapped ports or an error; otherwise the text "Forward TCP and UDP 2350/3450",
   always "Never forward the XML-RPC port".
3. Firewall: command visible, "Allow" (UAC), "Check" (`netsh ... show rule`, without admin).
4. Reachability: "Check" via the hub; plain-language verdict: reachable / CGNAT / router refuses / firewall / UPnP off /
   hub not reachable. CGNAT detection: WAN address of the router (UPnP) is private or 100.64/10, or differs from the
   address the hub sees. UDP cannot be checked with TCP ("UDP is confirmed when a friend joins").
5. Public list: only after ticking "IP and name are shown publicly", only with a passed test, contact
   for the admins; then paste the token, report every 5 min.

### 2.5 Maps, TMX, lists, console (branch host-polish, after my first LAN test)

- Bug from the test: via "Files…", replays (`*.Replay.Gbx`) ended up in the list as maps. Now the GBX class
  decides; the extension alone is not enough. The file dialog returns maps only (the rest is reported as
  "skipped"), `host_save` rejects non-maps, and the start (`place_maps`) checks once more.
  When the server list loads, old `server.json` files are cleaned up (replays removed, backup `server.json.bak`, a note
  at the top of the page until it is closed). Missing files stay in the list (the drive may not be there).
- Templates/empty maps: a map without an author time has never been validated; the TMF server does not load it
  ("Track not complete", see tm-modding-knowledge/server/xmlrpc-dedicated.md). The picker shows such maps
  as "Not validated" and does not let you add them (except in Stunts mode). The migration does not remove them.
- Map picker: sources on the left (My maps with folder tree, TMX, Files…), the server's list on the right with
  drag / Alt+arrow to reorder, random order, remove. Each row: thumbnail (from the file, or from TMX
  via the image cache), name with colour codes, environment, author, author time, source. One search applies to both sides.
- TMX: hosts per game as in `kinds.rs`; packs via `/api/trackpacks` or `/api/mappacks` and `packid`/`mappackid`,
  up to 500 maps (pages with `after=<last ID>`). Images: TMX `/trackshow/<id>/thumbnail`, MX `/mapthumb/<id>`
  (verified 2026-11-11). The maps live in the server's folder, never in a game folder; the TMX ID stays in the
  entry (for later updates). If you cancel the wizard of a new server, its folder is deleted.
- Lists: "Recent players" offers logins that the launcher has seen on the server (the server itself keeps
  no list, its logs do not name players); the watchdog reads the player list every 15 s. The last nickname is shown
  next to each login.
- Console: everything via the local XML-RPC with the SuperAdmin password from the Credential Manager. TMF names
  (`NextChallenge`, `ChallengeRestart`, `SetNextChallengeIndex`, `SetTimeAttackLimit`, `ForceSpectator`,
  `ChatSendServerMessage`, `GetChatLines`) or ManiaPlanet names (`NextMap`, `RestartMap`, `JumpToMapIndex`,
  `SetModeScriptSettings`, pause via `Maniaplanet.Pause.SetActive`). The old servers cannot pause.
- XML-RPC stays local: `xmlrpc_allowremote False` in every config (randomizer: sets it itself, `ServerSetup.cs`),
  the port is in neither UPnP nor the firewall rule (tests `never_maps_xmlrpc`, `firewall_command`).

## 3. Engine comparison

| | Plain | Randomizer (100% TMX) | XAseco + Dedimania |
|---|---|---|---|
| What | Nadeo's server, launcher as control | random TMX maps without a record, chat commands, votes, leaderboard, status page | records, Dedimania, chat commands, plugins |
| Games | all seven | TMNF, TMUF, ESWC, Sunrise, Original | TMNF, TMUF |
| Dependencies | none | own exe (self-contained, 101 MB, hard link per server) | PHP 5 + MySQL 5 (no longer supported) |
| Maps | own maps + TMX | picks itself (preset) | own |
| Password/slots | config | via XML-RPC after the start (the randomizer has no keys for it) | config |
| Status | built, tests with fake server | built, release missing | blocked |

## 4. Engines in detail

### 4.1 Plain

`prepare`: fetch the zip (cache, pin), unpack to `dedicated/` (only when the pin changes), save the template once as
`*.horizon-template`, patch the config from it, copy maps to `Tracks/Challenges/Horizon/` or `Maps/Horizon/`
(maps only, by extension and GBX class, at most 8 MB; replays are rejected), `MatchSettings/horizon.txt`, lists. Start with
`/dedicated_cfg=… /game_settings=MatchSettings/horizon.txt` and `/lan` (TMF/TM2/TM2020 on LAN) or `/internet`
(2006 online), `/nodaemon` on Linux.

### 4.2 Randomizer

- Source: latest release in `cheatoskar/100-TMX-Server` with the asset `RandomizerAnywhere-win-x64.zip`
  (or `-linux-x64.zip`), verified with GitHub's SHA-256 digest. To test beforehand:
  `TMHUB_RANDOMIZER_DIR=<folder with the dotnet publish output>`.
- **Still missing:** a release. `dotnet publish RandomizerAnywhere/RandomizerAnywhere.csproj -c Release -r win-x64
  --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:DebugType=none`
  builds cleanly here (verified: `RandomizerAnywhere.exe` 105,585,292 B + `config.default.toml`, `Presets/`,
  `WebStatus/`). Upload the zip of that as a release asset, or add a release action with exactly this command.
- License: AGPL-3.0; source named in the wizard, `/source` in the game. The launcher (AGPL) downloads the release, which
  is fine.
- `config.toml` is generated: game, preset, AutoSkip, time budget, display name with colour codes, comment, ports,
  `Lan`, server login, `AdminLogins` (empty = `-` = nobody; empty would mean "everyone is admin" in the randomizer),
  `[DownloadSha256]` with our pins. The launcher already puts the dedicated server, verified, into
  `randomizer/Servers/…`, so the randomizer does not download it again (not verified: its ETag cache might
  still download it once more; the pin applies there too).
- After the start: password, spectator password, slots, guest/ban list via XML-RPC.
- Taken from my live setup (`100_server`, read only): ports per instance (+1), `ConnectionUploadRate
  10240`, separate folders per instance. Not taken: Discord webhooks, `PublicHost`, the status page exposed to the outside.
  The status port is chosen freely per server, but not mapped.

### 4.3 XAseco with Dedimania: blocked

- XAseco 1.16 (current, 2013) is PHP 5 code with 570 `mysql_*` calls; `mysql_*` has not existed since PHP 7.0.
  PHP 5.6 has had no security updates since 2018. A maintained PHP 8 fork does not exist.
- Project rule: do not ship an engine with an unpatched, unsupported runtime. That is why it is visible in the
  wizard but locked, with a reason.
- A way to Dedimania that follows the rule: **PyXaseco** (Python 3.12 embeddable + MariaDB 11.8 portable, both
  pinned, Dedimania plugin included). Open: pin the pip dependencies with hashes (`pip install --require-hashes`),
  read the PyXaseco config format, a Dedimania step in the wizard (only needs server login/password). Effort
  estimated at 4 to 6 h of agent time plus a live test by me. Alternative: patch XAseco 1.16 to `mysqli` ourselves
  (tmserver-docker shows it can be done) – higher risk, our own fork of a GPL project.

## 5. Hub

- Self test `POST /v1/servers/reachability {port}`: the target is always the source address of the request, port only 2350
  to 2399, plain TCP connect (4 s), 12 per hour per IP, one check per IP at a time, private senders
  rejected. Response `{ip, port, tcp: open|closed|timeout}`. Docs: `docs/hub/server-registration.md`.
- List: existing path (submission, review by admin, token, report). From the launcher only with consent
  and a passed test. So far the hub list only knows TMNF/TMUF/ESWC/Sunrise/Original; TM2/TM2020 stay without a
  hub entry (error text in the UI).
- Privacy: section "Hosting your own server" in `docs/hub/legal/datenschutz.md` and `en/datenschutz.md`.

## 6. Linux

The start path is there (ELF binaries in the TMF, 2006, TM2 and TM2020 zips, `/nodaemon`, process group instead of
job object, secrets in a 0600 file), but not tested. The firewall and autostart parts exist for
Windows only.

## 7. Open

1. Randomizer release in `cheatoskar/100-TMX-Server` (see 4.2) and optionally a `SuperAdminPassword` key there.
2. PyXaseco engine (4.3) – decision: build it or wait.
3. TM2/TM2020: check the login requirement for LAN, check script settings on the real server, controller (EvoSC# with
   SQLite once there is a release; PyPlanet needs Python 3.8 + MySQL).
4. Hub list for TM2/TM2020 (needs its own query, our server query can only handle the old games).
5. TMUnlimiter maps on the dedicated server: not verified.

## 8. Test plan for my first live run

Beforehand: test installer of this branch, TMNF installed, no other program on 2350/3450/5000.

**A. LAN on my PC (about 20 min)**
1. Server › Own server › New server: TMNF, dedicated server, name `$f00Test $fffLAN`, LAN, two own
   maps. Save.
2. Start. Expected: "downloading" (13 MB), "waiting for the server", then "Running". Windows may ask for
   firewall access for TrackmaniaServer.exe: "Private networks" is enough for LAN.
3. Start the game (after the server!), Local network: the server appears with red text; join, drive
   one round.
4. Players tab: I show up. Test kick (with a second PC or second account), ban, remove again in the Lists tab.
5. Log tab: output is there, no passwords in it (search for "password").
6. Close the window: the prompt appears. "Keep running": tray icon, server stays visible in the game. Via tray
   "Stop servers and quit": server gone, `TrackmaniaServer.exe` no longer in Task Manager.
7. Restart the launcher, start the server, kill the launcher via Task Manager: the server must end with it (job object).

**B. Internet with my server login (about 30 min)**
1. Edit the server: Internet, Internet step: login + password of my existing TMNF server account, UPnP on.
2. Start. Internet tab: router "Opened via UPnP: TCP:2350, ..."; firewall "Allow" (confirm UAC),
   "Check" green.
3. Reachability "Check" (hub source on in the settings, hub with the new endpoint). Expected
   "Reachable from outside". Cross-check: server in the internet list in the game; join via phone hotspot from
   a second computer (also confirms UDP).
4. Stop: UPnP entries gone from the router (router interface).
5. Optional randomizer: set `TMHUB_RANDOMIZER_DIR` to a publish output, create a server with engine
   "Random maps" on TMUF, LAN, start; preset vote in the game.
6. Optional autostart: tick the box, sign out/in: launcher in the tray, server running. Untick again:
   task "TM Horizon\Servers" gone from Task Scheduler.

What I should report back: screenshot of the error message, `console.log` and the newest `Logs/ConsoleLog*.txt`
from the server folder (the Log tab shows both), and the verdict for reachability.
