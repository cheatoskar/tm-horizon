# Showcase-Seiten für Mods / Mod showcase pages

Deutsch zuerst, englische Kurzfassung weiter unten.

## Deutsch

Jeder Mod-Autor kann für seinen Mod eine eigene Seite gestalten: Kopfbild, Merkmale, Screenshots, Video, Tastenkürzel, Kompatibilität, FAQ und Knöpfe.
Der Launcher zeigt sie oben auf der Mod-Seite, vor den üblichen Abschnitten (README, Changelog, Versionen). Die Webseite zeigt dieselbe Seite statisch.
Ohne Showcase bleibt die Mod-Seite wie bisher.

Eine Showcase ist **Daten, kein HTML**: eine geordnete Liste von Blöcken. Es gibt kein HTML, kein CSS und kein JavaScript vom Autor.
Alles wird von denselben React-Komponenten gezeichnet (`packages/showcase-ui`), Texte sind immer Text, Links nur `https`.

### Wo die Seite herkommt

| Quelle | Wie |
|---|---|
| Repository des Mods | `showcase.json` im Wurzelordner (Standard-Branch) oder der Schlüssel `showcase` in `plugin.json`. Der Hub liest sie beim Import und bei jeder Quellenprüfung neu. |
| Entwickler-Portal | Reiter **Showcase** im Projekt: Blockliste mit Hinzufügen, Entfernen, Verschieben und Live-Vorschau (derselbe Renderer wie im Launcher). Speichern ersetzt die Repo-Fassung, der Hub liest sie dann nicht mehr neu ein. |
| Katalog (Beispiele) | `packages/catalog/showcases/*.json`, eingetragen in `SHOWCASES` in `packages/catalog/mods_seed.py` (`build_catalog.py` schreibt sie nach `catalog.json`). Heute: TM Vibrant Shaders, 100 TMX Bingo Plugin, ESWC Autosave. Der Hub findet die passende Vorlage über Katalog-ID, Name oder das Repository (`apps/server/src/services/catalog-seeds.ts`). Katalog-Projekte bekommen sie beim Katalog-Import gleich als Seite (`showcase_from = 'catalog'`); ein `showcase.json` im Repository ersetzt sie. |

Im Portal:

- Der Reiter **Showcase** ist immer da, auch für Besucher eines noch nicht übernommenen Katalog-Projekts (dann nur zum Ansehen, mit Hinweis „Projekt übernehmen, um sie zu ändern“).
- Ohne Seite erklärt er in zwei Sätzen, was eine Showcase ist, und bietet **Start from template** (Kopf, drei Features, die Bilder des Projekts, Kompatibilität, neueste Änderungen, Install-Knopf; noch nicht gespeichert), **Copy from catalog** (wenn es eine Vorlage gibt) und **Use showcase.json** (wenn ein GitHub-Repository verbunden ist). API: `POST /v1/projects/<slug>/showcase/adopt` mit `{"from":"catalog"}` oder `{"from":"repo"}`.
- Beim Import aus einem Link wählt die Autorin zwischen der Seite aus dem Repository, der Katalog-Vorlage und keiner.
- Die öffentliche Projektseite im Portal (`/p/<slug>`) zeigt die Showcase über der Beschreibung.
- **Remove page** entfernt die Seite dauerhaft; ein `showcase.json` im Repository kommt erst über „Use showcase.json“ zurück.

Bilder dürfen in `showcase.json` als Pfad im Repository stehen (`docs/images/a.png`); der Hub macht daraus `https://raw.githubusercontent.com/<owner>/<repo>/HEAD/docs/images/a.png`.

### Format

```json
{
  "$schema": "https://raw.githubusercontent.com/cheatoskar/tm-horizon/main/packages/shared/showcase.schema.json",
  "version": 1,
  "theme": { "accent": "orange" },
  "blocks": [
    { "type": "hero", "title": "Mein Mod", "tagline": "Ein Satz dazu.", "image": "docs/images/hero.jpg", "badges": ["TMNF", "Open source"] },
    { "type": "features", "items": [{ "icon": "sun", "title": "Licht", "text": "Sonne und Schatten." }] },
    { "type": "hotkeys", "rows": [{ "keys": "F8", "action": "Menü" }] },
    { "type": "cta", "buttons": [{ "kind": "install", "label": "Installieren" }] }
  ]
}
```

`theme.accent`: `blue`, `cyan`, `green`, `lime`, `amber`, `orange`, `red`, `pink`, `violet`, `slate`. Jede Farbe hat eine helle und eine dunkle Fassung; die Seite folgt dem Thema des Launchers beziehungsweise der Webseite.

| Block (`type`) | Felder | Grenzen |
|---|---|---|
| `hero` | `title`, `tagline`, `image`, `video`, `badges` | Titel 60, Tagline 140, bis zu 3 Badges je 24 Zeichen. Höchstens ein Hero. |
| `features` | `title`, `items[]` mit `icon`, `title`, `text` | bis 9 Einträge, Titel 40, Text 140 Zeichen. `icon` aus einer festen Lucide-Liste (siehe Schema, z. B. `sun`, `droplets`, `camera`, `film`, `palette`). |
| `gallery` | `title`, `images[]` mit `url`, `caption`, `alt` | bis 12 Bilder, Beschriftung 120 |
| `compare` | `before`, `after` je mit `url`, `label`; `caption` | zwei Bilder mit Schieberegler, Label 24 |
| `video` | `url`, `caption`, `poster` | YouTube, Vimeo, Streamable |
| `text` | `title`, `markdown` | 4000 Zeichen, begrenztes Markdown (unten) |
| `compat` | `rows[]` mit `game`, `status`, `note` | bis 14 Zeilen; `game` wie im Hub (`tmnf`, `tmuf`, `eswc`, `tm2-stadium`, ...), `status`: `works`, `partial`, `planned`, `no` |
| `hotkeys` | `rows[]` mit `keys`, `action` | bis 20 Zeilen, `keys` wie `Ctrl+F5` (24), `action` 80 |
| `changelog` | `count` (1 bis 3) | holt die Notizen der neuesten Versionen; ohne Notizen entfällt der Block |
| `faq` | `items[]` mit `q`, `a` | bis 12, Frage 120, Antwort 600 |
| `cta` | `text`, `buttons[]` mit `kind`, `label`, `url`, `style` | bis 3 Knöpfe, Label 30. `install` startet die Installation, `companion` öffnet den Companion-Link des Mods (siehe `related-links.md`) oder die eigene `url`, `link` braucht eine `url`. |

