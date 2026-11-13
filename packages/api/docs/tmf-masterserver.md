> Superseded: the master server client now lives in `packages/tmf-master` (docs in `docs/tmf-master/`). The old parser in this package was removed; it read the outer `<e>` of an answer as an error.

# TrackMania Nations/United Forever: master server list

## What is known

From Laiteux/TMF.NET (MIT, https://github.com/Laiteux/TMF.NET, files `TmfGameApi.cs`,
`TmfGameSession.cs`, `Helpers/CryptoHelper.cs`, `Requests/*`) and the request names in
`TmForever.exe` (TMNF, read only):

- Plain HTTP POST to `http://game2.trackmaniaforever.com/online_game/request.php` (Nations) or
  `http://game.trackmaniaforever.com/…` (United). Body: XML without declaration,
  `<root><game><name>TmForever</name><version>2.11.26</version><distro>ASPUR</distro><lang>en</lang></game><author><login/><session/></author><request><name/><params/></request>[<auth><value/></auth>]</root>`.
- Answer: `<r><n>name</n><c>content</c>[<e><v>code</v><m>message</m></e>]</r>`, sometimes followed
  by junk bytes. `RedirectOnMasterServer` carries another host in `c/a/c`.
- `OpenSession` (params `<cr>00000000</cr>`, session -1) needs only the login and returns a session id
  and a salt. The password is never sent: it only feeds the Blowfish key `md5hex(cr + md5hex(salt + password))`.
- `Connect` needs an RSA-"private-encrypted" login with a key embedded in the game (TMF.NET ships it),
  a Blowfish-CBC hardware key, and after that every request an auth value
  `upper(BlowfishCBC("00000000" + "00000000" + upper(md5hex("00000000" + requestXml)) + counter as 48 hex digits))`.
  Blowfish needs `node --openssl-legacy-provider` (OpenSSL 3 moved it to the legacy provider).
- Error codes: 7 invalid login, 13 unknown login, 18 not connected, 20 redirect, 23 overloaded,
  91 invalid player key, 103 bad packmask, 106 rate limit, 121 wrong password, 122 already connected.

## What is not known

TMF.NET has no server-list request, and I found no description of one. `TmForever.exe` lists these
master server requests: `OpenSession, LiveTick, GetPlayerInfos, … SearchNew, FindNew, GetNews, …
LiveUpdate, Achievements, Leagues, Skills, MasterServerOnSafeMode, RedirectOnMasterServer`. `SearchNew`
(built at `0x006C1844` with the category `Searchs`, generic search with caller parameters) is the
likely request behind the server browser (`CGameNetwork::FindServers`), but its parameters and its
answer are unconfirmed.

## What the pipeline does

`src/sources/tmf-master.ts` has the envelope, the answer parser (junk, errors, redirects), the
session key and `OpenSession`, all tested against handwritten fixtures (`test/fixtures/tmf/`).
The build source:

- without `TMF_LOGIN` / `TMF_PASSWORD`: skipped, one log line;
- with them: warns that the list request is not confirmed and requests nothing
  (`servers.tmfMaster.listRequest` is `null`).

It deliberately does not guess: a wrong request from a CI runner with my account could get the
account flagged (error 106 rate limit, 122 already connected while I play).

## For the owner to test

1. Install Wireshark, start a capture with the filter `http.request.uri contains "request.php"`.
2. Start TMNF (no mods needed), log in, open Internet > server list, wait until it fills, close the game.
3. Export the `SearchNew` (or whatever request name appears) request and answer. Before sharing,
   replace the login, session id and `<auth><value>` with `x`. The password is not in the capture.
4. With that: set `servers.tmfMaster.listRequest` (name and params), write the answer parser against the
   capture, and add `Connect` (RSA key, hardware key, auth counter) after TMF.NET. Estimate: one agent
   session, plus one live test with my login.
5. Use a separate account for CI (`TMF_LOGIN`/`TMF_PASSWORD` as repository secrets), not the one I play with,
   so the hourly session does not kick me (error 122).
