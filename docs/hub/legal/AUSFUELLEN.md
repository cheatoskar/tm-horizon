# Rechtstexte ausfüllen

Die drei Texte gibt es zweimal: deutsch (verbindlich) in `docs/hub/legal/` und englisch in `docs/hub/legal/en/`. Website (`/de/impressum/`, `/de/datenschutz/`, `/de/nutzungsbedingungen/` und die englischen Seiten ohne `/de/`) und Entwicklerportal (`/legal/...`) zeigen genau diese Dateien. Offene Stellen stehen in `[eckigen Klammern]` und sind auf der Website orange markiert.

Die Platzhalter sind in beiden Sprachen **wörtlich gleich**. Am schnellsten: in allen sechs Dateien „Suchen und Ersetzen“ für jeden Platzhalter. Danach zeigt

```
npm run check-legal
```

was noch fehlt (Datei, Zeile). Vor dem Livegang muss `npm run check-legal -- --strict` ohne Fehler durchlaufen.

Diese Datei selbst wird nirgends angezeigt.

## Die Platzhalter

| Platzhalter | Wo | Was hinein |
|---|---|---|
| `[Vorname Nachname]` | Impressum (Anbieter), Datenschutz 1, Nutzungsbedingungen § 1 | dein voller Name, wie im Ausweis. Kein Pseudonym. |
| `[c/o-Zeile laut IMPREGO]` | Impressum, Datenschutz 1 | die c/o-Zeile genau so, wie IMPREGO sie in der Bestätigung vorgibt (meist „c/o“ plus Firmenname). Nicht selbst formulieren. |
| `[Straße Hausnummer laut IMPREGO]` | Impressum, Datenschutz 1 | Straße und Hausnummer der IMPREGO-Anschrift aus der Bestätigung. |
| `[PLZ Ort laut IMPREGO]` | Impressum, Datenschutz 1 | PLZ und Ort der IMPREGO-Anschrift. |
| `[E-Mail-Adresse]` | Impressum (Kontakt und DSA-Kontaktstelle), Datenschutz (Verantwortlicher, Widerspruch, Rechte), Nutzungsbedingungen § 5, § 8 | eine Adresse, die du wirklich liest, am besten auf der eigenen Domain (z. B. `kontakt@<domain>`). Sie ist zugleich die Kontaktstelle nach Art. 11/12 DSA und die Adresse für Widersprüche; Antworten musst du von Hand schreiben, der Hub verschickt keine E-Mails. |
| `[Domain der Website]` | Impressum, Datenschutz (Einleitung) | die Adresse der Website, z. B. `tm-horizon.example`. |
| `[Domain des Hubs]` | Impressum, Datenschutz (Einleitung und 5.1) | die Adresse des Hubs, z. B. `hub.tm-horizon.example`. |
| `[Link zum Repository, sobald öffentlich]` | Impressum (letzter Satz) | `https://github.com/cheatoskar/tm-horizon`, sobald das Repository öffentlich ist. Bis dahin: den Satz ganz streichen (AGPL: wer den Hub nutzt, muss an den Quellcode kommen; also spätestens zum Livegang öffentlich machen). |
| `[Datum]` | Datenschutz, Nutzungsbedingungen („Stand:“) | Datum der veröffentlichten Fassung, z. B. `1. Dezember 2026`. Bei jeder Änderung neu setzen. |
| `[Hosting der Website, z. B. Oracle Cloud wie der Hub oder GitHub Pages]` | Datenschutz 3 | wo die statische Website liegt. Bei Oracle: „Oracle Cloud Infrastructure, Rechenzentrum Frankfurt, wie der Hub“. Bei GitHub Pages zusätzlich GitHub (USA) als Empfänger nennen und die Server-Log-Zeile anpassen (GitHub legt die Logs an, nicht du). |
| `[Oracle-Region, z. B. Frankfurt (eu-frankfurt-1)]` | Datenschutz 4 (Empfänger) | die Region der Oracle-Instanz und des Buckets, wie in `docs/hub/deploy-oracle.md` (`S3_REGION`). Die vorhandene Box 130.61.136.54 prüfen: In der Oracle-Konsole steht die Region oben rechts. |
| `[prüfen: Data Processing Agreement der Oracle Cloud, auch im Free Tier]` | Datenschutz 4 | prüfen, dass Oracles Data Processing Agreement für dein Konto gilt (es ist Teil der Oracle Cloud Services Agreement; auch im Free Tier), dann ersetzen durch: „Es gilt das Data Processing Agreement von Oracle.“ |
| `[Falls aktiviert: unbekannte Mod-Dateien werden zur Analyse hochgeladen; …]` | Datenschutz 4 (VirusTotal) | Mit `VT_UPLOAD=0` (Standard) diesen Satz ganz streichen. Nur mit `VT_UPLOAD=1` die Klammern entfernen und den Satz stehen lassen. |
| `[prüfen]` (nach „Data Privacy Framework, soweit zertifiziert“) | Datenschutz 4 | auf `dataprivacyframework.gov` nachsehen, ob Discord, GitHub und Google (VirusTotal) gelistet sind; dann `[prüfen]` streichen. Wer nicht gelistet ist: „Standardvertragsklauseln“ stehen lassen. |
| `[7]` (Server-Logs Website und Hub, Anwendungs-Log) | Datenschutz 3 und 4 | **7** passt zu `apps/server/deploy/logrotate-tm-hub` (`rotate 7`, täglich). Wenn du die Logrotation änderst, hier mitändern. Das **Anwendungs-Log** (journald, `journalctl -u tm-hub`) hat heute **keine** Frist: auf dem Server `MaxRetentionSec=7day` in `/etc/systemd/journald.conf` setzen, sonst stimmt die Zeile nicht. |
| `[3]` (Protokoll der Moderation) | Datenschutz 4 | Vorschlag 3 Jahre (Verjährungsfrist für Ansprüche). Der Hub löscht das Protokoll heute **nicht** automatisch; du musst es von Hand bereinigen oder einen Löschjob einplanen. |
| `[1]` (Meldungen) | Datenschutz 4 | Vorschlag 1 Jahr nach Abschluss. Auch hier löscht der Hub heute nicht von selbst. |
| ~~`[30]`~~ (Datensicherung) | Datenschutz 4 | **Erledigt (2026-11-12): 14 Tage**, passend zur Produktion (`apps/server/deploy/prod/backup-prod.sh`, `KEEP_DAYS=14`, plus Lifecycle-Regel des Buckets, `docs/hub/production.md`). Beim Ändern des Skripts mitändern. |
| `[prüfen: ob der Deinstaller diese Ordner entfernt …]` | Datenschutz 5.9 | Einmal den Launcher installieren und deinstallieren und nachsehen, ob `%APPDATA%` / `%LOCALAPPDATA%` des Launchers (inkl. `EmbeddedWeb`) bleiben. Dann den Satz ersetzen, z. B. „Beim Deinstallieren bleiben diese Daten; du kannst den Ordner `…` von Hand löschen.“ |
| `[später auch im Portal unter „Account“]` | Datenschutz 6 | streichen, solange das Portal keinen „Konto löschen“-Knopf hat (heute: keiner). |
| `[Datenschutzaufsichtsbehörde des Bundeslandes: Name, Anschrift, Website]` | Datenschutz 6 | die Landesbehörde für **deinen Wohnsitz** (nicht für IMPREGO). Liste aller Behörden: Datenschutzkonferenz, `datenschutzkonferenz-online.de` › Datenschutzaufsichtsbehörden. Name, Postanschrift und Website eintragen. |
| `[60]` | Nutzungsbedingungen § 5 Nr. 2 | Wartezeit für Updates in Minuten = `HOLD_MINUTES` auf dem Server (Standard 60). Wenn du den Wert änderst, hier mitändern. |

