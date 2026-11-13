# Discord bot: community events in tm-hub

tm-hub shows upcoming community events (cups, league rounds, mapping streams) in the launcher
and on the website. They come from **Discord scheduled events**: the "Events" a server creates
in its sidebar. A small bot that only reads those events does it; it never joins voice, never
reads messages and never sends anything.

## What the community does

1. A server admin opens the invite link below and picks their server.
2. The admin tells the tm-hub maintainers the server id, the name to show, a public invite
   link (optional) and which games the server is about. The maintainers add it to
   `config/hub.config.json`:

   ```json
   "discord": {
     "guilds": [
       { "id": "123456789012345678", "name": "Example TMNF community", "invite": "https://discord.gg/example", "games": ["tmnf"] }
     ]
   }
   ```

3. Within the hour the next build lists the server's scheduled and running events.

To stop it, kick the bot or ask for the entry to be removed; the next build drops the events.

## Invite link

```
https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot&permissions=0
```

- **Scope `bot` only.** No `applications.commands` (the bot has no commands), no user scopes.
- **Permissions `0`.** Listing scheduled events needs no special permission; the bot sees the
  events of channels its role can see, which by default is what `@everyone` sees. If events
  sit in voice or stage channels hidden from `@everyone`, give the bot role *View Channel* on
  those channels only (or use `permissions=1024`, View Channels, server wide).
- **No privileged intents.** The bot never connects to the gateway; it is a token used for one
  REST call. It does not need to be "online".

## What is read

One request per server per build (hourly, cached for 25 minutes):

```
GET https://discord.com/api/v10/guilds/{guild_id}/scheduled-events?with_user_count=true
Authorization: Bot <token>
```

Kept from each event: name, description, start and end time, status, location text (a
`tmtp://` or `maniaplanet://` link there becomes a "Join" button), the cover image and the
number of people marked as interested. Only scheduled and running events are published.

Not read or not kept: the creator (`creator_id` and `creator` are dropped), the list of
interested users (only the count is requested), members, roles, channels, messages.

## Privacy

- The output (`events.json`) is **public**: it is published on GitHub Pages and shown in the
  launcher and on the website. Add the bot only if your events are meant to be public anyway.
  Discord marks all guild events as "guild only"; adding the bot is the server's consent to
  publish them.
- No personal data about users is stored or published, only counts.
- The bot token is a GitHub Actions secret (`DISCORD_BOT_TOKEN`); it is never written to the
  output or the cache. Cached responses hold only what the API returned for events.

## Setting up the bot (maintainers)

1. https://discord.com/developers/applications > New Application ("tm-hub events").
2. Bot tab: Reset Token, copy it. Public Bot can stay on so communities can add it themselves.
   Turn all privileged gateway intents off.
3. Repository secret `DISCORD_BOT_TOKEN` = the token. For a local test:
   `DISCORD_BOT_TOKEN=... npm run build` (Git Bash) or `$env:DISCORD_BOT_TOKEN='...'; npm run build` (PowerShell).
4. Share the invite link above with the application id filled in.

Without a token (or with no guilds configured) the build writes clearly marked sample events
(`"sample": true`, names starting with "Sample:").

API reference: https://discord.com/developers/docs/resources/guild-scheduled-event
