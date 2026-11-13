# Moderation runbook

Who: admins listed in `HUB_ADMINS`. Where: portal > Admin. Notices: the Discord moderation channel
(`DISCORD_WEBHOOK_URL`) gets every hold, review item, report, claim, revocation and source error.

## Daily routine (5 minutes)

1. Admin > Queue, top to bottom. Order: **reports** first (DSA notices, deadlines), then versions in
   review, then manual claims.
2. Glance at the Discord channel for hold notices of clean updates (they go live after 60 minutes
   by themselves; stop one with Reject if anything looks off).

## Versions in review

Why a version is in review: first version of a project (`review.new-project`) or any `flag`
finding. Read the findings from top to bottom:

| Finding | Meaning | Usual decision |
|---|---|---|
| `review.new-project` | first version | check the project page: real mod, author plausible, description honest, licence; then approve |
| `type.exe`, `pe.program` | an EXE inside | only fine if the description explains it (e.g. a patched game for TMLoader "program"); otherwise reject |
| `pe.packed` | UPX or similar, imports hidden | ask the author for an unpacked build; reject if no answer |
| `diff.new-executable`, `diff.dll-renamed` | new or swapped DLL vs. the previous version | compare with the changelog; renamed proxy DLLs are a classic hijack sign |
| `diff.new-sensitive-imports` | new network / process / keyboard / crypto APIs | approve only if the changelog says why (e.g. "update check"); otherwise ask |
| `diff.signature-missing`, `diff.key-changed` | the signing key changed or vanished | contact the author through a known channel (Discord) before approving |
| `diff.owner-change` | project changed hands in the last 14 days | check the claim/transfer in the audit log |
| `diff.source-changed` | crawled from another repository | check that the author moved the repo |
| `vt.malicious`, `vt.suspicious` | VirusTotal engines | 3+ engines: auto-rejected; 1-2: open the VT link, often false positives for injectors; ask the author |
| `type.unknown` | unusual file type | usually harmless (readme formats); approve if it fits |

Approve publishes at once (no hold). Reject needs a statement of reasons (below).

### Browser extensions

Projects of type "browser extension" are checked by `apps/server/src/checks/browser.ts` instead of the
game install rules, because their `.js`, `.html` and `.svg` files are the point (the game rules refuse
them). The hub never installs them into a game. Automatic rules:

| Rule | Severity |
|---|---|
| any program (PE, ELF, Mach-O, under any name) or `.exe .dll .bat .cmd .ps1 .vbs .msi .lnk .jar .sh ...` | reject |
| no `manifest.json` at the top (or in one top folder), not JSON, no `manifest_version` | reject |
| unpacked size over 20 MB | reject |
| crypto miner names (coinhive, cryptonight, ...) | reject |
| `eval(atob(...))`, `new Function(atob(...))`, scripts loaded from another site, `chrome.debugger`, cookies read and sent | flag |
| wide permissions (`<all_urls>`, `*://*/*`, cookies, history, debugger, nativeMessaging, proxy, webRequestBlocking, management, ...), CSP with `unsafe-eval` or remote hosts | flag |
| a single file over 5 MB, unusual file types | flag |

Review rule: approve when the permissions match what the description says the extension does (a TMX
helper needs the TMX sites, not `<all_urls>`), the code is readable (minified is fine, packed or
encoded blobs are not), and nothing is sent to hosts the description does not name. Ask the author
about every wide permission; reject code that loads or decodes code at runtime unless the source in the
repository shows why. The first version of every project is reviewed anyway (`review.new-project`).

## Reports ("Inhalt melden", DSA Art. 16)

1. Read the explanation and open the project/version.
2. Decide quickly and objectively. Possible actions:
   - nothing wrong: **Dismiss** with a short reason;
   - one bad version: **Revoke** it (launchers refuse it and offer removal);
   - the whole project: **Remove project** (optionally revoke all versions);
   - repeated abuse by the account: **Suspend** (Users tab).
3. Resolve the report with the outcome (the text is the answer to the notifier; until e-mail is set
   up, answer by hand if they left an address).
4. Illegal content (copyright notices from rights holders, malware, personal data): act within a
   day. Malware: revoke first, ask later.

## Statement of reasons (DSA Art. 17)

Every rejection, revocation, removal and suspension stores one; the author sees it, and removed
projects show it publicly. Fill in:

- **Facts**: what exactly was found, e.g. "Version 1.3.0 contains `updater.exe`, which downloads and
  runs files from an unknown server; not mentioned in the description."
- **Ground**: the terms clause or the law, e.g. "Nutzungsbedingungen § 4 Nr. 1 (Schadsoftware /
  versteckte Funktionen)", "§ 4 Nr. 2 (Rechte Dritter, Urheberrecht)", "§ 4 Nr. 3 (Online-Cheat)".
- **Automated**: ticked only when the decision came from the checks alone.
- **Redress**: prefilled (appeal within 6 months by e-mail, courts).

## Appeals

An author writes to the contact address. Look at the case again (ideally another admin), then
restore (Admin > project > Restore, or upload of a fixed version) or confirm, and answer with the
reasons. Note the outcome in the audit log (the restore action is logged automatically).

## Discovered GitHub projects

With `DISCOVER_GITHUB=1` the hub searches GitHub daily and lists new TrackMania repositories under Admin > Discovered. Accept, hide or ignore each one; the details and the filters are in [discover-github.md](discover-github.md). Weekly is enough: read the cards, accept the real projects, ignore the noise (a repository that only mentions TrackMania, a game bot, a copy of someone else's work).

## Claims

- GitHub and TMLoader-token claims are approved automatically (proof of control).
- Manual claims: check the message against public evidence (Discord post history, forum thread,
  same name on the original page). When unsure, ask the requester to post a code word from their
  known account. Approve or reject with a note.
- After a claim, the next versions of that project go to review for 14 days (`diff.owner-change`).

## Suspensions (repeated abuse)

Suspend after a warning when an account repeatedly uploads clearly illegal content or malware
(malware: no warning needed), or files clearly unfounded reports. Use a limited period in the facts
("for 30 days"), and lift it afterwards (Users tab > Unsuspend). Suspension logs the account out and
revokes its API tokens.

## Revocation effects

A revoked version disappears from the index's project list and appears in `revoked`. Launchers with
the hub source turned on refuse to install it and show it in Settings with a Remove button. The
`/dl/` link answers 410. The stored file stays in the bucket (evidence); delete it by hand only for
illegal content that must not be kept.

## Source errors

"Source … : repository not found" usually means the repo was renamed or made private. Open the
project's Sources tab: update the URL (remove and add) or leave it; versions already copied stay.

## Emergency: signing key leaked or a bad version spread

1. Revoke the version(s); the next index (within a minute) carries the revocation.
2. If the index key leaked: follow "Key change" in `docs/hub/secrets.md` and post in the Discord
   announcements.

## Game servers (registered by operators)

Details: [server-registration.md](server-registration.md). The Discord channel gets "New game server to review".

1. `GET /v1/admin/servers?status=pending` (admin session): game, address, name, contact, homepage.
2. Check that the address answers (launcher, add it by hand) and that the name and homepage are fine.
3. `POST /v1/admin/servers/:id/approve` returns the announce token once; send it over the contact given.
   `reject` and `remove` take a short note. Approve again to issue a new token (the old one dies).
4. The portal has no screen for this yet; use the API.
