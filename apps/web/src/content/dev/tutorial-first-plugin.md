---
title: "Your first Horizon plugin"
group: "tutorials"
order: 2
synced: false
note: "Panels and the TM Horizon bridge are ABI 1.2 and 1.3. 1.3 is not released yet. The plugin below only needs ABI 1.0."
---

A Horizon plugin is a 32-bit native DLL that Horizon Client loads into the game. Use one when a [script](/dev/docs/tutorial-first-script/) is not enough: your own threads, files, network, or calls into the game. The plugin gets everything through one table of functions (`HorizonHostApi`), so you never hook Direct3D or ImGui yourself.

You need: Windows, Visual Studio with the C++ x86 tools, and a checkout of the horizon-host repository (it has the headers and the build).

## 1. Start from the sample

The repository has a small, commented example: `plugins/sample/` (`sample.cpp`, `plugin.json`, `build_plugin.cmd`). Copy the folder to `plugins/hello/` and rename the files.

A plugin folder in the game looks like this:

```
horizon\plugins\hello\
    hello.dll
    plugin.json
```

The folder name, the `id` in `plugin.json` and the `id` in the DLL must be the same, lowercase `[a-z0-9-]`.

## 2. plugin.json

```json
{
  "id": "hello",
  "name": "Hello",
  "version": "1.0.0",
  "dll": "hello.dll",
  "games": ["eswc", "sunrise", "tmnf", "tmuf"],
  "online": "solo-only",
  "abi": 1,
  "description": "Shows the last game events.",
  "author": "you"
}
```

The launcher and the host read this before the DLL is loaded. `online` is `"solo-only"` or `"online-ok"`. Use `solo-only` until you are sure the plugin gives no advantage online.

## 3. The code

The smallest useful plugin is a handful of exports. This one shows the last game event on its page in the Horizon menu:

```cpp
#define HORIZON_PLUGIN_BUILD        // exports get dllexport
#include <stdio.h>

#include "imgui.h"
#include "horizon_imgui.h"          // after imgui.h
#include "horizon_plugin.h"

namespace {
const HorizonHostApi* g_host = nullptr;
bool g_imgui = false;
char g_last[96] = "No event yet.";
}

extern "C" {

static const HorizonPluginInfo kInfo = {
    HORIZON_ABI,                    // always the header's value
    "hello",                        // id, same as the folder
    "Hello",
    "1.0.0",
    HORIZON_GAME_ALL,
    HORIZON_CAP_MENU | HORIZON_CAP_GAME_EVENTS,   // the optional exports we have
    HORIZON_FLAG_SOLO_ONLY,
    "you",
    "Shows the last game events.",
    HORIZON_ABI_MINOR,
};

HORIZON_EXPORT const HorizonPluginInfo* HORIZON_CALL HorizonPlugin_Info(void) { return &kInfo; }

// Return 0 to load. Any other number shows the plugin as "Failed" with that number.
HORIZON_EXPORT int32_t HORIZON_CALL HorizonPlugin_Init(const HorizonHostApi* host) {
    if (!host || host->abi != HORIZON_ABI) return 1;
    g_host = host;
    g_imgui = horizon_imgui_attach(host);                 // join the host's ImGui context
    host->subscribe(host->plugin, HORIZON_EVENTS_ALL);    // without this OnEvent is never called
    host->log(host->plugin, HORIZON_LOG_INFO, "hello loaded");
    return 0;
}

HORIZON_EXPORT void HORIZON_CALL HorizonPlugin_Shutdown(void) { g_host = nullptr; }

HORIZON_EXPORT void HORIZON_CALL HorizonPlugin_OnEvent(const HorizonEvent* e) {
    if (!e) return;
    switch (e->type) {
    case HORIZON_EVENT_CHECKPOINT: snprintf(g_last, sizeof(g_last), "checkpoint %d at %d ms", e->checkpoint_index, e->time_ms); break;
    case HORIZON_EVENT_FINISH:     snprintf(g_last, sizeof(g_last), "finish %d ms", e->time_ms); break;
    default: break;
    }
}

HORIZON_EXPORT void HORIZON_CALL HorizonPlugin_DrawMenu(void) {
    if (!g_imgui) return;
    ImGui::TextUnformatted(g_last);
}

}  // extern "C"
```

Things to know:

- Everything runs on the game's main thread. Keep handlers short. Only `run_on_game_thread` may be called from another thread.
- `HorizonPlugin_Init` is where you ask for what you need: events (`subscribe`), hotkeys (`register_hotkey`), settings (`get_int`, `set_int`), panels (ABI 1.2).
- Check `e->size` before you read event fields a newer host may have added.
- The full export list, events, threading rules and the online gate are in [Plugin guide and ABI](/dev/docs/plugin-abi/).

## 4. Build

Build with the same Dear ImGui version as the host. The easiest way is the repository's own build: add a `build_plugin.cmd` next to your source, modelled on `plugins/sample/build_plugin.cmd` (compile `hello.cpp`, link a 32-bit DLL against `build\imgui_core.lib`, copy `plugin.json`), and run the repository's `build.cmd`. The result is `build\plugins\hello\hello.dll`.

## 5. Try it

Copy `hello.dll` and `plugin.json` to `<game>\horizon\plugins\hello\` and start the game. The plugin shows up in the Horizon menu with its own page. If it shows "Failed" with a number, that is the value `Init` returned. The host log tells why.

## 6. More examples

`plugins/sample` shows every part of the ABI (hotkeys, panels, a HUD overlay, `save_replay`). Real ones: [TMX Upload](/dev/docs/plugin-tmx-upload/), [WR Hunter](/dev/docs/plugin-wr-hunter/), [Input Display](/dev/docs/plugin-input-display/), [TMX Browser](/dev/docs/plugin-tmx-browser/) and [Node Explorer](/dev/docs/node-explorer/).

## Next

[Publish your mod on TM Horizon](/dev/docs/tutorial-publish/), then [port it to the other games](/dev/docs/tutorial-crossover/).
