---
title: "Publishing mods"
group: "publish"
order: 1
synced: true
sourceRepo: "cheatoskar/tm-horizon"
sourceBranch: "integration-1111"
sourceCommit: "78d69f7164"
sourcePath: "docs/mod-publishing.md"
editUrl: "https://github.com/cheatoskar/tm-horizon/edit/integration-1111/docs/mod-publishing.md"
note: "Design document. Releases from GitHub or a TMLoader server, claims, the hold and the checks are built; signatures and the full portal flow are still being finished."
---
How authors put mods on TM Horizon and how the launcher gets them safely onto players' PCs. Nothing
of this is built yet; the launcher today installs from the TMLoader servers with their SHA-256.
This is the plan I want to build next.

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
