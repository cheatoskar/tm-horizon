# Datenschutzerklärung

> **ENTWURF – vor Veröffentlichung prüfen lassen.** Alles in `[eckigen Klammern]` ist noch offen; `docs/hub/legal/AUSFUELLEN.md` sagt, was wo hineingehört. Die Fristen müssen zu den echten Einstellungen auf dem Server passen (nginx-Logrotation, Backups).

Stand: [Datum]

Diese Erklärung gilt für drei Teile von TM Horizon:

- die **Website** [Domain der Website],
- den **Hub mit Entwicklerportal** [Domain des Hubs], auf dem Autorinnen und Autoren Mods veröffentlichen,
- den **TM Horizon Launcher**, das Programm auf deinem Rechner (Abschnitt 5).

## 1. Verantwortlicher

[Vorname Nachname], [c/o-Zeile laut IMPREGO], [Straße Hausnummer laut IMPREGO], [PLZ Ort laut IMPREGO], Deutschland. E-Mail: [E-Mail-Adresse]

Einen Datenschutzbeauftragten gibt es nicht; dazu bin ich als Privatperson nicht verpflichtet.

## 2. Kurz gesagt

- Kein Tracking, keine Werbung, keine Analyse-Dienste. Website und Launcher senden keine Nutzungsstatistik und keine Geräte- oder Installationskennung.
- Spielerinnen und Spieler brauchen kein Konto. Der Launcher lädt Listen und Dateien; dabei sehen die angefragten Server deine IP-Adresse, wie bei jedem Abruf einer Webseite.
- Ein Konto braucht nur, wer im Hub etwas veröffentlicht, einen Server einträgt oder eine Mod beansprucht. Anmeldung nur über Discord oder GitHub; Passwörter speichere ich nicht.
- Einziges Cookie: das Anmelde-Cookie des Entwicklerportals.

## 3. Website

| Daten | Wozu | Rechtsgrundlage | Wie lange |
|---|---|---|---|
| **Server-Logs** (IP-Adresse, Zeit, aufgerufene Adresse, Statuscode, übertragene Datenmenge, Referrer, Browser-Kennung) | Auslieferung der Seiten, Abwehr von Angriffen | Art. 6 Abs. 1 lit. f DSGVO (Betrieb und Sicherheit) | [7] Tage, dann gelöscht |
| **Einstellungen im Browser** (`localStorage`: gewählte Sprache und Farbschema) | damit die Seite deine Wahl behält | § 25 Abs. 2 Nr. 2 TDDDG (von dir gewünschte Funktion) | bis du sie im Browser löschst; sie werden nie an mich übertragen |

Hosting der Website: [Hosting der Website, z. B. Oracle Cloud wie der Hub oder GitHub Pages]. Schriften und die übrigen Bilder liegen auf demselben Server. Auch die offiziellen Titelbilder der Spiele (Cover von IGDB.com, Banner und Logos von Steam) und die Bilder auf den Mod-Seiten (Vorstellungsseiten, Galerien und README-Texte, die auf GitHub oder Imgur liegen) kommen von unserem Server: Er holt sie selbst bei IGDB (`images.igdb.com`), Steam (`cdn.cloudflare.steamstatic.com`, Valve Corporation), GitHub (`raw.githubusercontent.com`, `github.com` und dessen Dateiserver `*.githubusercontent.com`, GitHub Inc.) und Imgur (`i.imgur.com`) ab und speichert sie zwischen. Dabei gehen weder deine IP-Adresse noch Angaben aus deinem Browser an diese Anbieter. Bilder von anderen Servern zeigt die Website nicht an. Die Website lädt nichts von fremden Servern nach. Links zu anderen Seiten (Exchange-Seiten, GitHub, Discord, Shops) öffnen erst, wenn du sie anklickst; dort gelten deren Datenschutzbestimmungen.

„Installieren“-Knöpfe öffnen nur den Launcher auf deinem Rechner (`tmhub://…`); dabei wird nichts an mich gesendet.

