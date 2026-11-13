---
title: "Porting kit"
group: "porting"
order: 1
synced: true
sourceRepo: "cheatoskar/horizon-porting-kit"
sourceBranch: "main"
sourceCommit: "1da9521b34"
sourcePath: "README.md"
editUrl: "https://github.com/cheatoskar/horizon-porting-kit/edit/main/README.md"
---
One native TrackMania mod source for TrackMania Nations/United Forever (also TMLoader's relocated TmForever), TrackMania Nations ESWC and TrackMania Sunrise. TM Original follows once its exe is analysed.

Not a binary converter: a mod's source replaces hard-coded addresses with names once, and the kit resolves them per game at runtime.

- `include/hz_port.h`: header-only C++17 library (32-bit MSVC). Detects the running exe by SHA-256, rebases, resolves functions/globals by name, checks prologue bytes before any call or hook, gives typed access to engine members by name, refuses unknown builds with one clear log line. TMNF/TMUF are read-only by default (Competition Patch 2.0).
- `atlas/atlas.json` + `include/atlas/*.h`: the generated address atlas, 8 builds, 43 functions/globals, full engine reflection (623 / 562 / 522 classes). Method and confidence per entry. See [docs/ATLAS.md](/dev/docs/atlas/), [docs/ATLAS-TABLE.md](https://github.com/cheatoskar/horizon-porting-kit/blob/main/docs/ATLAS-TABLE.md).
- `tools/atlas/`: the generator (Python + capstone), reproducible from the game exes.
- `tools/horizon-check/`: offline checker for mod repos, CI exit codes.
- `.github/workflows/hz-build.yml`: reusable workflow, one DLL per game on every release ([docs/AUTOMATION.md](/dev/docs/automation/)).
- `examples/race-reader/`: the game reading of the 100 TMX Bingo plugin (TMNF only, raw offsets) as one Horizon plugin for every game.
- `examples/eswc-autosave-port/`: my ESWC Autosave plugin as one source for ESWC and Sunrise, every address from the atlas (Sunrise untested in game).

## Quick start

```cpp
#include "hz_port.h"                          // build with /DHZ_TARGET=HZ_TARGET_FOREVER (or ESWC, SUNRISE, ALL)

hz::Options o; o.mod = "my-mod"; o.log = myLog; o.allow = 0;   // read-only
if (!hz::attach(o)) return;                  // unknown build: logged, mod stays off
static hz::Field<int> raceTime("CTrackManiaPlayerInfo", "RaceTime");
int t; raceTime.get(playerInfo, &t);         // TMNF +0x2B0, ESWC +0x1F4, Sunrise +0x1C0
```

Guides: [docs/PORTING.md](/dev/docs/porting/) (people), [docs/AI-PORTING.md](/dev/docs/ai-porting/) (coding agents, with a copy-paste prompt), [docs/ASSESSMENT.md](/dev/docs/assessment/) (what ports how easily). Index for tools: [llms.txt](https://github.com/cheatoskar/horizon-porting-kit/blob/main/llms.txt).

## Build and test

```
build.cmd test        unit tests with fake game modules (no game needed)
build.cmd example     Race Reader for forever, eswc, sunrise
examples/eswc-autosave-port/build.cmd eswc|sunrise   (needs HORIZON_HOST for ImGui)
python -I -m unittest discover -s tools/atlas -p "test_*.py"
python -I -m unittest discover -s tools/horizon-check -p "test_*.py"
python -I tools/atlas/gen_header.py --check
```

## Status

Built and unit-tested; **not tested in game yet**. The atlas marks what a shipped mod already used in game (`verified`) apart from what was found statically (`matched`) or only by similarity (`guessed`, refused by default).

## Licence

MIT. The atlas holds addresses and names derived from the game executables (facts needed for interoperability), no game code. Exes, symbol maps and decompiled code are not part of this repo. Porting someone else's mod: only if its licence allows modification; no licence means ask the author ([docs/AUTOMATION.md](/dev/docs/automation/#licence-rule)).
