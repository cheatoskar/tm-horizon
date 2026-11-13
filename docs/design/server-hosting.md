# Server hosten: Entwurf und Stand

Stand 2026-11-11, Branch `server-host`. Teil 1 (Befunde) stammt aus der ersten Recherche und ist um die Prüfungen
dieser Runde ergänzt; Teil 2 sagt, was gebaut ist. Jede Aussage ist "geprüft" (Primärquelle gelesen, Datei
geladen und gehasht, HEAD/GET gemacht) oder "nicht geprüft". Ausgeführt habe ich auf diesem PC nichts davon:
kein Dedicated Server, kein PHP, kein MariaDB, kein Router-Port, keine Firewall-Regel, keine geplante Aufgabe.

## 0. Kurz

- **Gebaut:** Seite "Server" › "Eigener Server": Liste, Assistent (Spiel, Name mit Farbcodes und Vorschau, Zugang,
  Karten und Modus, Listen, Internet), Start/Stopp, Spieler mit Kick/Bann, Gäste-/Sperr-/Admin-Liste, Log,
  Internet-Schritte mit "Prüfen" (Konto, UPnP, Firewall, Erreichbarkeit, Hub-Liste), Autostart, Tray, Rückfrage
  beim Schließen, Waisen-Erkennung. Hub: `POST /v1/servers/reachability` mit Tests.
- **Engines:** (a) reiner Dedicated Server: gebaut. (b) 100%-TMX-Randomizer: gebaut, braucht ein GitHub-Release
  im Repo `cheatoskar/100-TMX-Server` (gibt es noch nicht, siehe 4.2). (c) XAseco mit Dedimania: **blockiert**,
  XAseco 1.16 braucht PHP 5 (siehe 4.3); Dedimania selbst läuft.
- **Spiele:** TMNF/TMUF fertig gebaut (Status "Built"); ESWC/Sunrise/Original, TM2 und TM2020 als "experimentell"
  (Download mit gepinntem SHA-256, Konfig aus der echten Vorlage im Zip, Startbefehl, Tests gegen die Vorlagen;
  nie gegen den echten Server gelaufen).
- **Der erste echte Lauf** ist der Testplan in Abschnitt 8 (ich, LAN, dann Internet mit meinem Server-Login).

## 1. Befunde

### 1.1 Dedicated Server pro Spiel (geprüft 2026-11-11)

| Spiel | Download | Größe / Stand | SHA-256 (im Launcher gepinnt) | Windows-Exe | Konfig | Konto |
|---|---|---|---|---|---|---|
| TMNF / TMUF | `http://files2.trackmaniaforever.com/TrackmaniaServer_2011-02-21.zip` | 13 075 571 B, 2011-02-21 | `dd021f49…6550c0b` | ja (`TrackmaniaServer.exe`) + Linux-ELF | `GameData/Config/dedicated_cfg.txt`, MatchSettings unter `GameData/Tracks/MatchSettings/` | LAN ohne; Internet mit Server-Login (+ Validation Key bei United) |
| Nations ESWC / Sunrise / Original | `http://slig.free.fr/TM/dedicated/TmDedicatedServer_2006-05-30.zip` (Spiegel von Slig, Nadeos Original-Host ist weg) | 8 284 536 B, 2006 | `28d79550…bf783d` | ja (`TrackManiaServer.exe`) + Linux | `dedicated.cfg` neben der Exe, `/game=nations\|sunrise\|original`, LAN über `<connection_type>LAN`, Internet mit `/internet` | Master-Server-Konto mit `<nation>` |
| TrackMania² (ManiaPlanet) | `http://files.v04.maniaplanet.com/server/ManiaplanetServer_Latest.zip` | 165 248 842 B, Last-Modified 2019-10-24 | `7ef745e0…02e5f` | ja (`ManiaPlanetServer.exe`) | `UserData/Config/dedicated_cfg.default.txt` (Vorlage), Script-Modi `TimeAttack.Script.txt` usw. | Login auf maniaplanet.com/account/dedicated-servers (Seite existiert, 302 auf Login) |
| Trackmania (2020) | `https://nadeo-download.cdn.ubi.com/trackmania/TrackmaniaServer_Latest.zip` | 253 509 378 B, Build 2026-05-16 | `5379519e…df1a` | ja (`TrackmaniaServer.exe`) | `UserData/Config/dedicated_cfg.default.txt`; Beispiel-MatchSettings mit `<script_name>Trackmania/TM_TimeAttack_Online</script_name>`; kein P2P-Port | Login auf trackmania.com/player/dedicated-servers (302 auf Login), **auch für LAN** (nicht geprüft, aus den Anleitungen) |

