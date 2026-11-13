# Mod publishing on TM Horizon (design)

How authors put mods on TM Horizon and how the launcher gets them safely onto players' PCs. The hub, the author portal (sign-in with GitHub or Discord) and the review step are built and run for my own
projects; opening them to other authors needs coordination with the community and TMX first. The launcher
still installs other mods from the TMLoader servers with their SHA-256.

## Goals

- Authors publish without running their own server, and keep the ways they use today.
- Players get exactly the file the author published, or nothing.
- A hijacked author account, a swapped file on a mirror or a bad update does not reach players
  silently.
- Players need no account. Only authors and server owners log in.

## How authors submit

One project page per mod; each version is a separate submission.

| Way | What happens |
|---|---|
| TMLoader server link | I read `<server>/index.json` like TMLoader does and import new versions from it. The author keeps their server; TM Horizon keeps its own copy (below). |
| GitHub releases | The author links the repository and picks the release asset. New releases are picked up by a webhook or the hourly check. |
| Zip upload | Upload in the browser. |

What a version may contain:

- **TMLoader mods**: the TMLoader layout (`<files>` plus the version's `executable`, `dependencies`,
  `priority`). A DLL-only upload is wrapped into that layout automatically; the author confirms the
  executable name and dependencies once.
- **Skins, texture packs, block packs, sounds**: a zip plus the target folder it unpacks into
  (for example `Skins\Vehicles\CarCommon` or `GameData\...`, chosen from a list per game, no free
  paths, no `..`). No `.dll`, `.exe`, `.asi`, `.bat`, `.ps1` or other executable content is
  allowed in these; the upload is refused.
- Metadata: games, mod type, what it requires, what it conflicts with, licence, homepage and
  issue tracker (the launcher's "Report a problem" links there).

### Project type (required)

The author picks what the project is, in the form and in the import preview (`HUB_PROJECT_TYPES` in
`packages/shared/src/hub.ts`, glyphs in `modicon.ts`): mod, skin, texture pack, sound pack, maps,
Openplanet plugin, TMInterface plugin, tool, TAS tool, editor tool, server tool, library, browser
extension, documentation, community, event. The import preselects a guess (catalog entry, repository
topics, file layout) and says where it came from; the author confirms it. Catalog imports take it from
`category` + `modType` (`projectTypeOfCatalog`). Each type has a delivery:

| Delivery | Types | Launcher |
|---|---|---|
| game | mod, skin, texture/sound pack, maps, Openplanet/TMInterface plugin | installs each version into the game (install types) |
| files | tool, TAS/editor/server tool, library | installs when a version has an install type, else download |
| browser | browser extension | never installs into a game: links to the store pages (related links) and hands the version's zip to its browser add-on manager. Versions carry no installs, also in the index (`installs: {}`), so launchers without type support cannot install it into a game. |
| link | documentation, community, event | no files, opens the links |

### Import from a link: nothing silently

"Preview" shows everything the hub found and the author ticks what to take (all on by default):
README as long description (rendered), pictures from the README, the release files and `docs/images`
(thumbnails; order and banner chosen by the author), licence, links (source, issues, homepage, a
Discord invite found in the README, `plugin.json` links), the newest release and its file (with size
and GitHub download count), and a showcase (the repository's `showcase.json`, or the catalog's seed
showcase when the repository is a catalog entry, or none). A summary "What will be imported" sits above
the Import button. The server takes only what the request names (`POST /v1/projects/import`: `type`,
`summary`, `description`, `license`, `links`, `images`, `banner`, `showcase`, `importLatest`); pictures
must be ones the preview found. Leaving the repository showcase out keeps it out (the crawler does not
bring it back until the author takes it over in the Showcase tab).

### What "Downloads" counts

Shown as one total with a breakdown (tooltip and Analytics tab), see `DownloadBreakdown` in hub.ts:

- **TM Horizon**: installs through the launcher and downloads from the project page, counted by the hub
  once per installation and project and day. The launcher sends a random installation id
  (`X-TMHub-Install` header or `?install=`); without it the address counts. Both are used only in memory
  as a salted hash (new salt every day); stored are daily totals per version.
- **GitHub**: sum of GitHub's `download_count` over the installable files (zip, dll, xpi, crx, exe, 7z;
  no checksums or source files) of all releases, read at most once a day per project.
