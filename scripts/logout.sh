#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AUTH_STATE="$HOME/.config/syncclient/sync_data.json"
COOKIE_JAR="/tmp/syncclient-session-cookies.txt"
PAIR_LOCKS="$HOME/.config/syncclient/pair-locks"

echo "[Logout] Clearing local session cookies..."
rm -f "$COOKIE_JAR"

echo "[Logout] Clearing auth tokens from state..."
if [[ -f "$AUTH_STATE" ]]; then
  node -e "
    const fs = require('fs');
    const path = '$AUTH_STATE';
    try {
      const data = JSON.parse(fs.readFileSync(path, 'utf8'));
      const hadTokens = !!(data.googleAccessToken || data.googleRefreshToken || data.firebaseUser);
      delete data.googleAccessToken;
      delete data.googleRefreshToken;
      delete data.firebaseUser;
      fs.writeFileSync(path, JSON.stringify(data, null, 2));
      if (hadTokens) {
        console.log('[Logout] Auth tokens removed from state.');
      } else {
        console.log('[Logout] No auth tokens found in state.');
      }
    } catch (e) {
      console.log('[Logout] Could not update state:', e.message);
    }
  "
else
  echo "[Logout] No state file found."
fi

echo "[Logout] Clearing pair locks (optional)..."
if [[ -d "$PAIR_LOCKS" ]]; then
  rm -f "$PAIR_LOCKS"/*.lock
  echo "[Logout] Pair locks cleared."
fi

echo "[Logout] Done. Auth session is closed."