Lizenz: In keinem der vier Zips liegt ein Lizenztext (geprüft: TMF-Zip vollständig gelesen, Readme und
CommandLine.html ohne Lizenzaussage; 2006-, TM2- und TM2020-Zip per Dateiliste). Wir verteilen nichts weiter, der
Launcher lädt vom Originalort (2006: Spiegel) und prüft den Hash.

**TM2020-Pin:** Nadeo hat nur die "Latest"-URL; datierte Namen geben 403. Der Pin bricht beim nächsten
Server-Update: dann lehnt der Launcher den Download ab, bis ein Launcher-Update den neuen Hash bringt. Das ist
gewollt (nie ungeprüft ausführen), heißt aber: nach jedem TM2020-Server-Update ein Launcher-Patch.

Fund nebenbei: Git-Bash-`unzip` entpackt das TMF-Zip falsch (die Linux-Datei `TrackmaniaServer` überschreibt
`TrackmaniaServer.exe`, weil MSYS beide Namen gleich behandelt). Der Launcher entpackt mit der `zip`-Crate, das
betrifft ihn nicht; wer von Hand entpackt, sollte es wissen.

### 1.2 Startschalter und Konfig (TMF, geprüft in CommandLine.html und Readme)

- TMF 2011: `/lan` macht LAN, ohne Schalter geht er ins Internet (die Readme von 2008 sagt noch `/internet`,
  CommandLine.html von 2009 nennt `/lan`). Der 2006-Server ist umgekehrt: LAN ohne Schalter, `/internet` für online.
- Namen mit Leerzeichen gehen nicht über die Kommandozeile (Readme "Known issues"); Name und Kommentar stehen
  deshalb in der Konfig.
- `xmlrpc_allowremote False` = XML-RPC nur von diesem Rechner. Steht so in der Vorlage, der Launcher setzt es
  trotzdem immer.
- Gäste-/Sperrliste: `guestlist_filename` / `blacklist_filename` in der Konfig (Ordner `GameData/Config`), zur
  Laufzeit über XML-RPC `AddGuest`, `BlackList`, `BanAndBlackList`, `SaveGuestList`, `SaveBlackList` (ListMethods.html).

### 1.3 Controller pro Spiel (geprüft per GitHub-API und README, 2026-11-11)

| Spiel | Controller | Sprache | Lizenz | Letzter Stand | Abhängigkeiten | Bewertung |
|---|---|---|---|---|---|---|
| TMF | XAseco 1.16 (xaseco.org) | PHP | GPL-2.0+ | Release 2013-07-26; Seite gepflegt (News 2025-11) | PHP 5.2/5.3, MySQL 5 (570 `mysql_*`-Aufrufe, kein `mysqli`) | läuft nicht auf PHP 7/8, siehe 4.3 |
| TMF | Forks "xaseco-php8" (nilakite2), tmu-xaseco-php73-fix | PHP | GPL | 2024 / 2021 | – | kein nutzbarer Fork (eine Datei bzw. nur TMU, verlassen) |
| TMF | tmserver-docker (pscriptos) | PHP 8.4 | NOASSERTION | 2026-11 | Docker | patcht XAseco 1.16 beim Containerstart; zeigt, dass es geht, aber "may still contain errors" |
| TMF | **PyXaseco** (nilakite2) | Python 3.12 | GPL-3.0 | 2026-11-08, v1.6 | MariaDB/MySQL, pip | gepflegt, Dedimania optional, nur TMNF/TMUF; jung (seit 2026-04) |
| TMF | Trakman (lythx) | TypeScript | MIT | 2026-11-11 | Node 18.20+, **PostgreSQL 12+** | beste Architektur, aber Postgres |
| TMF, 2006 | **100%-TMX-Server** (cheatoskar, Fork von BigBang1112/randomizer-anywhere) | C# .NET 10 | AGPL-3.0 | aktiv | keine (self-contained Publish 101 MB) | gebaut als Engine (b) |
| TM2 | PyPlanet | Python 3.8 | GPL-3.0 | 2026-10-29 | MySQL/Postgres (SQLite im Code-Default, laut Doku nicht unterstützt), alte Pins (peewee 2.10) | später |
| TM2 | ManiaControl | PHP 5.4+ | GPL-3.0 | 2025-01-01 | MySQL | später, PHP-Version prüfen |
| TM2020 | PyPlanet | Python | GPL-3.0 | 2026-10-29 | wie oben | später |
| TM2020 | EvoSC (PHP) | PHP 7.4 | unklar | 2025-01 | MySQL | nicht bündeln (Lizenz unklar, PHP 7.4 ohne Support) |
| TM2020 | **EvoSC#** | C# .NET | GPL-3.0 | 2026-11-10 | **SQLite** möglich, aber keine Release-Assets (nur Docker/Quellcode) | Kandidat, wenn es ein Release gibt oder wir es selbst bauen |
| 2006 | sonst nichts gefunden außer dem 100%-TMX-Server | | | | | |

