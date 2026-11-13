# Hub lokal testen (Entwickler-Ablauf)

Ein Befehl startet den Hub-Server (SQLite), das Entwicklerportal und die Website auf deinem Rechner. Angemeldet wird mit erfundenen Konten („Development login“), ohne Discord- oder GitHub-App. Nichts davon ist aus dem Netz erreichbar.

## Einmal vorbereiten

Im Repository-Ordner (oder im Worktree `tm-hub-mono-wt-legal`):

```
npm ci
```

Node 24 oder neuer (`node -v`).

## Starten

```
npm run dev:hub
```

Beim ersten Start legt das Skript Demo-Daten an (rund 100 Katalog-Projekte, ein Demo-Projekt in jedem Zustand, eine Meldung, eine Übernahme-Anfrage) und baut einmal die Daten der Website. Danach steht im Fenster:

```
================ TM Horizon hub: local test ================
  Portal   http://localhost:5174/   (Login > Development login > admin or author)
  Website  http://localhost:4321/   (legal pages: /de/impressum/, ...)
  API      http://127.0.0.1:8787/v1/index.json (signed index)
  Launcher (debug build): TMHUB_HUB_DEV_PUBKEYS=<Schlüssel>
  ...
  DEVELOPMENT LOGIN IS ON (made-up accounts, this computer only)
```

Beenden: **Strg+C** in diesem Fenster (stoppt alle drei).
Von vorn anfangen (leere Datenbank, neue Demo-Daten): `npm run dev:hub -- --fresh`.
Zweiter Hub neben einem laufenden (andere Ports): vorher `$env:PORTAL_PORT = "5184"; $env:HUB_PORT = "8797"; $env:WEB_PORT = "4331"` (PowerShell) setzen; das Portal ist dann `http://localhost:5184/`.
Ohne Website: `npm run dev:hub -- --no-web`.

Wichtig: Das Portal immer als **`http://localhost:5174`** öffnen, nicht als `127.0.0.1:5174`. Der Server prüft bei jeder Änderung die Herkunft der Anfrage; mit `127.0.0.1` schlagen Speichern und Hochladen fehl.

## Ablauf Schritt für Schritt

### 1. Als Entwickler anmelden

1. `http://localhost:5174/` öffnen. Du landest auf „Log in“.
2. Unten im gelb umrandeten Kasten „Development login“ auf **Author** klicken. Du bist jetzt `Dev Author`.

### 2. Repository einfügen

1. Links **New project**.
2. GitHub-Adresse einfügen und **Preview** drücken. Der Hub liest Name, Beschreibung, Lizenz, README, Bilder und das neueste Release.
3. Hat das Release mehrere Dateien, unter „Release file“ **die richtige auswählen**. (Das Portal lässt dich auch ohne Auswahl importieren; dann steht beim Projekt „Source needs a choice“ und du wählst die Datei später unter **Sources** › „Use this file“.)
4. Unter „Games“ mindestens ein Spiel ankreuzen, Install type prüfen, **Import**.

Zwei Beispiele, die ich getestet habe:

- `https://github.com/cheatoskar/TM-Vibrant-Shaders` – eine TMLoader-Mod. Ergebnis: Versionen 1.4.2 und 1.4.3-rc.2 bestehen die Prüfungen, sind „flagged“ (erste Version eines neuen Projekts, Programmdatei mit Netzwerk/Tastatur-Hooks) und warten auf Freigabe.
- `https://github.com/cheatoskar/TMX-Downloader` – eine **Browser-Erweiterung**. Sie steht schon als Katalog-Projekt im Hub (die Vorschau bietet dann „Claim this project“). Wer den Import selbst sehen will, löscht das Katalog-Projekt vorher aus der lokalen Datenbank. Mit Typ „Browser extension“ prüft der Hub die Datei nach den Browser-Regeln (`docs/hub/moderation.md`): die `.js`-Dateien sind erlaubt, die erste Version wartet als neues Projekt auf Freigabe.

GitHub erlaubt ohne Token 60 Abrufe pro Stunde; ein Import braucht etwa fünf. Wer mehr testen will, setzt vor dem Start ein eigenes Lese-Token: `$env:GITHUB_TOKEN = "<token>"` (PowerShell). Nötig ist es nicht.

