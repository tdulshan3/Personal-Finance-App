#!/usr/bin/env bash
#
# deploy-to-termux.sh — run this ON THE PC.
#
# Builds the app and ships it to the Samsung Galaxy S20 running Termux.
#
# Why a deploy step at all: Next.js compiles with SWC, whose prebuilt binaries target glibc/musl
# and will not load against Termux's bionic libc. So the phone never compiles anything. We build
# here, and copy a tree that starts with a plain `node server.js`. See docs/adr/0002.
#
# Two transports:
#   adb  (default)  USB. adb cannot write into Termux's private home directory, so this pushes a
#                   tarball to shared storage and prints the one command to run in Termux.
#   ssh             Direct. Needs sshd running in Termux on port 8022. rsync when available,
#                   otherwise scp of a tarball. This is the smoother option once it is set up.
#
# Safety properties:
#   * idempotent — re-running with no source changes copies nothing new
#   * $PFA_REMOTE_HOME/data is OUTSIDE the synced tree, so no mode of this script can reach the
#     encrypted database. Not even --prune.
#   * node_modules/better-sqlite3-multiple-ciphers is excluded from the payload, because the phone
#     has its own on-device build and the PC's copy is the wrong architecture (docs/adr/0002).
#
# Usage:  bash scripts/deploy-to-termux.sh [options]
#         npm run deploy:s20

set -euo pipefail

# ------------------------------------------------------------------------------------------------
# Defaults (every one of these is overridable by flag or environment)
# ------------------------------------------------------------------------------------------------

TRANSPORT="${PFA_TRANSPORT:-adb}"

# The Termux home directory. Termux's $HOME is always this path on a non-rooted device.
REMOTE_HOME="${PFA_REMOTE_HOME:-/data/data/com.termux/files/home/personal-finance-app}"

SSH_HOST="${PFA_SSH_HOST:-}"
SSH_PORT="${PFA_SSH_PORT:-8022}"
SSH_USER="${PFA_SSH_USER:-}"

ADB_SERIAL="${PFA_ADB_SERIAL:-}"
SDCARD_DIR="${PFA_SDCARD_DIR:-/sdcard/Download}"

SKIP_BUILD=0
PRUNE=0
DRY_RUN=0

NATIVE_PKG="better-sqlite3-multiple-ciphers"
PAYLOAD_NAME="pfa-deploy.tar.gz"

# ------------------------------------------------------------------------------------------------
# Output helpers
# ------------------------------------------------------------------------------------------------

step() { printf '\n\033[1;34m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
ok()   { printf '    \033[32mok\033[0m    %s\n' "$*"; }
warn() { printf '    \033[33mwarn\033[0m  %s\n' "$*"; }
info() { printf '          %s\n' "$*"; }
fail() { printf '\n\033[1;31mfailed:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: bash scripts/deploy-to-termux.sh [options]

Transport:
  --transport adb|ssh   How to reach the phone (default: adb)

adb options:
  --serial ID           adb device serial, when more than one device is attached
  --sdcard-dir PATH     Staging directory on shared storage (default: /sdcard/Download)

ssh options:
  --host HOST           Phone's LAN address or hostname (required for ssh)
  --port PORT           sshd port in Termux (default: 8022)
  --user USER           ssh username (Termux prints it with `whoami`; usually optional)
  --prune               Also delete files on the phone that no longer exist in the build.
                        Only ever touches the app directory; data/ is outside it.

General:
  --remote-home PATH    Application root on the phone
                        (default: /data/data/com.termux/files/home/personal-finance-app)
  --skip-build          Reuse the existing .next/standalone output
  --dry-run             Show what would be transferred, transfer nothing
  -h, --help            Show this help

Environment: PFA_TRANSPORT, PFA_REMOTE_HOME, PFA_SSH_HOST, PFA_SSH_PORT, PFA_SSH_USER,
             PFA_ADB_SERIAL, PFA_SDCARD_DIR

Examples:
  npm run deploy:s20
  bash scripts/deploy-to-termux.sh --transport ssh --host 192.168.1.42
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --transport)   [ $# -ge 2 ] || fail "--transport needs adb or ssh"; TRANSPORT="$2"; shift 2 ;;
    --host)        [ $# -ge 2 ] || fail "--host needs a value"; SSH_HOST="$2"; shift 2 ;;
    --port)        [ $# -ge 2 ] || fail "--port needs a value"; SSH_PORT="$2"; shift 2 ;;
    --user)        [ $# -ge 2 ] || fail "--user needs a value"; SSH_USER="$2"; shift 2 ;;
    --serial)      [ $# -ge 2 ] || fail "--serial needs a value"; ADB_SERIAL="$2"; shift 2 ;;
    --sdcard-dir)  [ $# -ge 2 ] || fail "--sdcard-dir needs a value"; SDCARD_DIR="$2"; shift 2 ;;
    --remote-home) [ $# -ge 2 ] || fail "--remote-home needs a value"; REMOTE_HOME="$2"; shift 2 ;;
    --skip-build)  SKIP_BUILD=1; shift ;;
    --prune)       PRUNE=1; shift ;;
    --dry-run)     DRY_RUN=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    *)             usage >&2; fail "unknown option: $1" ;;
  esac
