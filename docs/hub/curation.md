# Curating the discovered GitHub repositories

The daily GitHub search (docs/hub/discover-github.md) leaves a long list of waiting repositories. Curation sorts the
waiting ones ("new") into three buckets, with a reason code and a one-line reason each
(`apps/server/src/services/discover-curate.ts`, a pure `classify` over stored metadata plus a few facts from GitHub).

| Bucket | What happens | Codes |
|---|---|---|
| reject | hidden, the code is in the note (`curate:<code>: <reason>`); reversible with "Back to the list", never deleted | `duplicate-listed`, `duplicate`, `fork-no-own-work`, `template-test`, `near-empty`, `archived-no-content`, `not-trackmania`, `manual` |
| approve | accepted as an unclaimed link-only entry (text and link, no pictures from others; authors can claim or remove it) | `approve`, `approve-openplanet` |
| pending | stays waiting, the one-line reason is the note | `review`, `unchecked` |

Approve needs: a README (100+ characters) or a description, not a fork, and a push in the last 3 years, or 3+ stars, or
a release. Openplanet plugins become type "Openplanet plugin" for TM2020 (ManiaPlanet or Turbo when the text says so),
the main link is the plugin's openplanet.dev page when that list names the repository, else the repository;
installation stays with Openplanet's plugin manager. Forks only count as rejects when they have no stars and no
release; a fork with more is left pending (own commits against the parent are not compared).

Facts (README size, TrackMania mentions, any release) come from the GitHub API once and are cached in the database
(kv `curate:facts`, 3 days; the openplanet.dev list in `curate:oppages`).

## Running it

```sh
# dry run: numbers per bucket and 15 examples each, changes nothing (on the box, as the hub user)
node scripts/curate-discovered.ts --examples 15
node scripts/curate-discovered.ts --no-gather            # cached facts only
node scripts/curate-discovered.ts --apply                # reject + approve (pending only gets a note)
node scripts/curate-discovered.ts --apply reject,approve,pending
```

In the portal (Admin > Discovered > Waiting) the "Curation" box lists the same buckets, filterable by bucket, reason code
and text, with "Approve all in this filter" and "Reject all in this filter" (`POST /v1/admin/discovered/bulk`,
`GET /v1/admin/discovered-curation`). Tests: `apps/server/test/discover-curate.test.ts`.
