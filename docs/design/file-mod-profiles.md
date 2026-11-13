# Profile-scoped file mods (design, not built)

TMLoader mods are per profile already: TMLoader loads only the ticked DLLs. File mods are
different: textures, sounds or blocks are files in `GameData\` or `Documents\TrackMania\`, and once
copied they apply to every start. This note describes how TM Horizon could switch file mods per
profile without touching the originals for good, and why I have not built it yet.

## Goal

- A file mod is ticked in a profile like a TMLoader mod.
- Starting the profile applies exactly its file mods; after the game exits the folder is as before.
- The originals are never lost, also when the PC crashes during a game.

## Options

1. **Swap on start, restore on exit.** Before the start, copy the mod's files over the originals
   (originals into a journal folder), start the game, wait for its process to end, restore.
   - Simple, works with every game version.
   - Risk: a crash or power loss leaves the files swapped. Needs a journal
     (`<data>/file-mod-journal.json`: root, files, backup paths, state) that is replayed on the
     next start of TM Horizon before anything else, and a "Restore game files" button.
   - Risk: Steam's "verify files" or a game update while swapped mixes versions.
2. **Overlay folder via the game's own search path.** Forever reads `GameData\` and the
   `Documents\TrackMania\` user folder; for skins and mods it also reads zips referenced by maps.
   Only some content can be redirected this way (Skins, MenuForever packs), not core files.
   - Safe (nothing replaced), but covers only part of the mods.
3. **Hard links / symlinks into GameData.** Needs admin or developer mode on Windows for
   symlinks; hard links do not cross drives. Not reliable for normal users.
4. **TMLoader-side redirect.** A small TMLoader mod that hooks the game's file open and serves
   files from a per-profile overlay folder. Cleanest result (nothing on disk changes), but needs
   reverse engineering of the file system calls in TmForever.exe and its own test round.

## Recommendation

Option 1 with a journal for file mods in `GameData\` and `Documents\TrackMania\Skins\`, and
option 4 later if the TMLoader route turns out stable.

Steps for option 1:
1. Record per profile which installed file mods (from `installs.json`) are ticked.
2. On Play: refuse if the game runs; write the journal; back up the originals the mods replace
   (same backup code as the installer); copy the mod files; then start.
3. Watch the game process (the Play button already does); on exit restore from the journal and
   delete it.
4. On TM Horizon start: if a journal exists and no game runs, restore first and tell the user.
5. Never for ESWC proxy DLLs (dinput8.dll) and never in the protected StarForce folder.

## Why not built now

The restore-after-exit path cannot be tested here without starting the game, and a bug would
leave someone's game files changed. It needs a test round on my PC with the journal replay and a
forced crash.
