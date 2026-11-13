---
title: "Porting with a coding agent"
group: "porting"
order: 3
synced: true
sourceRepo: "cheatoskar/horizon-porting-kit"
sourceBranch: "main"
sourceCommit: "1da9521b34"
sourcePath: "docs/AI-PORTING.md"
editUrl: "https://github.com/cheatoskar/horizon-porting-kit/edit/main/docs/AI-PORTING.md"
---
This page is self-contained. It is written for a coding agent (Claude Code, Codex, ...) working in a mod's repository. Follow the rules exactly, in the step order, and stop at the definition of done. Humans: [PORTING.md](/dev/docs/porting/) explains the same with more background.

Goal: one source that builds a 32-bit DLL (or a script) per game and runs on TrackMania Nations/United Forever (TMNF/TMUF, also under TMLoader), TrackMania Nations ESWC and TrackMania Sunrise, inside the Horizon Client. Not a binary converter: you change the source.

## Rules

R1. **Licence first.** Read the LICENSE of the mod folder, else of the repository root (it covers sub-folders unless they say otherwise). Port only if the licence allows modification (MIT, BSD, Apache, GPL, MPL, zlib...). No licence file = all rights reserved: stop and tell the user to ask the author. Never remove copyright lines. A port of somebody else's mod goes back to the author as a pull request, never as a separate release.

