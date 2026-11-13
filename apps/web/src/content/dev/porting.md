---
title: "Porting guide"
group: "porting"
order: 2
synced: true
sourceRepo: "cheatoskar/horizon-porting-kit"
sourceBranch: "main"
sourceCommit: "1da9521b34"
sourcePath: "docs/PORTING.md"
editUrl: "https://github.com/cheatoskar/horizon-porting-kit/edit/main/docs/PORTING.md"
---
This guide takes a native TMNF/TMUF mod (a DLL with hard-coded addresses) to a source that builds for every game the kit knows. The kit does not convert binaries: the mod's source changes, once, from raw addresses to names.

Coding agent? Read [AI-PORTING.md](/dev/docs/ai-porting/) instead: same content as rules and a step order.

## 0. Pick the right way first

| The mod... | Best way | Why |
|---|---|---|
| only reads game state and draws or logs something | **Horizon Script** (AngelScript, `info.toml`), no DLL at all | Scripts see the engine by member name and run unchanged on all four games. See Horizon Client `docs/scripting.md`. |
| needs native code but no game hooks (reads, own window, files, network) | Horizon plugin + `hz_port.h`, read-only | One source, per-game DLLs, allowed on Forever with Competition Patch. |
| hooks or calls game functions | Horizon plugin + `hz_port.h` with `hz::hook` / `hz::function` | Hooks and calls run on ESWC/Sunrise; on TMNF/TMUF only with an explicit opt-in and never with Competition Patch 2.0. |
| only replaces files (textures, sounds, mod packs, shaders loaded from disk) | no port needed for the code; check the file formats per game | See [ASSESSMENT.md](/dev/docs/assessment/). |
| wraps Direct3D (d3d9 proxy, post effects) | keep the proxy, or use the host's device callbacks | The D3D9 side is the same on all games; only engine addresses next to it need the kit. |

## 1. Add the kit

```
git submodule add https://github.com/OWNER/horizon-porting-kit third_party/horizon-porting-kit
```

Compiler include path: `third_party/horizon-porting-kit/include`. x86 only, C++17, MSVC (`vcvarsamd64_x86.bat`). The header links `bcrypt.lib` itself (SHA-256 of the exe).

## 2. Attach once

```cpp
#include "hz_port.h"

hz::Options o;
o.mod = "my-mod";            // prefix of every kit log line
o.log = myLogFunction;       // void(const char*); Horizon plugin: forward to host->log
o.allow = 0;                 // read-only; HZ_ALLOW_DEFAULT = calls + writes + hooks (legacy games)
if (!hz::attach(o)) return;  // unknown build: the kit already logged which exe and why
```

`attach()` hashes the running exe file (about 50 ms), so call it once at start-up on the game thread, not every frame. Under TMLoader 2.12.0 the exe loads at a random base; the kit rebases every address, nothing to do in the mod.

## 3. Replace raw addresses

| Before (TMNF only) | After (every game) |
|---|---|
| `*(void**)(base + 0x972EB8)` (app global) | `hz::app()` or `hz::global_ptr("CGameApp::s_TheGame")` |
| `*(int*)(info + 0x2B0)` | `static hz::Field<int> raceTime("CTrackManiaPlayerInfo", "RaceTime");` then `raceTime.get(info, &t)` |
| `*(void**)(app + 0x198)` | `hz::Field<void*>("CGameCtnApp", "Challenge")` |
| `vt[0xa0 / 4]`, an unreflected member | `hz::offset_entry("CGameCtnReplayRecord.vt.StopRecording")` (atlas kind `offset`, -1 if unknown) |
| `((Fn)0x5CF100)(...)` | `auto f = hz::function<Fn>("CGameCtnChallengeInfo::RefreshFromDisk"); if (f) f(...);` |
| MinHook / own detour on `0x480820` | `hz::hook("CTrackManiaRace::OnFinishLine", &MyDetour, (void**)&g_orig)` |
| an address the atlas does not have (yet) | `static const hz::LocalAddress kX[] = {{"eswc-1.80-unofficial", 0x712340, nullptr}};` (example address) then `hz::local_function<Fn>(kX)`: rebased and build-checked, null on every other build; ask for an atlas entry (step 7) |
| `if (timestamp == 0x4d431494)` | `hz::game() == hz::GameTmnf`, or better: test the feature (`field.exists()`, `hz::address(...) != 0`) |

Names:

- **Functions and globals** use the atlas names: `atlas/atlas.json` → `entries[].name` (a table is in [ATLAS.md](/dev/docs/atlas/)). Missing one? See step 7.
- **Members** use the engine's reflection names (the same names Openplanet and the Horizon node explorer show). Class names are the Forever ones; the kit translates them (ESWC/Sunrise call the map `CConstructionChallenge` and the app `CConstructionGame`). `hz::offset(cls, member)` returns -1 when the game has no such field.
- **Links the reflection does not name** (e.g. the current race on Forever, app+0x454): `hz::find_pointer_of_kind(app, "CTrackManiaRace")` finds the field by the class of what it points to. This costs a scan, so cache the result per map.
- **Check every replaced offset** against the old constant on the original game (the atlas table or one log line). A different value means a wrong name: ESWC's map type at +0x118 is `PlayMode`, not `Kind`.
- **thiscall** functions: declare the pointer as `__fastcall` with a dummy `edx`: `void(__fastcall*)(void* self, void* edx, void* player)`. The atlas records the convention and the `ret n` per build (`hz::entry(name)->conv`, `->ret_bytes`); the argument lists can differ between games (Forever's `OnFinishLine` has one more argument than ESWC's: `ret 8` vs `ret 4`).

