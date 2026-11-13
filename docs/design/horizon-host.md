# Horizon Host: in-game mod host and Legacy Loader (draft)

Status: draft, 2026-11-11. Nothing built yet. Written with the Legacy Randomizer session (%USERPROFILE%\Downloads\legacy-randomizer\PLAN.md), which will be the first plugin.

## Why

- ESWC, Sunrise and Original have no mod loader. Every mod today is its own proxy DLL (TMVS as `d3d9.dll`, ESWC Autosave as `dinput8.dll`), and there are only a few proxy names the games load. A third mod already has nowhere to go.
- Every mod that draws something hooks Direct3D on its own (TMVS, CenterSpeed via kiero/MinHook, Twinkie). They fight over the same hooks; I already had a TMVS + CenterSpeed device-hook clash on TMNF.
- I want one in-game menu for all Horizon mods (like Openplanet or Twinkie in game): one hotkey, one style, tiles per mod with on/off and settings.

## Pieces

1. **Legacy Loader** (`dinput8.dll`, a few KB, ESWC/Sunrise/Original only). Grows out of the eswc-autosave loader: forwards DirectInput8Create to the system DLL, then loads `horizon\host.dll`. Nothing else.
2. **Host** (`horizon\host.dll`, one per game process). Owns the D3D hook, the Dear ImGui context, input and hotkeys, the menu shell, the log, the settings store and the plugin list. Loads the plugins that TM Horizon enabled for the current profile.
3. **Plugins** (`horizon\plugins\<id>\<id>.dll` + `plugin.json`). Native DLLs against a small C ABI (below). Plugins never hook Present/EndScene/Reset themselves.

Per game:

| Game | Host loaded by | Notes |
|---|---|---|
| Nations ESWC, Sunrise, Original | Legacy Loader (`dinput8.dll`) | exe pinned by SHA-256 per supported version; unknown exe → host stays off and logs why |
| Nations/United Forever | TMLoader mod "Horizon Host" (CoreMod dependency) | TMLoader stays underneath (decision 2026-11-10); TMLoader mods that are not Horizon plugins keep working as today |
| TM² / Trackmania 2020 | none | Openplanet exists there; Horizon ships Openplanet plugins instead |

## Profile → plugin list

