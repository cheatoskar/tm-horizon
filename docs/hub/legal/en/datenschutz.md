# Privacy policy

> **DRAFT – have it checked before publishing.** This is an English translation; the German version is binding. Everything in `[square brackets]` is still open (filled in German in both versions); `docs/hub/legal/AUSFUELLEN.md` says what goes where. The retention periods must match the real settings on the server (nginx log rotation, backups).

Last updated: [Datum]

This policy covers three parts of TM Horizon:

- the **website** [Domain der Website],
- the **hub with developer portal** [Domain des Hubs], where authors publish mods,
- the **TM Horizon launcher**, the program on your computer (section 5).

## 1. Controller

[Vorname Nachname], [c/o-Zeile laut IMPREGO], [Straße Hausnummer laut IMPREGO], [PLZ Ort laut IMPREGO], Germany. Email: [E-Mail-Adresse]

There is no data protection officer; as a private person I am not required to appoint one.

## 2. In short

- No tracking, no advertising, no analytics services. The website and the launcher send no usage statistics and no device or installation identifier.
- Players do not need an account. The launcher downloads lists and files; the servers it contacts see your IP address, as with any web page request.
- Only people who publish something in the hub, add a server or claim a mod need an account. Sign-in is only through Discord or GitHub; I do not store passwords.
- The only cookie: the sign-in cookie of the developer portal.

## 3. Website

| Data | Purpose | Legal basis | How long |
|---|---|---|---|
| **Server logs** (IP address, time, requested address, status code, amount of data transferred, referrer, browser identifier) | Delivering the pages, defending against attacks | Art. 6(1)(f) GDPR (operation and security) | [7] days, then deleted |
| **Settings in the browser** (`localStorage`: chosen language and colour scheme) | So the site remembers your choice | Section 25(2) no. 2 TDDDG (function you asked for) | Until you delete them in the browser; they are never sent to me |

Hosting of the website: [Hosting der Website, z. B. Oracle Cloud wie der Hub oder GitHub Pages]. Fonts and the other images are on the same server. The official game pictures (covers from IGDB.com, banners and logos from Steam) and the pictures on the mod pages (showcases, galleries and READMEs hosted on GitHub or Imgur) come from our server too: it fetches them itself from IGDB (`images.igdb.com`), Steam (`cdn.cloudflare.steamstatic.com`, Valve Corporation), GitHub (`raw.githubusercontent.com`, `github.com` and its file servers `*.githubusercontent.com`, GitHub Inc.) and Imgur (`i.imgur.com`) and caches them. Neither your IP address nor anything from your browser goes to these providers. The website does not show pictures from other servers. The website loads nothing from other servers. Links to other sites (exchange sites, GitHub, Discord, shops) only open when you click them; their privacy policies apply there.

"Install" buttons only open the launcher on your computer (`tmhub://…`); nothing is sent to me.

## 4. Hub and developer portal

| Data | Purpose | Legal basis | How long |
|---|---|---|---|
| **Server logs** of the web server (IP address, time, requested address, status code, browser identifier) | Operation, defending against attacks and misuse | Art. 6(1)(f) GDPR (security of the service) | [7] days, then deleted |
| **Application log** of the hub program (requests with IP address, errors; cookies and credentials are masked) | Troubleshooting, defending against misuse | Art. 6(1)(f) GDPR | [7] days, then deleted |
| **Rate limiting** (IP address) | Protection against overload and spam | Art. 6(1)(f) GDPR | Only in memory, at most 1 hour |
| **Download counting** | Download numbers per version and day for the authors | Art. 6(1)(f) GDPR | So that one installation counts once per project and day, the server keeps the launcher's random installation id (without one: the IP address) only in memory as a salted hash; the salt changes daily and none of it is stored. Only daily totals without personal reference are stored; the total shown adds the public download numbers of GitHub releases. |
| **Submitted game servers** (game, game-port address, name, homepage, contact; when logged in, the account ID of the sender and a salted hash of their IP address; result of the last query) | Listing, review, protection against abuse (limits per account and per address). The hub queries the game port of a submitted server only (one connection, 3 seconds), then every 6 hours. The server address is public server data; the sender's IP address is never stored in clear text | Art. 6(1)(f) GDPR | until the server is removed; the contact is deleted on request; entries offline for 14 days are hidden |
| **Account from Discord/GitHub** (provider ID, username, display name, avatar address) | Sign-in, display as author | Art. 6(1)(b) GDPR (usage contract) | Until the account is deleted |
| **Session cookie** (random identifier, technically necessary) and CSRF protection token | Staying signed in, protection against forged requests | Section 25(2) no. 2 TDDDG; Art. 6(1)(b) GDPR | 30 days or until you sign out |
| **Uploaded content** (files, images, descriptions, changelogs, review reports) | Publication and distribution to players | Art. 6(1)(b) GDPR | As long as the project exists; published versions are immutable (see terms of use) |
| **Signing keys** (public keys) and **API tokens** (as hash only) | "Verified" badge, uploads from CI | Art. 6(1)(b) GDPR | Until revoked or the account is deleted |
| **Projects not yet claimed** from public sources (catalogue, Discord mod channel, GitHub, TMLoader servers): name or username of the original author, link to the source; for entries from the Discord mod channel, the Discord ID of the person who posted the entry (not displayed, only used for claiming via Discord sign-in) | Crediting the authors, claiming of the project by them | Art. 6(1)(f) GDPR | Until claimed or until removed on request (objection to [E-Mail-Adresse]) |
| **Moderation log** (who decided what and when) | Traceability, obligations under the DSA | Art. 6(1)(c) and (f) GDPR | [3] years |
| **Reports "Report content"** (reason, explanation, optionally name and email) | Handling under Art. 16 DSA, reply to the person reporting | Art. 6(1)(c) GDPR | [1] year after closure |
| **Backup** of the database (contains the account data above) | Recovery after failures | Art. 6(1)(f) GDPR | [30] days; deleted data disappears from the backups at the latest by then |

