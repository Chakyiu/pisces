#!/bin/bash
# Docker sets HOSTNAME to the container id. Next binds that name unless we override it.
set -euo pipefail

mkdir -p /data

# Username and password validation lives in the backend so there is one contract
# for the image and for `cargo run`; it hashes PISCES_PASSWORD itself at startup.

if [[ -z "${PISCES_JWT_SECRET:-}" ]]; then
  secret_file=/data/jwt_secret
  if [[ ! -s "$secret_file" ]]; then
    head -c 32 /dev/urandom | base64 -w 0 > "$secret_file"
    chmod 600 "$secret_file"
  fi
  PISCES_JWT_SECRET="$(tr -d '\r\n' < "$secret_file")"
  export PISCES_JWT_SECRET
fi

export HOSTNAME=127.0.0.1
export PISCES_BIND="${PISCES_BIND:-127.0.0.1:8787}"
export PISCES_DATA_DIR="${PISCES_DATA_DIR:-/data}"
export PISCES_API_URL="${PISCES_API_URL:-http://127.0.0.1:8787}"

/usr/local/bin/pisces &
api_pid=$!
HOSTNAME=127.0.0.1 PORT=3001 node /app/server.js &
web_pid=$!
PORT=3000 node /usr/local/bin/ws-bridge.mjs &
bridge_pid=$!

shutdown() {
  kill "$api_pid" "$web_pid" "$bridge_pid" 2>/dev/null || true
  wait "$api_pid" "$web_pid" "$bridge_pid" 2>/dev/null || true
}
trap shutdown INT TERM

set +e
wait -n "$api_pid" "$web_pid" "$bridge_pid"
status=$?
set -e
shutdown
exit "$status"
