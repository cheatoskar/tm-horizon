# Deploying the hub on the Oracle box

Target: my Oracle Cloud VM (Ubuntu, 4 cores, ~11 GB RAM free, ~19 GB disk free) that also runs other
sites. The hub gets its own Unix user, systemd service, database, subdomain and nginx server block;
files live in Oracle Object Storage behind an nginx cache. Nothing here has been run against the
server yet. Files referenced: `apps/server/deploy/`.

Budget on the box: Node ~150-300 MB RAM, Postgres ~150 MB, nginx file cache up to 8 GB on disk
(`max_size=8g`, lower it if the disk gets tight), logs a few MB.

## 0. What I need first

| Item | Where | Notes |
|---|---|---|
| Subdomain, e.g. `hub.<domain>` | DNS: A/AAAA record to the VM | TLS with certbot |
| Discord OAuth app | discord.com/developers | Redirect `https://hub.<domain>/auth/discord/callback`, scope `identify` |
| GitHub OAuth app | GitHub > Settings > Developer settings > OAuth Apps | Callback `https://hub.<domain>/auth/github/callback`; no scopes needed |
| GitHub token for the crawler | fine-grained token, "Public repositories (read-only)" | `GITHUB_TOKEN`; 5000 requests/hour |
| Optional GitHub App | GitHub > Developer settings > GitHub Apps | Webhook URL `https://hub.<domain>/hooks/github`, secret = `GITHUB_WEBHOOK_SECRET`, permission "Contents: read", event "Release"; `GITHUB_APP_SLUG` |
| Object Storage bucket | OCI console > Storage > Buckets | private bucket, e.g. `tm-hub-files`, Standard tier |
| Customer Secret Key | OCI console > My profile > Customer secret keys | S3 access key id + secret for `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` |
| Pre-Authenticated Request (read) | Bucket > Pre-Authenticated Requests | "Objects with prefix", access "Permit object reads", no listing, long expiry (note the date in my calendar) |
| Index signing key | `npm run generate-key -w @tm-hub/server` on my PC | private part only into `hub.env`, keep an offline copy; public part into the launcher (`PINNED_KEYS`) |
| Discord webhook for moderation | a private channel > Integrations > Webhooks | `DISCORD_WEBHOOK_URL` |
| VirusTotal API key (optional) | virustotal.com account | `VT_API_KEY` (public API: 4 lookups/minute, 500/day) |
| Impressum c/o address, contact e-mail | booked service | fill `docs/hub/legal/*.md` before going live |

S3 endpoint: `https://<namespace>.compat.objectstorage.<region>.oraclecloud.com`, region e.g.
`eu-frankfurt-1` (`S3_REGION`). The namespace is shown on the tenancy page.

## 1. User, folders, Node

```sh
sudo adduser --system --group --home /srv/tm-hub tmhub
sudo mkdir -p /srv/tm-hub/app /srv/tm-hub/portal /var/lib/tm-hub /etc/tm-hub
sudo chown tmhub:tmhub /srv/tm-hub/app /var/lib/tm-hub
sudo chmod 750 /etc/tm-hub
# Node 24 (NodeSource or the distro's nodejs 24 package)
node -v   # v24.x
```

## 2. PostgreSQL (own database and user)

```sh
sudo apt install postgresql
sudo -u postgres createuser --pwprompt tmhub        # long random password
sudo -u postgres createdb --owner tmhub tmhub
# listen only on localhost (default on Ubuntu); pg_hba: host tmhub tmhub 127.0.0.1/32 scram-sha-256
```

## 3. Code and configuration

```sh
sudo -u tmhub git clone <repo> /srv/tm-hub/app     # or rsync a release checkout
cd /srv/tm-hub/app && sudo -u tmhub npm ci --omit=dev -w @tm-hub/server -w @tm-hub/shared
sudo install -m 600 -o tmhub -g tmhub /dev/null /etc/tm-hub/hub.env
sudoedit /etc/tm-hub/hub.env    # from apps/server/.env.example, see docs/hub/secrets.md
```

`hub.env` for production (values in `<>`):

