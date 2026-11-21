#!/bin/bash
# Docker sets HOSTNAME to the container id. Next binds that name unless we override it.
set -euo pipefail

mkdir -p /data

if [[ -z "${PISCES_USERNAME:-}" ]]; then
  echo "pisces: set PISCES_USERNAME" >&2
  exit 1
fi

if [[ -z "${PISCES_PASSWORD_HASH:-}" ]]; then
  if [[ -z "${PISCES_PASSWORD:-}" ]]; then
    echo "pisces: set PISCES_PASSWORD or PISCES_PASSWORD_HASH" >&2
    exit 1
  fi
  PISCES_PASSWORD_HASH="$(printf '%s' "$PISCES_PASSWORD" | /usr/local/bin/pisces hash-password | tr -d '\r\n')"
  export PISCES_PASSWORD_HASH
fi
unset PISCES_PASSWORD || true

if [[ -z "${PISCES_JWT_SECRET:-}" ]]; then
  secret_file=/data/jwt_secret
  if [[ ! -s "$secret_file" ]]; then
    head -c 32 /dev/urandom | base64 -w 0 > "$secret_file"
    chmod 600 "$secret_file"
  fi
  PISCES_JWT_SECRET="$(tr -d '\r\n' < "$secret_file")"
  export PISCES_JWT_SECRET
fi

export HOSTNAME=0.0.0.0
export PORT="${PORT:-3000}"
export PISCES_BIND="${PISCES_BIND:-127.0.0.1:8787}"
export PISCES_DATA_DIR="${PISCES_DATA_DIR:-/data}"
export PISCES_API_URL="${PISCES_API_URL:-http://127.0.0.1:8787}"

/usr/local/bin/pisces &
api_pid=$!
node /app/server.js &
web_pid=$!

shutdown() {
  kill "$api_pid" "$web_pid" 2>/dev/null || true
  wait "$api_pid" "$web_pid" 2>/dev/null || true
}
trap shutdown INT TERM

set +e
wait -n "$api_pid" "$web_pid"
status=$?
set -e
shutdown
exit "$status"