## 4. Hub und Entwicklerportal

| Daten | Wozu | Rechtsgrundlage | Wie lange |
|---|---|---|---|
| **Server-Logs** des Webservers (IP-Adresse, Zeit, aufgerufene Adresse, Statuscode, Browser-Kennung) | Betrieb, Abwehr von Angriffen und Missbrauch | Art. 6 Abs. 1 lit. f DSGVO (Sicherheit des Dienstes) | [7] Tage, dann gelöscht |
| **Anwendungs-Log** des Hub-Programms (Anfragen mit IP-Adresse, Fehler; Cookies und Zugangsdaten werden ausgeblendet) | Fehlersuche, Abwehr von Missbrauch | Art. 6 Abs. 1 lit. f DSGVO | [7] Tage, dann gelöscht |
| **Ratenbegrenzung** (IP-Adresse) | Schutz vor Überlastung und Spam | Art. 6 Abs. 1 lit. f DSGVO | nur im Arbeitsspeicher, höchstens 1 Stunde |
| **Download-Zählung** | Download-Zahlen pro Version und Tag für die Autorinnen und Autoren | Art. 6 Abs. 1 lit. f DSGVO | Damit eine Installation pro Projekt und Tag nur einmal zählt, hält der Server die zufällige Installations-ID des Launchers (ohne sie: die IP-Adresse) nur als gesalzenen Hash im Arbeitsspeicher; das Salz wechselt täglich, nichts davon wird gespeichert. Gespeichert werden nur Tagessummen ohne Personenbezug; die angezeigte Gesamtzahl rechnet die öffentlichen Download-Zahlen von GitHub-Releases hinzu. |
| **Eingereichte Spielserver** (Spiel, Adresse des Spielports, Name, Webseite, Kontakt; bei Anmeldung die Konto-ID der einsendenden Person und ein gesalzener Hash ihrer IP-Adresse; Ergebnis der letzten Abfrage) | Aufnahme in die Serverliste, Prüfung, Schutz vor Missbrauch (Grenzen pro Konto und pro Adresse). Der Hub fragt den Spielport nur eines eingereichten Servers ab (eine Verbindung, 3 Sekunden), danach alle 6 Stunden. Die Serveradresse sind öffentliche Serverdaten; die IP-Adresse der einsendenden Person wird nie im Klartext gespeichert | Art. 6 Abs. 1 lit. f DSGVO | bis zur Entfernung des Servers; der Kontakt wird auf Wunsch gelöscht; Einträge, die 14 Tage offline sind, werden ausgeblendet |
| **Konto aus Discord/GitHub** (Anbieter-ID, Benutzername, Anzeigename, Avatar-Adresse) | Anmeldung, Anzeige als Autorin oder Autor | Art. 6 Abs. 1 lit. b DSGVO (Nutzungsvertrag) | bis zur Löschung des Kontos |
| **Sitzungs-Cookie** (zufällige Kennung, technisch notwendig) und CSRF-Schutz-Token | angemeldet bleiben, Schutz vor fremden Anfragen | § 25 Abs. 2 Nr. 2 TDDDG; Art. 6 Abs. 1 lit. b DSGVO | 30 Tage oder bis zur Abmeldung |
| **Hochgeladene Inhalte** (Dateien, Bilder, Beschreibungen, Changelogs, Prüfberichte) | Veröffentlichung und Verteilung an Spielerinnen und Spieler | Art. 6 Abs. 1 lit. b DSGVO | solange das Projekt besteht; veröffentlichte Versionen sind unveränderlich (siehe Nutzungsbedingungen) |
| **Signaturschlüssel** (öffentliche Schlüssel) und **API-Tokens** (nur als Hash) | „Verifiziert“-Kennzeichen, Uploads aus CI | Art. 6 Abs. 1 lit. b DSGVO | bis zum Widerruf oder zur Löschung des Kontos |
| **Nicht übernommene Projekte** aus öffentlichen Quellen (Katalog, Discord-Mod-Kanal, GitHub, TMLoader-Server): Name oder Benutzername der ursprünglichen Autorin bzw. des Autors, Link zur Quelle; bei Einträgen aus dem Discord-Mod-Kanal die Discord-ID der Person, die den Beitrag gepostet hat (wird nicht angezeigt, dient nur der Übernahme per Discord-Anmeldung) | Nennung der Urheber, Übernahme des Projekts durch sie | Art. 6 Abs. 1 lit. f DSGVO | bis zur Übernahme oder bis zur Entfernung auf Wunsch (Widerspruch an [E-Mail-Adresse]) |
| **Protokoll der Moderation** (wer hat wann was entschieden) | Nachvollziehbarkeit, Pflichten nach dem DSA | Art. 6 Abs. 1 lit. c und f DSGVO | [3] Jahre |
| **Meldungen „Inhalt melden“** (Grund, Erläuterung, freiwillig Name und E-Mail) | Bearbeitung nach Art. 16 DSA, Antwort an die meldende Person | Art. 6 Abs. 1 lit. c DSGVO | [1] Jahr nach Abschluss |
| **Datensicherung** der Datenbank (enthält die Kontodaten oben) | Wiederherstellung nach Ausfällen | Art. 6 Abs. 1 lit. f DSGVO | 14 Tage; gelöschte Daten verschwinden spätestens dann auch aus den Sicherungen |

