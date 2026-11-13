---
title: "Review, claims and appeals"
group: "publish"
order: 5
synced: true
sourceRepo: "cheatoskar/tm-horizon"
sourceBranch: "integration-1111"
sourceCommit: "78d69f7164"
sourcePath: "docs/hub/moderation.md"
editUrl: "https://github.com/cheatoskar/tm-horizon/edit/integration-1111/docs/hub/moderation.md"
---
The parts of the moderators' runbook that concern authors: why a version waits for review, what a rejection must say, how to appeal, how claims work.

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

## Claims

- GitHub and TMLoader-token claims are approved automatically (proof of control).
- Manual claims: check the message against public evidence (Discord post history, forum thread,
  same name on the original page). When unsure, ask the requester to post a code word from their
  known account. Approve or reject with a note.
- After a claim, the next versions of that project go to review for 14 days (`diff.owner-change`).