### 1.4 Dedimania (TMF, geprüft 2026-11-11)

- `http://dedimania.net/` antwortet (Last-Modified 2026-11-09): "Dedimania service for TMF dedicated server
  scripts: seems ok", gezeichnet Slig.
- Endpunkt `http://dedimania.net:8002/Dedimania`: XML-RPC `system.listMethods` liefert die Dedimania-Methoden
  (`Authenticate`, `ValidateAccount`, `PlayerArrive`, `ChallengeRaceTimes`, ...). **Der Dienst läuft.**
- Was er braucht (XAseco `dedimania.xml`): Server-Login plus dessen Passwort oder "community code", Nation. Keine
  eigene Anmeldung bei Dedimania, kein Schlüssel.

### 1.5 Laufzeiten für spätere Controller (geprüft, im Launcher gepinnt in `hosting/deps.rs`)

| Paket | URL | SHA-256 | Quelle des Hashes |
|---|---|---|---|
| PHP 8.4.27 NTS x64 | downloads.php.net/~windows/releases/php-8.4.27-1-nts-Win32-vs17-x64.zip | `dbae154a…b63ab7` | sha256sum.txt von windows.php.net = eigener Hash |
| MariaDB 11.8.9 (LTS bis 2030) | archive.mariadb.org/mariadb-11.8.9/winx64-packages/mariadb-11.8.9-winx64.zip | `830c4672…1963f5` | sha256sums.txt = eigener Hash |
| Python 3.12.10 embeddable | python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip | `4acbed6d…25a3c3` | eigener Hash (python.org hat .sigstore daneben) |

Der Launcher hat dafür schon: Download mit Pin, Entpacken in den Datenordner, `my.ini` nur auf 127.0.0.1 mit
eigenem Port und `mariadb-install-db` mit erzeugtem Root-Passwort (beides nur als Builder mit Tests, nie gestartet).

## 2. Was gebaut ist

### 2.1 Aufbau