### Empfänger und Dienste des Hubs

- **Hosting:** Oracle Cloud Infrastructure ([Oracle-Region, z. B. Frankfurt (eu-frankfurt-1)]), Server und Objektspeicher. Vertrag zur Auftragsverarbeitung nach Art. 28 DSGVO: [prüfen: Data Processing Agreement der Oracle Cloud, auch im Free Tier].
- **Discord und GitHub (Anmeldung):** nur wenn du dich darüber anmeldest. Du wirst zu Discord bzw. GitHub weitergeleitet; dort gelten deren Datenschutzbestimmungen. Ich erhalte nur die oben genannten Kontodaten (Discord-Scope `identify`, GitHub ohne zusätzliche Rechte). Bei der Übernahme eines Projekts über GitHub prüfe ich einmalig, ob dein GitHub-Konto Administrator des verknüpften Repositorys ist; das Zugriffstoken wird danach verworfen und nicht gespeichert.
- **GitHub (Import und Crawler):** Wenn du eine Repository-Adresse einfügst oder ein Projekt mit einem Repository verknüpft ist, liest der Hub dessen öffentliche Releases und Dateien über die GitHub-API. Dabei werden keine Daten von Besucherinnen und Besuchern übermittelt.
- **TMLoader-Server:** Ist ein Projekt mit einem TMLoader-Server verknüpft, liest der Hub dessen öffentlichen Index und lädt die Dateien. Auch dabei werden keine Daten von Besucherinnen und Besuchern übermittelt.
- **VirusTotal** (Google/Chronicle, USA): Für jede neue Datei wird ihr SHA-256-Hash abgefragt. [Falls aktiviert: unbekannte Mod-Dateien werden zur Analyse hochgeladen; sie enthalten keine personenbezogenen Daten der Hochladenden.] Grundlage: Art. 6 Abs. 1 lit. f DSGVO (Schutz vor Schadsoftware).
- **Discord-Webhook der Moderation:** Hinweise auf neue Versionen und Meldungen (Projektname, Version, Grund) gehen in einen privaten Moderationskanal. Namen oder E-Mail-Adressen meldender Personen werden dort nicht übermittelt.
- Übermittlungen in Drittländer gibt es beim Hub nur bei den genannten Diensten (Discord, GitHub, VirusTotal: USA; Grundlage: EU-US Data Privacy Framework, soweit zertifiziert [prüfen], sonst Standardvertragsklauseln).

## 5. TM Horizon Launcher {#launcher}

