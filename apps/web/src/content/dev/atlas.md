---
title: "The address atlas"
group: "porting"
order: 5
synced: true
sourceRepo: "cheatoskar/horizon-porting-kit"
sourceBranch: "main"
sourceCommit: "1da9521b34"
sourcePath: "docs/ATLAS.md"
editUrl: "https://github.com/cheatoskar/horizon-porting-kit/edit/main/docs/ATLAS.md"
---
`atlas/atlas.json` is the machine-readable table behind `hz_port.h`: per game build, the engine's class and member names with their offsets, and the functions and globals a mod usually needs, each with address, calling convention, prologue bytes, hook length, confidence and the method that found it. `include/atlas/*.h` and [ATLAS-TABLE.md](https://github.com/cheatoskar/horizon-porting-kit/blob/main/docs/ATLAS-TABLE.md) are generated from it.

Nothing in it is typed in by hand except the inputs in `tools/atlas/seeds.json` (which entries exist, and addresses earlier work already found, each with its source) and `tools/atlas/builds.json` (the known exes).

## Regenerate

```
pip install capstone              (5.x; the only dependency)
copy tools\atlas\exes.example.json tools\atlas\exes.local.json   and point it to local, read-only exe copies
python -I tools/atlas/build_atlas.py      about 5 minutes (similarity search and call graph for Sunrise)
python -I tools/atlas/gen_header.py
build.cmd test
```

Every exe is checked against the SHA-256 in `builds.json` before it is read. The exes are only read, never written. The output contains no local paths or dates, so the same inputs give the same file. Reflection dumps are cached in `tools/atlas/.cache` (git-ignored).

## Builds

| Id | What | How its entries are found |
|---|---|---|
| `tmnf-2.11.26` | TMNF, PE timestamp 4d431494 | `TmForever.map` symbols (public map of this exact build) |
| `tmnf-tmloader-2.12.0` | TMLoader's TmForever product, ASLR | `.text` and `.data` byte-identical to TMNF (checked by the generator) |
| `tmnf-tmloader-2.12.0-compat` | the same without ASLR | same |
| `tmuf-2.11.26` | TMUF, timestamp 4b9e8add | ported from TMNF |
| `eswc-1.80-unofficial` | TMN ESWC 1.80 community build (sha 983bd127) | seeds (ESWC Autosave, TMVS ESWC port, game-control notes) + reflection |
| `eswc-1.80-original-win10` | original 1.80 + Win10 patch (sha 38121332), same timestamp | ported from the unofficial build |
| `sunrise-win10-repack` | TM Sunrise Win10 repack | seeds (race-events notes, kit analysis) + reflection + ported from ESWC (patterns and call graph) |
| `original` | TM Original | missing: no exe analysed |

Identification at runtime is by the SHA-256 of the exe file. The PE timestamp is not enough: both ESWC builds share 5ce7272f, and TMLoader's exe shares TMNF's 4d431494.

## Methods (field `method` per entry and build)

| Method | Meaning | Confidence it gives |
|---|---|---|
| `map-symbol` | name lookup in TmForever.map; calling convention from the mangled name | matched |
| `reflection-method` | entry point from the engine's own member table (`SMwParamInfo`, method flag 2 + 0x2f80/0x3f80) | matched |
| `import-table` | IAT slot from the PE import directory | matched |
| `code-identical` | the build's code section equals another build's | inherits |
| `seed` | address from earlier work, with its source in `source` | matched (or what the seed says) |
| `masked-pattern` | the reference function's first 32-96 bytes with absolute addresses and rel32 operands masked, unique in the target; within one code lineage (TMNF->TMUF, ESWC->ESWC) the hit nearest to the reference address when several match | matched |
| `fn-similarity` | instruction-shape similarity of the first 30 instructions (method of `fnmatch.py`), with score and margin to the runner-up | matched at >= 0.95 with a 0.05 margin, else guessed (>= 0.8) |
| `operand-follow` | a global read out of the same instruction of an already matched function that uses it (atlas functions, relocation slots, raw operand bytes, or instructions aligned through the call graph) | matched if all votes agree or one value has >= 5x the votes of the next |
| `call-graph` | ESWC->Sunrise (and ESWC->ESWC original): starting from anchors (reflection methods paired by class alias and member name, plus seeds in both builds), the direct calls of each paired function are aligned in order; a callee pair needs 2 votes and twice the runner-up. The entry's own function is then read from that pair list (`n votes`) | matched |
| `callee-set+order` | the reference function's mapped callees, looked up among the callers of their counterparts, inside the address range of its paired neighbours (one object file keeps its order) | matched if all mapped callees agree, else guessed |
| `site-follow` | for `offset` entries: the instruction that uses the offset in the reference build (`sites` in seeds.json), aligned in the paired target function by mnemonic and operand shape; the target's displacement is the value | matched if all sites agree |
| `code-pattern` | the class-registry head from its registration code (`mov ecx,[head]; mov [eax+18h],ecx; ... mov [head],eax`) | matched |

When several methods give an address, the strongest one wins (symbol/reflection > seed > pattern > operand-follow > similarity) and the others are listed under `checks` as `agrees` or `differs`. A disagreement between two strong methods makes the entry `guessed`.

**Confidence**: `verified` = a shipped mod used exactly this address in the running game (field `evidence`); `matched` = found statically by an exact method; `guessed` = similarity only or sources disagree, refused by `hz_port.h` unless the mod sets `HZ_ALLOW_GUESSED`; `missing` = not found, or `absent` = the feature does not exist in that game.