| Teil | Datei | Was |
|---|---|---|
| Spiele-Tabelle | `src-tauri/src/hosting/kinds.rs` | `GameServerKind` pro Spiel: Paket (URL, Pin, Größe), Exe, Konfig-Dialekt, Vorlage, Tracks-/Listen-Ordner, Startschalter, Login-Pflicht LAN/Internet, Login-Seite, Query, GBXRemote-Version, TMX-Seite, erlaubte Engines, Status |
| Gespeicherter Server | `hosting/model.rs` | `server.json` (ohne Geheimnisse), Prüfung mit i18n-Fehlercodes |
| Konfig | `hosting/config.rs` | Vorlage aus dem Zip patchen (unbekannte Tags bleiben), MatchSettings (Legacy-Zahlen oder Script + `mode_script_settings`), Gäste-/Sperrliste, Startargumente, Ports, Passwörter |
| Engines | `hosting/engines.rs` | `Engine`-Trait (`prepare` -> Startplan, `after_start`); `Plain`, `Randomizer` |
| Prozesse | `hosting/procs.rs` | versteckt starten, Ausgabe in `console.log`, ein Job-Objekt pro Server (KILL_ON_JOB_CLOSE), PID-Datei, Waisen-Erkennung mit Namensprüfung, Rechte nur für den Benutzer (`icacls`) |
| XML-RPC | `hosting/xmlrpc.rs` | GBXRemote 1 und 2, eigener kleiner Parser, Fake-Server für Tests (und den Demo-Modus) |
| Karten | `hosting/mapfiles.rs` | nur echte Karten: Endung `.Challenge.Gbx`/`.Map.Gbx` UND GBX-Klasse `0x03043000` (alt `0x24003000`); nur der Kopf wird gelesen; Kopfdaten (Name mit Farbcodes, Autor, Umgebung, Autorenzeit, validiert) mit Cache; eingebettetes Vorschaubild; Migration alter `server.json` |
| TMX | `hosting/tmx.rs` | ID, Karten-Link, Paket-ID/-Link, Such-Link oder Name -> Vorschau; Download in `servers/<id>/maps/tmx-<id>.Gbx` mit Klassenprüfung; höchstens eine Anfrage gleichzeitig, 350 ms Abstand, Wiederholung bei 429/5xx |
| Spieler | `hosting/players.rs` | gesehene Logins mit letztem Nickname (`servers/<id>/players.json`, höchstens 500) |
| Konsole | `hosting/console.rs` | Spieler (Kick, Ban, Gast, Zuschauer/Spieler erzwingen), Chat lesen/senden, Karten (nächste, neu, springen), Zeitlimit, Pause (nur Script-Modi) |
| Demo | `hosting/demo.rs` | nur Debug-Builds mit `TMHUB_HOST_DEMO=1`: "Start" startet keinen Server, ein Fake beantwortet XML-RPC (Screenshots) |
| Netz | `hosting/netops.rs` | UPnP (`igd-next`, MIT): nur Spiel- und P2P-Port, TCP+UDP, Lease 1 h mit Erneuerung, beim Stopp weg; Firewall-`netsh`-Befehl und Start mit UAC; Erreichbarkeits-Urteil; Hub-Eintrag und Meldung |
| Autostart | `hosting/autostart.rs` | eine geplante Aufgabe "TM Horizon\Servers" aus XML (Anmelde-Trigger nur für diesen Benutzer, LeastPrivilege, kein Admin), startet `--start-servers` |
| Geheimnisse | `hosting/secrets.rs` | Windows-Anmeldeinformationsverwaltung (`TM Horizon/server/<id>/…`), Linux/Tests: Datei mit 0600 |
| Downloads | `hosting/deps.rs` | Pin-Prüfung vor dem Entpacken, Cache, Zip-Pfadprüfung, Randomizer aus GitHub-Release mit Digest, Hardlink der 101-MB-Exe pro Server, Laufzeit-Pins |
| Ablauf | `hosting/mod.rs`, `hosting/app.rs` | Start im Hintergrund mit Schritten ("lädt herunter", "wartet auf den Server", ...), Wächter (Absturz, UPnP-Erneuerung, Hub-Meldung alle 5 min), Stopp (`QuitGame`, nach 10 s Job beenden), Tauri-Befehle, Tray, Schließen-Frage |
| Oberfläche | `src/pages/HostServers.tsx`, `src/data/hosting.ts`, `src/ui/hosting/*` | Liste, Assistent, Detail-Tabs; Farbcode-Parser `src/data/tmformat.ts` mit Vorschau |
| Hub | `apps/server/src/services/reachability.ts`, `routes/servers.ts` | Selbsttest |

Ordner pro Server: `<Datenordner>/servers/<id>/` mit `server.json`, `run.json` (PID, UPnP-Einträge),
`console.log`, `dedicated/` (eigene Kopie des Servers) bzw. `randomizer/`. Gemeinsam: `servers/_cache/`
(geprüfte Zips), `servers/_tmx/` (alter TMX-Cache, nur noch gelesen), `servers/_tools/randomizer/<tag>/`. Neu pro
Server: `maps/` (TMX-Karten, beim Hinzufügen geladen), `players.json` (gesehene Spieler), `server.json.bak` (nach der
Migration).

### 2.2 Sicherheit

- XML-RPC: in der Konfig immer `xmlrpc_allowremote False`; nie in UPnP, nie in der Firewall-Regel (Tests
  prüfen beides). Level-Passwörter (SuperAdmin/Admin/User) zufällig, 24 Zeichen, im Credential Manager; die
  Konfig-Datei bekommt Benutzer-Rechte. Ausnahme Randomizer: der meldet sich fest mit `SuperAdmin/SuperAdmin` an
  (sein Code); bleibt lokal, aber jeder Prozess auf dem PC könnte sich verbinden. Vorschlag an mich selbst:
  `SuperAdminPassword` als Konfig-Schlüssel im Randomizer.