Der Launcher ist ein Programm auf deinem Rechner. Er hat **kein Konto, keine Telemetrie und keine automatischen Absturzmeldungen**. Er sendet keine Geräte- oder Installationskennung; als Programmkennung schickt er bei seinen eigenen Abrufen nur `TM-Horizon` mit der Versionsnummer und der Adresse der Website (zum Beispiel `TM-Horizon/0.4.0 (+https://tm-horizon.com)`).

Alle Verbindungen unten baut der Launcher auf deinem Rechner **direkt** zu dem jeweiligen Dienst auf. Der Dienst sieht dabei deine IP-Adresse und die angefragte Adresse, wie bei jedem Webseitenabruf. Ich erhalte davon nichts – außer bei den Abrufen, die an meinen Hub gehen (wenn du ihn einschaltest). Für die Verarbeitung bei den anderen Diensten sind deren Betreiber verantwortlich; es gelten deren Datenschutzbestimmungen.

### 5.1 Verbindungen, die der Launcher aufbaut

| Wann | Wohin | Was übertragen wird |
|---|---|---|
| Beim Start und beim Aktualisieren | **GitHub Pages** (`cheatoskar.github.io`, GitHub Inc., USA): Listen von Spielen, Servern, Events und Mods | nur der Abruf |
| Nur wenn du „TM Horizon Hub“ in den Einstellungen einschaltest (aus ab Werk) | **mein Hub** [Domain des Hubs]: signierter Index, Mod-Dateien, Serverliste für TMNF/TMUF | nur der Abruf (siehe Abschnitt 4: Server-Logs und Download-Zählung) |
| Beim Start (abschaltbar) und wenn du nach Updates suchst | **GitHub** (`github.com`, Dateien über `objects.githubusercontent.com` / `release-assets.githubusercontent.com`): Update-Infos und Installationsdatei des Launchers | nur der Abruf |
| Auf der Startseite und den Spielseiten | **ManiaExchange-Seiten** (`tmnf.exchange`, `tmuf.exchange`, `tm.mania.exchange`, `trackmania.exchange`): News | nur der Abruf |
| Mods-Seite, Mod-Updates | **TMLoader-Mod-Server** (`modloader.tomashu.dev`, `tomashu.pages.dev`, `unlimiter.net`, `donadigo.com`, `fullspeed.mooo.com`, `cheatoskar.github.io`, `home.koyaanis.com`, `bigbang1112.github.io` sowie Server, die du in TMLoader selbst eingetragen hast): Mod-Listen und Mod-Dateien | nur der Abruf |
| Mod-Seiten, Installation und Update-Prüfung von Mods und Browser-Add-ons | **GitHub** (`api.github.com`, `raw.githubusercontent.com`, `github.com`): Releases, Beschreibungen (README), Bilder und Dateien der Projekte | nur der Abruf |
| Wenn du eine Mod installierst, deren Datei woanders liegt | der **Server, auf dem die Autorin oder der Autor die Datei anbietet** (steht auf der Mod-Seite) | nur der Abruf |
| Openplanet-Seite, Openplanet-Installation | **Openplanet** (`openplanet.dev`, `cdn.openplanet.dev`): Plugin-Liste, Download-Seite, Installer | nur der Abruf |
| TMLoader-Einrichtung | **TMLoader** (`tomashu.dev` und die dort verlinkten Download-Server) | nur der Abruf |
| Nur wenn du ein Spiel über den Launcher installierst | **Ubisoft/Nadeo** (`nadeo-download.cdn.ubi.com`, `files.trackmaniaforever.com`): Installationsprogramme der kostenlosen Spiele | nur der Abruf |
| Nur bei der Einrichtung unter Linux | **GitHub** (Releases von Proton-GE und Wine-Werkzeugen) | nur der Abruf |
| Beim Anzeigen von Bildern | die Server, auf denen die Bilder liegen (z. B. Steam-CDN, `images.mania.exchange`, GitHub, Seiten der Mod-Autorinnen und -Autoren) | nur der Abruf |
| In der Bibliothek, wenn „Spiel-Cover aus dem Internet laden“ an ist (an ab Werk, abschaltbar in den Einstellungen) | **IGDB-Bilderserver** (`images.igdb.com`, IGDB.com / Twitch Interactive, USA) für die Cover aller Spiele und, falls dort keins zu laden ist, das **Steam-CDN** (`shared.steamstatic.com`, Valve Corporation, USA). Der Launcher lädt jedes Bild einmal direkt (dabei sehen IGDB bzw. Steam deine IP-Adresse und die Kennung des Launchers) und speichert es dann auf deinem Rechner. | nur der Abruf |
| Beim Anzeigen von Seiten-Symbolen | die jeweilige Seite (Exchange- und Community-Seiten): ihr Symbol (Favicon), abgerufen mit einer üblichen Browser-Kennung | nur der Abruf |

