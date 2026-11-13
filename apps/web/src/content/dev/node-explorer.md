---
title: "Node Explorer"
group: "plugins"
order: 8
synced: false
sourceRepo: "cheatoskar/horizon-host"
sourceBranch: "client-mods"
sourcePath: "plugins/node-explorer"
editUrl: "https://github.com/cheatoskar/tm-horizon/edit/main/apps/web/src/content/dev/node-explorer.md"
note: "The horizon-host repository has no document for Node Explorer yet. This page is written from the plugin's source (plugins/node-explorer on the client-mods branch) and is not synced."
---

Node Explorer is a Horizon plugin that lets you browse the engine's classes and its live objects while the game runs. It is for people who write scripts, plugins and ports: you see which class has which member, what the value is right now, and the name to use in a script (`Nod`, `Reflection::`) or with `hz::Field` in the porting kit.

It runs in ESWC, Sunrise, TMNF and TMUF and is allowed online (`online-ok`). Open the Horizon menu in the game and pick the **Node Explorer** page.

## Read-only

The plugin only reads memory. Each read is page-checked and guarded against access violations, and there is a hard limit of reads per frame. It never writes, never calls game code (not even getters) and installs no hooks, so it can stay loaded next to Competition Patch. With Competition Patch loaded the page shows a notice saying the same. The page only reads while it is open in the menu.

## Objects

The **Objects** tab starts at one of three engine pointers the host provides: `App`, `Race` or `Challenge`. Pick one on the left, then click your way through the members. Every object has a table of its members with the current value. A member that points to another object, or to a list of objects, opens it.

A path is written by member names, for example:

```
App.CurrentPlayground.GameTerminals[0]
Race.Players[2].Name
```

The explorer walks a path by names again on every refresh, so a path stays valid when the game replaces objects (new race, new map). That also means a path you copy from here works in a script or a note tomorrow.

Buttons above the table:

| Button | What it does |
|---|---|
| Back, Forward | Walk through the objects you opened. |
| Refresh | Read the open object again. |
| Copy path | Copies the path as text. |
| Pin, Unpin | Keeps the path in the pinned list (saved between sessions). A pinned path that does not exist right now is greyed out. |

The path above the table is a breadcrumb: click a part to go back to that object. In a row, the right-click menu has **Copy value** and **Show class**. The filter field narrows the member list.

If an object is gone, the page says so, and the values come back when the object exists again.

## Classes

The **Classes** tab lists every class of the engine's reflection (the `CMwClassInfo` list). Search by name on the left, pick a class and see its members: name, type, and whether they are inherited (a checkbox switches inherited members on and off). "Show methods" in Settings adds methods to the list.

The class names are the engine's own. Forever, ESWC and Sunrise name some classes differently; the porting kit translates them, see [Porting guide](/dev/docs/porting/).

## Settings

| Setting | Meaning |
|---|---|
| Refresh | Manual, every second or every frame. Only the open object is read, and only while the page is open. |
| Reads per frame | Hard limit (200 to 20000). Values past it are skipped until the next refresh, and the page tells you how many. |
| List items shown | How many items of a list member are shown (1 to 64). |
| Show methods | Also list methods in the class view. |
| Dump classes to JSON | Writes the class list of the running game to `classes-<game>-<exe timestamp>.json` in the plugin's data folder. |

The last tab, class and refresh mode are remembered.

## Use it with scripts and the porting kit

1. Find the member in Node Explorer, for example on `Race`.
2. In a script, read it by name with `Reflection::` and `Nod` (permission `read-game`, see [Horizon Scripts](/dev/docs/scripting/)).
3. In a DLL, use `hz::Field<T>("Class", "Member")` from the porting kit ([Porting guide](/dev/docs/porting/)).

Names that the explorer shows are the names these two APIs use. If a name is not in the list on one game, the member does not exist there.

## Install

Node Explorer is part of the Horizon Client distribution (`plugins/node-explorer`: `node-explorer.dll`, `plugin.json`, `icon.png`). Its folder is `<game>\horizon\plugins\node-explorer\`. Source: `plugins/node-explorer` in the horizon-host repository, branch `client-mods`.
