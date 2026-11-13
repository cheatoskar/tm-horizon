# Releasing TM Horizon

How I cut a release, what I have to set up once on GitHub, and what the other workflows do.
The workflows are `.github/workflows/release.yml` (build and draft release), `ci.yml` (checks on every
push and pull request) and `links.yml` (daily link check).

## Cut a release

1. Bump the version in three places so they agree:
   - `apps/launcher/src-tauri/tauri.conf.json` (`version`)
   - `apps/launcher/src-tauri/Cargo.toml` (`version`; run `cargo check` once so `Cargo.lock` follows)
   - `apps/launcher/package.json` (`version`) and the other `package.json` files in `apps/*` and `packages/*`
     (`npm install --package-lock-only` updates `package-lock.json`)
   - `packaging/arch/*/PKGBUILD` (`_tag`)
   The workflow stops early if the tag does not match `tauri.conf.json`.
2. Merge that through a pull request, wait for CI to be green on `main`.
3. Tag the merge commit and push the tag: `git tag v0.3.0 && git push origin v0.3.0`.
   A tag with `-beta` or `-rc` in it (`v0.3.0-beta.1`) becomes a prerelease.
4. The `Release` workflow builds the Windows installer (NSIS) and the Linux packages (AppImage, deb, rpm)
   and puts them into a **draft** release for the tag, together with `SHA256SUMS` (and `latest.json` when
   signing is set up). File names use hyphens instead of the space in "TM Horizon", for example
   `TM-Horizon_0.3.0_x64-setup.exe`. The release build sets `TMHUB_PUBLIC_BUILD=1` (see "Public build and
   art" below). Pre-release versions: NSIS, AppImage and .deb take `0.3.0-beta.1` as it is (MSI would not,
   which is why only NSIS is built on Windows). The .rpm is built in its own step with `0.3.0~beta.1`,
   because the released Tauri bundler hands the `-` to the rpm tool, which refuses it; that step may fail
   without failing the release (then there is no .rpm).
5. I open the draft, download one file, check it against `SHA256SUMS` (`sha256sum -c SHA256SUMS` in a folder
   with the files, on Windows `Get-FileHash`), edit the release notes and click Publish.

A stable release becomes the "latest" release once I publish it; the app's stable update channel reads
`https://github.com/cheatoskar/tm-horizon/releases/latest/download/latest.json`. Every signed release,
stable or beta, also replaces `latest.json` on the prerelease `updater-beta` (created by the workflow if it
is missing); that is the beta channel: `https://github.com/cheatoskar/tm-horizon/releases/download/updater-beta/latest.json`.

## Public build and art

Some art in the repository is only allowed for local previews (`ART_CREDITS.md`): the TMX Headers Contest
2022 banners (`public/header-art/`), the box covers (`public/store-art/*/cover.*`) and the Nations ESWC hero.
`TMHUB_PUBLIC_BUILD=1` (or `npm run build:public -w @tm-hub/launcher`, which is `vite build --mode public`)
switches them off:

- The UI never references them: no banners and backdrops, no box covers, and the game tiles use the gradient
  or the wide key art and logo that exist. The flag is the constant `__PUBLIC_BUILD__` in the code.
- The Vite plugin in `apps/launcher/vite.config.ts` empties the generated art tables in the bundle and deletes
  those files from `dist/`. The release workflow checks `dist/` for them and fails if any is left.

A plain `npm run build` stays the preview build with all art. `npx tauri build` runs `npm run build`, so
a local installer has the art unless I set `TMHUB_PUBLIC_BUILD=1` first; the release workflow sets it.

## Launcher Preview (0.5.0)

`TMHUB_RELEASE_PREVIEW=1` (or `vite build --mode release`) builds the public build without anything that needs
the TM Horizon Hub or my servers: the frontend constant `__RELEASE_PREVIEW__` hides sign-in, claims, server
listing and reachability test, event and server submission and the hub settings; the Rust cfg `release_preview`
(set by `build.rs`, `crate::RELEASE_PREVIEW`) refuses every hub address except the production hub's signed
index, turns off the old hub data refresh and update check and installs catalog mods only from GitHub. It implies
`TMHUB_PUBLIC_BUILD=1`.

The mod list comes from the production hub's signed index (on by default, no setting):
`hubindex::PRODUCTION_HUB` = `https://hub.tm-horizon.com`, `PRODUCTION_KEY` = its public key (key id
`30e908dace1ecba8`); a release build does not compile while either is a placeholder. A valid index with at least
one project is the list: entries it does not name disappear, the bundled `catalog.json` only fills fields for the
ids it names (`mergeEntry` in `src/data/hubIndex.ts`). Empty, invalid or unreachable: the bundled catalog.
Hosts the build can contact: [release/outbound-hosts.md](release/outbound-hosts.md). Local installer:

```
cd apps/launcher
$env:TMHUB_RELEASE_PREVIEW='1'
$env:TAURI_SIGNING_PRIVATE_KEY=(Get-Content -Raw "$HOME/.tauri/tm-horizon-updater.key")
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD=(Get-Content -Raw "$HOME/.tauri/tm-horizon-updater.password.txt").Trim()
'{"bundle":{"createUpdaterArtifacts":true}}' | Set-Content -Encoding ascii "$env:TEMP/updater.json"
npx tauri build --config "$env:TEMP/updater.json"
```

Public builds also apply the licence list `packages/catalog/release-policy.json` to the catalog and fail when
sample data (`src/data/sample.ts`) is in the bundle.

## Updater signing (once)