## Was der Code dazu sagt (schon eingearbeitet)

- Launcher: keine Telemetrie, keine Geräte-ID, Programmkennung `TM-Horizon/<Version> (+https://tm-horizon.com)`; alle Hosts aus `apps/launcher/src-tauri/src` (Stand main 2026-11-11) plus die Zweige `tmx-autoupload`, `browser-addons`, `server-query`, `horizon-host-launcher`, `linux-setup`. Wenn ein neuer Dienst dazukommt (z. B. eine Hub-Serverliste, Telemetrie, ein neuer Mod-Server), muss Abschnitt 5.1 mitwachsen.
- Discord-Statusanzeige: im Code fertig, aber noch ohne Discord-App-ID, also heute aus. Der Text beschreibt sie schon.
- Problembericht: wird nur gespeichert, nie hochgeladen (`report.rs`).
- Ein Link „Datenschutz“ im Launcher (Einstellungen › Über) fehlt noch: Der Launcher hat heute keinen Über-Bereich. Ziel des Links: `https://[Domain der Website]/de/datenschutz/#launcher` (deutsch) bzw. `/datenschutz/#launcher` (englisch).

## Prüfen lassen

Was eine Anwältin, ein Anwalt oder ein Generator wie eRecht24 / Dr. Schwenke ansehen sollte:

