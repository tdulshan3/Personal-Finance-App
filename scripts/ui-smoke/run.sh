#!/usr/bin/env bash
# UI smoke run: build, seed a throwaway vault with synthetic data, serve the standalone build on
# 127.0.0.1, and drive headless Chrome through it. Never touches data/ or the real ledger.
#
#   npm run smoke:ui -- "/|mac|light" "/plan|ios|dark"                  screenshots (path|look|theme|height)
#   PFA_FLOWS=scripts/ui-smoke/flows.mjs npm run smoke:ui                every write path, both looks
#   PFA_FLOWS=scripts/ui-smoke/responsive.mjs npm run smoke:ui           which look each screen size gets
#   npm run smoke:ui -- --no-build ...                                   reuse the last build
#   PFA_NOSEED=1 PFA_NOUNLOCK=1 npm run smoke:ui -- "/setup|ios|light"   a fresh install
#
# Screenshots land in $PFA_SMOKE_OUT (default: a new /tmp/pfa-shots-* directory, printed at the end).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$HERE/../.." && pwd)"
OUT="${PFA_SMOKE_OUT:-$(mktemp -d /tmp/pfa-shots-XXXXXX)}"
mkdir -p "$OUT"
export PFA_SMOKE_OUT="$OUT"

if [ "${1:-}" = "--no-build" ]; then shift; else
  (cd "$APP" && npx next build > "$OUT/build.log" 2>&1) || { tail -40 "$OUT/build.log"; exit 1; }
fi
# Next does not copy static assets into the standalone output; a stale copy serves old CSS.
rm -rf "$APP/.next/standalone/.next/static"
cp -a "$APP/.next/static" "$APP/.next/standalone/.next/static"

DATA="$(mktemp -d /tmp/pfa-smoke-XXXXXX)"
SERVER=""
cleanup() { [ -n "$SERVER" ] && kill "$SERVER" 2>/dev/null || true; rm -rf "$DATA"; }
trap cleanup EXIT

if [ -z "${PFA_NOSEED:-}" ]; then
  PFA_DATA_DIR="$DATA" node "$HERE/seed.ts" > "$OUT/seed.log" 2>&1 || { cat "$OUT/seed.log"; exit 1; }
  tail -1 "$OUT/seed.log"
else
  echo '{}' > "$OUT/ids.json"
fi

PORT=$((4100 + RANDOM % 500))
(cd "$APP/.next/standalone" && PORT=$PORT HOSTNAME=127.0.0.1 PFA_DATA_DIR="$DATA" node server.js > "$OUT/server.log" 2>&1) &
SERVER=$!
for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT/api/health" > /dev/null && break; sleep 0.25; done
node "$HERE/drive.mjs" "http://127.0.0.1:$PORT" "$OUT" "$@"
grep -iE "error|warn" "$OUT/server.log" | head -20 || true
echo "screenshots: $OUT"
