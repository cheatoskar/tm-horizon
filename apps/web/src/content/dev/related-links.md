---
title: "Related links"
group: "publish"
order: 3
synced: true
sourceRepo: "cheatoskar/tm-horizon"
sourceBranch: "integration-1111"
sourceCommit: "78d69f7164"
sourcePath: "docs/hub/related-links.md"
editUrl: "https://github.com/cheatoskar/tm-horizon/edit/integration-1111/docs/hub/related-links.md"
---
A mod can list pages that belong to it: a companion page (a bingo board, a settings page), docs, Discord, source, website.
The launcher shows them on the mod page in a section "Related" above the screenshots (companion first, as a big button).
On the game page, an installed mod with a companion link gets a button "Open <label>" (for example "Open Bingo-Board").
A page on a site the launcher's embedded browser lists (see `apps/launcher/src/data/sites.ts`) opens there, every other page in the system browser.

## Format

```json
"links": [
  { "kind": "companion", "label": "Bingo-Board", "url": "https://100tmx.com/events/bingo" },
  { "kind": "docs", "label": "Settings", "url": "https://github.com/owner/repo/blob/main/docs/settings.md" }
]
```

- `kind`: `companion`, `docs`, `discord`, `source` or `website`. Anything else is dropped.
- `label`: the button text, 1 to 40 characters.
- `url`: https only, no user name or password, at most 500 characters.
- At most 8 links, no duplicate URLs, sorted companion first.
- The old fields (`homepage`, `source`, `url`, `urls`) keep working next to it.

The rules live in `packages/shared/src/links.ts` (`cleanRelatedLinks`); the catalog build, the hub server and the launcher use that one file.

## Where it is read from

| Source | Where |
|---|---|
| Catalog entry | `links` on the entry in `packages/catalog/catalog.json` |
| TMLoader product without own catalog entry | `modLinks: [{ "mod": "<product name or catalog id>", "links": [...] }]` in `catalog.json`; source: `MOD_LINKS` in `packages/catalog/mods_seed.py` (`build_catalog.py` writes it) |
| Hub project (portal) | `links.related` of the project (the project's `links` object is stored as JSON, so no database migration), editable in the dev portal under "Links and licence" |
| Auto import from GitHub | `links` in a `plugin.json` in the repository root (default branch) |
| Auto import from a TMLoader server | `links` on the product in the server's `index.json` |

Invalid entries are dropped silently when imported; the portal form and the API (`PATCH /v1/projects/:slug`) answer 400 for them.