### Recipients and services of the hub

- **Hosting:** Oracle Cloud Infrastructure ([Oracle-Region, z. B. Frankfurt (eu-frankfurt-1)]), server and object storage. Data processing agreement under Art. 28 GDPR: [prüfen: Data Processing Agreement der Oracle Cloud, auch im Free Tier].
- **Discord and GitHub (sign-in):** only if you sign in with them. You are redirected to Discord or GitHub; their privacy policies apply there. I only receive the account data listed above (Discord scope `identify`, GitHub without additional permissions). When a project is claimed via GitHub, I check once whether your GitHub account is an administrator of the linked repository; the access token is then discarded and not stored.
- **GitHub (import and crawler):** If you paste a repository address or a project is linked to a repository, the hub reads its public releases and files through the GitHub API. No data of visitors is sent in the process.
- **TMLoader servers:** If a project is linked to a TMLoader server, the hub reads its public index and downloads the files. No data of visitors is sent in this case either.
- **VirusTotal** (Google/Chronicle, USA): For every new file, its SHA-256 hash is looked up. [Falls aktiviert: unbekannte Mod-Dateien werden zur Analyse hochgeladen; sie enthalten keine personenbezogenen Daten der Hochladenden.] Basis: Art. 6(1)(f) GDPR (protection against malware).
- **Moderation Discord webhook:** Notices about new versions and reports (project name, version, reason) go to a private moderation channel. Names or email addresses of people who report are not sent there.
- Transfers to third countries by the hub only happen through the services named (Discord, GitHub, VirusTotal: USA; basis: EU-US Data Privacy Framework, where certified [prüfen], otherwise standard contractual clauses).

## 5. TM Horizon launcher {#launcher}

The launcher is a program on your computer. It has **no account, no telemetry and no automatic crash reports**. It sends no device or installation identifier; as a program identifier it sends only `TM-Horizon` with the version number and the website address (for example `TM-Horizon/0.4.0 (+https://tm-horizon.com)`) in its own requests.

The launcher makes all connections below **directly** from your computer to the service concerned. The service sees your IP address and the requested address, as with any web page request. I receive none of this, except for the requests that go to my hub (if you turn it on). The operators of the other services are responsible for processing on their side; their privacy policies apply.

### 5.1 Connections the launcher makes

