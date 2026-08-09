#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

exec 9>/tmp/syncclient-launch.lock
flock -n 9 || {
  echo "SyncClient ya está ejecutándose."
  exit 1
}

electron . --no-sandbox