Links zu Shops (Steam, Ubisoft, Epic Games), Discord-Einladungen und anderen Seiten öffnet der Launcher in deinem normalen Browser.

### 5.2 Eingebauter Browser (TMX, ManiaPark und andere Seiten)

Auf den Seiten Maps und Skins und im TAS-Bereich zeigt der Launcher fremde Seiten in einem eingebauten Browser (Microsoft Edge WebView2, unter Linux WebKitGTK): die TM-Exchange- und ManiaExchange-Seiten (`tmnf.exchange`, `tmuf.exchange`, `nations.tm-exchange.com`, `original.tm-exchange.com`, `sunrise.tm-exchange.com`, `tm.mania.exchange`, `sm.mania.exchange`, `trackmania.exchange`, `item.exchange`, `item.mania.exchange`), ManiaPark (`maniapark.com`), TM RPG Trial (`tmrpgtrial.com`), TMTAS Exchange (`tmtas.exchange`), 100% TMX (`100tmx.com`) und GBX Tools (`gbx.tools`).

- Das ist wie ein normaler Browser: Die Seiten sehen deine IP-Adresse, setzen eigene Cookies und können eigene Dienste einbinden. Dafür sind die Betreiber der Seiten verantwortlich; es gelten deren Datenschutzbestimmungen.
- Anmeldungen und Cookies dieser Seiten bleiben **nur auf deinem Rechner** in einem eigenen Browserprofil des Launchers (Ordner `EmbeddedWeb` in den lokalen Programmdaten). Der Launcher liest weder Cookies noch Passwörter aus und überträgt sie nirgendwohin. „Von eingebetteten Seiten abmelden“ in den Einstellungen löscht dieses Profil.
- Heruntergeladene Maps, Replays und Skins speichert der Launcher direkt in den Ordner des gewählten Spiels.

### 5.3 Browser-Add-ons

Für den eingebauten Browser kannst du Add-ons aus einer festen Liste installieren (zum Beispiel den TMX Universal Track Downloader). Sie werden aus dem GitHub-Release der Autorin oder des Autors geladen und mit einer Prüfsumme kontrolliert. Vor der Installation zeigt der Launcher, auf welche Seiten das Add-on zugreifen darf. Add-ons laufen nur im eingebauten Browser, nicht im Launcher selbst. Was ein Add-on überträgt, steht in seiner eigenen Beschreibung; der TMX Universal Track Downloader zum Beispiel spricht nur mit den TMX-Seiten, mit `100tmx.com` und mit Programmen auf deinem eigenen Rechner (`127.0.0.1`).

### 5.4 Replays automatisch zu TMX hochladen (aus ab Werk)

Wenn du „Neue Bestzeiten zu TMX hochladen“ für ein Spiel einschaltest, lädt der Launcher neue Replays dieses Spiels auf die Exchange-Seite des Spiels hoch (zum Beispiel `tmnf.exchange`). Er nutzt dafür deine Anmeldung im eingebauten Browser; der Upload läuft innerhalb der Exchange-Seite. Übertragen wird nur die Replay-Datei an die Exchange-Seite des Spiels. Deine Anmeldedaten verlassen den eingebauten Browser nicht.