**Kinds**: `function`, `global`, `import`, and `offset` - a member offset or vtable byte offset that the reflection does not name (`hz::offset_entry("CTrackMania.PrevReplayRecord")`, -1 when unknown). Reflected members go through `hz::offset("Class", "Member")` instead.

**Not identified vs absent**: an entry `missing` with a note under `checks` was searched for and not found yet; `absent` means the game has no such feature (ManiaCode and replay autosave on the 2006 engine).

Per function the atlas also stores: the first 16 bytes and a mask (`??` = absolute address or rel32, may differ after relocation), `hook_len` (whole leading instructions >= 5 bytes without relative branches; 0 = do not inline-hook), the `ret n` values and the convention.

## Reflection

The engine registers every class with a member table (name, id, field offset, method entry). The generator dumps it statically from each exe (`tools/atlas/reflection.py`); identical tables are merged into sets (`forever` = TMNF + TMUF + TMLoader, `eswc`, `eswc-original`, `sunrise`). Numbers today:

| Set | Classes | Members | Methods with entry point |
|---|---|---|---|
| forever | 623 | 7124 | 756 |
| eswc / eswc-original | 562 | 6102 | 635 |
| sunrise | 522 | 5577 | 562 |

Class names changed between engine generations (ESWC `CConstructionChallenge` = Forever `CGameCtnChallenge`). The generator pairs them by member-name overlap (Jaccard >= 0.3 and 1.5x the runner-up): 62 aliases for ESWC, 48 for Sunrise, recorded with their score. The C headers carry the member tables of the classes listed in `seeds.json` `classes` (and their aliases); every other member comes from the game's live reflection at runtime. `hz::self_check()` compares both in game.

## Findings while building it

- TMLoader's TmForever 2.12.0 is not a different game build: code and data are byte-identical to TMNF 2.11.26, it only adds an export table (1090 ordinals) and has a smaller resource section. That explains the "build key" `4d431494-00a62000` in the 100 TMX Bingo plugin (SizeOfImage 0xa62000 belongs to the TMLoader exe, 0xa2b000 to the plain one) - an open point in tm-modding-knowledge `contradictions.md`.
- `CMwEngineManager::First` on TMUF is 0xd75208 (ported from the map symbol 0xd73ba8). The registry pattern finds another list head on Forever (TMNF 0xd7348c, TMUF 0xd74aec); the Horizon Client's `reflect.cpp` uses 0xd73ba8 on TMNF but 0xd74aec on TMUF, i.e. two different variables. Both may hold the class list; `self_check()` in game tells.
- ESWC original 1.80 + Win10 patch: although it differs in about 5,600 byte runs, every atlas entry found there (37 of 43) sits at the same address as in the unofficial build; only `CFastStringInt::SetString` was not found. The two builds are still kept apart (prologues and unseen functions may differ).
- Sunrise (2026-11-11, all static, none tested in game): 48 of 54 entries matched, 1 guessed, 5 missing. Before the call graph it was 27 of 43 matched, 4 guessed, 12 missing. ESWC->Sunrise byte patterns rarely match because struct offsets inside the code differ; the call graph closes most of that gap: `SetString` (0x41a2a0, 132 votes), `CFastStringInt::Empty` (0x401280, 25 votes), `IsFileExistsAtLocation` (0x44e860), `SaveToFolder` (0x421e60, call graph and similarity agree), `ScanDiskForReplays` (0x821f30, reflection pair), `SetChallenge` (0x81c820) and `RespawnPlayer` (0x7ec270, between `ResetPlayer` and the next paired function), the viewport vtable (0xa31b68, aligned code in the viewport constructor). `GetBestGhostStuntsScore` was guessed at 0x892a60 by similarity; it is 0x7abe10 (same distance to `GetBestGhostRaceTime` as in ESWC, +0xe0). `DialogInGameMenu_OnSaveReplay` is 0x866b30, a three-stub block like ESWC's with other menu result codes (0x25/0x26/0x2d instead of 0x2f/0x30/0x37). `RenderFrameBegin` 0x6c9230 is slot 78 of the Sunrise viewport vtable (ESWC slot 80; `RenderFrameEnd` 0x6ced50 is slot 86 vs ESWC 88), so it counts as matched. Replay offsets moved by 8 to 0x38 bytes (PrevReplayRecord 0x25c -> 0x224, ReplaysFolder 0x210 -> 0x1d8, IsRecording 0xb4 -> 0xac, SavedFid 0xdc -> 0xd4, FidBuffer 0x30 -> 0x28, StopRecording vtable 0xa0 -> 0x90), consistent with the reflected members (replay Challenge 0x60 -> 0x58, app ReplayRecord 0x144 -> 0x130). Guessed: the `CSystemFids` GetFullPath slot 0xac (not seen in use; the slot next to it is unchanged). Missing on Sunrise: `LaunchManiaCodeAction` and `AutoSaveReplays` (absent in the 2006 engine), `DoMenus`, `DialogInGameMenu` and `CMwId::GetName` (not identified; also missing on ESWC).
- The same call graph confirms the ESWC original + Win10 build: `SetString` is 0x413b10 there (missing before), 48 of 54 matched.
- `CGameApp::s_TheGame` (TMNF 0xd68c44) is not the global the Bingo plugin reads (0xd72eb8, which the map calls `CFastAssert::s_GlobalContext_UserData`); both point to the app.