Insgesamt höchstens **30 Blöcke** und 60 000 Zeichen.

### Bilder und Videos

- Bilder: `https`, Endung `.png`, `.jpg`, `.jpeg`, `.webp` oder `.gif`, ohne Query und ohne Zugangsdaten. Erlaubte Hosts: der Speicher des Hubs (Bild im Portal hochladen oder aus den Projektbildern wählen), `raw.githubusercontent.com`, GitHub-Release-Anhänge (`github.com/<owner>/<repo>/releases/download/...`) und `i.imgur.com`.
- Empfohlen: höchstens 5 MB und 3840 Pixel an der langen Kante. Der Hub prüft Bilder von anderen Hosts mit einer HEAD-Anfrage; was kein Bild ist oder über 5 MB liegt, wird weggelassen.
- Videos: `youtube.com/watch?v=`, `youtu.be/`, `youtube.com/embed/` (auch Shorts), `vimeo.com/<id>`, `streamable.com/<id>`. Eingebettet wird datensparsam (`youtube-nocookie.com`, Vimeo mit `dnt=1`) und erst **nach einem Klick**. Vorher gibt es keine Anfrage an die Videoseite, auch kein Vorschaubild; wer eines will, gibt ein `poster` aus der Bilderliste an.

### Markdown in `text`

Überschriften (`#` bis `####`, im Block als Zwischenüberschriften), Absätze, Listen (`-` und `1.`), `**fett**`, `*kursiv*`, `` `Code` ``, Codeblöcke mit drei Backticks und `[Links](https://...)`.
Alles andere bleibt einfacher Text: rohes HTML, Bilder, Tabellen, Zitate. Links, die nicht `https` sind, verlieren den Link und behalten den Text.

### Prüfung

Dieselbe Prüfung (`packages/shared/src/showcase.ts`, `validateShowcase`) läuft im Hub-Server, im Portal (live beim Tippen) und im Launcher.
Das Portal und `PUT /v1/projects/:slug/showcase` lehnen eine Seite mit Fehlern ab (400 mit der Liste `details.issues`, Pfad und Meldung je Fehler).
Beim Import aus dem Repository und im Launcher wird nachsichtig geprüft: Was falsch ist, fällt weg, der Rest bleibt. Unbekannte Felder zählen als Fehler (Tippfehler sollen auffallen).
`showcase.schema.json` (`packages/shared`) ist das JSON Schema für Editor-Hinweise; maßgeblich ist der Validator.

### Technik

- Schema und Validator: `packages/shared/src/showcase.ts`, `showcase-md.ts`, `showcase.schema.json`.
- Renderer: `packages/showcase-ui` (React; im Launcher, in der Portal-Vorschau und für die Webseite als statisches Markup mit `react-dom/server`, plus ein kleines Skript für Schieberegler und Video-Klick).
- Hub: Spalten `projects.showcase` und `projects.showcase_from` (`repo` oder `portal`), Feld `showcase` in der Projektantwort und im signierten Index.
- Launcher: im Tauri-Fenster erlaubt die CSP `frame-src` nur für `youtube-nocookie.com`, `player.vimeo.com` und `streamable.com`.

## English (short)

Every mod author can design a page for their mod; the launcher shows it above the usual sections of the mod page, the website renders the same data statically. No showcase means the page looks as before.

A showcase is data, not HTML: an ordered list of up to 30 blocks (`hero`, `features`, `gallery`, `compare`, `video`, `text`, `compat`, `hotkeys`, `changelog`, `faq`, `cta`) and an accent colour from a fixed palette (light and dark safe). No HTML, CSS or scripts from authors; text is always text, links are https only.

Where it comes from: `showcase.json` in the repository root (or a `showcase` key in `plugin.json`), read at import and at every source check; or the **Showcase** tab of the dev portal (block list with add, remove, reorder and a live preview with the launcher's renderer; saving there replaces the repository copy); or the catalog's seed showcases (`packages/catalog/showcases`), which catalog projects get at import and every project can take over with "Copy from catalog" (`POST /v1/projects/<slug>/showcase/adopt`). An empty Showcase tab offers a one-click starter template. Pictures may be repository paths (`docs/images/a.png`), the hub does the rest.

Pictures: https, `.png .jpg .webp .gif`, on the hub storage, `raw.githubusercontent.com`, GitHub release assets or `i.imgur.com`; up to 5 MB, 3840 px. Videos: YouTube, Vimeo or Streamable; loaded only after a click (privacy-friendly embeds, no thumbnail request).

Validation is one function (`validateShowcase` in `packages/shared/src/showcase.ts`) used by the server (strict, HTTP 400 with the list of problems), the portal (live) and the launcher (lenient: drops what is wrong). The JSON Schema for editors is `packages/shared/showcase.schema.json`. Examples: `packages/catalog/showcases/`.