## 4. `#if` only where the games really differ

Most differences are runtime facts (a field missing, a function missing) and are handled with `exists()` / null checks. Use `#if (HZ_TARGET) == HZ_TARGET_FOREVER` only for:

- a feature that exists on one game family only (ManiaCode, Forever's own replay autosave, ESWC's game allocator),
- different function signatures you must declare at compile time,
- what the DLL claims in `HorizonPluginInfo.games` (each per-game DLL claims its own games).

## 5. Build per game

`build.cmd <target>` with `/DHZ_TARGET=HZ_TARGET_FOREVER|ESWC|SUNRISE|ALL`, output `dist\<target>\<id>.dll` plus `plugin.json`. The example `examples/race-reader/build.cmd` is a template. A per-game DLL carries only its game's tables and refuses other games with a clear line ("this DLL was built for 'eswc' only: install the 'forever' build"). CI: [AUTOMATION.md](/dev/docs/automation/).

Then run the checker:

```
python -I third_party/horizon-porting-kit/tools/horizon-check/horizon_check.py --repo . --dist dist/forever --dist dist/eswc --dist dist/sunrise
```

## 6. Test

1. Unit tests in the mod for anything that does not need the game.
2. Install the per-game DLL into a **test copy**, never into the normal install: Horizon test copies are `C:\Users\<you>\Games\TMN-ESWC-horizon-test`, `TMSunrise-horizon-test`, TMNF/TMUF through a TMLoader profile. Plugin folder: `<game>\horizon\plugins\<id>\` with the DLL and `plugin.json`.
3. Start the game once, play one map to the finish, leave to the menu.
4. Read the host log (`<game>\horizon\logs\<start>.log`): the kit's first line names the build (`hz_port[my-mod]: TrackMania Nations ESWC unofficial 1.80 (eswc-1.80-unofficial), base 0x00400000, policy: ...`). Every missing address or field is logged once.
5. Once per game build: call `hz::self_check()` in a debug build. It compares the atlas member table with the game's live reflection and checks every function prologue, and logs the count of differences. Send me that log line if it is not 0.

## Checklist: what older games do not have

| Feature | TMNF/TMUF | ESWC 1.80 | Sunrise | Notes |
|---|---|---|---|---|
| Menu fibers (`DoMenus`, `DialogInGameMenu`) | yes | not identified | not identified | hook the menu result handlers instead (`DialogInGameMenu_OnSaveReplay` is in the atlas for both) |
| ManiaCode (`LaunchManiaCodeAction`), ManiaLinks | yes | no | no | |
| Own replay autosave (`CGameCtnNetwork::AutoSaveReplays`) | yes | no | no | ESWC Autosave adds it on ESWC |
| Map UIDs through `CMwId::GetName` | yes | not identified | not identified | read the map file header instead (GBX) |
| Race event functions | all | all | all (`RespawnPlayer` found statically 2026-11-11, untested) | |
| `OffsetFromBestAtCurrentCP`, `CurrentRaceRank` fields | yes | Offset yes, Rank yes | neither | `Field::exists()` |
| `CTrackMania.Races` / `CConstructionGame.CurrentRace` | not reflected (app+0x454) | yes | yes | use `find_pointer_of_kind` |
| Viewport vtable / RenderFrameBegin | yes | yes | yes (statically; Begin is slot 78, ESWC 80) | hook through the vtable slot the atlas gives, not a fixed index |
| Input: Competition Patch owns it | yes (CP 2.0) | - | - | never hook input on Forever |
| Relocated image | TMLoader 2.12.0 | no | no | handled by the kit |
| Game allocator needed for game buffers | no | yes (`game_malloc`) | yes | |

Missing in the atlas does not always mean missing in the game: it can mean "not found yet". The atlas says which (`absent` text vs. a "not identified" note under `checks`).

## 7. Request a missing build or address

The kit refuses unknown builds on purpose. To add one:

1. Copy the line the kit logged (it has the exe name, SHA-256, PE timestamp and image size).
2. Open an issue in the kit repo titled `build: <game> <version>` with that line and where the exe comes from (download page or installer name). Do not attach the exe.
3. For a missing function: issue `address: <Class::Method> on <build>` with what it does, where it is called from on a game where it exists (atlas name), and if you have it, the address on any build and how you found it. Ghidra project files and decompiled code stay private.

With the exe on my machine I add it to `tools/atlas/builds.json` / `seeds.json`, run `build_atlas.py` and `gen_header.py`, and release a new kit version. Mods then rebuild (CI does it on the next release).
