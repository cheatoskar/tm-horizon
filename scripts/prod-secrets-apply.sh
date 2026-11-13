#!/usr/bin/env bash
# Puts the production keys from a local file into /etc/tm-hub/prod.env on the box (docs/hub/production.md,
# "Keys"). The file is streamed over ssh into a root-only merge script; it is never printed, never copied
# to a file on the box (nothing to clean up there), and only these names are taken:
#   DISCORD_CLIENT_ID DISCORD_CLIENT_SECRET GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET GITHUB_TOKEN VT_API_KEY
#   DISCORD_WEBHOOK_URL GITHUB_WEBHOOK_SECRET GITHUB_APP_SLUG S3_ENDPOINT S3_REGION S3_ACCESS_KEY_ID
#   S3_SECRET_ACCESS_KEY BACKUP_S3_BUCKET
# Then the hub restarts, /healthz and the login start pages are checked (status and target host only).
#
#   scripts/prod-secrets-apply.sh [file]      default: ~/.tm-horizon/prod-secrets.env
#
# Delete the local file afterwards (the script asks nothing and does not delete it).
set -euo pipefail
FILE=${1:-$HOME/.tm-horizon/prod-secrets.env}
HOST=${PROD_HOST:-ubuntu@130.61.136.54}
SSH=(ssh -o BatchMode=yes "$HOST")
[ -f "$FILE" ] || { echo "no file $FILE" >&2; exit 1; }

# Names only (values are cut off before anything is shown).
names=$(sed -nE 's/^[[:space:]]*(export[[:space:]]+)?([A-Z0-9_]+)[[:space:]]*=.*/\2/p' "$FILE" | tr '\n' ' ')
echo "keys in the file: ${names:-none}"

"${SSH[@]}" "sudo /usr/local/sbin/tm-horizon-prod-secrets-merge" < "$FILE"

"${SSH[@]}" 'set -e
  sudo systemctl restart tm-hub-prod
  for i in $(seq 1 30); do curl -fsS http://127.0.0.1:8788/healthz >/dev/null 2>&1 && break; sleep 1; done
  if ! curl -fsS http://127.0.0.1:8788/healthz >/dev/null 2>&1; then
    echo "hub NOT healthy after the restart:" >&2; sudo journalctl --namespace=tm-horizon -u tm-hub-prod -n 20 --no-pager >&2; exit 1
  fi
  echo "hub healthy; login providers: $(curl -fsS http://127.0.0.1:8788/v1/config | python3 -c "import json,sys; print(\",\".join(json.load(sys.stdin)[\"providers\"]) or \"none\")")"
  for p in discord github; do
    r=$(curl -s -o /dev/null -w "%{http_code} %{redirect_url}" -H "Host: hub.tm-horizon.com" -H "X-Forwarded-Proto: https" http://127.0.0.1:8788/auth/$p/start)
    code=${r%% *}; host=$(printf "%s" "${r#* }" | sed -E "s#^https?://([^/]+).*#\1#")
    echo "  /auth/$p/start: $code ${host:-(no redirect)}"
  done'