R2. **No raw game addresses.** Every hex constant in [0x401000, 0x1000000) used as a pointer, function or global must be replaced by a name:
- functions/globals: `hz::function<Fn>("Class::Method")`, `hz::address("...")`, `hz::global_ptr("...")`, `hz::app()`;
- member offsets: `hz::Field<T>("Class", "Member")` or `hz::offset("Class", "Member")`; offsets the reflection does not name (some members, vtable slots) are atlas entries of kind `offset`: `hz::offset_entry("CGameCtnReplayRecord.SavedFid")`, -1 when unknown.
Names come from `atlas/atlas.json` (`entries[].name`), `docs/ATLAS-TABLE.md`, or the engine reflection (class and member names as Openplanet / the Horizon node explorer show them; the Forever class name or the game's own class name, e.g. `CConstructionGame` on ESWC, both work).
- **Not in the atlas?** Keep the known address in a per-build table, `static const hz::LocalAddress kX[] = {{"eswc-1.80-unofficial", 0x00712340, nullptr}};  // hz-check: allow (local table)` (example address), and use `hz::local_function<Fn>(kX)` / `hz::local_address(kX)` / `hz::local_offset(kX)`. It is still rebased, build-checked and (with a prologue string) byte-checked; on other builds it returns null/-1, so the feature stays off there. List every such entry under "Open points" (step 10) - do not guess addresses for other games.
- **Check each replaced offset**: on the game the mod was written for, the name must resolve to the old constant (`docs/ATLAS-TABLE.md`, `atlas.json` reflection, or log `hz::offset` once). A different value means a wrong name (example: ESWC's "map type" at +0x118 is `PlayMode`, not `Kind`).

R3. **No own hooks.** Remove MinHook/Detours/VirtualProtect patching of game code. Use `hz::hook("Class::Method", detour, &original)`: it checks policy, confidence, prologue bytes and hook length. Never hook Direct3D Present/EndScene/Reset or DirectInput in a Horizon plugin: the host owns them (device callbacks and hotkeys in the plugin API).

R4. **Forever is read-only by default.** On TMNF/TMUF, Competition Patch 2.0 treats changed code or memory as tampering. `hz_port.h` refuses calls, writes and hooks there unless the mod sets `HZ_FOREVER_OPT_IN`, and always while `TMCompPatch.dll` is loaded. Do not set the opt-in unless the original mod already modified the game on Forever, and then say so in the PR. Never touch timing, physics, input or replay data.

R5. **TMX rules** (every game, online or not): no checkpoint or trigger display, no ideal or brake line, nothing that changes physics, timing, input or a run's replay, no disabling of camera or MediaTracker behaviour. Saving a replay file after the fact is fine. A mod that breaks this stays `solo-only` and says so.

R6. **Choose the smallest form** (decide once, write the reason in the PR):
- reads game state and only draws or logs → **Horizon Script** (`info.toml` + `main.as`, AngelScript): no DLL, runs on all four games unchanged. Use when the mod has no native dependency.
- needs native code → **Horizon plugin** (DLL exporting `HorizonPlugin_Info/Init/Shutdown`, `plugin.json`), using `hz_port.h`.
- standalone loader mods (TMLoader product, d3d9/dinput8 proxy) may stay standalone; still use `hz_port.h` for addresses.

R7. **`#if` only for real differences.** Runtime checks first (`Field::exists()`, a null `hz::function`). Compile-time `#if (HZ_TARGET) == HZ_TARGET_FOREVER` only for: a feature that exists in one game family only, different function signatures, and the `games` mask the DLL claims.

R8. **Threads.** `hz::attach` and `hz::hook` on the game's main thread at start-up (plugin: in `HorizonPlugin_Init`). Game state changes: from the game thread only (`DrawOverlay`, `OnEvent`, `run_on_game_thread`). Reads elsewhere are SEH-guarded but may see torn values.

R9. **Do not touch** game installs, exes or user data. Do not start the game. Do not push or publish; prepare a branch and a PR description.

## hz_port.h in 30 lines

```cpp
#define HZ_TARGET HZ_TARGET_FOREVER   // normally /DHZ_TARGET=... from build.cmd: FOREVER, ESWC, SUNRISE, ALL
#include "hz_port.h"

hz::Options o; o.mod = "<id>"; o.log = logFn; o.allow = 0;   // 0 = read-only; HZ_ALLOW_DEFAULT = calls|writes|hooks
if (!hz::attach(o)) return 2;           // unknown/other build: logged, mod stays off (plugin Init returns 2)

void* app = hz::app();                  // game object (CTrackMania / CConstructionGame)
static hz::Field<int> raceTime("CTrackManiaPlayerInfo", "RaceTime");
int t; if (raceTime.get(info, &t)) {}  // offset per game: TMNF 0x2B0, ESWC 0x1F4, Sunrise 0x1C0
if (!raceTime.exists()) {}              // field not on this game
int off = hz::offset("CGameCtnChallenge", "ChallengeName");   // Forever class names, translated per game
wchar_t name[128]; hz::read_wstring(challenge, off, name, 128);   // CFastStringInt; read_string for CFastString
void* race = hz::find_pointer_of_kind(app, "CTrackManiaRace");    // unnamed links: search by class
bool solo = hz::is_kind_of(race, "CTrackManiaRace1P");

using QuitFn = void(__fastcall*)(void* race, void* edx);           // thiscall = fastcall + dummy edx
if (auto quit = hz::function<QuitFn>("CTrackManiaRace::ButtonQuitOnClick")) quit(race, nullptr);
static void(__fastcall* origFinish)(void*, void*, void*);
hz::hook("CTrackManiaRace::OnFinishLine", (void*)&MyFinish, (void**)&origFinish);
hz::game();  hz::build()->id;  hz::allowed(HZ_ALLOW_HOOKS);  hz::self_check();
uint32_t n; void* const* players = hz::find_buffer_of_kind(race, "CTrackManiaPlayer", &n);  // {count, items}
int savedFid = hz::offset_entry("CGameCtnReplayRecord.SavedFid");   // unreflected offset from the atlas, -1 if unknown
static const hz::LocalAddress kMine[] = {{"eswc-1.80-unofficial", 0x00712340, nullptr}};  // hz-check: allow (local table)
auto mine = hz::local_function<MineFn>(kMine);   // not in the atlas yet: null on every other build
```

Pattern for mods that call several game functions: resolve everything once in `Init` into a struct of pointers and offsets; if a required one is null, log which one and refuse to load (`return 2`). Do not resolve inside `__try` blocks or per frame.

### Hooks

`hz::hook(name, detour, &original)` installs a 5-byte jump after checking: permission (`HZ_ALLOW_HOOKS`, Forever opt-in, no Competition Patch), confidence (no `guessed` without `HZ_ALLOW_GUESSED`), the prologue bytes, and that the first instructions can be moved (`hook_len`). The detour has the game's convention (thiscall → `__fastcall` with dummy `edx`) and calls `original`. `hz::unhook(name)` restores the bytes. Never hook a function another mod may already hook without saying so in the PR.

Calling convention and argument bytes per build: `hz::entry(name)->conv`, `->ret_bytes` (`ret 8` on Forever vs `ret 4` on ESWC for `OnFinishLine`: the signatures differ - declare per target with `#if`).

## plugin.json

```json
{"id": "my-mod", "name": "My Mod", "version": "1.0.0", "dll": "my-mod.dll",
 "games": ["eswc", "sunrise", "tmnf", "tmuf"], "online": "solo-only", "abi": 1,
 "description": "One short sentence.", "author": "<original author>"}
```

`id` lowercase `[a-z0-9-]`, equal to the DLL's `HorizonPluginInfo.id`. `games`: only games the build really supports. `online`: `solo-only` unless the mod is harmless online (R5). `abi`: 1. Optional `icon` (PNG next to the json), `enabled_by_default`. Keep this `plugin.json` in the mod's folder in git (horizon-check looks for it there); the build writes a copy per target into `dist\<target>\` with only that target's games.

Plugins that draw a menu or overlay use Dear ImGui **1.91.5** with the default `imconfig.h` (the host's version) and `horizon_imgui.h` from the host; vendor both. Read-only plugins without UI need neither.

### Exports

`extern "C" __declspec(dllexport)` with `__cdecl` (`HORIZON_EXPORT ... HORIZON_CALL` from `horizon_plugin.h`), undecorated names: `HorizonPlugin_Info`, `HorizonPlugin_Init`, `HorizonPlugin_Shutdown`; optional `HorizonPlugin_DrawMenu`, `_DrawOverlay`, `_OnEvent`, `_SetEnabled` with the matching `HORIZON_CAP_*`. Vendor `horizon_plugin.h` (MIT) from the Horizon Client.

## info.toml (Horizon Script)

```toml
name = "My Mod"
author = "<original author>"
version = "1.0.0"
games = ["all"]
online = "solo-only"
permissions = ["ui", "read-game"]
```

Permissions: `ui` (Render/UI::), `settings` ([Setting]), `read-game` (Game::GetState/CurrentMap, Reflection::, events), `game-control` (PlayMapFile/ReturnToMenu; never with Competition Patch). Values are strings or string lists only.

## Steps

1. Check R1. Write down licence, author, and what the mod does (one paragraph).
2. Inventory: list every raw address, offset, hook and patch in the source. `python -I <kit>/tools/horizon-check/horizon_check.py --repo .` lists most addresses with the atlas name when there is one, but it is a text heuristic: small struct offsets (`o.race = 0x454`, `p + 0x2B0`) and addresses built at runtime are not all found. Read the game-facing code yourself.
3. Decide the form (R6).
4. Add the kit as a submodule at `third_party/horizon-porting-kit` (or copy `include/`), include path `third_party/horizon-porting-kit/include`.
5. Replace addresses (R2), hooks (R3), add `hz::attach` with the right `allow` (R4). Keep behaviour identical on the original game.
6. Per-game builds (see below).
7. Build all targets. Fix warnings.
8. Run `horizon_check.py --repo . --dist dist/forever --dist dist/eswc --dist dist/sunrise` until it reports 0 errors. Every remaining warning gets a reason in the PR.
9. Optional CI: add the caller workflow from the kit's `docs/AUTOMATION.md`.
10. Write the PR description: form chosen and why, per game what works / what is off and why, list of names used, open points (every `LocalAddress` entry and every address you could not name, with what it does), and "not tested in game" unless the user tested it.

## Per-game builds

`build.cmd <forever|eswc|sunrise|all>` → `/DHZ_TARGET=HZ_TARGET_<X>`, x86 (`vcvarsamd64_x86.bat`, `/MACHINE:X86`), output `dist\<target>\<id>.dll` + `plugin.json`. Use `cl` from PATH when it is there (CI), else find vcvars with vswhere. Template: the kit's `examples/race-reader/build.cmd`. The DLL's `HorizonPluginInfo.games` must match the target (`#if (HZ_TARGET) == HZ_TARGET_ESWC ...` or a `/D` define from the build script). A target where a required function is missing still builds; the DLL refuses to load there with a log line naming what is missing - say so in the PR instead of dropping the target silently.

## Definition of done

- [ ] Licence allows the port (R1); author credited unchanged.
- [ ] `horizon_check.py` exit code 0 (no errors), warnings explained.
- [ ] No raw game address left outside `// hz-check: allow` lines with a reason.
- [ ] Every replaced offset resolves to the old constant on the original game; every `LocalAddress` entry is listed as an open point.
- [ ] `hz::attach` result checked; the mod does nothing on unknown builds.
- [ ] Builds for every target in `plugin.json` `games`; each DLL is x86 and exports the three required functions.
- [ ] Forever: read-only unless the original modified the game there (then `HZ_FOREVER_OPT_IN`, stated in the PR).
- [ ] TMX rules (R5) hold; `online` flag matches.
- [ ] PR text written; nothing pushed or released without the user.

## Prompt to give your agent

```
Read https://raw.githubusercontent.com/OWNER/horizon-porting-kit/main/docs/AI-PORTING.md and follow it
exactly to make this repository Horizon-compatible (TMNF/TMUF, TM Nations ESWC, TM Sunrise from one
source). Start with rule R1 (licence) and stop if it does not allow modification. Add the kit as a git
submodule at third_party/horizon-porting-kit. Do not touch game folders, do not start the game, do not
push. At the end show me the horizon-check output and the PR description from step 10.
```