- Server-Konto-Passwort: Credential Manager; in die Konfig-Datei, weil der Server es nur von dort liest; beim
  Randomizer über die Umgebungsvariable `RANDANY_SERVER_PASSWORD`. Nie auf der Kommandozeile, nie im Log.
- Downloads nur mit gepinntem SHA-256 (GitHub-Digest beim Randomizer); falscher Hash = Datei gelöscht, nichts
  ausgeführt. Zip-Einträge mit `..` werden abgelehnt.
- Nichts gegen Nadeos Master-Server: der Launcher baut keine Anmeldung, keinen Connect, keine Kontoerstellung.
  Konto-Seiten öffnet ein Knopf im Browser.
- Firewall-Regel nur auf Klick, mit UAC-Bestätigung, Befehl vorher sichtbar; Pfade mit `& | ^ % "` werden
  abgelehnt statt maskiert.
- Waisen: die PID-Datei gilt nur, wenn der Prozess mit dieser PID denselben Programmnamen hat (PID-Wiederverwendung).

### 2.3 Lebensdauer

- Server laufen als Kinder des Launchers in je einem Job-Objekt. Schließen des Spiels: egal. Schließen des
  Fensters mit laufenden Servern: Frage "Weiterlaufen / Stoppen und beenden / Abbrechen"; "Weiterlaufen"
  versteckt das Fenster, ein Tray-Symbol erscheint ("Open TM Horizon", "Stop servers and quit").
- Absturz des Launchers: das Job-Objekt beendet die Server mit (gewollt: keine unsichtbaren Server). Beim
  nächsten Start: PID-Datei prüfen, "Läuft noch vom letzten Mal" mit Stoppen/Behalten (Linux, oder wenn die
  Zuordnung zum Job scheiterte); UPnP-Einträge aus `run.json` werden beim Stoppen entfernt.
- Autostart pro Server; die eine geplante Aufgabe gibt es, solange mindestens ein Server sie will. Läuft der
  Launcher schon, startet der zweite Aufruf (`--start-servers`) nur die Server.

### 2.4 Internet-Schritte im Assistenten und im Tab "Internet"

1. Server-Konto: TMF-Text (eigenes Konto, nicht das Spielkonto), TM2/TM2020 Knopf "Seite öffnen" auf die
   offizielle Seite; Login + Passwort (+ Validation Key bei United) eintragen. "Prüfen": Format sofort; ob der
   Master-Server das Konto annimmt, sieht man erst am laufenden Server (Hinweis im UI).
2. Router: UPnP an/aus; Ergebnis mit gemappten Ports oder Fehler; sonst Text "TCP und UDP 2350/3450 weiterleiten",
   immer "XML-RPC-Port nie weiterleiten".
3. Firewall: Befehl sichtbar, "Erlauben" (UAC), "Prüfen" (`netsh ... show rule`, ohne Admin).
4. Erreichbarkeit: "Prüfen" über den Hub; Klartext: erreichbar / CGNAT / Router lehnt ab / Firewall / UPnP aus /
   Hub nicht erreichbar. CGNAT-Erkennung: WAN-Adresse des Routers (UPnP) privat oder 100.64/10, oder ungleich der
   Adresse, die der Hub sieht. UDP ist mit TCP nicht prüfbar ("UDP bestätigt, wenn ein Freund beitritt").
5. Öffentliche Liste: nur nach Häkchen "IP und Name werden öffentlich angezeigt", nur mit bestandenem Test, Kontakt
   für die Admins; danach Token einfügen, Meldung alle 5 min.

### 2.5 Karten, TMX, Listen, Konsole (Branch host-polish, nach meinem ersten LAN-Test)

- Fehler aus dem Test: über "Dateien…" landeten Replays (`*.Replay.Gbx`) als Karten in der Liste. Jetzt entscheidet
  die GBX-Klasse, die Endung allein reicht nicht. Der Dateidialog gibt nur Karten zurück (der Rest wird als
  "übersprungen" gemeldet), `host_save` lehnt Nicht-Karten ab, der Start (`place_maps`) prüft noch einmal.
  Beim Laden der Serverliste werden alte `server.json` bereinigt (Replays raus, Sicherung `server.json.bak`, Hinweis
  oben auf der Seite, bis er geschlossen wird). Fehlende Dateien bleiben stehen (Laufwerk evtl. nicht da).
