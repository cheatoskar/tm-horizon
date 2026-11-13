# Hub secrets and settings

Everything comes from the environment: `apps/server/.env` in development (gitignored, from
`.env.example`), `/etc/tm-hub/hub.env` (mode 600, owner tmhub) on the server. Nothing secret is in
the repository; the server creates no production key by itself.

| Name | Secret | What | Who creates it |
|---|---|---|---|
| `HUB_INDEX_SIGNING_KEY` | **yes, the most important one** | Ed25519 private seed (base64) that signs the index the launcher trusts | me, with `npm run generate-key -w @tm-hub/server` on my PC; offline copy |
| `HUB_INDEX_PUBLIC_KEYS` | no | extra public keys listed at `/v1/index/keys` during a key change | — |
| `DATABASE_URL` | yes (password) | `postgres://tmhub:<password>@127.0.0.1:5432/tmhub` | me, at `createuser` |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | yes | Oracle "Customer Secret Key" for the bucket | OCI console |
| PAR URL in the nginx config | yes | read-only Pre-Authenticated Request for `/files/` | OCI console |
| `DISCORD_CLIENT_SECRET` | yes | Discord OAuth (also claims Discord-only mods for the poster's Discord id, `docs/hub/architecture.md`) | Discord developer portal |
| `GITHUB_CLIENT_SECRET` | yes | GitHub OAuth | GitHub OAuth app |
| `DISCORD_CLIENT_ID`, `GITHUB_CLIENT_ID` | no | OAuth app ids | same |
| `GITHUB_TOKEN` | yes | crawler token (public repos, read-only) | GitHub fine-grained token |
| `GITHUB_WEBHOOK_SECRET` | yes | HMAC of the GitHub App webhook | GitHub App settings |
| `DISCORD_WEBHOOK_URL` | yes | moderation channel posts | Discord channel settings |
| `VT_API_KEY` | yes | VirusTotal lookups | VirusTotal account |
| `TMF_ENABLED`, `TMF_LIVE` | no | both `1` switch on `GET /tmf/servers` (live contact with the Nadeo master server; default off) | me |
| `TMF_BOT_LOGIN`, `TMF_BOT_PASSWORD` | password: yes | separate bot account for the master server (`docs/tmf-master/risks.md`) | me |
| `HUB_ADMINS` | no | `discord:<id>,github:<id>` | me |
| `HUB_DEV_LOGIN` | — | development only; the server refuses to start with it in production | — |
| `POSTGRES_PASSWORD` | yes | docker-compose only | me |

Public keys (not secret): the index public key goes into the launcher (`PINNED_KEYS` in
`apps/launcher/src-tauri/src/hubindex.rs`); authors' public keys are uploaded in the portal.

## Key change for the index key

1. Generate a new key; add its public key to the launcher's `PINNED_KEYS` next to the old one and
   ship that launcher.
2. When most launchers have it (a few weeks), switch `HUB_INDEX_SIGNING_KEY` to the new key and
   restart; the index is re-signed at start (the cached one has a different key id).
3. Remove the old key from `PINNED_KEYS` in a later launcher release.

If the private key leaks: switch to a new key at once, ship a launcher that pins only the new key,
and post a notice. Launchers that still pin the old key would accept indexes signed with it, so the
leak window lasts until they update. (Possible later: a short-lived online key signed by an offline
root key, as `docs/mod-publishing.md` plans.)

## Rotating other secrets

OAuth secrets, S3 keys, GitHub token, webhook secrets: create the new one, put it into `hub.env`,
`systemctl restart tm-hub`, delete the old one at the provider. PAR: create the new PAR, change the
nginx config, `nginx -s reload`, delete the old PAR. Sessions survive restarts (database); to log
everyone out: `DELETE FROM sessions;`.

The launcher updater has its own key pair. It is not a server value: private key and password are GitHub Actions secrets (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`), the public key a variable (`TAURI_UPDATER_PUBKEY`). Steps in `docs/release.md`, "Updater signing (once)".