**Since 0.5.0 the key is `~/.tauri/tm-horizon-updater.key`** (password in `tm-horizon-updater.password.txt`
next to it, readable only by my user) and its public key is in `tauri.conf.json` (`plugins.updater.pubkey`), so
local builds can update too. The older text below (key as repository secret, public key as variable) still
describes the CI path; the variable must hold the same public key.

The app only installs updates signed with my key. I create the key pair myself, locally, once:

1. `cd apps/launcher` and `npx tauri signer generate -w ~/.tauri/tm-horizon.key`. It asks for a password and
   writes the private key `~/.tauri/tm-horizon.key` and the public key `~/.tauri/tm-horizon.key.pub`.
2. I back up the private key and the password (password manager plus one offline copy). The private key
   never goes into the repository. If I lose it, installed copies can no longer update, and everyone has
   to install a new build by hand.
3. In the repository under Settings > Secrets and variables > Actions:

| Where | Name | Value |
|---|---|---|
| Secrets | `TAURI_SIGNING_PRIVATE_KEY` | content of `tm-horizon.key` |
| Secrets | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the password I chose |
| Variables | `TAURI_UPDATER_PUBKEY` | content of `tm-horizon.key.pub` (one line) |

The public key is a variable and not part of `tauri.conf.json` on purpose: local builds then have no key and
cannot update themselves (they would otherwise check GitHub for a release they were not built from), and a
key change needs no commit. The release workflow writes the variable into `plugins.updater.pubkey`.

### What CI does

- The release build signs only when the secret and the variable both exist. Otherwise it builds unsigned
  bundles, skips `latest.json` and prints a notice; the build does not fail.
- With signing, Tauri writes `TM Horizon_<version>_x64-setup.exe` and `.sig` next to it (Windows) and the
  `.AppImage` with its `.sig` (Linux). The workflow renames spaces to hyphens.
- `scripts/updater-json.mjs` builds `latest.json` from those files (`version`, `notes`, `pub_date`,
  `platforms.windows-x86_64` / `linux-x86_64` with `signature` and `url`) and uploads it to the draft release.
- Stable channel: the app reads `releases/latest/download/latest.json`. GitHub's "latest" is the newest
  published release that is not a prerelease, so I have to publish the draft first. A tag with `-beta` or
  `-rc` becomes a prerelease and stable users never see it.
- Beta channel: every signed run also copies `latest.json` to the release `updater-beta` (created on first
  use), so beta users get beta and stable versions, whichever is newer.
- If I ever change the key, older installs reject the new updates.

### Test the updater locally

No GitHub and no real key needed. In `apps/launcher`:

```
node tools/updater-e2e.mjs
```

It makes a throwaway key under `%TEMP%\tmh-upd-e2e`, a fake installer `TM-Horizon_9.9.9_x64-setup.exe` (just
bytes, never run), signs it, writes `good/latest.json` and `bad/latest.json` (the installer there has one
byte changed) and serves the folder on `127.0.0.1:8765`. It prints the two start lines for the debug app, for
example in PowerShell:

```
$env:TMHUB_UPDATE_ENDPOINT='http://127.0.0.1:8765/good/latest.json'; $env:TMHUB_UPDATE_PUBKEY='<printed>'; $env:TMHUB_UPDATE_DRY_RUN='1'; npm run tauri dev
```

The three variables work in debug builds only; a release build ignores them. With `DRY_RUN=1` the app
downloads and checks the signature but installs nothing and says "Checked, test mode, nothing installed".
The `bad` endpoint must end in the signature error. `--selftest` serves, fetches the files once and stops.
The signature check without the app: `TMHUB_E2E_DIR=%TEMP%\tmh-upd-e2e cargo test e2e_signature_files -- --ignored`
in `apps/launcher/src-tauri`.

On Linux only the AppImage updates itself; .deb, .rpm and the Arch packages show "Installed as a package"
and update through the package manager.

## The repository is private

While `cheatoskar/tm-horizon` is private, release assets and `latest.json` cannot be downloaded without
a login, so the app's update check gets a 404 and nobody can update through it. It starts working
when the repository is public. The alternative is a separate public repository, for example
`tm-horizon-releases`, that only holds releases: the workflow would then have to upload there (a token
with write access to that repository as a secret), and the two update URLs (`STABLE_URL`, `BETA_URL` in
`apps/launcher/src-tauri/src/updater.rs`, plus `plugins.updater.endpoints` in `tauri.conf.json`) change to
`https://github.com/cheatoskar/tm-horizon-releases/...`. I have not set that up.

## Arch Linux

`packaging/arch/tm-horizon/PKGBUILD` builds from the release tag, `packaging/arch/tm-horizon-bin/PKGBUILD`
repacks the release .deb. After a release I set `pkgver`, run `updpkgsums` (needs the public download) and
`makepkg --printsrcinfo > .SRCINFO` before pushing to the AUR.

## Windows code signing (later)

The installer is not signed with a Windows certificate, so SmartScreen warns on first start. When I
buy a certificate (or use Azure Trusted Signing), it goes in as more secrets and a signing step or
`bundle.windows.signCommand`. That is separate from the updater key above.

## Link check

`links.yml` runs every day (and on demand under Actions > Mod links > Run workflow). It runs
`scripts/check-links.mjs`: every download link of mod, tool and skin entries in
`packages/catalog/catalog.json` (Discord attachments are skipped, Google Drive, Yandex and Discord links
only have to answer), and for every mod in the TMLoader index the newest file is downloaded (up to
300 MB) and its SHA-256 compared with the index. If something is broken, one open issue "Broken mod
links" holds the report; when everything works again the workflow comments and closes it.
Locally: `npm run check-links -- --limit 15` (or `--dry-run`); it only reads from the network.
