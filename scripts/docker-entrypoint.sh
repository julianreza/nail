#!/bin/sh
set -eu

read_secret() {
  name="$1"
  path="/run/secrets/$2"
  if [ ! -r "$path" ]; then
    printf '%s\n' "Required Docker secret is unavailable" >&2
    exit 1
  fi
  value=$(cat "$path")
  if [ -z "$value" ]; then
    printf '%s\n' "Required Docker secret is empty" >&2
    exit 1
  fi
  export "$name=$value"
  unset value
}

read_secret OWNER_PASSWORD_HASH owner_password_hash
read_secret SESSION_SECRET session_secret
read_secret NAIL_SECRET_ENCRYPTION_KEY nail_secret_encryption_key
read_secret DATABASE_URL database_url

mkdir -p /var/lib/nail/secrets
chown -R 10001:10001 /var/lib/nail
chmod 0700 /var/lib/nail /var/lib/nail/secrets

exec setpriv \
  --bounding-set=-all \
  --inh-caps=-all \
  --ambient-caps=-all \
  --reuid=10001 \
  --regid=10001 \
  --clear-groups \
  "$@"
