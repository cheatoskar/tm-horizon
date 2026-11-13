---
title: "CI builds per game"
group: "porting"
order: 4
synced: true
sourceRepo: "cheatoskar/horizon-porting-kit"
sourceBranch: "main"
sourceCommit: "1da9521b34"
sourcePath: "docs/AUTOMATION.md"
editUrl: "https://github.com/cheatoskar/horizon-porting-kit/edit/main/docs/AUTOMATION.md"
---
A mod repo that uses `hz_port.h` can get one DLL per game built and attached to
its GitHub releases without any manual work. The kit provides a reusable
workflow for this: `.github/workflows/hz-build.yml`.

## Prerequisites

- The mod includes the kit as a git submodule (for example
  `third_party/horizon-porting-kit`) or as a copied `include/` folder.
- The mod has a `build.cmd <target>` that
  - compiles with `/DHZ_TARGET=HZ_TARGET_<UPPER>` where `<UPPER>` is `FOREVER`,
    `ESWC`, `SUNRISE` or `ALL`,
  - links as x86 only (`/MACHINE:X86`),
  - writes `dist\<target>\<dll>.dll`.

Sample `build.cmd`. It works locally (finds Visual Studio itself) and in CI
(the compiler is already on the PATH, so vcvars is skipped):

```bat
@echo off
setlocal
set TARGET=%1
if "%TARGET%"=="" set TARGET=forever

where cl >nul 2>nul
if errorlevel 1 (
  set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
  for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -property installationPath`) do set "VSDIR=%%i"
  if not defined VSDIR ( echo Visual Studio not found & exit /b 1 )
  call "%VSDIR%\VC\Auxiliary\Build\vcvarsamd64_x86.bat" || exit /b 1
)

set UPPER=
if /i "%TARGET%"=="forever" set UPPER=FOREVER
if /i "%TARGET%"=="eswc"    set UPPER=ESWC
if /i "%TARGET%"=="sunrise" set UPPER=SUNRISE
if /i "%TARGET%"=="all"     set UPPER=ALL
if not defined UPPER ( echo Unknown target %TARGET% & exit /b 1 )

if not exist dist\%TARGET% mkdir dist\%TARGET%
cl /nologo /LD /O2 /MT /EHsc /DHZ_TARGET=HZ_TARGET_%UPPER% ^
  /I third_party\horizon-porting-kit\include src\mod.cpp ^
  /Fe:dist\%TARGET%\race-reader.dll /link /MACHINE:X86
exit /b %errorlevel%
```

## Caller workflow

Add `.github/workflows/release.yml` to the mod repo:

```yaml
name: release
on:
  release:
    types: [published]
  workflow_dispatch:

permissions:
  contents: write

jobs:
  build:
    uses: OWNER/horizon-porting-kit/.github/workflows/hz-build.yml@v1
    permissions:
      contents: write
    with:
      dll-name: race-reader
      targets: forever,eswc,sunrise
```

The caller must grant `contents: write`. Without it the release job cannot
upload files. Replace `OWNER` with the GitHub owner of the kit.

Inputs:

| Input | Default | Meaning |
|---|---|---|
| `targets` | `forever,eswc,sunrise` | Comma list of `forever`, `eswc`, `sunrise`, `original`, `all` |
| `working-directory` | `.` | Folder of the mod |
| `build-command` | `build.cmd` | Called as `<build-command> <target>` in cmd |
| `dll-name` | required | DLL name without extension |
| `output-pattern` | `dist/{target}/{dll}.dll` | Where the build leaves the DLL, relative to the working directory |
| `kit-ref` | empty | Kit version, only written into the manifest |

What happens:

1. `prepare` checks the target list (an unknown target fails the run) and warns
   if the repo has no LICENSE, LICENSE.md or COPYING file.
2. `build` runs once per target on `windows-latest` with the x86 compiler and
   `HZ_TARGET=<target>` set. It checks that the DLL exists and is a 32-bit PE,
   and uploads `<dll>-<target>.dll` (and the `.pdb` if present) as an artifact.
3. `release` runs only on a published release or a `v*` tag. It writes
   `hz-release.json` and uploads the DLLs and the manifest to the release.

The manifest looks like this:

```json
{"format": 1, "mod": "race-reader", "version": "1.2.0", "repo": "OWNER/race-reader",
 "commit": "<sha>", "kit": "v1.0.0",
 "files": [{"target": "eswc", "games": ["eswc"], "file": "race-reader-eswc.dll",
            "sha256": "...", "size": 12345}]}
```

## What the hub does with it

The TM Horizon hub reads `hz-release.json` from the release. It picks the file
whose `games` list contains the detected game, checks the sha256 before
installing, and shows "not available for this game" if no file matches. The hub
never rebuilds or republishes other people's mods.

## What the targets mean

| Target | Games |
|---|---|
| `forever` | TMNF 2.11.26, TMUF 2.11.26, and TMLoader's TmForever 2.12.0 / 2.12.0-compat (code identical to TMNF) |
| `eswc` | TMN ESWC unofficial 1.80, and the original 1.80 with the Win10 patch |
| `sunrise` | TM Sunrise, Win10 repack |
| `original` | Not available yet (no exe analysed) |
| `all` | One DLL with every table (bigger) |

Each DLL still detects the exact build at runtime and stays off on unknown
builds.

## Licence rule

Only mods whose licence allows modification and redistribution may be ported or
rebuilt by others.

- No licence means all rights reserved. Ask the author first.
- Keep the original copyright and licence text in the port.
- A port by someone else goes back to the author as a pull request, never as a
  silent re-release.
- CI builds are only for repos that opted in, meaning repos that contain the
  caller workflow above.

## Limits

- CI cannot test in game. The game exes are not on the runners (licence and
  size), so a green build only means it compiled and is a 32-bit DLL.
- The atlas version is fixed at build time. A new game build needs a new atlas
  and a rebuild of the mod.
- Signing is not done.
