---
title: "Port a mod to ESWC, Sunrise and the other games"
group: "tutorials"
order: 4
synced: false
note: "There is no automatic converter. This page says what exists and what does not."
---

Trackmania Nations Forever and United Forever, Trackmania Nations ESWC, TrackMania Sunrise and TrackMania Original are four different executables. A native mod (a DLL with addresses of the game's functions) written for one of them does not run on the others, and no tool converts a DLL. TM Horizon does not have a "convert" button, and nothing in the launcher pretends to.

What exists is two ways to write **one source for several games**, and a kit and an AI prompt that help you move an existing mod onto them. This page helps you pick.

## 1. Pick the way

| Your mod | Way | Games |
|---|---|---|
| only reads game state and shows something (timers, map info, input display, logger) | **Horizon script** (AngelScript, no DLL) | ESWC, Sunrise, TMNF, TMUF with the same folder. Original is not supported by scripts yet. |
| needs native code (own threads, files, network) but does not call into the game | Horizon plugin with the porting kit, read-only | one source, one DLL per game |
| calls or hooks game functions | Horizon plugin with the porting kit | calls and hooks work on ESWC and Sunrise. On TMNF/TMUF only with an explicit opt-in, and never together with Competition Patch |
| only replaces files (skins, textures, sounds, shaders loaded from disk) | no code to port | check the file formats per game, ESWC and Sunrise use older GBX versions and other folders |
| TAS tools, input injectors, physics | not portable as a Horizon mod | |

More detail per kind of mod: [What ports how easily](/dev/docs/assessment/).

## 2. If you can, make it a script

Scripts see the game only through the API and the engine's own member names, never an address. That is why one script folder runs unchanged on four games. Rewriting a small mod as a script is often faster than porting a DLL.

- Start with [Your first Horizon script](/dev/docs/tutorial-first-script/).
- Set `games = ["eswc", "sunrise", "tmnf", "tmuf"]` in `info.toml` (or leave `games` out: the default is all four).
- Test it in each game. A callback that a game never fires is simply never called, for example `OnRespawn` only exists on ESWC. Do not depend on a rare event for the main job. The guide has a section "Writing for every game".

## 3. If it has to be a DLL: the porting kit

The porting kit is a header (`hz_port.h`) and an address atlas. You replace raw addresses with names, the kit finds the right address for the game that is running, and your CI builds one DLL per game.

1. Add the kit to your repository as a submodule and include `hz_port.h`.
2. Call `hz::attach()` once at start-up.
3. Replace every raw address with a name, for example `hz::function<Fn>("CGameCtnChallengeInfo::RefreshFromDisk")` instead of `((Fn)0x5CF100)`. Replace MinHook or your own detours with `hz::hook(...)`.
4. Keep the code read-only on TMNF/TMUF unless you have a reason to opt in.
5. Build once per game (`build.cmd <target>`) and run `horizon-check`.
6. Test every DLL in a **test copy** of the game. Never test a port in the normal install.

The full steps are in the [Porting guide](/dev/docs/porting/). How the CI builds one DLL per game and attaches them to your release is in [CI builds per game](/dev/docs/automation/). The address atlas and what it does not cover yet is in [The address atlas](/dev/docs/atlas/).

## 4. Let a coding agent do the boring part

For an existing mod with a licence that allows changes, you can give your coding agent (Claude Code, Codex and others) the page [Porting with a coding agent](/dev/docs/ai-porting/). It is written for the agent: licence check first, names instead of addresses, build per game, checker, tests. Copy the page into the agent's context, open your mod's repository, and tell it to port the mod.

What to expect:

- The agent prepares a branch. It does not make the port work by magic: missing entries in the atlas need reverse engineering, and every game needs a test by a human.
- Closed-source mods and mods whose licence forbids changes cannot be ported by anyone but the author.
- Read the diff. Do not release a port as "compatible" with a game you did not test.

## 5. Tell the hub which games work

When the port is released, tick the games in the portal (steps 4 and 5 of [Publish your mod on TM Horizon](/dev/docs/tutorial-publish/)) and say how each game gets its files. With the reusable CI workflow from [CI builds per game](/dev/docs/automation/), the release carries one DLL per game plus a `hz-release.json` that tells the hub which file belongs to which game.

## Next

- [Porting kit](/dev/docs/porting-kit/)
- [What ports how easily](/dev/docs/assessment/)