- Vorlagen/leere Karten: eine Karte ohne Autorenzeit ist nie validiert worden; der TMF-Server lädt sie nicht
  ("Track not complete", siehe tm-modding-knowledge/server/xmlrpc-dedicated.md). Solche Karten zeigt die Auswahl mit
  "Nicht validiert" und lässt sie nicht hinzufügen (außer im Stunts-Modus). Die Migration entfernt sie nicht.
- Kartenauswahl: links Quellen (Meine Karten mit Ordnerbaum, TMX, Dateien…), rechts die Liste des Servers mit
  Ziehen/Alt+Pfeil zum Sortieren, Zufallsreihenfolge, Entfernen. Jede Zeile: Vorschaubild (aus der Datei bzw. von TMX
  über den Bild-Cache), Name mit Farbcodes, Umgebung, Autor, Autorenzeit, Quelle. Eine Suche gilt für beide Seiten.
- TMX: Hosts je Spiel wie in `kinds.rs`; Pakete über `/api/trackpacks` bzw. `/api/mappacks` und `packid`/`mappackid`,
  bis 500 Karten (Seiten mit `after=<letzte ID>`). Bilder: TMX `/trackshow/<id>/thumbnail`, MX `/mapthumb/<id>`
  (geprüft 2026-11-11). Die Karten liegen im Ordner des Servers, nie in einem Spielordner; die TMX-ID bleibt im
  Eintrag (für spätere Updates). Bricht man den Assistenten eines neuen Servers ab, wird sein Ordner gelöscht.
- Listen: "Letzte Spieler" bietet Logins an, die der Launcher auf dem Server gesehen hat (der Server selbst führt
  keine Liste, seine Logs nennen keine Spieler); der Wächter liest alle 15 s die Spielerliste. Neben jedem Login steht
  der letzte Nickname.
- Konsole: alles über das lokale XML-RPC mit dem SuperAdmin-Passwort aus dem Credential Manager. TMF-Namen
  (`NextChallenge`, `ChallengeRestart`, `SetNextChallengeIndex`, `SetTimeAttackLimit`, `ForceSpectator`,
  `ChatSendServerMessage`, `GetChatLines`) bzw. ManiaPlanet-Namen (`NextMap`, `RestartMap`, `JumpToMapIndex`,
  `SetModeScriptSettings`, Pause über `Maniaplanet.Pause.SetActive`). Die alten Server können nicht pausieren.
- XML-RPC bleibt lokal: `xmlrpc_allowremote False` in jeder Konfig (Randomizer: setzt er selbst, `ServerSetup.cs`),
  der Port steht weder in UPnP noch in der Firewall-Regel (Tests `never_maps_xmlrpc`, `firewall_command`).

## 3. Engine-Vergleich

| | Plain | Randomizer (100% TMX) | XAseco + Dedimania |
|---|---|---|---|
| Was | Nadeos Server, Launcher als Steuerung | zufällige TMX-Karten ohne Rekord, Chat-Befehle, Votes, Bestenliste, Statusseite | Rekorde, Dedimania, Chat-Befehle, Plugins |
| Spiele | alle sieben | TMNF, TMUF, ESWC, Sunrise, Original | TMNF, TMUF |
| Abhängigkeiten | keine | eigene Exe (self-contained, 101 MB, Hardlink pro Server) | PHP 5 + MySQL 5 (nicht mehr unterstützt) |
| Karten | eigene Karten + TMX | wählt selbst (Preset) | eigene |
| Passwort/Slots | Konfig | per XML-RPC nach dem Start (Randomizer hat keine Schlüssel dafür) | Konfig |
| Status | gebaut, Tests mit Fake-Server | gebaut, Release fehlt | blockiert |

## 4. Engines im Detail

### 4.1 Plain

`prepare`: Zip holen (Cache, Pin), nach `dedicated/` entpacken (nur wenn sich der Pin ändert), Vorlage einmal als
`*.horizon-template` sichern, Konfig daraus patchen, Karten nach `Tracks/Challenges/Horizon/` bzw. `Maps/Horizon/`
kopieren (nur Karten nach Endung und GBX-Klasse, höchstens 8 MB; Replays werden abgelehnt), `MatchSettings/horizon.txt`, Listen. Start mit
`/dedicated_cfg=… /game_settings=MatchSettings/horizon.txt` und `/lan` (TMF/TM2/TM2020 im LAN) bzw. `/internet`
(2006 online), `/nodaemon` unter Linux.