1. **Impressum mit c/o-Anschrift:** Reicht die IMPREGO-Anschrift als „ladungsfähige Anschrift“ nach § 5 DDG für eine Privatperson? (IMPREGO wirbt damit; die Rechtsprechung dazu ist nicht einheitlich.) Muss für „Diensteanbieter“ ein zweiter schneller Kontaktweg neben E-Mail angegeben werden (Telefon oder Kontaktformular)?
2. **Brauche ich § 18 Abs. 2 MStV** („Verantwortlich für den Inhalt“)? Die Website zeigt News und Events von Dritten, aber keine eigenen journalistischen Texte.
3. **Rolle beim Launcher:** Der Text sagt, dass ich für die direkten Verbindungen des Launchers zu Dritten nicht verantwortlich bin (das Programm läuft beim Nutzer). Ist das so haltbar, oder muss dafür eine Rechtsgrundlage genannt werden?
4. **Nicht übernommene Projekte:** Ist Art. 6 Abs. 1 lit. f für Name und Discord-ID von Mod-Autoren aus dem öffentlichen Discord-Kanal tragfähig? Muss ich sie aktiv informieren (Art. 14 DSGVO)?
5. **DSA-Pflichten** für eine kleine Hosting-Plattform: Kontaktstelle (Art. 11/12), Meldeverfahren (Art. 16), Begründungen (Art. 17), internes Beschwerdeverfahren (Art. 20 gilt nur für Online-Plattformen; ist der Hub eine?), Transparenzbericht (Art. 15; Ausnahme für Kleinst- und Kleinunternehmen nach Art. 19?).
6. **Nutzungsbedingungen:** Lizenzeinräumung (§ 3), Haftungsausschluss (§ 9), Mindestalter 16, Änderungsklausel mit zwei Wochen (§ 10) – AGB-rechtlich wirksam gegenüber Verbrauchern?
7. **Drittlandübermittlung:** Data Privacy Framework für Discord, GitHub, Google; Auftragsverarbeitung mit Oracle.
8. **Cookies und localStorage:** Sitzungs-Cookie und gespeicherte Sprache/Farbschema ohne Einwilligung nach § 25 Abs. 2 Nr. 2 TDDDG – passt das?
9. **Englische Fassung:** Hinweis „deutsche Fassung ist verbindlich“ ausreichend?
10. **Löschfristen** praktisch umgesetzt: logrotate (7 Tage), journald (Produktion: eigener Namespace mit 7 Tagen, `docs/hub/production.md`), Backups (14 Tage), Moderationsprotokoll und Meldungen (noch kein Löschjob).