### 3. Prüfungen und Warteschlange ansehen

1. Im Projekt den Reiter **Versions** öffnen: Jede Version zeigt Status (review, held, published, rejected), Dateigröße, SHA-256 und die Liste der Prüfungen (reject / flag / info).
2. Unten links **Log out**.

### 4. Als Admin freigeben

1. Wieder „Development login“, diesmal **Admin**.
2. Links **Admin**. Oben die Warteschlange: neue Projekte und auffällige Updates („review“), Updates in der Wartezeit („held“), Übernahme-Anfragen, Meldungen.
3. Bei deiner Version **Approve**. Sie ist sofort veröffentlicht.

### 5. Im signierten Index nachsehen

`http://127.0.0.1:8787/v1/index.json` öffnen. Das ist der Index, den der Launcher lädt: `alg: ed25519`, `keyId`, `sig` und darin `payload` mit allen veröffentlichten Projekten und Versionen. Dein Projekt steht jetzt drin. Die öffentliche Projektseite: im Portal **View page** (`/p/<name>`).

### 6. Launcher auf den lokalen Hub zeigen (optional)

Geht nur mit einem **Debug-Build** des Launchers (nur der akzeptiert `http://` und einen Entwicklungsschlüssel):

```
cd apps/launcher
$env:TMHUB_HUB_DEV_PUBKEYS = "<Schlüssel aus der Startmeldung>"
npx tauri dev
```

Dann im Launcher **Einstellungen › TM Horizon Hub** einschalten und als Hub-Adresse `http://localhost:5174/` eintragen, **Aktualisieren**. Unter dem Schalter stehen Schlüssel, Index-Nummer und Zahl der Projekte. Der Schlüssel liegt in `apps/server/data/dev-index-key.txt` und bleibt gleich, bis du diese Datei löschst.

Dein installierter Launcher bleibt davon unberührt: Er hat den Hub ab Werk aus und nimmt keine Entwicklungsschlüssel an.

### 7. Rechtstexte ansehen

- Website: `http://localhost:4321/de/impressum/`, `/de/datenschutz/` (Launcher-Abschnitt: `/de/datenschutz/#launcher`), `/de/nutzungsbedingungen/`; englisch ohne `/de/`. Links im Fuß jeder Seite.
- Portal: Fußzeile „Impressum · Datenschutz · Nutzungsbedingungen“, oben „English version“.
- Offene Stellen sind orange markiert. Liste: `npm run check-legal`. Was wohin gehört: `docs/hub/legal/AUSFUELLEN.md`.

## Was der Development login darf und was nicht

- Er ist nur an, wenn `HUB_DEV_LOGIN=1`, `NODE_ENV=development` **und** der Server nur auf `127.0.0.1` lauscht. Sonst startet der Server nicht.
- Auch dann nimmt der Server die Anmeldung nur von Anfragen dieses Rechners an.
- In Produktion (`NODE_ENV=production`) verweigert der Server den Start, sobald `HUB_DEV_LOGIN` gesetzt ist.
- `npm run dev:hub` liest keine `.env`-Datei und keine Geheimnisse; alle Einstellungen stehen in `scripts/dev-hub.mjs`. Daten landen in `apps/server/data/devhub.sqlite` und `apps/server/data/devhub-files/` (nicht im Git).

## Wenn etwas nicht geht

| Problem | Lösung |
|---|---|
| „Port 5174 is already in use“ oder `EADDRINUSE` | Ein alter Lauf läuft noch. Fenster schließen oder im Task-Manager die `node.exe` mit `dev-hub`, `vite` oder `astro` beenden. |
| Speichern im Portal schlägt fehl („origin“) | Portal über `http://localhost:5174` öffnen, nicht über `127.0.0.1`. |
| Preview meldet ein GitHub-Limit | eine Stunde warten oder `GITHUB_TOKEN` setzen (siehe oben). |
| Website zeigt keine Spielbilder | Die Bilder sind nicht im Git; `python apps/web/scripts/fetch-game-art.py` holt sie (siehe `apps/web/README.md`). Für die Rechtstexte unwichtig. |
