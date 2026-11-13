#!/bin/sh
# Nightly database backup into the bucket (the bucket doubles as the off-disk backup).
# Run as user tmhub from a systemd timer or cron: /srv/tm-hub/app/apps/server/deploy/backup.sh
# Needs pg_dump and rclone with a remote "oci" (S3 provider "Other", endpoint = S3_ENDPOINT,
# the hub's Customer Secret Key). Hub files are already in the bucket.
set -eu
set -a; . /etc/tm-hub/hub.env; set +a
stamp=$(date -u +%Y-%m-%dT%H%M)
out=/var/lib/tm-hub/backup-$stamp.sql.gz
pg_dump --no-owner --dbname="$DATABASE_URL" | gzip -9 > "$out"
rclone copyto "$out" "oci:$S3_BUCKET/backups/db/$stamp.sql.gz"
rm -f "$out"
# Keep 30 days of dumps in the bucket.
rclone delete --min-age 30d "oci:$S3_BUCKET/backups/db/"