Auf deinem Rechner gespeichert werden: die Schalter, ein Kopplungsschlüssel für die 100%-TMX-Mod, die letzten 100 Uploads (Map, Zeit, Seite, Ergebnis, Link) und Prüfsummen bereits hochgeladener Replays. An mich geht nichts davon.

### 5.5 Verbindungen nur auf deinem Rechner

Einige Funktionen sprechen über die Adresse `127.0.0.1` mit anderen Programmen **auf demselben Rechner**; diese Verbindungen verlassen den Rechner nicht:

- mit der 100%-TMX-Mod im Spiel (Ports 27311–27315), wenn der automatische Upload an ist; die Mod fragt im Spiel, ob die Verbindung erlaubt ist,
- eine kleine Statusabfrage für das Browser-Add-on (Ports 27321–27325), nur solange der automatische Upload an ist, damit Replays nicht doppelt hochgeladen werden,
- mit der Discord-App (siehe 5.7).

### 5.6 Live-Status von Spielservern

Auf der Serverseite und einigen Spielseiten fragt der Launcher Spielserver direkt nach Name, Spielerzahl, Modus und aktueller Map – so wie es die Serverliste im Spiel tut. Gefragt werden nur Server aus deiner Liste (mitgelieferte Beispielserver und Server, die du selbst einträgst), höchstens einmal pro Minute und nur, solange die Seite offen ist. Die Server sehen dabei deine IP-Adresse. Du kannst das in den Einstellungen ausschalten; Liste und Schalter liegen nur auf deinem Rechner. An Nadeo oder an meinen Hub wird dabei nichts gesendet.

#### Eigener Server hosten (Seite „Server“ › „Eigener Server“)

- **Downloads:** Der Launcher lädt den Dedicated Server des Spiels von Nadeos Download-Servern (`files2.trackmaniaforever.com`, `files.v04.maniaplanet.com`, `nadeo-download.cdn.ubi.com`; für Nations ESWC, Sunrise und Original von `slig.free.fr`), auf Wunsch den 100%-TMX-Server von GitHub und Karten von TMX. Dabei sehen diese Server deine IP-Adresse.
- **Server-Konto:** Login und Passwort deines Server-Kontos bleiben auf deinem Rechner (Windows-Anmeldeinformationsverwaltung); der Dedicated Server selbst meldet sich damit bei Nadeos Master-Server an, wie bei jedem Dedicated Server. Der Launcher sendet sie nirgendwohin.
- **Router (UPnP, nur wenn eingeschaltet):** Der Launcher bittet deinen Router im Heimnetz, die zwei Spiel-Ports an deinen Rechner weiterzuleiten, und nimmt das beim Stoppen zurück.
- **Erreichbarkeitstest (nur auf Klick „Prüfen“):** Der Launcher fragt meinen Hub; der Hub baut eine TCP-Verbindung zu der IP-Adresse auf, von der die Anfrage kam, auf dem Spiel-Port, und meldet „offen“ oder „zu“. Gespeichert wird dabei nichts außer den normalen Server-Logs (Abschnitt 4).
- **Öffentliche Liste (nur mit deiner ausdrücklichen Zustimmung):** Wenn du deinen Server eintragen lässt, übermittelt der Launcher Spiel, **deine öffentliche IP-Adresse mit Port**, den Servernamen und deinen Kontakt an meinen Hub. Adresse und Name werden nach der Prüfung durch einen Admin **öffentlich angezeigt** (Serverliste in Launcher und Website); der Kontakt nur Admins. Mit dem Token meldet der Launcher danach alle 5 Minuten Name, Spielerzahl, Karte und Modus, solange der Server läuft. Rechtsgrundlage: Art. 6 Abs. 1 lit. a DSGVO (Einwilligung); Widerruf jederzeit mit „Austragen“ im Launcher oder per E-Mail an [E-Mail-Adresse], der Eintrag wird dann entfernt.

### 5.7 Discord-Statusanzeige (aus ab Werk)

