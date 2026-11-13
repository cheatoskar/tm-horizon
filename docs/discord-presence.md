# Discord status ("Playing …") for games started from TM Horizon

TM Horizon can show "Playing TrackMania Nations ESWC" with the elapsed time in Discord while a game it
started runs. It talks to the Discord app on the same PC over Discord's local IPC pipe
(`\\.\pipe\discord-ipc-0`); no Discord SDK DLL, no network call of its own.

It uses TM Horizon's own Discord application, whose id is built into the launcher
(`DISCORD_APP_ID` in `apps/launcher/src-tauri/src/discord.rs`). Players only get one switch,
Settings > Discord > "Show what I play in Discord" (off by default). While the constant is empty
the switch is disabled and says "Coming soon".

## Creating the application (once, by me)

1. https://discord.com/developers/applications > New Application, name it "TM Horizon" (the name
   is what Discord shows after "Playing", the game name follows in the details line).
2. Copy the Application ID (17-20 digits) into the constant `DISCORD_APP_ID` in
   `apps/launcher/src-tauri/src/discord.rs`. Presence works when it is non-empty and the player
   switched it on (`discord_presence` in settings.json). The old `discord_app_id` setting is
   still read from old settings files but ignored.
3. Rich Presence > Art Assets: upload
   - `tmhub`: the TM Horizon icon (small image),
   - one image per game, named by the launcher's game id: `tmnf`, `tmuf`, `tmn-eswc`,
     `tm2-stadium`, `tm2-canyon`, `tm2-valley`, `tm2-lagoon`, `sm-storm`, `tm2020`,
     `tm-turbo`, `tm-sunrise`, `tm-original`, `tm-2003`, `tm-wii`, `tm-ds`, `tm-turbo-ds` (large image).
     Missing images are simply not shown. The console games show while their emulator (Dolphin,
     melonDS) runs after Play.

## Behaviour

- Set when the game's process appears (up to 3 minutes after Play, so TMLoader, Steam or
  Ubisoft Connect can start it), cleared when it exits or TM Horizon closes.
- Not set when TMInterface is on in the started TMLoader profile: TMInterface sets its own.
- Details: "Playing <game name>", state: "Profile: <profile>", elapsed time from the start.
- Code: `apps/launcher/src-tauri/src/discord.rs` (frame format and rules are unit tested).