- **Not counted**: TMLoader servers and Discord posts publish no numbers; the portal says so.

Launcher side (open): send `X-TMHub-Install` with a random id kept in its settings when it downloads
from `/dl/`.

## Immutable hub copies

- Every accepted version is stored once, by SHA-256, in Oracle Object Storage
  (`/<project>/<version>/<sha256>.zip`). A stored version is never changed or replaced; a fix is a
  new version.
- The files are served through an nginx cache on the web box (the free tier has few Object
  Storage requests, so nginx keeps hot files on disk and asks the bucket only on a miss). The
  launcher downloads only from the hub copy, never from the author's server, so a later change
  on the author's side cannot swap a file under an existing version.
- Old versions stay available so profiles and packs with pinned versions keep working.

## Signatures

- **Author signatures (optional at first)**: authors can add an Ed25519 public key to their
  account and sign `sha256 + project + version`. The launcher verifies it and shows a
  "Verified" badge. Later, signed versions can be required for auto-updates. Key changes need a
  waiting period and a notice to the old key's owner.
- **Signed hub index**: the index the launcher reads (projects, versions, hashes, sizes,
  author signatures) is signed with a hub key whose public half ships in the launcher. The
  launcher refuses an index with a bad signature and keeps the last good one. The key lives
  offline; a short-lived online key signs the hourly index and is itself signed by it.

## Checks per version

Every new version runs through automated checks:

- malware scan of every file (ClamAV, plus a multi-engine lookup of the hash);
- diff against the previous version: new imports of network, crypto or process APIs
  (`WinHttp*`, `InternetOpen*`, `socket`, `CryptEncrypt`, `CreateProcess`, `WriteProcessMemory`,
  ...), large size jumps, new executables or DLLs, files outside the declared target folder;
- signature missing where the previous version was signed;
- metadata sanity (dependencies exist, versions are semver, target folder allowed).

Only flagged updates and new projects go to a human review. Clean updates of known projects go
through on their own.

## Release hold and auto-updates

- Every update waits **1 hour** before it goes live. The author gets a Discord DM when the
  version is queued ("Version 1.4.3 of TM Vibrant Shaders goes live at 18:40. Not you? Cancel
  here."), so a stolen account is noticed before players get anything.
- The launcher auto-updates only to versions that have been live for a few hours (default 6),
  so a bad release can still be pulled before most players get it. Manual installs of newer
  versions stay possible, with a "new" label.
- A pulled version disappears from the index; launchers that have it show a notice and offer
  the previous version.

## Teams, forks, takeovers

- A project has an owner and maintainers (roles: owner, maintainer, uploader). Only owner and
  maintainers can change metadata or remove versions; uploaders can submit versions that still
  go through checks and the hold.
- Forks only with a licence that allows it or written permission of the original author; the
  fork page links the original.
- Abandoned mods (no answer from the author for a long time, broken by a game or loader update)
  can be taken over through the moderators: public notice on the project page, a waiting
  period, and the original author can always claim it back.

## Compatibility and conflicts

- Each version declares the games, what it requires (with version ranges, like TMLoader's
  dependencies) and known conflicts.
- The launcher checks a profile before starting: missing dependencies, declared conflicts.
- Players can report a conflict from the launcher ("these two crash together"); reports with
  the redacted log zip from "Report a problem" go to both authors. Repeated reports become a
  "known conflict" note on both pages until an author confirms or fixes it.

## Accounts and login

- Login only with Discord or GitHub OAuth. No passwords are stored.
- Accounts exist only for authors and server owners. Players need none; the launcher works
  without any login.

## Hosting next to the 100tmx site

The hub runs on the same Oracle box as the 100tmx site, isolated from it:

- own Unix user and systemd service, own database (and database user), own subdomain and TLS
  certificate;
- nginx is the only shared part: separate server blocks, separate cache zones, separate logs;
- upload storage and the Object Storage credentials are readable only by the hub user;
- backups of the hub database and the bucket list are separate from 100tmx's.
