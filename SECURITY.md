# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private reporting instead: open the [Security tab](../../security), choose "Report a vulnerability" and describe the problem, with steps to reproduce if you can. The report stays private until a fix is out.

Reports are answered as soon as possible, usually within a few days. This is a hobby project, so there is no fixed deadline.

## Supported versions

Only the latest release gets fixes. Please check that the problem is still there in the latest release before reporting.

## Scope

In scope:

- the updater: update signatures and the signing key check, anything that lets an unsigned or altered update install
- downloads: mod, game and tool downloads that should be https with a pinned SHA-256 (or an index SHA-256) and size caps, and path handling when unpacking them
- file writes into game folders, TMLoader and Documents (path traversal, writes outside the intended folder, missing backups)
- `tmhub://` links and `.tmhubpack` files that can make the launcher do more than the user agreed to
- anything that adds Windows Defender exclusions or changes Defender settings (TM Horizon never does this; a way to make it do so is a vulnerability)
- data that leaves the PC contrary to the [privacy section](README.md#privacy) and [docs/release/outbound-hosts.md](docs/release/outbound-hosts.md)

Out of scope:

- the SmartScreen warning on the installer (it is not code-signed; this is documented)
- vulnerabilities in the games, TMLoader, Openplanet or other third-party mods; report those to their authors
- problems that need an attacker who already controls your PC or your Windows account