TM Horizon writes `horizon\profile.json` next to the exe (legacy games) or in the TMLoader product folder (Forever) before each start: enabled plugin ids + versions, hotkey, safe-mode flag. Holding Shift at start (or the launcher's "Start without mods") = host loads no plugins. One log per start: `horizon\logs\<date>.log` (which plugin loaded, failed, crashed).

Format (spec: horizon-host repo `docs/profile-json.md`, built 2026-11-11 in host 0.1.0):

```json
{ "format": 1, "profile": "My ESWC", "game": "eswc", "safe_mode": false, "menu_key": "Insert", "bar": true,
  "plugins": [ { "id": "eswc-autosave", "version": "2.0.0", "enabled": true }, { "id": "legacy-randomizer", "enabled": false } ],
  "written_by": "TM Horizon 0.3.0", "written_at": "2026-11-11T19:00:00Z" }
```

- Next to `host.dll`: `<game>\horizon\profile.json`; Forever/TMLoader: `...\products\Horizon Host\<version>\profile.json`. UTF-8, BOM allowed, unknown keys ignored.
- `format` must be 1, otherwise no plugin loads (error in the menu). `plugins` entries: object or plain id string; ids `[a-z0-9._-]`, 1..64; invalid/duplicate entries skipped with a warning; a version mismatch only warns.
- A plugin loads when its folder `horizon\plugins\<id>\` exists, the profile enables it (or there is no profile), the in-game menu did not switch it off (`settings\host.json`, `plugin.<id>.enabled`), it supports the game, and there is no safe mode.
- **No profile.json is not an error:** every installed plugin loads (unless its plugin.json says `"enabled_by_default": false`, or it is `eswc-autosave` while the old autosave loader is chained). The host never needs the launcher (no IPC, own folders for settings and logs).
- `menu_key` is the default; a key rebound in the menu (stored in `settings\host.json`) wins.
- Legacy install keeps an existing `dinput8.dll` as `dinput8.chain.dll`; the Legacy Loader forwards DirectInput through it first (that mod keeps working), then starts the host.

## Plugin ABI (C, stable, versioned)

```c
#define HORIZON_ABI 1

typedef struct HorizonPluginInfo {
    uint32_t abi;            // HORIZON_ABI
    const char* id;          // "tmvs", "legacy-randomizer", "eswc-autosave"
    const char* name;
    const char* version;     // semver
    uint32_t games;          // bit mask: ESWC, SUNRISE, ORIGINAL, TMNF, TMUF
    uint32_t caps;           // HORIZON_CAP_MENU | _OVERLAY | _DEVICE | _GAME_EVENTS
} HorizonPluginInfo;

// exported by every plugin
const HorizonPluginInfo* HorizonPlugin_Info(void);
int  HorizonPlugin_Init(const HorizonHostApi* host);   // 0 = ok
void HorizonPlugin_Shutdown(void);
// optional, looked up by name
void HorizonPlugin_DrawMenu(void);      // inside the plugin's tile/page
void HorizonPlugin_DrawOverlay(void);   // always-on HUD (e.g. randomizer timer)
void HorizonPlugin_OnEvent(const HorizonEvent* e);
```

Host API (function table handed to Init): log, settings get/set (per plugin, stored by the host), ImGui context + shared style, game info (game id, exe version, sha256, language, user data folder), hotkey registration (host resolves conflicts and shows them), game-event subscription, and for `_DEVICE` plugins the device access below.

### Game events (shared hooks, one per event)

The host owns the game hooks; Autosave, Randomizer and Clips all subscribe to the same Finish hook instead of patching the game three times. Adding an event = host update, ABI stays. Payloads (reviewed by the randomizer session, 2026-11-11):

- `MapLoaded`: path, uid, name, author, environment, author/gold/silver/bronze times, play mode (solo / net / editor test)
- `RaceStart`, `Respawn`, `Checkpoint(time)`
- `Finish`: time, is_local_player, respawn count, play mode, is_pb
- `RaceEnd` / `EndScreen`: the solo end-race menu is shown (auto-advance, "next map")
- `MenuEntered`, `ReplaySaved(path)`

### Game control (host API; the per-exe RE lives in the host)

- `PlayMapFile(path, flags) -> result` (solo), `ReturnToMenu()`, `GetGameState()` (main menu / solo race / end-race screen / online / editor), `IsOnline()`. The launcher wants "play this map" too, so this belongs in the host, not in one plugin. Known internals: ESWC copies the file into Tracks\Challenges\Downloaded, calls `CGameCtnChallengeInfo::RefreshFromDisk`, then sets the menu state the "Play Track › Solo › OK" button sets (valid only in the main-menu loop, untested in game); TMNF via the ManiaCode game action or the menus fields; Sunrise like ESWC (offsets being mapped). Details: the randomizer session's notes and %USERPROFILE%\Downloads\tm-modding-knowledge (local RE notes).
- `RunOnGameThread(cb)`: queued, run at a safe point (message pump / menu loop); plugins fetch maps on worker threads.
- Per-plugin data folder (history, caches) besides settings get/set.

### Input

While the menu is open the host blocks game input. Overlays (DrawOverlay) are click-through except their own buttons. Hotkeys only through the host registry, which shows conflicts. Taken today: TMVS F5–F8 and F12, ESWC Autosave F9, randomizer spike F11.

### Online gate

Plugins declare `solo-only` or `online-ok`. The host disables solo-only plugins' actions while `IsOnline()`.

### Exe pinning (first entries)

| Game | Build | SHA-256 | PE timestamp |
|---|---|---|---|
| Nations ESWC | unofficial 1.80 | 983bd12724739dcb0f876aeb3a4259154b068940f5167f57ede750ca452d8068 | 0x5ce7272f |
| Sunrise | Win10 community repack (TmSunrise.exe, 7,904,768 bytes) | e59dfc7eaa5314e85b2b0df6f40ef7ba01a23bd5a9525f84407f5dff301df4fe | 0x5cc8f0cf |
| Original | – | not installed yet | |

Note on d3d9.dll: the Sunrise repack ships its own d3d9.dll (a wrapper), so TMVS as a d3d9 proxy collides there. In my ESWC folder the d3d9.dll is TMVS itself (installed by me; backup d3d9.dll.before-1.5.0), not a repack wrapper. Either way the dinput8 loader + host avoids the proxy-name fight.

### Device access (`HORIZON_CAP_DEVICE`, for renderers like TMVS)

TMVS is a renderer, not just an overlay. It needs: the device pointer and its creation parameters (and a say in them, e.g. MSAA off), Reset before/after, BeginScene/EndScene, a pre-present slot that runs before the host draws ImGui, and its render-target/scene callbacks. TMVS already exports `TMVS_AttachDevice / TMVS_DrawOverlay / TMVS_SetSceneCallbacks` for the TMFOXR VR mod — the same pattern: the host owns the device hook and calls TMVS. Order per frame: device plugins' pre-present → host ImGui (menu + overlays) → present.

### Coexisting with mods that hook D3D themselves

CenterSpeed (kiero/MinHook trampolines in d3d9 code), Twinkie and others hook on their own. The host must not assume it is alone: hook via the factory/device vtables and re-check them (what TMVS 1.5.0 does after the CenterSpeed clash), never inline-patch d3d9 code, log foreign hooks it sees.

## Rules

- Nothing of ours overwrites a user's `dinput8.dll` silently. TM Horizon installs the Legacy Loader only after the user confirms, with a backup and one-click restore; if another `dinput8.dll` is there (e.g. a mod we don't know), it shows it and lets the user decide.
- No changes to the exe on disk, no physics/validation/checksum changes, no DRM circumvention; versions with StarForce are not supported.
- TMX rules apply to every plugin that runs online (no CP/trigger display, no ideal line, etc.); online-sensitive plugins declare it and the host can disable them online.

## Competition Patch 2.0 (TMNF/TMUF)

TMX requires Competition Patch 2.0 (donadigo) for uploads from 2026-11-19. CP 2.0 validates runs server-side against tool-assisted runs and slow motion ("completely rewritten to use server based validation", changelog 2.0.0). The host and its plugins must never make a CP-validated run invalid or look like a cheat:

- No changes to game timing, physics, input or the replay/validation data; no hooks on the game's simulation/timer paths in CP-relevant play modes. Rendering (D3D), overlays, menus and reading game state are what TMVS already does next to CP.
- Reflection writes/method calls and scripts that change game state stay off whenever CP is loaded and a run is being validated (treat "CP present + race running" like online).
- Test matrix before any release that touches Forever: host + TMVS + CP 2.0.1 (+ TMUnlimiter, CenterSpeed, Twinkie) in solo, online and a TMX-validated run; check CP's own logs/UI for warnings.
- Ask donadigo before release how CP 2.0 treats other injected DLLs/hooks (allowed list? module checks?), and follow that.

## In-game bar (all games)

Instead of a full custom game menu: a slim **Horizon bar** that slides in when the mouse touches the top edge of the screen (like TMUnlimiter's settings icon or the Steam overlay), and a hotkey. It shows the installed Horizon plugins as icons with on/off and their settings page, the log, and "Open TM Horizon". It is part of the host shell, so it is the same code for every game; the per-game cost is only the host's game adapter, which is needed anyway.

- Plugins that support it switch live (overlays, autosave, clips); native mods that hook the game deeper take effect after a restart — the bar says so ("applies after restart") instead of pretending.
- Forever: TMLoader mods that are not Horizon plugins can be listed (read from the active TMLoader profile) and toggled for the next start; they can't be loaded/unloaded live.
- Hidden while racing unless the mouse is at the top edge; never drawn into clips/video export (same rule as TMVS's menu).

## Forever: TMLoader stays the default

The host ships as a TMLoader mod for TMNF/TMUF; TMLoader is what the Forever community uses, and replacing it would split mod users. A fallback path (the same dinput8 Legacy Loader + host) is worth offering only where TMLoader can't serve: players without TMLoader, and TM Horizon's per-profile instances (TMLoader knows the game folder per product, not per profile, so instances can't launch through it today). Fallback-loaded Forever games run only Horizon plugins, not TMLoader mods.

## Phase 2: reflection, node explorer, scripting

All these games (ESWC, Sunrise, Forever, very likely Original) carry Nadeo's CMwNod reflection: every class has a CMwClassInfo with member tables (name, type, member id, getter/method). Openplanet builds its script API on the same idea; the randomizer session found ESWC/Sunrise menu actions purely by member name this way, and I used the ManiaPlanet reflection tables for TMVS's TM2 port.

Key everything on **class name + member name, never on class or member ids**: the ids differ between engine versions (ESWC, Sunrise and TMNF give the same class different ids). Layout and per-exe dumps: tm-modding-knowledge `modding/reflection.md` and `data/reflection/*_classes.json`.

1. **Reflection layer in the host**: walk the class-info registry at start, expose classes/nods/members by class + member name; read, write and call through the engine's own member accessors, not raw offsets. Per-exe dumps (all classes/members as JSON) go into %USERPROFILE%\Downloads\tm-modding-knowledge.
2. **Node explorer** (dev page in the menu): browse the live nod tree, inspect members, call parameterless methods — read-only while online.
3. **Script engine**: AngelScript (zlib licence; Openplanet and TMInterface use it, so authors feel at home). Scripts get the reflection layer + the event registry + ImGui + settings, hot reload on file change. Native plugins keep the C ABI; native hot reload only in dev mode.

Safety: writes and method calls through reflection are disabled while `IsOnline()` (and in net play modes) unless a plugin is explicitly `online-ok` and only reads; scripts declare solo-only/online-ok like plugins. TMX rules apply to scripts too.

### Porting mods between games

- Ports almost for free: anything that uses only host APIs (overlay/ImGui, events, settings, file formats, TMX) or reflection by name — randomizer, autosave, clips, most UI mods and scripts.
- Needs per-exe work: raw-address patches and engine internals not exposed through reflection (physics, renderer internals; e.g. TMVS's CVisionViewportDx9 camera hooks). Those use a per-exe address table, filled semi-automatically with the function matcher (TMNF symbols → ESWC/Sunrise: %USERPROFILE%\tools\tm-re\rmc\scripts\fnmatch.py, mwmethod.py, immref.py, callers.py).
- Limits: Original is an older engine generation (maybe D3D8, fewer classes); some features don't exist in old games (e.g. no ManiaCodes in ESWC).
- Rule for plugin authors: use events + reflection names, avoid raw addresses; the host guarantees those per supported exe.

## Who builds what

- Launcher side (this repo): Legacy Loader, host shell, ABI header + docs, TM Horizon integration (profile.json, install/backup, safe mode, logs view).
- Legacy Randomizer session: the randomizer as the first plugin, against this ABI, kept separable (game adapter / core / UI); feedback on this draft before building.
- TMVS: later, a host build path (`_DEVICE` plugin) next to its existing standalone/TMLoader paths; its ImGui style (src/overlay.cpp) becomes the host's shared style.
- Reflection walker prototype (phase 2): the randomizer session, for ESWC and Sunrise first (class-info registry, member-table layout, JSON dumps per exe into tm-modding-knowledge); TMNF/TMUF next with the existing Ghidra project.

## Open questions

- Sunrise/Original graphics API: D3D9 for Sunrise (it ships a `d3d9.dll` wrapper in the Win10 repack — check what it is), Original possibly D3D8 → host needs a D3D8 path or a d3d8→9 wrapper.
- Which exe versions per game (Sunrise vs Sunrise eXtreme, patches) — pin by SHA-256, list in a table.
- Forever: host as a TMLoader mod next to other TMLoader mods that hook D3D — test with CenterSpeed, Twinkie, KimMod.
