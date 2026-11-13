# TrackMania Nations ESWC: online services and the server list

What the game (unofficial patch 1.80, `TmNationsESWC.exe` 0.1.7.9, SHA-256 `983bd127…2d8068`) asks
the old Nadeo servers, read from the exe without running it, plus the request log of my
eswc-autosave online fix (`eswc_autosave.log`, 2026-11-09). Addresses are virtual addresses in that exe.
No request to a Nadeo server was made for this note.

## Transport

- Host `game.trackmanianations.com`, path prefix `/online_game` (built in `0x00401150`), HTTPS on
  port 443 (`0x00C07368`), WinINet, user agent `GameBox`. Ladder calls use `/online_game/ladder`,
  the patch check `patch/patch.php?action=0`.
- The server still answers (Apache, PHP 5.2.6) but only with **TLS 1.0** and the cipher AES256-SHA.
  Its certificate is for player.trackmania.com and expired on 2020-11-14. The game ignores name and
  date errors; current Windows refuses TLS 1.0 (error 12157), which the eswc-autosave online fix solves.
- Node 24 can still talk to it: `minVersion: 'TLSv1'`, ciphers `DEFAULT:AES256-SHA:@SECLEVEL=0`,
  no certificate check (`tls10Get` in `src/sources/eswc-master.ts`). The test suite proves the handshake
  against a local TLS 1.0 server with the same cipher. Without a certificate check the answer could be
  changed on the way; `servers.eswcMaster.certSha256` pins the fingerprint once it is known.
- All calls are GET with the parameters in the query string, answers are plain text.

## Calls in the order the game makes them (request log)

| Call | When | Parameters (format strings in the exe) |
| --- | --- | --- |
| `autotest_connection.php` | Internet menu | `?ver=%s&lang=%s` |
| `ad_init.php` | Internet menu | `?ver=%s&lang=%s&protocol=1&key=%s&disabled=%d` |
| `patch/patch.php?action=0` | Internet menu | `&game=&lang=&version=&os=Win9x|WinNt2kXp&protocol=1` |
| **`getservers.php`** | Internet menu, before and after login | `?ver=%s&lang=%s`, plus `&login=%s` once logged in |
| `subscribe.php` | new account | `?ver&lang&key&login&password&country&bigcity&email&nick` |
| `ident.php` | login | `?key=%s&login=%s&password=%s&nick=%s&lang=%s&ver=%s` (+ `&data4=%s&data5=%s`) |
| `ladder/joinmatch.php`, `hasjoinedmatch.php`, `statssend.php`, `disconnect.php` | joining a ladder server, race results | `?login&pass&ver&lang&idmatch…` |
| `disconnect.php` | leaving the Internet menu | `?key&login&password&lang&ver` |

Other format strings exist (`live.php` with `ishost`, `findhosts.php`, `browse.php`, `getdataservers.php`
…) but the game did not call them in my sessions, including while browsing and joining servers.
`findhosts.php` is the peer-to-peer file sharing (`&host=ip|port`), not the server list.

## getservers.php: the master servers (no login needed)

```
GET https://game.trackmanianations.com/online_game/getservers.php?ver=0.1.7.9&lang=en[&login=<login>]
```

The answer is parsed in the online state machine at `0x00A2F520` (request built at `0x00A2FB13`,
parsing from `0x00A2FC22`): lines split at `\n`, fields at `;`.

```
<status>;<count>                              status 0 = ok; otherwise the rest of the text is the message
<addr>;<prefix>;<port>;<name>;<level>;<nbOnline>;<nbServer>;<nbBuddy>;<string>;<port2>   × count
```

Each line fills a `CNetMasterServerInfo` (class id `0x12019000`, members from its table at
`0x00C8E830`): `Addr` (+0x14), `Prefix` (+0x1C), port (+0x24, checked ≤ 65535), `Name` (+0x28),
`Level` (+0x38, enum Beginner / Normal / Expert), `NbOnline` (+0x3C), `NbServer` (+0x40),
`NbBuddy` (+0x44), an unnamed string (+0x30) and a second port (+0x26). These are the "rooms" the
Internet menu shows with their player and server counts; they are **not** the game servers.

What I have not seen: a real answer. The field order is from the code, the values in
`test/fixtures/eswc-getservers.txt` are made up.

## The game server list itself

After the login (`ident.php`) the game makes no further web call when it lists or joins servers. The list
comes from the chosen master server (`Addr`:`port` from getservers) over the game's own network protocol:
the exe has `CNetFormQuerrySessions` (class id `0x12007000`) and `CNetFormEnumSessions` (`0x12008000`), the
same message family as the LAN search. Their serialisation and whether the TCP connection carries the
login or the `ident.php` key are not worked out; that is a longer reverse-engineering job (start at the
form factory `0x004D4F60` and the handler `0x00A3EEA0`).

`ident.php`: the login's password is passed as `password=` in the query. Whether that is the plain
password or a hash is not confirmed (the value comes from the session object at `+0x78`). The answer
format is not worked out either. I did not implement `ident.php` for that reason.

## What the pipeline does with it

- `src/sources/eswc-master.ts` calls `getservers.php` and writes the rooms to `servers.json`
  `masterServers` (name, level, players, servers, buddies). Their players count into `hub.json`
  `playersOnline`.
- Off by default: `config/hub.config.json` `servers.eswcMaster.enabled: false`.
- `ESWC_LOGIN` (optional) adds `&login=` like the game does after a login. `ESWC_PASSWORD` is not used
  by anything yet (it would be needed for `ident.php` and the master server connection).
- The last good answer is kept in `.cache/eswc-getservers.txt` and used when the server does not answer.
- ESWC game servers in `servers.json` come from the community registry (`data/servers/`), with
  `address` instead of a join link.

## Joining by address

The exe has no `tmtp://` handler (no such string), so there is no join link for ESWC. Players join a
server by address in the game's network menu; `servers[].address` gives `host:port`. The exact menu
path I could not confirm from the exe (there are `JoinServerInternet`, `JoinServerLan` and the setting
`NetworkForceServerAddress`).

## For the owner to test (with my account, on my machine)

1. **getservers.php answer.** Run `%USERPROFILE%\tools\eswc-autosave\build\test\onlinetest.exe` (prints
   `HTTP 200` and the first 255 bytes), or in this repo set `servers.eswcMaster.enabled` to `true` and run
   `npm run build -- --pretty`. Check `dist/servers.json` `masterServers` against the Internet menu
   (rooms, players, servers). The build log prints the certificate fingerprint: put it into
   `servers.eswcMaster.certSha256`. Save one real answer as `test/fixtures/eswc-getservers.txt`.
2. **Hourly polling.** One small GET an hour to a 2006 server. If that is fine, leave `enabled: true`.
3. **Server list (later).** With Wireshark on the master server address and port from step 1, open the
   Internet server list once. That shows whether the protocol is plain and what the session query looks
   like. Only then is a server list client worth writing.
4. **Join by address.** Which menu entry takes an IP and port, for the launcher's help text.