```
NODE_ENV=production
HOST=127.0.0.1
PORT=8787
HUB_PUBLIC_URL=https://hub.<domain>/
HUB_PORTAL_URL=https://hub.<domain>/
DATABASE_URL=postgres://tmhub:<password>@127.0.0.1:5432/tmhub
STORAGE=s3
FILES_PUBLIC_URL=https://hub.<domain>/files/
S3_ENDPOINT=https://<namespace>.compat.objectstorage.<region>.oraclecloud.com
S3_REGION=<region>
S3_BUCKET=tm-hub-files
S3_ACCESS_KEY_ID=<...>
S3_SECRET_ACCESS_KEY=<...>
HUB_INDEX_SIGNING_KEY=<private seed>
DISCORD_CLIENT_ID=<...>
DISCORD_CLIENT_SECRET=<...>
GITHUB_CLIENT_ID=<...>
GITHUB_CLIENT_SECRET=<...>
HUB_ADMINS=discord:<my user id>,github:<my user id>
GITHUB_TOKEN=<...>
DISCORD_WEBHOOK_URL=<...>
TRUST_PROXY=1
# optional, off by default: live TMNF/TMUF server list (GET /tmf/servers), needs both
# TMF_ENABLED=1
# TMF_LIVE=1
# TMF_BOT_LOGIN=<...>
# TMF_BOT_PASSWORD=<...>
```

The server refuses to start in production without the signing key, with `HUB_DEV_LOGIN` set, or
with http URLs.

## 4. systemd

```sh
sudo cp apps/server/deploy/tm-hub.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now tm-hub
journalctl -u tm-hub -f       # "[hub] listening on http://127.0.0.1:8787 (production, db postgres, storage s3)"
curl -s http://127.0.0.1:8787/healthz
```

Migrations run at every start. First data: `sudo -u tmhub sh -c 'set -a; . /etc/tm-hub/hub.env; cd /srv/tm-hub/app/apps/server && node scripts/import-catalog.ts'` (add `--crawl` once the GitHub token is in).

## 5. Portal

Build on my PC (`VITE_WEB_URL=https://<website> npm run build -w @tm-hub/portal`; without it the portal's "Docs" link goes to `/dev/` on the portal's own host, which does not exist) and copy `apps/portal/dist/` to
`/srv/tm-hub/portal/` (owner root, readable by nginx).

## 6. nginx and TLS

```sh
sudo cp apps/server/deploy/tm-hub-proxy.conf /etc/nginx/snippets/
sudo cp apps/server/deploy/nginx-tm-hub.conf /etc/nginx/sites-available/tm-hub
sudoedit /etc/nginx/sites-available/tm-hub      # domain, <PAR-URL>, region host
sudo chmod 640 /etc/nginx/sites-available/tm-hub && sudo chown root:www-data /etc/nginx/sites-available/tm-hub
sudo mkdir -p /var/cache/nginx/tm-hub-files /var/cache/nginx/tm-hub-api
sudo certbot certonly --nginx -d hub.<domain>
sudo ln -s /etc/nginx/sites-available/tm-hub /etc/nginx/sites-enabled/ && sudo nginx -t && sudo systemctl reload nginx
sudo cp apps/server/deploy/logrotate-tm-hub /etc/logrotate.d/tm-hub
```

The `/files/` location reads from the bucket through the read-only PAR and caches for 60 days
(objects never change). Check a hit: `curl -sI https://hub.<domain>/files/<key> | grep X-Cache`.
With the free tier's ~50k requests a month, almost all traffic must be cache hits; the upload
side needs one HEAD and one PUT per new file.

### Website image proxy (/ext-img/)

The website never lets visitors' browsers load pictures from other servers (their IP address would go
there without consent). Every remote picture is referenced same-origin under `/ext-img/` (the mapping is
`packages/shared/src/extimg.ts`; a picture from any other host is not shown at all):

| Path | Upstream | Used for |
|---|---|---|
| `/ext-img/igdb/<image>.<ext>` | `images.igdb.com/igdb/image/upload/t_cover_big_2x/...` (528x748) | covers of every game (`packages/shared/src/covers.ts`) |
| `/ext-img/steam/<appid>/<file>` | `cdn.cloudflare.steamstatic.com/steam/apps/...` | hero, header, logo |
| `/ext-img/gh-raw/<owner>/<repo>/<ref>/<path>` | `raw.githubusercontent.com` | showcase and README pictures |
| `/ext-img/gh-rel/<owner>/<repo>/<tag>/<file>` | `github.com/.../releases/download/...`, one redirect to GitHub's file hosts | showcase pictures as release assets |
| `/ext-img/gh-att/<uuid>` | `github.com/user-attachments/assets/...`, one redirect to `private-user-images.githubusercontent.com` | README pictures |
| `/ext-img/imgur/<id>.<ext>` | `i.imgur.com` | showcase pictures |
| `/ext-img/gametdb/<region>/<id>.png` | `art.gametdb.com/wii/cover/...` | Wii cover (launcher) |
| `/ext-img/tmx/<site>/<track id>/thumbnail` or `image/<1-9>` | `trackshow/<id>/...` on `tmnf.exchange`, `tmuf.exchange`, `nations.`/`sunrise.`/`original.tm-exchange.com` (site = tmnf, tmuf, nations, sunrise, original) | track thumbnails (launcher, website); same rate limit as everything under `/ext-img/` |

