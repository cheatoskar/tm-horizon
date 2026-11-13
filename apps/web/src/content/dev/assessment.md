---
title: "What ports how easily"
group: "porting"
order: 6
synced: true
sourceRepo: "cheatoskar/horizon-porting-kit"
sourceBranch: "main"
sourceCommit: "1da9521b34"
sourcePath: "docs/ASSESSMENT.md"
editUrl: "https://github.com/cheatoskar/horizon-porting-kit/edit/main/docs/ASSESSMENT.md"
---
Short answer: mods that only touch files or Direct3D port almost for free; mods that read game state port well with names; mods that hook deep into the engine port function by function, and only as far as the atlas reaches on the older games. An "auto-port from GitHub" in the hub can build kit-based mods automatically; for everything else it can only prepare a pull request for the author.

## Kinds of mods

| Kind | Examples | Effort | What decides it |
|---|---|---|---|
| Asset / file mods | skins, texture and sound packs, mod packs, maps, replays, locator files | none for code; per-game file check | ESWC/Sunrise use the 2006 GBX versions and other folder layouts (`GameData\` next to the exe instead of `Documents\TrackMania`); Forever-only chunks or resources (e.g. newer map/mod-pack formats) do not load on the old games. A converter per format, not the kit. |
| Direct3D-only | post effects, shaders through a d3d9 proxy, overlays that draw on Present, FPS tools, screenshot tools | low | The D3D9 interface is the same on all four games. Ports need: no engine addresses (or a few through the kit), a d3d9 proxy that also loads on the old exes, and on Horizon the host's device callbacks instead of an own Present hook. Engine-aware effects (sky, lighting, cameras) fall into the next rows. |
| Reads game state | timers, split displays, map info, input displays, loggers, Discord status, the Bingo plugin's reading | low to medium | Everything the engine reflects by name works on every game through `hz::Field` or, simpler, as a Horizon Script. Links the reflection does not name need `find_pointer_of_kind` or a per-game note. Example: [examples/race-reader](https://github.com/cheatoskar/horizon-porting-kit/blob/main/examples/race-reader/README.md), one file of about 170 lines replacing the TMNF-only reading. |
| Calls game functions | play a map, leave a race, save a replay, rescan folders | medium | Needs the function in the atlas for every target game, with a matching signature. On Forever only with `HZ_FOREVER_OPT_IN`, never with Competition Patch. |
| Hooks engine internals | race events, renderer hooks (TMVS), camera, media tracker, physics probes | high, per function | Every hooked function must exist and be identified on the old game; signatures and struct layouts differ (ESWC `OnFinishLine` takes one argument less than Forever's). On Forever, hooks collide with Competition Patch 2.0 by design. Expect a feature subset per game. |
| Physics, timing, input, replay rewriting | TAS tools, validators, input injectors | not portable as a Horizon mod | TMX rules and Competition Patch forbid them in normal play; they belong in separate, clearly marked tools. |

Rule of thumb from building the atlas: on Sunrise 48 of 54 entries are matched (statically; none tested in game), 5 are missing, 2 of them because the 2006 engine has no such feature; ESWC is close to Forever for everything the earlier ESWC mods needed; TM Original has nothing yet. A mod that depends on one missing function stays off on that game until the address is found, it does not crash.

## What an "auto-port from GitHub" service in the hub can realistically do

| Case | Realistic | How |
|---|---|---|
| Mod already uses `hz_port.h` and has `build.cmd <target>` | **yes, fully automatic** | The reusable workflow builds one x86 DLL per target on every release and attaches them with `hz-release.json`; the hub reads that file and offers the right DLL per game, checking SHA-256. The author opted in by adding the workflow. See [AUTOMATION.md](/dev/docs/automation/). |
| Mod uses `hz_port.h` but the hub needs a newer atlas (new game build) | yes, with the author | The hub can show "a rebuild with kit vX supports this game" and open an issue or a PR that bumps the submodule; the author's CI releases it. |
| Open-source mod without the kit, licence allows modification | **assisted, not automatic** | An agent run with [AI-PORTING.md](/dev/docs/ai-porting/) prepares a branch: names instead of addresses, per-game builds, horizon-check clean, a list of what works per game. The result is a **pull request to the author**. A human must test it in game. The hub may list the PR ("port in review"), not a build of it. |
| No licence, or a licence that forbids modification | **no** | All rights reserved: the hub can only show "ask the author". No builds, no forks, no mirrors. |
| Closed-source / binary-only mods | **no** | No binary rewriting. The hub can still list them for the game they were made for. |

What the service must never do: rebuild or republish someone else's mod under the hub's name, strip or change licences and credits, ship a port nobody tested in game as "compatible", or enable Forever writes/hooks on its own.

Where the cost sits: the agent run is cheap (minutes of agent time per small mod); the bottlenecks are the in-game test per game (a human with test copies, about 15 minutes per game and mod) and missing atlas entries, which need RE time on the exe (an hour or more per function on Sunrise when byte patterns fail). Prioritise addresses that several mods ask for (the "request an address" issues give that list).
