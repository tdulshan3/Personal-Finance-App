#!/data/data/com.termux/files/usr/bin/bash
#
# start-server.sh — run this ON THE PHONE, inside Termux.
#
# Starts the deployed Next.js standalone server, holding a wake lock so Android does not suspend
# the process (there is no WorkManager here — see docs/adr/0001 and docs/adr/0004; if Termux dies,
# SMS capture stops silently until someone notices).
#
# ---------------------------------------------------------------------------------------------
# BIND ADDRESS
# ---------------------------------------------------------------------------------------------
# Default is 127.0.0.1: reachable only from this phone. Exposing the server on the LAN needs the
# explicit --expose-lan flag, and it should stay unused for now.
#
# buildspec.md §16 requires authenticated, scoped, revision-checked access to these contracts, and
# §18 requires a future network adapter to "authenticate paired clients, encrypt transport, scope
# access, enforce the same confirmations, and defend browser-origin/CSRF paths". None of that is
# built yet. Until it is, a LAN bind puts an unauthenticated finance database on the network, and
# the database key is in this process's memory (docs/adr/0003).
#
# buildspec.md §3 goes further and says not to add a public HTTP server to the phone at all. We
# did, for the reasons in docs/adr/0001, which makes the loopback default part of the bargain.
# ---------------------------------------------------------------------------------------------
#
# Usage:  bash start-server.sh [options]

set -euo pipefail

# ------------------------------------------------------------------------------------------------
# Configuration
# ------------------------------------------------------------------------------------------------

PFA_HOME="${PFA_HOME:-$HOME/personal-finance-app}"
BIND="${PFA_BIND:-127.0.0.1}"
PORT="${PFA_PORT:-3000}"
EXPOSE_LAN=0
WAKE_LOCK=1

step() { printf '\n\033[1;34m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
ok()   { printf '    \033[32mok\033[0m    %s\n' "$*"; }
warn() { printf '    \033[33mwarn\033[0m  %s\n' "$*"; }
info() { printf '          %s\n' "$*"; }
fail() { printf '\n\033[1;31mfailed:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: bash start-server.sh [options]

Options:
  --home DIR       Application root (default: $HOME/personal-finance-app)
  --port PORT      Port to listen on (default: 3000)
  --bind ADDR      Address to bind (default: 127.0.0.1).
                   Any non-loopback address also requires --expose-lan.
  --expose-lan     Bind 0.0.0.0 and accept connections from the local network.
                   Do not use this until the app has authentication. See the comment at the
                   top of this script, and buildspec.md §16 and §18.
  --no-wake-lock   Do not acquire termux-wake-lock (the phone may suspend the server)
  -h, --help       Show this help

Environment: PFA_HOME, PFA_BIND, PFA_PORT
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --home)         [ $# -ge 2 ] || fail "--home needs a directory"; PFA_HOME="$2"; shift 2 ;;
    --port)         [ $# -ge 2 ] || fail "--port needs a value"; PORT="$2"; shift 2 ;;
    --bind)         [ $# -ge 2 ] || fail "--bind needs an address"; BIND="$2"; shift 2 ;;
    --expose-lan)   EXPOSE_LAN=1; shift ;;
    --no-wake-lock) WAKE_LOCK=0; shift ;;
    -h|--help)      usage; exit 0 ;;
    *)              usage >&2; fail "unknown option: $1" ;;
  esac
done

APP_DIR="$PFA_HOME/app"
DATA_DIR="$PFA_HOME/data"
LOG_DIR="$PFA_HOME/logs"
LOG_FILE="$LOG_DIR/server.log"

# ------------------------------------------------------------------------------------------------
# Bind policy
# ------------------------------------------------------------------------------------------------

if [ "$EXPOSE_LAN" -eq 1 ]; then
  # Only override the bind if the caller did not name one explicitly.
  [ "$BIND" = "127.0.0.1" ] && BIND="0.0.0.0"
  warn "LISTENING ON $BIND — every device on this network can reach the app"
  warn "there is no authentication yet (buildspec.md §16, §18). Do not leave this running."
else
  case "$BIND" in
    127.0.0.1|::1|localhost) ;;
    *) fail "refusing to bind '$BIND' without --expose-lan.
    Loopback is the default for a reason: the server has no authentication yet, and the
    database key lives in its memory (docs/adr/0003). If you really mean it:
      bash start-server.sh --bind $BIND --expose-lan" ;;
  esac
fi

# ------------------------------------------------------------------------------------------------
# Preflight
# ------------------------------------------------------------------------------------------------

step "Preflight"

[ -f "$APP_DIR/server.js" ] || fail "no build found at $APP_DIR/server.js
    Deploy from the PC first:  npm run deploy:s20"
ok "build:  $APP_DIR/server.js"

command -v node >/dev/null 2>&1 || fail "node is not installed. Run: bash scripts/setup-termux.sh"
ok "node:   $(node --version)"

NATIVE_LINK="$APP_DIR/node_modules/better-sqlite3-multiple-ciphers"
if [ -e "$NATIVE_LINK" ]; then
  ok "sqlite: $NATIVE_LINK"
else
  warn "the native SQLite module is not linked into the build"
  info "run:  bash $PFA_HOME/app/scripts/setup-termux.sh"
  info "the server will start, but anything touching the database will fail"
fi

mkdir -p "$DATA_DIR" "$LOG_DIR"
chmod 700 "$DATA_DIR"
ok "data:   $DATA_DIR"
ok "log:    $LOG_FILE"

# ------------------------------------------------------------------------------------------------
# Wake lock
# ------------------------------------------------------------------------------------------------

WAKE_LOCK_HELD=0

release_wake_lock() {
  if [ "$WAKE_LOCK_HELD" -eq 1 ]; then
    termux-wake-unlock >/dev/null 2>&1 || true
    WAKE_LOCK_HELD=0
    printf '\n    wake lock released\n'
  fi
}
trap release_wake_lock EXIT INT TERM

if [ "$WAKE_LOCK" -eq 1 ]; then
  step "Acquiring wake lock"
  if command -v termux-wake-lock >/dev/null 2>&1; then
    if termux-wake-lock; then
      WAKE_LOCK_HELD=1
      ok "held (released when this script exits)"
      info "Android still needs Termux exempted from battery optimisation — see docs/termux-setup.md"
    else
      warn "termux-wake-lock failed; Android may suspend this process"
    fi
  else
    warn "termux-wake-lock not found. Install with: pkg install termux-api"
  fi
else
  warn "running without a wake lock (--no-wake-lock); Android may suspend this process"
fi

# ------------------------------------------------------------------------------------------------
# Run
# ------------------------------------------------------------------------------------------------

step "Starting the server"
info "http://$BIND:$PORT"
info "the server starts LOCKED — the database key is derived from your passphrase at login"
info "(docs/adr/0003). Ctrl-C stops it and releases the wake lock."

# Next's standalone server.js reads HOSTNAME and PORT from the environment.
export HOSTNAME="$BIND"
export PORT
export NODE_ENV=production
export PFA_DATA_DIR="$DATA_DIR"

{
  printf '\n=== %s  start  bind=%s port=%s ===\n' "$(date -Iseconds)" "$BIND" "$PORT"
} >> "$LOG_FILE"

# No `exec`: the EXIT trap has to survive so the wake lock is always released. pipefail makes the
# pipeline report node's exit status rather than tee's.
cd "$APP_DIR"
node server.js 2>&1 | tee -a "$LOG_FILE"
