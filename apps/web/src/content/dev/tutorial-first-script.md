---
title: "Your first Horizon script"
group: "tutorials"
order: 1
synced: false
note: "Horizon Scripts are on the same unreleased branch as ABI 1.3. The API can still change. Reference: the Horizon Scripts guide."
---

A Horizon script is a folder with a text file for the manifest and one or more AngelScript files. No compiler, no DLL. The same folder runs in TMNF, TMUF, ESWC and Sunrise. This tutorial builds a small overlay that shows the running map and its medal times. It takes about 15 minutes.

You need: TM Horizon with a game that has Horizon Client installed (a Horizon menu in the game), and any text editor.

## 1. Make the folder

Open the scripts folder of your game: `<game>\horizon\scripts\`. In the game, the **Scripts** tab of the Horizon menu has an "Open folder" button. Create a folder `hello`. The folder name is the script id.

## 2. Write the manifest

`hello\info.toml`:

```toml
name = "Hello"
permissions = ["ui"]
```

`permissions` is what the script may do. Without `ui` it cannot draw. The other ones are `settings`, `read-game` and `game-control`.

## 3. Write the script

`hello\main.as`:

```angelscript
void Render() {
    UI::SetNextWindowPos(vec2(20, 20), UI::Cond::FirstUseEver);
    if (UI::Begin("Hello", UI::WindowFlags::AlwaysAutoResize)) {
        UI::Text("Hello from " + Game::Title());
        UI::Text("Script time " + Time::FormatDuration(Time::ScriptTime()));
    }
    UI::End();
}
```

Save the file. The folder is checked every 500 ms, so the script loads while the game runs. A small window appears. Edit and save again to reload.

`UI::End()` is outside the `if`. `UI::Begin` must always be closed, even when it returns `false`, the same as in Dear ImGui.

## 4. Read the map

Reading the game needs one more permission. Change `info.toml`:

```toml
name = "Hello"
author = "you"
version = "1.0.0"
description = "Shows the running map."
games = ["eswc", "sunrise", "tmnf", "tmuf"]
online = "online-ok"
permissions = ["ui", "settings", "read-game"]
```

`online = "online-ok"` says the script is fine in online play (it only reads). The default is `"solo-only"`.

Now replace `main.as`. This is a shortened version of the `map-info` example that ships with the host:

```angelscript
[Setting name="Show"]
bool show = true;

bool haveMap = false;
string mapName, mapAuthor;
int authorTime = -1, goldTime = -1;

void Main() {
    // loaded while a map is already running: pick it up
    Game::Map@ map = Game::CurrentMap();
    if (map !is null) OnMapLoaded(map);
}

void OnMapLoaded(Game::Map@ map) {
    haveMap = map !is null;
    if (!haveMap) return;
    mapName = map.name;
    mapAuthor = map.author;
    authorTime = map.authorTime;
    goldTime = map.goldTime;
    print("map: " + mapName);
}

void OnMenu() {
    haveMap = false;
}

void Render() {
    if (!show || !haveMap) return;
    if (UI::Begin("Hello", UI::WindowFlags::AlwaysAutoResize)) {
        UI::Text(mapName.isEmpty() ? "Unnamed map" : mapName);
        if (!mapAuthor.isEmpty()) UI::TextColored(UI::MutedColor(), "by " + mapAuthor);
        if (authorTime >= 0) UI::Text("Author  " + Time::FormatRace(authorTime));
        if (goldTime >= 0) UI::Text("Gold    " + Time::FormatRace(goldTime));
    }
    UI::End();
}
```

What is new:

- `[Setting name="Show"]` above a global makes a checkbox on the script's settings page. It is saved. It needs the `settings` permission.
- `OnMapLoaded` and `OnMenu` are callbacks. The host calls them by name when a map loads or the player goes back to the menu. They need `read-game`.
- Some games leave the author empty for maps started from their own menus, so the code checks `isEmpty()`.

## 5. Find mistakes

In the Horizon menu, page "Horizon Scripts", tab "Scripts": pick your script. **Problems** lists compile errors and warnings as `file:line:column`, **Log** shows what `print` wrote. The host log has the same lines with the script id in front, for example `[hello] main.as:3:5: ...`.

## 6. Look at the real examples

The host repository has two finished scripts, `plugins/scripts/examples/clock` (time in a corner, with a settings page) and `plugins/scripts/examples/map-info` (the full version of step 4, with medal colours and a corner picker). Copy a folder, change `name` in `info.toml`, edit.

## Next

- Every call and permission: [Horizon Scripts (AngelScript)](/dev/docs/scripting/).
- Writing for every game, and what differs between them, is in the same guide under "Writing for every game".
- A native plugin when a script is not enough: [Your first Horizon plugin](/dev/docs/tutorial-first-plugin/).
- Getting it to players: [Publish your mod on TM Horizon](/dev/docs/tutorial-publish/).