| When | Where to | What is transferred |
|---|---|---|
| On start and when refreshing | **GitHub Pages** (`cheatoskar.github.io`, GitHub Inc., USA): lists of games, servers, events and mods | the request only |
| Only if you turn on "TM Horizon Hub" in the settings (off by default) | **my hub** [Domain des Hubs]: signed index, mod files, server list for TMNF/TMUF | the request only (see section 4: server logs and download counting) |
| On start (can be turned off) and when you check for updates | **GitHub** (`github.com`, files via `objects.githubusercontent.com` / `release-assets.githubusercontent.com`): update information and installation file of the launcher | the request only |
| On the home page and the game pages | **ManiaExchange sites** (`tmnf.exchange`, `tmuf.exchange`, `tm.mania.exchange`, `trackmania.exchange`): news | the request only |
| Mods page, mod updates | **TMLoader mod servers** (`modloader.tomashu.dev`, `tomashu.pages.dev`, `unlimiter.net`, `donadigo.com`, `fullspeed.mooo.com`, `cheatoskar.github.io`, `home.koyaanis.com`, `bigbang1112.github.io` and servers you added in TMLoader yourself): mod lists and mod files | the request only |
| Mod pages, installing and checking for updates of mods and browser add-ons | **GitHub** (`api.github.com`, `raw.githubusercontent.com`, `github.com`): releases, descriptions (README), images and files of the projects | the request only |
| When you install a mod whose file is hosted elsewhere | the **server where the author offers the file** (shown on the mod page) | the request only |
| Openplanet page, Openplanet installation | **Openplanet** (`openplanet.dev`, `cdn.openplanet.dev`): plugin list, download page, installer | the request only |
| TMLoader setup | **TMLoader** (`tomashu.dev` and the download servers linked there) | the request only |
| Only if you install a game through the launcher | **Ubisoft/Nadeo** (`nadeo-download.cdn.ubi.com`, `files.trackmaniaforever.com`): installers of the free games | the request only |
| Only during setup on Linux | **GitHub** (releases of Proton-GE and Wine tools) | the request only |
| When showing images | the servers where the images are hosted (e.g. Steam CDN, `images.mania.exchange`, GitHub, sites of the mod authors) | the request only |
| In the library, while "Load game covers from the internet" is on (on by default, can be turned off in Settings) | **IGDB image server** (`images.igdb.com`, IGDB.com / Twitch Interactive, USA) for the covers of all games and, when none can be loaded there, the **Steam CDN** (`shared.steamstatic.com`, Valve Corporation, USA). The launcher loads each picture once directly (IGDB or Steam see your IP address and the launcher's identifier) and then keeps it on your computer. | the request only |
| When showing site icons | the site concerned (exchange and community sites): its icon (favicon), fetched with a common browser identifier | the request only |

The launcher opens links to shops (Steam, Ubisoft, Epic Games), Discord invitations and other sites in your normal browser.

### 5.2 Built-in browser (TMX, ManiaPark and other sites)

On the Maps and Skins pages and in the TAS area, the launcher shows third-party sites in a built-in browser (Microsoft Edge WebView2, on Linux WebKitGTK): the TM Exchange and ManiaExchange sites (`tmnf.exchange`, `tmuf.exchange`, `nations.tm-exchange.com`, `original.tm-exchange.com`, `sunrise.tm-exchange.com`, `tm.mania.exchange`, `sm.mania.exchange`, `trackmania.exchange`, `item.exchange`, `item.mania.exchange`), ManiaPark (`maniapark.com`), TM RPG Trial (`tmrpgtrial.com`), TMTAS Exchange (`tmtas.exchange`), 100% TMX (`100tmx.com`) and GBX Tools (`gbx.tools`).

- This is like a normal browser: the sites see your IP address, set their own cookies and can embed their own services. The operators of the sites are responsible for that; their privacy policies apply.
- Sign-ins and cookies of these sites stay **only on your computer** in a separate browser profile of the launcher (folder `EmbeddedWeb` in the local program data). The launcher neither reads cookies or passwords nor sends them anywhere. "Sign out of embedded sites" in the settings deletes this profile.
- The launcher saves downloaded maps, replays and skins directly into the folder of the chosen game.

### 5.3 Browser add-ons

For the built-in browser you can install add-ons from a fixed list (for example the TMX Universal Track Downloader). They are loaded from the author's GitHub release and verified with a checksum. Before installation, the launcher shows which sites the add-on may access. Add-ons only run in the built-in browser, not in the launcher itself. What an add-on transmits is stated in its own description; the TMX Universal Track Downloader, for example, only talks to the TMX sites, to `100tmx.com` and to programs on your own computer (`127.0.0.1`).

### 5.4 Upload replays to TMX automatically (off by default)

If you turn on "Upload new personal bests to TMX" for a game, the launcher uploads new replays of that game to the game's exchange site (for example `tmnf.exchange`). It uses your sign-in in the built-in browser for this; the upload runs inside the exchange site. Only the replay file is sent to the game's exchange site. Your sign-in details do not leave the built-in browser.

Stored on your computer: the switches, a pairing key for the 100% TMX mod, the last 100 uploads (map, time, site, result, link) and checksums of replays already uploaded. None of this goes to me.

### 5.5 Connections on your computer only

Some functions talk to other programs **on the same computer** through the address `127.0.0.1`; these connections do not leave the computer:

- with the 100% TMX mod in the game (ports 27311–27315) when automatic upload is on; the mod asks in the game whether the connection is allowed,
- a small status query for the browser add-on (ports 27321–27325), only while automatic upload is on, so that replays are not uploaded twice,
- with the Discord app (see 5.7).

### 5.6 Live status of game servers

On the server page and some game pages, the launcher asks game servers directly for name, player count, mode and current map, the same way the server list in the game does. Only servers from your list are queried (bundled example servers and servers you add yourself), at most once per minute and only while the page is open. The servers see your IP address. You can turn this off in the settings; the list and the switch are only on your computer. Nothing is sent to Nadeo or to my hub.

#### Hosting your own server (page "Servers" › "My servers")

- **Downloads:** The launcher downloads the game's dedicated server from Nadeo's download servers (`files2.trackmaniaforever.com`, `files.v04.maniaplanet.com`, `nadeo-download.cdn.ubi.com`; for Nations ESWC, Sunrise and Original from `slig.free.fr`), if you choose it the 100% TMX server from GitHub, and maps from TMX. These servers see your IP address.
- **Server account:** The login and password of your server account stay on your computer (Windows Credential Manager); the dedicated server itself uses them to log in to Nadeo's master server, like any dedicated server. The launcher sends them nowhere.
- **Router (UPnP, only when switched on):** The launcher asks your home router to forward the two game ports to your computer and removes that when the server stops.
- **Reachability test (only when you click "Check"):** The launcher asks my hub; the hub opens a TCP connection to the IP address the request came from, on the game port, and answers "open" or "closed". Nothing is stored besides the normal server logs (section 4).
- **Public list (only with your explicit consent):** If you list your server, the launcher sends the game, **your public IP address and port**, the server name and your contact to my hub. After an admin has checked it, address and name are **shown publicly** (server list in the launcher and on the website); the contact only to admins. With the token, the launcher then reports name, player count, map and mode every 5 minutes while the server runs. Legal basis: Art. 6(1)(a) GDPR (consent); withdraw at any time with "Unlist" in the launcher or by e-mail to [e-mail address]; the entry is then removed.

### 5.7 Discord status display (off by default)

If you turn on the Discord status display, the launcher tells the Discord app on your computer which game you started (game name, profile name, start time). Discord shows this to your contacts and processes it under its own privacy policy (Discord Inc., USA). The launcher itself sends nothing to the internet for this.

### 5.8 Problem report

"Report a problem" creates a ZIP file on your desktop or in the downloads folder. It contains:

- the logs of the mods of the started profile and of Horizon Host,
- the latest crash logs of the game (at most three),
- a short system overview: launcher version, Windows version, graphics card, game and installation type, TMLoader version, profile name, installed mods with version and origin.

Beforehand, your Windows username, the name of your computer and email addresses are masked. You see the list of files and a preview before the file is saved. **The launcher does not upload the report anywhere.** You decide yourself whether and to whom you send it (for example to a mod author through Discord or GitHub); whoever receives the report is then responsible for the data.

### 5.9 What the launcher stores on your computer

Settings, caches (lists, images, responses from GitHub), profiles and game instances, logs, the browser profile of the built-in browser, installed add-ons, the server list, the upload history and, if you sign in to the hub from the launcher, its access token (`hub-login.json`; the hub keeps only a hash, valid for 90 days, "Sign out" revokes it) are in the launcher's program data on your computer. I have no access to them. [prüfen: ob der Deinstaller diese Ordner entfernt oder ob man sie von Hand löschen muss, und den Pfad hier nennen]

## 6. Your rights

You have the right of access (Art. 15), rectification (Art. 16), erasure (Art. 17), restriction (Art. 18), data portability (Art. 20) and to object to processing based on Art. 6(1)(f) (Art. 21 GDPR). Write to [E-Mail-Adresse] for this.

Deleting your account: on request by email [später auch im Portal unter „Account“]. This deletes account data, sessions, tokens and keys. Published versions are kept as part of the project if other team members maintain it; your name is then replaced with "former account". Projects that belong only to you are removed on request.

You can complain to a data protection supervisory authority, e.g. the one responsible for my place of residence: [Datenschutzaufsichtsbehörde des Bundeslandes: Name, Anschrift, Website].

## 7. Security

Connections to the website and the hub only over HTTPS. Session cookies are `HttpOnly`, `Secure` and `SameSite=Lax`. I store API tokens and session identifiers only as a hash. Uploads are checked automatically and stored as immutable copies with SHA-256. The launcher downloads only over HTTPS (exception: the installer of TrackMania United Forever, which Nadeo only offers over HTTP; the launcher checks it before starting by its signature or checksum) and verifies the hub index by a digital signature.

## 8. Changes

If the website, the hub or the launcher change, I update this policy. The version with the latest date at the top applies.
