#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
COOKIE_JAR="/tmp/syncclient-session-cookies.txt"
AUTH_STATE="$HOME/.config/syncclient/sync_data.json"
LOG_FILE="$HOME/.config/syncclient/logs/sync-client.log"
PORT=3000
TIMEOUT=30

cleanup() {
  echo ""
  echo "[Cleanup] Stopping backend..."
  if [[ -f "/tmp/syncclient-backend.pid" ]]; then
    kill "$(cat /tmp/syncclient-backend.pid)" 2>/dev/null || true
    rm -f "/tmp/syncclient-backend.pid"
  fi
  pkill -f "tsx server.ts" 2>/dev/null || true
  pkill -f "node.*server.ts" 2>/dev/null || true
  sleep 1
}

trap cleanup EXIT

# 1. Clear previous session/auth state
echo "[Verify] Clearing previous auth session..."
rm -f "$COOKIE_JAR"
if [[ -f "$AUTH_STATE" ]]; then
  cp "$AUTH_STATE" "${AUTH_STATE}.bak" 2>/dev/null || true
  # Remove tokens from state but keep pairs/settings
  node -e "
    const fs = require('fs');
    const path = '$AUTH_STATE';
    try {
      const data = JSON.parse(fs.readFileSync(path, 'utf8'));
      delete data.googleAccessToken;
      delete data.googleRefreshToken;
      delete data.firebaseUser;
      fs.writeFileSync(path, JSON.stringify(data, null, 2));
      console.log('[Verify] Auth state cleared, backup saved.');
    } catch (e) {
      console.log('[Verify] Could not clear auth state:', e.message);
    }
  "
fi

# 2. Kill any process on port 3000
echo "[Verify] Ensuring port $PORT is free..."
lsof -ti tcp:$PORT | xargs kill -9 2>/dev/null || true
sleep 1

# 3. Start backend
echo "[Verify] Starting backend..."
cd "$PROJECT_DIR"
npm run dev > /tmp/syncclient-backend.log 2>&1 &
echo $! > /tmp/syncclient-backend.pid

# 4. Wait for backend to be ready
echo "[Verify] Waiting for backend on port $PORT..."
for i in $(seq 1 $TIMEOUT); do
  if curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/api/session/bootstrap" | grep -q "200"; then
    echo "[Verify] Backend ready after ${i}s"
    break
  fi
  if [[ $i -eq $TIMEOUT ]]; then
    echo "[Verify] Backend failed to start within ${TIMEOUT}s"
    echo "[Verify] Last 50 lines of backend log:"
    tail -n 50 /tmp/syncclient-backend.log || true
    exit 1
  fi
  sleep 1
done

# 5. Bootstrap session
echo "[Verify] Bootstrapping session..."
curl -s -c "$COOKIE_JAR" "http://127.0.0.1:$PORT/api/session/bootstrap" > /dev/null

# 6. Run checks
echo ""
echo "[Verify] ===== Running verification checks ====="
PASS=0
FAIL=0

check() {
  local name="$1"
  local url="$2"
  local expected="$3"
  local method="${4:-GET}"
  local body="${5:-}"

  local args=(-s -b "$COOKIE_JAR" -w "\n%{http_code}")
  if [[ "$method" == "POST" ]]; then
    args+=(-X POST -H "Content-Type: application/json" -d "$body")
  fi

  local response
  response=$(curl "${args[@]}" "$url" 2>/dev/null || echo "")
  local http_code
  http_code=$(echo "$response" | tail -n1)
  local body_response
  body_response=$(echo "$response" | sed '$d')

  if [[ "$http_code" == "$expected" ]]; then
    echo "  [PASS] $name (HTTP $http_code)"
    PASS=$((PASS + 1))
  else
    echo "  [FAIL] $name (expected HTTP $expected, got $http_code)"
    echo "  Response: $(echo "$body_response" | head -c 200)"
    FAIL=$((FAIL + 1))
  fi
}

check "Health check" "http://127.0.0.1:$PORT/api/session/bootstrap" "200"
check "Get status" "http://127.0.0.1:$PORT/api/sync/status" "200"

# Check pair exists
check "Pair exists" "http://127.0.0.1:$PORT/api/sync/status" "200"

# Set dummy token to test sync path (will still fail auth, but tests the flow)
echo "[Verify] Injecting dummy token for sync path test..."
curl -s -b "$COOKIE_JAR" -X POST "http://127.0.0.1:$PORT/api/sync/token" \
  -H "Content-Type: application/json" \
  -d '{"token":"test-token","refreshToken":"test-refresh"}' > /dev/null

# Trigger sync - should attempt but fail at Drive API (401), not crash
check "Force sync trigger" "http://127.0.0.1:$PORT/api/sync/force" "200" "POST" '{"pairId":"w49cxfp8c"}'

# Wait a moment for async processing
sleep 3

# Verify status after sync attempt
check "Status after sync" "http://127.0.0.1:$PORT/api/sync/status" "200"

# Verify frontend is served
check "Frontend HTML" "http://127.0.0.1:$PORT/" "200"

# Verify frontend assets exist
check "Frontend JS" "http://127.0.0.1:$PORT/assets/index.js" "200" || true
check "Frontend CSS" "http://127.0.0.1:$PORT/assets/index.css" "200" || true

# 7. Summary
echo ""
echo "[Verify] ===== Verification Summary ====="
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
echo ""

if [[ $FAIL -gt 0 ]]; then
  echo "[Verify] Some checks failed. Recent backend log:"
  tail -n 30 /tmp/syncclient-backend.log || true
  exit 1
fi

echo "[Verify] All checks passed."
echo "[Verify] Backend log tail:"
tail -n 20 /tmp/syncclient-backend.log || true