done

case "$TRANSPORT" in
  adb|ssh) ;;
  *) fail "--transport must be 'adb' or 'ssh', not '$TRANSPORT'" ;;
esac

# ------------------------------------------------------------------------------------------------
# Guard rails on the remote paths
# ------------------------------------------------------------------------------------------------

# Trim trailing slashes so the path guards below cannot be defeated by "…/personal-finance-app/".
REMOTE_HOME="${REMOTE_HOME%/}"

case "$REMOTE_HOME" in
  ""|"/"|"/data"|"/data/data") fail "refusing to use '$REMOTE_HOME' as the application root" ;;
  */data)                      fail "the application root must not be a directory called 'data'
    '$REMOTE_HOME' looks like the database directory. Pass the app root instead, e.g.
    --remote-home /data/data/com.termux/files/home/personal-finance-app" ;;
  /*) ;;
  *) fail "--remote-home must be an absolute path, got '$REMOTE_HOME'" ;;
esac

REMOTE_APP="$REMOTE_HOME/app"    # the deployed build; replaced on every deploy
REMOTE_DATA="$REMOTE_HOME/data"  # the encrypted database; NEVER touched by this script

# ------------------------------------------------------------------------------------------------
# Locate the repository
# ------------------------------------------------------------------------------------------------

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

[ -f "$REPO_ROOT/package.json" ] || fail "no package.json in $REPO_ROOT — is this the repo root?"

step "Personal Finance App -> S20"
info "repo        $REPO_ROOT"
info "transport   $TRANSPORT"
info "app dir     $REMOTE_APP"
info "data dir    $REMOTE_DATA  (never written by this script)"

# ------------------------------------------------------------------------------------------------
# 1. Build
# ------------------------------------------------------------------------------------------------

if [ "$SKIP_BUILD" -eq 1 ]; then
  step "Skipping build (--skip-build)"
else
  step "Building (next build, output: standalone)"
  ( cd "$REPO_ROOT" && npm run build ) || fail "npm run build failed; nothing was deployed"
  ok "build complete"
fi

STANDALONE="$REPO_ROOT/.next/standalone"
[ -f "$STANDALONE/server.js" ] || fail "$STANDALONE/server.js not found.
    next.config.ts must set  output: \"standalone\"  — check it, then rebuild without --skip-build."

# ------------------------------------------------------------------------------------------------
# 2. Stage the payload
# ------------------------------------------------------------------------------------------------
#
# `next build` does not trace .next/static or public/ into the standalone output. Copying them in
# is not optional: without them the app 404s its own JS, CSS and images.

step "Staging the payload"

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/pfa-stage.XXXXXX")"
cleanup() { rm -rf "$STAGE" "$STAGE.tar.gz"; }
trap cleanup EXIT

cp -a "$STANDALONE/." "$STAGE/"
ok "standalone server + traced node_modules"

if [ -d "$REPO_ROOT/.next/static" ]; then
  mkdir -p "$STAGE/.next/static"
  cp -a "$REPO_ROOT/.next/static/." "$STAGE/.next/static/"
  ok ".next/static"
else
  warn ".next/static is missing — the app will load without its client assets"
fi

if [ -d "$REPO_ROOT/public" ]; then
  mkdir -p "$STAGE/public"
  cp -a "$REPO_ROOT/public/." "$STAGE/public/"
  ok "public/"
else
  info "no public/ directory — skipping"
fi

# The phone needs start-server.sh, and setup-termux.sh for later re-runs.
mkdir -p "$STAGE/scripts"
cp -a "$REPO_ROOT/scripts/." "$STAGE/scripts/"
chmod +x "$STAGE/scripts/"*.sh 2>/dev/null || true
ok "scripts/"

# The native module: the phone builds its own and setup-termux.sh symlinks it in. Shipping the
# PC's x86-64 build would overwrite the working arm64 one with a binary that cannot load.
if [ -e "$STAGE/node_modules/$NATIVE_PKG" ]; then
  rm -rf "$STAGE/node_modules/$NATIVE_PKG"
  ok "excluded node_modules/$NATIVE_PKG (the phone has its own build)"
fi

PAYLOAD_SIZE="$(du -sh "$STAGE" | cut -f1)"
info "payload size: $PAYLOAD_SIZE"

# ------------------------------------------------------------------------------------------------
# 3. Transfer
# ------------------------------------------------------------------------------------------------

# Re-creates the symlink from the deployed tree to the on-device native build. Run after every
# deploy, because the deploy replaces node_modules/.
RELINK_CMD="mkdir -p '$REMOTE_APP/node_modules' && ln -sfn '$REMOTE_HOME/native/node_modules/$NATIVE_PKG' '$REMOTE_APP/node_modules/$NATIVE_PKG'"

if [ "$TRANSPORT" = "ssh" ]; then
  # ----------------------------------------------------------------------------------------------
  step "Transferring over ssh"

  [ -n "$SSH_HOST" ] || fail "ssh transport needs a host: --host 192.168.1.42 (or PFA_SSH_HOST)"
  command -v ssh >/dev/null 2>&1 || fail "ssh is not installed on this machine"

  SSH_TARGET="$SSH_HOST"
  [ -n "$SSH_USER" ] && SSH_TARGET="$SSH_USER@$SSH_HOST"
  SSH_OPTS=(-p "$SSH_PORT")

  info "target $SSH_TARGET:$SSH_PORT"

  if ! ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "mkdir -p '$REMOTE_APP' '$REMOTE_HOME/logs'"; then
    fail "could not reach the phone over ssh.
    In Termux, check that sshd is running:   sshd
    Find the phone's address in Termux with: ifconfig
    Termux's sshd listens on 8022, not 22, and needs a key or a password set with \`passwd\`."
  fi
  ok "connected; app directory exists"

  REMOTE_HAS_RSYNC=0
  ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "command -v rsync >/dev/null 2>&1" && REMOTE_HAS_RSYNC=1

  if command -v rsync >/dev/null 2>&1 && [ "$REMOTE_HAS_RSYNC" -eq 1 ]; then
    RSYNC_ARGS=(-a --human-readable --itemize-changes)
    # data/ is a sibling of the sync root, not inside it, so --delete cannot reach it. The
    # exclusions below are belt-and-braces in case someone repoints --remote-home. Each pattern
    # is anchored with a leading slash so it matches only at the transfer root — an unanchored
    # "data/" would also match something like .next/server/app/data/.
    # rsync does not delete excluded paths on the receiver, so --prune cannot remove them either.
    RSYNC_ARGS+=(--exclude "/data/" --exclude "/logs/" --exclude "/node_modules/$NATIVE_PKG")
    [ "$PRUNE" -eq 1 ] && RSYNC_ARGS+=(--delete) && info "pruning stale files in $REMOTE_APP"
    [ "$DRY_RUN" -eq 1 ] && RSYNC_ARGS+=(--dry-run) && info "DRY RUN — nothing will be written"

    rsync "${RSYNC_ARGS[@]}" -e "ssh -p $SSH_PORT" "$STAGE/" "$SSH_TARGET:$REMOTE_APP/" \
      || fail "rsync failed; the phone may hold a partial copy. Re-run this script."
    ok "rsync complete"
  else
    warn "rsync unavailable on $( [ "$REMOTE_HAS_RSYNC" -eq 1 ] && echo "this machine" || echo "the phone" ) — falling back to scp"
    [ "$PRUNE" -eq 1 ] && warn "--prune is ignored by the scp fallback"
    if [ "$DRY_RUN" -eq 1 ]; then
      info "DRY RUN — would scp $PAYLOAD_SIZE to $SSH_TARGET:$REMOTE_APP/"
    else
      tar -czf "$STAGE.tar.gz" -C "$STAGE" .
      scp -P "$SSH_PORT" "$STAGE.tar.gz" "$SSH_TARGET:$REMOTE_HOME/$PAYLOAD_NAME" \
        || { rm -f "$STAGE.tar.gz"; fail "scp failed"; }
      rm -f "$STAGE.tar.gz"
      ssh "${SSH_OPTS[@]}" "$SSH_TARGET" \
        "tar -xzf '$REMOTE_HOME/$PAYLOAD_NAME' -C '$REMOTE_APP' && rm -f '$REMOTE_HOME/$PAYLOAD_NAME'" \
        || fail "extracting the payload on the phone failed"
      ok "scp + extract complete"
    fi
  fi

  if [ "$DRY_RUN" -eq 0 ]; then
    ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "$RELINK_CMD" \
      && ok "native module relinked" \
      || warn "could not relink the native module. Run setup-termux.sh on the phone."
  fi

  step "Deployed"
  cat <<EOF
    On the phone, restart the server:

        bash $REMOTE_APP/scripts/start-server.sh

    The server starts LOCKED (docs/adr/0003) and binds 127.0.0.1 unless you pass --expose-lan.
EOF

else
  # ----------------------------------------------------------------------------------------------
  step "Transferring over adb"

  command -v adb >/dev/null 2>&1 || fail "adb is not installed on this machine.
    Install Android platform-tools, or use the ssh transport:
      bash scripts/deploy-to-termux.sh --transport ssh --host <phone-ip>"

  ADB=(adb)
  [ -n "$ADB_SERIAL" ] && ADB=(adb -s "$ADB_SERIAL")

  DEVICES="$("${ADB[@]}" devices | awk 'NR>1 && $2=="device" {print $1}')"
  DEVICE_COUNT="$(printf '%s\n' "$DEVICES" | grep -c . || true)"

  if [ "$DEVICE_COUNT" -eq 0 ]; then
    fail "no adb device is attached and authorised.
    Check the USB cable, enable USB debugging on the phone, and accept the RSA prompt.
      adb devices"
  elif [ "$DEVICE_COUNT" -gt 1 ] && [ -z "$ADB_SERIAL" ]; then
    fail "more than one adb device is attached. Pick one with --serial:
$(printf '      %s\n' $DEVICES)"
  fi
  ok "device: $(printf '%s' "$DEVICES" | head -n1)"

  if [ "$DRY_RUN" -eq 1 ]; then
    info "DRY RUN — would push $PAYLOAD_SIZE to $SDCARD_DIR/$PAYLOAD_NAME"
    exit 0
  fi

  info "packing $PAYLOAD_SIZE"
  tar -czf "$STAGE.tar.gz" -C "$STAGE" .

  "${ADB[@]}" shell "mkdir -p '$SDCARD_DIR'" >/dev/null 2>&1 || true
  if ! "${ADB[@]}" push "$STAGE.tar.gz" "$SDCARD_DIR/$PAYLOAD_NAME"; then
    rm -f "$STAGE.tar.gz"
    fail "adb push failed.
    adb cannot write into Termux's private directory, so it pushes to shared storage instead.
    If '$SDCARD_DIR' is not writable, pass a different one with --sdcard-dir."
  fi
  rm -f "$STAGE.tar.gz"
  ok "pushed to $SDCARD_DIR/$PAYLOAD_NAME"

  # adb cannot finish the job: /data/data/com.termux/files/home is not readable by the shell user,
  # so the last step has to run inside Termux. Termux reaches shared storage through
  # ~/storage/shared, which termux-setup-storage creates.
  case "$SDCARD_DIR" in
    /sdcard)                 TERMUX_PAYLOAD="\$HOME/storage/shared/$PAYLOAD_NAME" ;;
    /sdcard/*)               TERMUX_PAYLOAD="\$HOME/storage/shared/${SDCARD_DIR#/sdcard/}/$PAYLOAD_NAME" ;;
    /storage/emulated/0)     TERMUX_PAYLOAD="\$HOME/storage/shared/$PAYLOAD_NAME" ;;
    /storage/emulated/0/*)   TERMUX_PAYLOAD="\$HOME/storage/shared/${SDCARD_DIR#/storage/emulated/0/}/$PAYLOAD_NAME" ;;
    *)                       TERMUX_PAYLOAD="$SDCARD_DIR/$PAYLOAD_NAME" ;;
  esac

  step "Finish on the phone"
  cat <<EOF
    adb cannot write into Termux's home directory, so run this in Termux to install the build:

        mkdir -p '$REMOTE_APP' \\
          && tar -xzf $TERMUX_PAYLOAD -C '$REMOTE_APP' \\
          && $RELINK_CMD \\
          && bash '$REMOTE_APP/scripts/start-server.sh'

    If ~/storage does not exist yet, run \`termux-setup-storage\` first and grant the prompt.
    If that path is wrong on your device, the tarball is also reachable at:
        $SDCARD_DIR/$PAYLOAD_NAME

    The server starts LOCKED (docs/adr/0003) and binds 127.0.0.1 unless you pass --expose-lan.
EOF
fi
