#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

exec 9>/tmp/syncclient-launch.lock
flock -n 9 || {
  echo "SyncClient ya está ejecutándose."
  exit 1
}

SYNCCLIENT_V2=true node dist/server.cjs &
server_pid=$!

cleanup() {
  kill "$server_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for _ in $(seq 1 30); do
  if curl --silent --fail --max-time 2 http://127.0.0.1:3000/api/session/bootstrap >/dev/null; then
    electron . --no-sandbox
    exit $?
  fi
  sleep 0.5
done

echo "El backend de SyncClient no inició en el puerto 3000." >&2
exit 1
