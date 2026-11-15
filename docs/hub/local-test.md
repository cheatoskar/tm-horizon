# Testing the hub locally (developer workflow)

One command starts the hub server (SQLite), the developer portal and the website on your machine. You sign in with made-up accounts ("Development login"), without a Discord or GitHub app. None of it is reachable from the network.

## One-time setup

In the repository folder (or in the worktree `tm-hub-mono-wt-legal`):

```
npm ci
```

Node 24 or newer (`node -v`).

## Start

```
npm run dev:hub
```

On the first start the script creates demo data (about 100 catalog projects, one demo project in every state, a report, a claim request) and builds the website data once. Afterwards the window shows:

```
================ TM Horizon hub: local test ================
  Portal   http://localhost:5174/   (Login > Development login > admin or author)
  Website  http://localhost:4321/   (legal pages: /de/impressum/, ...)
  API      http://127.0.0.1:8787/v1/index.json (signed index)
  Launcher (debug build): TMHUB_HUB_DEV_PUBKEYS=<key>
  ...
  DEVELOPMENT LOGIN IS ON (made-up accounts, this computer only)
```

Stop: **Ctrl+C** in that window (stops all three).
Start from scratch (empty database, new demo data): `npm run dev:hub -- --fresh`.
A second hub next to a running one (different ports): set `$env:PORTAL_PORT = "5184"; $env:HUB_PORT = "8797"; $env:WEB_PORT = "4331"` first (PowerShell); the portal is then `http://localhost:5184/`.
Without the website: `npm run dev:hub -- --no-web`.

Important: always open the portal as **`http://localhost:5174`**, not as `127.0.0.1:5174`. The server checks the origin of the request on every change; with `127.0.0.1`, saving and uploading fail.

## Step by step

### 1. Sign in as a developer

1. Open `http://localhost:5174/`. You land on "Log in".
2. In the yellow-bordered "Development login" box at the bottom, click **Author**. You are now `Dev Author`.

### 2. Paste a repository

1. Click **New project** on the left.
2. Paste a GitHub address and press **Preview**. The hub reads the name, description, license, README, images and the latest release.
3. If the release has several files, **pick the right one** under "Release file". (The portal also lets you import without choosing; the project then shows "Source needs a choice" and you pick the file later under **Sources** › "Use this file".)
4. Under "Games" tick at least one game, check the install type, **Import**.

Two examples I tested:

- `https://github.com/cheatoskar/TM-Vibrant-Shaders` – a TMLoader mod. Result: versions 1.4.2 and 1.4.3-rc.2 pass the checks, are "flagged" (first version of a new project, program file with network/keyboard hooks) and wait for approval.
- `https://github.com/cheatoskar/TMX-Downloader` – a **browser extension**. It is already in the hub as a catalog project (the preview then offers "Claim this project"). To see the import yourself, delete the catalog project from the local database first. With the type "Browser extension" the hub checks the file against the browser rules (`docs/hub/moderation.md`): the `.js` files are allowed, and the first version waits for approval as a new project.

Without a token, GitHub allows 60 requests per hour; an import needs about five. If you want to test more, set your own read token before starting: `$env:GITHUB_TOKEN = "<token>"` (PowerShell). It is not required.

### 3. Look at the checks and the queue

1. Open the **Versions** tab in the project: each version shows its status (review, held, published, rejected), file size, SHA-256 and the list of checks (reject / flag / info).
2. Click **Log out** at the bottom left.

### 4. Approve as admin

1. "Development login" again, this time **Admin**.
2. Click **Admin** on the left. At the top is the queue: new projects and suspicious updates ("review"), updates in the waiting period ("held"), claim requests, reports.
3. Click **Approve** on your version. It is published immediately.

### 5. Check the signed index

Open `http://127.0.0.1:8787/v1/index.json`. This is the index the launcher loads: `alg: ed25519`, `keyId`, `sig` and, inside it, `payload` with all published projects and versions. Your project is in there now. The public project page: **View page** in the portal (`/p/<name>`).

### 6. Point the launcher at the local hub (optional)

Only works with a **debug build** of the launcher (only that accepts `http://` and a development key):

```
cd apps/launcher
$env:TMHUB_HUB_DEV_PUBKEYS = "<key from the start message>"
npx tauri dev
```

Then turn on **Settings › TM Horizon Hub** in the launcher, enter `http://localhost:5174/` as the hub address and click **Refresh**. Below the switch you see the key, the index number and the number of projects. The key is stored in `apps/server/data/dev-index-key.txt` and stays the same until you delete that file.

Your installed launcher is not affected: it ships with the hub off and does not accept development keys.

### 7. Look at the legal texts

- Website: `http://localhost:4321/de/impressum/`, `/de/datenschutz/` (launcher section: `/de/datenschutz/#launcher`), `/de/nutzungsbedingungen/`; English without `/de/`. Links are in the footer of every page.
- Portal: footer "Impressum · Datenschutz · Nutzungsbedingungen", "English version" at the top.
- Open gaps are marked orange. List: `npm run check-legal`. What goes where: `docs/hub/legal/AUSFUELLEN.md`.

## What the Development login may and may not do

- It is only on if `HUB_DEV_LOGIN=1`, `NODE_ENV=development` **and** the server listens only on `127.0.0.1`. Otherwise the server does not start.
- Even then, the server accepts the login only from requests from this machine.
- In production (`NODE_ENV=production`) the server refuses to start as soon as `HUB_DEV_LOGIN` is set.
- `npm run dev:hub` reads no `.env` file and no secrets; all settings are in `scripts/dev-hub.mjs`. Data ends up in `apps/server/data/devhub.sqlite` and `apps/server/data/devhub-files/` (not in Git).

## If something does not work

| Problem | Fix |
|---|---|
| "Port 5174 is already in use" or `EADDRINUSE` | An old run is still going. Close the window, or end the `node.exe` with `dev-hub`, `vite` or `astro` in Task Manager. |
| Saving in the portal fails ("origin") | Open the portal via `http://localhost:5174`, not via `127.0.0.1`. |
| Preview reports a GitHub limit | Wait an hour or set `GITHUB_TOKEN` (see above). |
| Website shows no game images | The images are not in Git; `python apps/web/scripts/fetch-game-art.py` fetches them (see `apps/web/README.md`). Irrelevant for the legal texts. |