Wenn du die Discord-Statusanzeige einschaltest, sagt der Launcher der Discord-App auf deinem Rechner, welches Spiel du gestartet hast (Spielname, Profilname, Startzeit). Discord zeigt das deinen Kontakten an und verarbeitet es nach seinen eigenen Datenschutzbestimmungen (Discord Inc., USA). Der Launcher selbst sendet dafür nichts ins Internet.

### 5.8 Problembericht

„Problem melden“ erstellt eine ZIP-Datei auf deinem Desktop oder im Download-Ordner. Sie enthält:

- die Logs der Mods des gestarteten Profils und von Horizon Host,
- die neuesten Absturz-Logs des Spiels (höchstens drei),
- eine kurze Systemübersicht: Version des Launchers, Windows-Version, Grafikkarte, Spiel und Installationsart, TMLoader-Version, Profilname, installierte Mods mit Version und Herkunft.

Vorher werden dein Windows-Benutzername, der Name deines Rechners und E-Mail-Adressen unkenntlich gemacht. Du siehst die Dateiliste und eine Vorschau, bevor die Datei gespeichert wird. **Der Launcher lädt den Bericht nirgendwohin hoch.** Du entscheidest selbst, ob und an wen du ihn schickst (zum Beispiel an eine Mod-Autorin über Discord oder GitHub); verantwortlich für die Daten ist dann, wer den Bericht bekommt.

### 5.9 Was der Launcher auf deinem Rechner speichert

Einstellungen, Zwischenspeicher (Listen, Bilder, Antworten von GitHub), Profile und Spielinstanzen, Logs, das Browserprofil des eingebauten Browsers, installierte Add-ons, die Serverliste, die Upload-Historie und, wenn du dich im Launcher beim Hub anmeldest, dessen Zugangs-Token (`hub-login.json`; der Hub speichert davon nur einen Hash, gültig 90 Tage, „Abmelden“ widerruft es) liegen in den Programmdaten des Launchers auf deinem Rechner. Ich habe darauf keinen Zugriff. [prüfen: ob der Deinstaller diese Ordner entfernt oder ob man sie von Hand löschen muss, und den Pfad hier nennen]

## 6. Deine Rechte

Du hast das Recht auf Auskunft (Art. 15), Berichtigung (Art. 16), Löschung (Art. 17), Einschränkung (Art. 18), Datenübertragbarkeit (Art. 20) und Widerspruch gegen Verarbeitungen auf Grundlage von Art. 6 Abs. 1 lit. f (Art. 21 DSGVO). Schreib dafür an [E-Mail-Adresse].

Konto löschen: auf Anfrage per E-Mail [später auch im Portal unter „Account“]. Dabei werden Kontodaten, Sitzungen, Tokens und Schlüssel gelöscht. Veröffentlichte Versionen bleiben als Teil des Projekts erhalten, wenn weitere Teammitglieder sie betreuen; der Name wird dann durch „ehemaliges Konto“ ersetzt. Projekte, die nur dir gehören, werden auf Wunsch entfernt.

Du kannst dich bei einer Datenschutzaufsichtsbehörde beschweren, z. B. bei der für meinen Wohnsitz zuständigen: [Datenschutzaufsichtsbehörde des Bundeslandes: Name, Anschrift, Website].

## 7. Sicherheit

Verbindungen zu Website und Hub nur über HTTPS. Sitzungs-Cookies sind `HttpOnly`, `Secure` und `SameSite=Lax`. API-Tokens und Sitzungskennungen speichere ich nur als Hash. Uploads werden automatisch geprüft und als unveränderliche Kopien mit SHA-256 gespeichert. Der Launcher lädt nur über HTTPS (Ausnahme: das Installationsprogramm von TrackMania United Forever, das Nadeo nur über HTTP anbietet; der Launcher prüft es vor dem Start an seiner Signatur oder Prüfsumme) und prüft den Hub-Index anhand einer digitalen Signatur.

## 8. Änderungen

Wenn sich Website, Hub oder Launcher ändern, passe ich diese Erklärung an. Es gilt die Fassung mit dem neuesten Datum oben.