nginx fetches them from that strict allowlist and caches them:

```sh
sudo cp apps/web/deploy/ext-img-cache.conf /etc/nginx/conf.d/
sudo cp apps/web/deploy/ext-img.conf apps/web/deploy/ext-img-fetch.conf apps/web/deploy/ext-img-picture-type.conf /etc/nginx/snippets/
sudo mkdir -p /var/cache/nginx/ext-img && sudo chown www-data: /var/cache/nginx/ext-img
sudoedit /etc/nginx/sites-available/<website>   # inside its server { }: include snippets/ext-img.conf;
sudo nginx -t && sudo systemctl reload nginx
curl -sI https://<domain>/ext-img/igdb/co1pa6.webp | grep -iE 'HTTP/|content-type|x-cache'   # 200, image/..., MISS then HIT
curl -sI https://<domain>/ext-img/steam/11020/header.jpg | grep -i 'HTTP/'                     # 200
curl -sI https://<domain>/ext-img/gh-raw/TwinkieTweaks/TwinkieForever/HEAD/Media/tAd.png | grep -iE 'HTTP/|content-type'   # 200 image/png
curl -sI 'https://<domain>/ext-img/igdb/../../etc/passwd' | grep -i 'HTTP/'                    # 404
curl -sI https://<domain>/ext-img/other/x.png | grep -i 'HTTP/'                                 # 404
```

Rules in the snippets: only the path patterns above (no free host or path); GET/HEAD only; no query string
and no client header goes upstream (fixed user agent `TM-Horizon-Website-ImageCache/1`, no cookies, no
forwarded IP); github.com redirects are followed once and only to `objects.`, `release-assets.` or
`private-user-images.githubusercontent.com`, every other redirect and every error becomes a 404; GitHub and
Imgur pictures are sent with the picture type of their extension, never the upstream's; every answer carries
`X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`; good answers are
cached 30 days (1 GB zone, 90 days inactive), answers of 10 MB or more (IGDB, Steam) or 5 MB or more (GitHub,
Imgur) are not cached. The resolver is systemd-resolved (`127.0.0.53`); change it in `ext-img-fetch.conf` if the
box uses another.
Without the proxy (`astro dev`) the pages fall back to our own designed covers.

## 7. Backups

The bucket holds every file; the database goes there too:

```sh
sudo apt install rclone postgresql-client
sudo -u tmhub rclone config     # remote "oci": S3, provider Other, endpoint = S3_ENDPOINT, keys from hub.env
# systemd timer or cron for tmhub: 30 3 * * * /srv/tm-hub/app/apps/server/deploy/backup.sh
```

Restore: `gunzip -c <dump> | psql "$DATABASE_URL"` into an empty database. Keep a copy of
`HUB_INDEX_SIGNING_KEY` offline: losing it means shipping a launcher update with a new pinned key.

## 8. Docker instead of systemd (alternative)

`apps/server/deploy/docker-compose.yml` runs the API and its own Postgres; nginx stays on the host
as above. `POSTGRES_PASSWORD` goes into `hub.env`. Not built on my PC (no Docker there).

## 9. Updates

```sh
cd /srv/tm-hub/app && sudo -u tmhub git pull && sudo -u tmhub npm ci --omit=dev -w @tm-hub/server -w @tm-hub/shared
sudo systemctl restart tm-hub
```

## 10. Going live checklist

1. Legal pages filled (name, c/o address, e-mail, supervisory authority, retention periods match logrotate/backup), checked by someone who knows German law: `npm run check-legal -- --strict` passes, `docs/hub/legal/AUSFUELLEN.md` is done. The hub's own request log goes to journald with client IPs: set `MaxRetentionSec=7day` in `/etc/systemd/journald.conf` so it matches the 7 days in the privacy policy.
2. Production public key in `apps/launcher/src-tauri/src/hubindex.rs` `PINNED_KEYS`, launcher release built.
3. `HUB_ADMINS` with my ids; log in once with Discord and GitHub; admin page visible.
4. Upload a test version, watch the 60-minute hold notice in the Discord channel, download through `/dl/`.
5. Turn on "TM Horizon Hub" in a launcher's settings with `https://hub.<domain>/`.
