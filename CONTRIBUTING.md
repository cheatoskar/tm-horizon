# Contributing

Bug reports, ideas and pull requests are welcome.

## About this repository

This public repository is an export of a private development repository. A pull request here is welcome, but it is ported by hand into the development repository, and the change then arrives here with the next release. History in this repository is squashed per release, so commits do not map one to one. Licence: AGPL-3.0 ([LICENSE](LICENSE)); contributions are under the same licence.

## Community project

The goal is one shared project instead of many separate forks. Improvements, fixes and features are welcome as pull requests and issues here. Forks are allowed by the AGPL-3.0, but please contribute back, and do not publish a fork under the TM Horizon name or logo: name and logo are not part of the code licence.

Questions and ideas: [Discussions](https://github.com/cheatoskar/tm-horizon/discussions). Bugs: [Issues](https://github.com/cheatoskar/tm-horizon/issues). Issues labelled "good first issue" and "help wanted" are a good place to start.

## Reporting a bug

Open an [issue](../../issues) and include:

- the game and its version, and where it is installed from (Steam, Ubisoft Connect, Epic, own folder)
- the TM Horizon version and the version of any mod involved
- what you did, what you expected and what happened
- for a problem with a game: the zip from "Report" on that game's page in TM Horizon. It holds the logs of the profile's mods, the newest crash logs and a redacted system summary, and nothing is uploaded; you attach it yourself

Search the existing issues first.

## Feature ideas

Open an issue and describe the problem you want solved. Servers and events for the community lists have their own issue forms.

## Pull requests

Pull requests are welcome. Keep them small and focused: one fix or one feature per pull request. For a larger change, open an issue first so the direction is clear before you spend time on it.

In the description, say what changed and how you tested it in the game (game, version, what you did). Include the output of the checks below.

## Build and test

Node 24, Rust and Python 3 are needed (see the [README](README.md#build)). From the repository root:

```
npm install
npm run typecheck
npm test -w @tm-hub/api
npm run test:scripts
cd apps/launcher/src-tauri && cargo test
```

These are what CI runs ([.github/workflows/ci.yml](.github/workflows/ci.yml)). The launcher itself builds with `npx tauri build` in `apps/launcher`; the README has the details, and [docs/release.md](docs/release.md) describes how a release is made.

## Rules that apply to the code

- The safety rules in the [README](README.md#safety-rules-in-the-code) are not negotiable: nothing inside the StarForce folder is touched, downloads are https with pinned SHA-256 where there is a source of checksums, no Windows Defender exclusions, TAS tools stay offline.
- TM Horizon is a launcher, not an in-game mod, but what it installs follows the TMX rules for mods: [TMX rules for mods](https://github.com/cheatoskar/trackmania-internals/blob/main/modding/tmx-rules-for-mods.md).
- Texts are short and plain. User-facing strings exist in English, Deutsch, Polski and Français; `npm run check-i18n -w @tm-hub/launcher` and `npm run check-i18n -w @tm-hub/web` check that none is missing.

## AI-assisted contributions

Contributions written with AI tools are fine, as long as the contributor has tested them and can explain what the change does. Untested generated code will be sent back.
