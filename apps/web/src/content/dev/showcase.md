---
title: "Showcase pages"
group: "publish"
order: 2
synced: false
editUrl: "https://github.com/cheatoskar/tm-horizon/edit/main/docs/hub/showcase.md"
note: "English version of docs/hub/showcase.md, which is written in German. The validator in packages/shared/src/showcase.ts is the authority."
---

Every mod author can design a page for their mod: header image, features, screenshots, video, hotkeys, compatibility, FAQ and buttons. The launcher shows it above the usual sections of the mod page (README, changelog, versions), the website renders the same data statically. Without a showcase the mod page looks as before.

A showcase is **data, not HTML**: an ordered list of up to 30 blocks and an accent colour. No HTML, CSS or script from authors. Text is always text, links are https only.

## Where it comes from

| Source | How |
|---|---|
| Your repository | `showcase.json` in the root folder (default branch), or a `showcase` key in `plugin.json`. The hub reads it at import and at every source check. |
| Dev portal | The **Showcase** tab of the project: block list with add, remove, reorder and a live preview with the launcher's renderer. Saving replaces the repository copy; the hub then stops reading the repository file. |

Pictures in `showcase.json` may be repository paths (`docs/images/a.png`). The hub turns them into `https://raw.githubusercontent.com/<owner>/<repo>/HEAD/docs/images/a.png`.

## Format

```json
{
  "$schema": "https://raw.githubusercontent.com/cheatoskar/tm-horizon/main/packages/shared/showcase.schema.json",
  "version": 1,
  "theme": { "accent": "orange" },
  "blocks": [
    { "type": "hero", "title": "My mod", "tagline": "One sentence.", "image": "docs/images/hero.jpg", "badges": ["TMNF", "Open source"] },
    { "type": "features", "items": [{ "icon": "sun", "title": "Light", "text": "Sun and shadows." }] },
    { "type": "hotkeys", "rows": [{ "keys": "F8", "action": "Menu" }] },
    { "type": "cta", "buttons": [{ "kind": "install", "label": "Install" }] }
  ]
}
```

`theme.accent` is one of `blue`, `cyan`, `green`, `lime`, `amber`, `orange`, `red`, `pink`, `violet`, `slate`. Each has a light and a dark version, and the page follows the theme of the launcher or the website.

| Block (`type`) | Fields | Limits |
|---|---|---|
| `hero` | `title`, `tagline`, `image`, `video`, `badges` | Title 60, tagline 140, up to 3 badges of 24 characters. At most one hero. |
| `features` | `title`, `items[]` with `icon`, `title`, `text` | Up to 9 items, title 40, text 140 characters. `icon` comes from a fixed Lucide list (see the schema, for example `sun`, `droplets`, `camera`, `film`, `palette`). |
| `gallery` | `title`, `images[]` with `url`, `caption`, `alt` | Up to 12 images, caption 120 |
| `compare` | `before`, `after` each with `url`, `label`; `caption` | Two images with a slider, label 24 |
| `video` | `url`, `caption`, `poster` | YouTube, Vimeo, Streamable |
| `text` | `title`, `markdown` | 4000 characters, limited Markdown (below) |
| `compat` | `rows[]` with `game`, `status`, `note` | Up to 14 rows. `game` as in the hub (`tmnf`, `tmuf`, `eswc`, `tm2-stadium`, ...), `status`: `works`, `partial`, `planned`, `no` |
| `hotkeys` | `rows[]` with `keys`, `action` | Up to 20 rows, `keys` like `Ctrl+F5` (24), `action` 80 |
| `changelog` | `count` (1 to 3) | Pulls the notes of the newest versions; without notes the block is dropped |
| `faq` | `items[]` with `q`, `a` | Up to 12, question 120, answer 600 |
| `cta` | `text`, `buttons[]` with `kind`, `label`, `url`, `style` | Up to 3 buttons, label 30. `install` starts the install, `companion` opens the mod's companion link (see [Related links](/dev/docs/related-links/)) or the button's own `url`, `link` needs a `url`. |

In total at most **30 blocks** and 60,000 characters.

## Pictures and videos

- Pictures: https, ending in `.png`, `.jpg`, `.jpeg`, `.webp` or `.gif`, no query string, no credentials. Allowed hosts: the hub's storage (upload in the portal or pick from the project pictures), `raw.githubusercontent.com`, GitHub release assets (`github.com/<owner>/<repo>/releases/download/...`) and `i.imgur.com`.
- Recommended: at most 5 MB and 3840 pixels on the long edge. The hub checks pictures from other hosts with a HEAD request. Anything that is not a picture or is over 5 MB is left out.
- Videos: `youtube.com/watch?v=`, `youtu.be/`, `youtube.com/embed/` (Shorts too), `vimeo.com/<id>`, `streamable.com/<id>`. They are embedded in a privacy-friendly way (`youtube-nocookie.com`, Vimeo with `dnt=1`) and only **after a click**. Nothing is requested from the video site before, not even a thumbnail. If you want a picture there, give a `poster` from the image list.

## Markdown in `text`

Headings (`#` to `####`, shown as subheadings inside the block), paragraphs, lists (`-` and `1.`), `**bold**`, `*italic*`, `` `code` ``, code blocks with three backticks and `[links](https://...)`. Everything else stays plain text: raw HTML, images, tables, quotes. Links that are not https lose the link and keep the text.

## Validation

One function (`validateShowcase` in `packages/shared/src/showcase.ts`) runs in the hub server, in the portal (live while you type) and in the launcher. The portal and `PUT /v1/projects/:slug/showcase` reject a page with errors: HTTP 400 with the list `details.issues`, path and message for each error. When the hub imports from a repository, and in the launcher, the check is lenient: what is wrong is dropped, the rest stays. Unknown fields count as errors, so typos show up.

`packages/shared/showcase.schema.json` is the JSON Schema for editor hints. Examples are in `packages/catalog/showcases/`.