### 4.2 Randomizer

- Quelle: neuestes Release in `cheatoskar/100-TMX-Server` mit Asset `RandomizerAnywhere-win-x64.zip`
  (bzw. `-linux-x64.zip`), geprüft mit GitHubs SHA-256-Digest. Zum Testen vorher:
  `TMHUB_RANDOMIZER_DIR=<Ordner mit dotnet-publish-Ausgabe>`.
- **Fehlt noch:** ein Release. `dotnet publish RandomizerAnywhere/RandomizerAnywhere.csproj -c Release -r win-x64
  --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:DebugType=none`
  baut hier sauber (geprüft: `RandomizerAnywhere.exe` 105 585 292 B + `config.default.toml`, `Presets/`,
  `WebStatus/`). Das Zip davon als Release-Asset hochladen, oder eine Release-Action mit genau diesem Befehl.
- Lizenz: AGPL-3.0; Quelle im Assistenten genannt, im Spiel `/source`. Der Launcher (AGPL) lädt das Release, das
  passt.
- `config.toml` wird erzeugt: Spiel, Preset, AutoSkip, Zeitbudget, Anzeigename mit Farbcodes, Kommentar, Ports,
  `Lan`, Server-Login, `AdminLogins` (leer = `-` = niemand; leer hieße beim Randomizer "alle sind Admin"),
  `[DownloadSha256]` mit unseren Pins. Den Dedicated Server legt der Launcher schon geprüft in
  `randomizer/Servers/…`, der Randomizer lädt ihn dann nicht noch einmal (nicht geprüft: sein ETag-Cache könnte
  trotzdem einmal neu laden; der Pin gilt dann auch dort).
- Nach dem Start: Passwort, Zuschauer-Passwort, Slots, Gäste-/Sperrliste über XML-RPC.
- Aus meinem Live-Setup (`100_server`, nur gelesen) übernommen: Ports pro Instanz (+1), `ConnectionUploadRate
  10240`, eigene Ordner pro Instanz. Nicht übernommen: Discord-Webhooks, `PublicHost`, die Statusseite nach außen.
  Der Statusport wird pro Server frei gewählt, aber nicht gemappt.

### 4.3 XAseco mit Dedimania: blockiert

- XAseco 1.16 (aktuell, 2013) ist PHP-5-Code mit 570 `mysql_*`-Aufrufen; `mysql_*` gibt es seit PHP 7.0 nicht
  mehr. PHP 5.6 bekommt seit 2018 keine Sicherheitsupdates. Ein gepflegter PHP-8-Fork existiert nicht.
- Regel des Projekts: keine Engine mit ungepatchter, nicht unterstützter Laufzeit ausliefern. Deshalb im
  Assistenten sichtbar, aber gesperrt, mit Begründung.
- Weg zu Dedimania, der die Regel einhält: **PyXaseco** (Python 3.12 embeddable + MariaDB 11.8 portabel, beide
  gepinnt, Dedimania-Plugin dabei). Offen: pip-Abhängigkeiten mit Hashes pinnen (`pip install --require-hashes`),
  PyXaseco-Konfig-Format lesen, Dedimania-Schritt im Assistenten (braucht nur Server-Login/-Passwort). Aufwand
  geschätzt 4 bis 6 h Agentenzeit plus ein Live-Test von mir. Alternative: XAseco 1.16 selbst auf `mysqli`
  patchen (tmserver-docker zeigt, dass es geht) – größeres Risiko, eigener Fork eines GPL-Projekts.

## 5. Hub

- Selbsttest `POST /v1/servers/reachability {port}`: Ziel ist immer die Quelladresse der Anfrage, Port nur 2350
  bis 2399, reiner TCP-Connect (4 s), 12 pro Stunde pro IP, eine Prüfung pro IP gleichzeitig, private Absender
  abgelehnt. Antwort `{ip, port, tcp: open|closed|timeout}`. Doku: `docs/hub/server-registration.md`.
- Liste: bestehender Weg (Einreichung, Prüfung durch Admin, Token, Meldung). Aus dem Launcher nur mit Zustimmung
  und bestandenem Test. Die Hub-Liste kennt bisher nur TMNF/TMUF/ESWC/Sunrise/Original; TM2/TM2020 bleiben ohne
  Hub-Eintrag (Fehlertext im UI).
