#!/data/data/com.termux/files/usr/bin/sh
# The personal finance server, in Termux on the phone.
#
# Follows the conventions this phone already uses for termox, AdGuard, Immich and the two model
# servers (see ~/Projects/home-lab-dashboard/docs/OPERATIONS.md). Run it from a named tmux session:
#
#     tmux new-session -d -s =finance 'sh ~/finance/scripts/phone/finance.sh'
#     tmux attach -t =finance
#
#
# PORT
#
# 8090. The phone's other ports are taken:
#
#     3000  AdGuard Home          8081  llama.cpp, CPU
#     2283  Immich                8082  llama.cpp, GPU
#     8022  sshd                  8080  termox
#
# Next.js defaults to 3000, which would collide with AdGuard and fail with EADDRINUSE at a moment
# when the finance server looks like the thing that is broken.
#
#
# TMUX TARGETS
#
# Always `-t =finance`, with the equals sign. OPERATIONS.md records why: a tmux target with no
# exact match falls back to a prefix match, so `tmux kill-session -t finance` would also kill a
# session called `financexyz`. The equals sign pins it to an exact name.
#
#
# WHAT THIS DOES NOT DO
#
# It does not unlock the database. The server starts locked by design (ADR 0003/0007): the key is
# derived from the owner's passphrase and lives only in memory, so after every reboot somebody has
# to open the app and type it. Until then the server answers, shows the unlock screen, and captures
# nothing. That is the deliberate trade -- see ADR 0003 for what the alternative costs.
#
#
# PHANTOM PROCESS KILLER
#
# Android 12+ kills background processes past a device-wide limit of 32, and this phone already
# runs close to it. OPERATIONS.md has the fix, which needs adb once from a computer:
#
#     adb shell "settings put global settings_enable_monitor_phantom_procs false"
#
# Also add Termux to Battery > Never sleeping apps. Without both, this server is killed at random
# and the symptom looks like the app crashing.

set -eu

APP_DIR="${PFA_APP_DIR:-$HOME/finance/app}"
DATA_DIR="${PFA_DATA_DIR:-$HOME/finance/data}"
LOG_DIR="${PFA_LOG_DIR:-$HOME/finance/logs}"
PORT="${PFA_PORT:-8090}"

# Loopback by default. ADR 0007: the session cookie authenticates the browser, but the transport is
# plain HTTP, so the passphrase would cross the network in the clear. Binding to the LAN is an
# explicit choice, not the default.
HOST="${PFA_HOST:-127.0.0.1}"

die() { printf '%s\n' "$*" >&2; exit 1; }

[ -d "$APP_DIR" ] || die "No app at $APP_DIR. Deploy it first: npm run deploy:s20"
[ -f "$APP_DIR/server.js" ] || die "$APP_DIR has no server.js. The standalone build did not arrive."
[ -f "$APP_DIR/start.js" ] || die "$APP_DIR has no start.js. Copy scripts/phone/start.js beside server.js."

mkdir -p "$DATA_DIR" "$LOG_DIR"

# The native SQLite module is compiled on the phone and symlinked in; the deploy never ships it,
# because the PC's build is x86-64 and would overwrite the phone's arm64 one.
NATIVE_LINK="$APP_DIR/node_modules/better-sqlite3-multiple-ciphers"
if [ ! -e "$NATIVE_LINK" ]; then
  die "The native SQLite module is missing. Run scripts/setup-termux.sh on the phone."
fi

# Hold the CPU awake. Without this Android suspends Termux and the scheduled SMS scan stops,
# which looks like messages silently going missing.
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock || printf 'warning: could not take a wake lock\n' >&2
fi
trap 'command -v termux-wake-unlock >/dev/null 2>&1 && termux-wake-unlock || true' EXIT INT TERM

cd "$APP_DIR"

export NODE_ENV=production
export PFA_DATA_DIR="$DATA_DIR"
export PORT="$PORT"
export HOSTNAME="$HOST"

printf 'personal finance: http://%s:%s   data=%s\n' "$HOST" "$PORT" "$DATA_DIR"
if [ "$HOST" = "0.0.0.0" ]; then
  printf 'warning: bound to the LAN over plain HTTP. The passphrase crosses the network in the clear.\n' >&2
fi

# Four threads is the right number on a Snapdragon 865 for anything CPU-bound alongside the model
# servers; core 0 is left for everything else, matching what tune.sh does for llama.cpp.
if command -v taskset >/dev/null 2>&1; then
  exec taskset -c 1-3 node start.js 2>&1 | tee -a "$LOG_DIR/finance.log"
fi
exec node start.js 2>&1 | tee -a "$LOG_DIR/finance.log"
