# GitHub discovery (crawler and moderation)

The hub can look for TrackMania projects on GitHub that nobody told it about, including those with 0 stars,
and offer them to the admins. Code: `apps/server/src/services/discover-github.ts` (search and filters),
`apps/server/src/routes/discover.ts` (admin and public API), `apps/portal/src/pages/AdminDiscovered.tsx` (list).
Tests with a mocked GitHub: `apps/server/test/discover-github.test.ts`.

## Turn it on

Off by default. On the hub: `DISCOVER_GITHUB=1` (`/etc/tm-hub/hub.env`). It runs once a day from the hub's job loop.
`GITHUB_TOKEN` is used when set (30 search requests a minute instead of 10, and 5000 other requests an hour instead of 60);
without it the run still works, only slower and with fewer README checks. Admin > Discovered > **Search now** starts a run by hand
(2 per 10 minutes).

A run that ended on a GitHub limit is repeated after an hour, not after a day.

## What it searches

| Kind | Queries |
|---|---|
| Topics | `topic:` trackmania, trackmania2020, trackmania-2020, tmnf, tmuf, tmforever, trackmania-forever, trackmania-nations, trackmania-united, trackmania-nations-forever, trackmania-united-forever, trackmania-turbo, trackmania-2, maniaplanet, shootmania, openplanet, tminterface, tmlib, tmloader, trackmania-exchange, nadeo, gbx, tmx |
| Keywords | "trackmania", "TmForever", "Openplanet plugin", "ManiaPlanet", "Nadeo" in name, description or README |
| Language | `language:AngelScript trackmania` (Openplanet plugins) |

Each query reads up to 3 pages of 100 (newest pushed first). GitHub never returns more than 1000 results per query.

## How it stays inside GitHub's limits

- Requests are spaced (2.3 s with a token, 6.5 s without), below the 30 and 10 per minute.
- Every result page keeps its `ETag`; the next day an unchanged page answers `304` and costs nothing.
- `Retry-After` and `x-ratelimit-*` are honoured: the run waits for short limits (up to 2 minutes) and stops cleanly for longer ones.
  `5xx` answers are retried with a growing pause (3 times).
- The whole run is one job; the result of the last run (requests, 304s, new, skipped, stopped early) is shown in the portal.

## What is kept

Every hit gets a score; only clearly TrackMania-related ones are offered:

- Topic that means TrackMania: +4 each (up to 3), a broad topic (gbx, tmx, nadeo): +1.
- TrackMania word in the repository name: +4, in the description: +3, language AngelScript: +3, homepage on a TrackMania site: +2, any star: +1.
- A hit that was only found through the README text scores 1 and is dropped. The limit is 3.

Dropped on top of that (kept in the table as state `skipped`, with the reason, never shown in the list):

- empty repositories, archived and empty ones, disabled ones;
- **forks without releases of their own** (checked with one request; a fork with its own releases is kept);
- repositories **without a README** (checked with one request; with 20 checks per run without a token and 300 with one, the rest is
  marked "README unchecked" in the list and checked in the next runs);
- repositories the hub already has: a project that links the repository, a GitHub source, or a catalog entry (state `known`).

A skipped repository is looked at again when it gets a new push.

## Moderation

Portal > Admin > **Discovered** (admins only). One card per repository: name and link, language, stars, last push, description,
topics (the matching ones highlighted), the games guessed from topics and description (marked "guessed" when nothing pointed anywhere:
then Trackmania 2020 is the default; check it).

| Button | What happens |
|---|---|
| Accept | Creates an **unclaimed, link-only project**: links to the repository, no install, no GitHub source, so the crawler never fetches files. Type is guessed (Openplanet or AngelScript: Openplanet plugin; tminterface: TMInterface plugin; tmlib or gbx: library; else tool). The author name is the GitHub owner. The author can claim it like any catalog project (GitHub login as repository admin). |
| Hide | Out of the waiting list for now; "Back to the list" restores it. |
| Ignore | Never offered again, also not by later runs. Restorable under Ignored. |
| Accept all with a matching topic | Accepts every waiting repository that has at least one TrackMania topic. Asks for confirmation first. Needs a person to have skimmed the list: the topic is a good sign, not a guarantee. |

Accepted projects show on the website's page **All TrackMania projects on GitHub** (`/discover/github/`, linked from the open-source
section of the home page) with filters for game, language and last update. The page is built from `GET /v1/github-projects`
(public, accepted repositories only; `game`, `language`, `q`, `page`, `limit`) plus the repositories of the catalog.
The website build reads it from the hub named in `HUB_URL` (`npm run data -w @tm-hub/web` runs `scripts/build-github-projects.mjs`);
without `HUB_URL` the page shows the catalog's repositories only.

A taken-down project (Admin > remove) stays out of the page.

## What is stored

Table `discovered`: the public metadata GitHub returns for a repository (full name, owner login, name, description, topics,
language, stars, forks, licence, last push, whether it is a fork or archived) plus the hub's own state, score and the admin who decided.
No README text, no e-mail addresses, no contributor lists. The owner login is part of the repository address and is the same
public name the hub already shows for unclaimed projects from other public sources; the privacy policy names GitHub among the
sources of unclaimed projects ("Nicht übernommene Projekte aus öffentlichen Quellen"), so it needed no change. The owner can ask
for removal like for every unclaimed project (Ignore, or Admin > remove project).