- Datenschutz: Abschnitt "Eigener Server hosten" in `docs/hub/legal/datenschutz.md` und `en/datenschutz.md`.

## 6. Linux

Startpfad ist da (ELF-Binaries in TMF-, 2006-, TM2- und TM2020-Zip, `/nodaemon`, Prozessgruppe statt
Job-Objekt, Geheimnisse in einer 0600-Datei), aber nicht getestet. Firewall- und Autostart-Teil gibt es nur für
Windows.

## 7. Offen

1. Randomizer-Release in `cheatoskar/100-TMX-Server` (siehe 4.2) und optional `SuperAdminPassword`-Schlüssel dort.
2. PyXaseco-Engine (4.3) – Entscheidung: bauen oder warten.
3. TM2/TM2020: Login-Pflicht für LAN prüfen, Script-Einstellungen am echten Server prüfen, Controller (EvoSC# mit
   SQLite, sobald es ein Release gibt; PyPlanet braucht Python 3.8 + MySQL).
4. Hub-Liste für TM2/TM2020 (eigene Abfrage nötig, unsere Server-Abfrage kann nur die alten Spiele).
5. TMUnlimiter-Karten auf dem Dedicated Server: nicht geprüft.

## 8. Testplan für meinen ersten Live-Lauf

Vorher: Test-Installer dieses Branches, TMNF installiert, kein anderes Programm auf 2350/3450/5000.

**A. LAN auf meinem PC (ca. 20 min)**
1. Server › Eigener Server › Neuer Server: TMNF, Dedicated Server, Name `$f00Test $fffLAN`, LAN, zwei eigene
   Karten. Speichern.
2. Starten. Erwartung: "lädt herunter" (13 MB), "wartet auf den Server", dann "Läuft". Windows fragt evtl. nach
   Firewall-Zugriff für TrackmaniaServer.exe: "Private Netzwerke" reicht für LAN.
3. Spiel starten (nach dem Server!), Lokales Netzwerk: Server erscheint mit roter Schrift; beitreten, eine Runde
   fahren.
4. Tab Spieler: ich erscheine. Kicken testen (mit zweitem PC oder Zweitkonto), Bannen, im Tab Listen
   wieder entfernen.
5. Tab Log: Ausgabe da, keine Passwörter darin (nach "password" suchen).
6. Fenster schließen: Frage kommt. "Weiterlaufen": Tray-Symbol, Server bleibt im Spiel sichtbar. Über Tray
   "Stop servers and quit": Server weg, `TrackmaniaServer.exe` nicht mehr im Task-Manager.
7. Launcher neu, Server starten, Launcher per Task-Manager beenden: Server muss mit beendet sein (Job-Objekt).

**B. Internet mit meinem Server-Login (ca. 30 min)**
1. Server bearbeiten: Internet, Schritt Internet: Login + Passwort meines bestehenden TMNF-Server-Kontos, UPnP an.
2. Starten. Tab Internet: Router "Per UPnP geöffnet: TCP:2350, ..."; Firewall "Erlauben" (UAC bestätigen),
   "Prüfen" grün.
3. Erreichbarkeit "Prüfen" (Hub-Quelle in den Einstellungen an, Hub mit dem neuen Endpunkt). Erwartung
   "Von außen erreichbar". Gegencheck: Server in der Internet-Liste im Spiel; Beitritt über Handy-Hotspot von
   einem zweiten Rechner (bestätigt auch UDP).
4. Stoppen: UPnP-Einträge im Router weg (Router-Oberfläche).
5. Optional Randomizer: `TMHUB_RANDOMIZER_DIR` auf eine Publish-Ausgabe setzen, Server mit Engine
   "Zufallskarten" auf TMUF anlegen, LAN, starten; Preset-Abstimmung im Spiel.
6. Optional Autostart: Haken setzen, abmelden/anmelden: Launcher im Tray, Server läuft. Haken wieder weg:
   Aufgabe "TM Horizon\Servers" in der Aufgabenplanung verschwunden.

Was ich dabei zurückmelden sollte: Screenshot der Fehlermeldung, `console.log` und neueste `Logs/ConsoleLog*.txt`
aus dem Server-Ordner (Tab Log zeigt beide), und bei Erreichbarkeit das Urteil.
