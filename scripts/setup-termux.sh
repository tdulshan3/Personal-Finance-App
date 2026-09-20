#!/data/data/com.termux/files/usr/bin/bash
#
# setup-termux.sh — run this ON THE PHONE, inside Termux.
#
# Prepares the Samsung Galaxy S20 to host the personal finance app:
#
#   1. installs the Termux packages the app and its deploy path need
#   2. creates $PFA_HOME/{app,data,logs,native}
#   3. compiles better-sqlite3-multiple-ciphers on-device (see docs/adr/0002 — the PC's copy is the
#      wrong architecture, and this is the only thing that must be built here)
#   4. proves the encrypted-database path actually works, with a throwaway database
#   5. checks that termux-sms-list returns messages, and explains the silent-empty-list failure
#
# It is safe to re-run. It never touches $PFA_HOME/data.
#
# Usage:  bash setup-termux.sh [options]
#
# See ../docs/termux-setup.md for the full walkthrough.

set -euo pipefail

# ------------------------------------------------------------------------------------------------
# Configuration
# ------------------------------------------------------------------------------------------------

PFA_HOME="${PFA_HOME:-$HOME/personal-finance-app}"
# Keep this in step with the "better-sqlite3-multiple-ciphers" range in the repo's package.json.
SQLITE_PKG="better-sqlite3-multiple-ciphers"
SQLITE_VERSION="${PFA_SQLITE_VERSION:-^13.0.3}"

SKIP_PACKAGES=0
SKIP_SMS_CHECK=0
REBUILD_NATIVE=0

TERMUX_PACKAGES=(
  nodejs          # the runtime; the app ships as prebuilt JS so nothing else is compiled here
  termux-api      # provides termux-sms-list and friends (the *app* must be installed separately)
  openssh         # optional deploy transport: sshd on port 8022
  rsync           # used by the ssh deploy transport
  tar             # used by the adb deploy transport
  build-essential # clang/make/pkg-config: node-gyp needs these for the native sqlite module
  python          # node-gyp needs python3
  binutils        # ar/ranlib/strip for the native build
)

# ------------------------------------------------------------------------------------------------
# Output helpers
# ------------------------------------------------------------------------------------------------

step()  { printf '\n\033[1;34m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
ok()    { printf '    \033[32mok\033[0m    %s\n' "$*"; }
warn()  { printf '    \033[33mwarn\033[0m  %s\n' "$*"; }
info()  { printf '          %s\n' "$*"; }
fail()  { printf '\n\033[1;31mfailed:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: bash setup-termux.sh [options]

Options:
  --home DIR          Application root on the phone (default: $HOME/personal-finance-app)
  --skip-packages     Do not run "pkg install" (use when you already have the packages)
  --rebuild-native    Force a from-source rebuild of the native SQLite module.
                      Do this after a Termux "nodejs" major upgrade.
  --skip-sms-check    Do not call termux-sms-list
  -h, --help          Show this help

Environment:
  PFA_HOME            Same as --home
  PFA_SQLITE_VERSION  npm version range for better-sqlite3-multiple-ciphers (default: ^13.0.3)

This script never writes to, moves, or deletes $PFA_HOME/data.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --home)           [ $# -ge 2 ] || fail "--home needs a directory"; PFA_HOME="$2"; shift 2 ;;
    --skip-packages)  SKIP_PACKAGES=1; shift ;;
    --skip-sms-check) SKIP_SMS_CHECK=1; shift ;;
    --rebuild-native) REBUILD_NATIVE=1; shift ;;
    -h|--help)        usage; exit 0 ;;
    *)                usage >&2; fail "unknown option: $1" ;;
  esac
done

# ------------------------------------------------------------------------------------------------
# 0. Are we actually in Termux?
# ------------------------------------------------------------------------------------------------

step "Checking that this is Termux"

if [ -z "${PREFIX:-}" ] || [ ! -d "$PREFIX/bin" ]; then
  fail "\$PREFIX is not set or does not look like a Termux prefix.
    This script must run on the phone, inside the Termux app.
    To deploy from the PC, use scripts/deploy-to-termux.sh instead."
fi

case "$PREFIX" in
  */com.termux/*) ok "Termux prefix: $PREFIX" ;;
  *) warn "\$PREFIX is '$PREFIX', which is not the usual Termux path. Continuing anyway." ;;
esac

info "Android: $(getprop ro.build.version.release 2>/dev/null || echo unknown) \
(SDK $(getprop ro.build.version.sdk 2>/dev/null || echo unknown)), \
device $(getprop ro.product.device 2>/dev/null || echo unknown), \
abi $(getprop ro.product.cpu.abi 2>/dev/null || echo unknown)"

# ------------------------------------------------------------------------------------------------
# 1. Packages
# ------------------------------------------------------------------------------------------------

if [ "$SKIP_PACKAGES" -eq 1 ]; then
  step "Skipping package installation (--skip-packages)"
else
  step "Installing Termux packages"
  info "${TERMUX_PACKAGES[*]}"
  if ! pkg install -y "${TERMUX_PACKAGES[@]}"; then
    fail "pkg install failed.
    Most often this is no network, or stale repository metadata.
    Try:  pkg update && pkg upgrade
    then re-run this script."
  fi
  ok "packages installed"
fi

step "Verifying the toolchain"

missing=0
check_bin() {
  if command -v "$1" >/dev/null 2>&1; then
    ok "$1 -> $(command -v "$1")"
  else
    warn "$1 is NOT on PATH ($2)"
    missing=1
  fi
}

check_bin node  "install with: pkg install nodejs"
check_bin npm   "install with: pkg install nodejs"
check_bin clang "install with: pkg install build-essential"
check_bin make  "install with: pkg install build-essential"
check_bin tar   "install with: pkg install tar"

if command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1; then
  ok "python -> $(command -v python3 2>/dev/null || command -v python)"
else
  warn "python is NOT on PATH (install with: pkg install python) — node-gyp needs it"
  missing=1
fi

command -v rsync >/dev/null 2>&1 && ok "rsync -> $(command -v rsync)" \
  || warn "rsync missing — the ssh deploy transport will fall back to scp"
command -v sshd  >/dev/null 2>&1 && ok "sshd  -> $(command -v sshd)" \
  || warn "sshd missing — only the adb deploy transport will work"

[ "$missing" -eq 0 ] || fail "required tools are missing; see the warnings above"

info "node $(node --version), npm $(npm --version)"

# ------------------------------------------------------------------------------------------------
# 2. Directories
# ------------------------------------------------------------------------------------------------

step "Creating directories under $PFA_HOME"

mkdir -p "$PFA_HOME/app" "$PFA_HOME/logs" "$PFA_HOME/native"
ok "$PFA_HOME/app     (deployed build — overwritten by every deploy)"
ok "$PFA_HOME/logs    (server logs)"
ok "$PFA_HOME/native  (on-device native module build)"

# data/ is created but never rewritten: it holds the encrypted database (docs/adr/0003).
if [ -d "$PFA_HOME/data" ]; then
  ok "$PFA_HOME/data    (already exists — left exactly as it is)"
else
  mkdir -p "$PFA_HOME/data"
  ok "$PFA_HOME/data    (created)"
fi
chmod 700 "$PFA_HOME/data"

# ------------------------------------------------------------------------------------------------
# 3. Native SQLite module
# ------------------------------------------------------------------------------------------------

step "Building $SQLITE_PKG on-device"

NATIVE_DIR="$PFA_HOME/native"
NATIVE_MODULE="$NATIVE_DIR/node_modules/$SQLITE_PKG"

if [ ! -f "$NATIVE_DIR/package.json" ]; then
  cat > "$NATIVE_DIR/package.json" <<EOF
{
  "name": "pfa-native",
  "version": "1.0.0",
  "private": true,
  "description": "On-device build of the one native dependency. See docs/adr/0002 and 0003.",
  "dependencies": {
    "$SQLITE_PKG": "$SQLITE_VERSION"
  }
}
EOF
  info "wrote $NATIVE_DIR/package.json"
fi

info "this compiles SQLCipher from source and takes several minutes on a phone"
if ! ( cd "$NATIVE_DIR" && npm install --no-audit --no-fund ); then
  fail "npm install failed in $NATIVE_DIR.
    Usual causes:
      * build toolchain missing   -> pkg install build-essential python binutils
      * out of disk space         -> df -h \$HOME
      * no network                -> check Wi-Fi, then: pkg update"
fi

if [ "$REBUILD_NATIVE" -eq 1 ]; then
  info "forcing a from-source rebuild (--rebuild-native)"
  ( cd "$NATIVE_DIR" && npm rebuild "$SQLITE_PKG" --build-from-source )
fi

[ -d "$NATIVE_MODULE" ] || fail "$SQLITE_PKG is not in $NATIVE_DIR/node_modules after install"
ok "built at $NATIVE_MODULE"

# ------------------------------------------------------------------------------------------------
# 4. Prove the encrypted database path works
# ------------------------------------------------------------------------------------------------

step "Smoke-testing whole-database encryption"

SMOKE_DIR="$(mktemp -d "${TMPDIR:-$PREFIX/tmp}/pfa-smoke.XXXXXX")"
trap 'rm -rf "$SMOKE_DIR"' EXIT

if node -e '
  const path = require("path");
  const fs = require("fs");
  const Database = require(process.argv[1]);
  const file = path.join(process.argv[2], "smoke.db");
  const key = "throwaway-passphrase-not-a-real-key";

  // Write an encrypted database.
  let db = new Database(file);
  db.pragma("cipher = \x27sqlcipher\x27");
  db.pragma("key = \x27" + key + "\x27");
  db.exec("CREATE TABLE t (minor INTEGER NOT NULL)");
  db.prepare("INSERT INTO t (minor) VALUES (?)").run(345000n);
  db.close();

  // Reopen with the key: the row must come back, and come back as a BigInt (docs/adr/0006).
  db = new Database(file, { readonly: true });
  db.pragma("key = \x27" + key + "\x27");
  db.defaultSafeIntegers(true);
  const row = db.prepare("SELECT minor FROM t").get();
  db.close();
  if (typeof row.minor !== "bigint" || row.minor !== 345000n) {
    throw new Error("round trip returned " + typeof row.minor + " " + row.minor);
  }

  // Reopen WITHOUT the key: this must fail, otherwise nothing is actually encrypted.
  let leaked = false;
  try {
    const plain = new Database(file, { readonly: true });
    plain.prepare("SELECT minor FROM t").get();
    plain.close();
    leaked = true;
  } catch (err) { /* expected: file is not a database */ }
  if (leaked) throw new Error("the database was readable WITHOUT the key — it is not encrypted");

  // The header of an encrypted file must not be SQLite plaintext.
  const header = fs.readFileSync(file).subarray(0, 16).toString("latin1");
  if (header.startsWith("SQLite format 3")) {
    throw new Error("plaintext SQLite header found — the file is not encrypted");
  }
  console.log("encrypted round trip ok; bigint round trip ok; unkeyed read refused");
' "$NATIVE_MODULE" "$SMOKE_DIR"; then
  ok "SQLCipher encryption verified on this device"
else
  fail "the encryption smoke test failed.
    The native module loaded or built, but the encrypted round trip did not work.
    Do not put real data behind this until it passes. See docs/adr/0003."
fi

rm -rf "$SMOKE_DIR"
trap - EXIT

# ------------------------------------------------------------------------------------------------
# 5. Link the native module into the deployed app, if a build is already there
# ------------------------------------------------------------------------------------------------

step "Linking the native module into the deployed app"

APP_MODULES="$PFA_HOME/app/node_modules"
if [ -d "$PFA_HOME/app" ] && [ -f "$PFA_HOME/app/server.js" ]; then
  mkdir -p "$APP_MODULES"
  ln -sfn "$NATIVE_MODULE" "$APP_MODULES/$SQLITE_PKG"
  ok "$APP_MODULES/$SQLITE_PKG -> $NATIVE_MODULE"
else
  info "no build deployed yet ($PFA_HOME/app/server.js not found)."
  info "Run scripts/deploy-to-termux.sh on the PC; it re-creates this link on every deploy."
fi

# ------------------------------------------------------------------------------------------------
# 6. SMS capability
# ------------------------------------------------------------------------------------------------

if [ "$SKIP_SMS_CHECK" -eq 1 ]; then
  step "Skipping the SMS check (--skip-sms-check)"
else
  step "Checking termux-sms-list"

  sms_diagnostic() {
    cat <<'EOF'

    termux-sms-list did not return any messages.

    The usual cause is the appops entry, not the permission. Android's hard restriction on
    READ_SMS is enforced separately from the grant, and when it is active termux-sms-list
    returns an EMPTY LIST rather than an error. It looks exactly like "no messages".

    From a PC with adb, run BOTH of these — the second one is the one people forget:

        adb shell pm grant com.termux.api android.permission.READ_SMS
        adb shell appops set com.termux.api READ_SMS allow

    Then check what the device thinks:

        adb shell dumpsys package com.termux.api | grep READ_SMS
        adb shell appops get com.termux.api READ_SMS

    If "pm grant" itself fails, Termux:API was probably installed from Google Play. The Play
    build does not carry RESTRICTION_INSTALLER_EXEMPT and cannot be granted this way.
    Install the F-Droid build instead. See docs/termux-setup.md.

    If the inbox genuinely has no SMS, this is a false alarm — send yourself one and retry.
EOF
  }

  if ! command -v termux-sms-list >/dev/null 2>&1; then
    warn "termux-sms-list is not on PATH"
    info "install the package with: pkg install termux-api"
    info "AND install the Termux:API *app* from F-Droid — the package alone does nothing."
  else
    SMS_OUT="$(mktemp "${TMPDIR:-$PREFIX/tmp}/pfa-sms.XXXXXX")"
    trap 'rm -f "$SMS_OUT" "$SMS_OUT.err"' EXIT

    # -l 1 asks for a single row. Nothing here ever prints a message body: the JSON goes to a
    # temp file, node reports only the array length, and the file is deleted immediately.
    if timeout 30 termux-sms-list -l 1 >"$SMS_OUT" 2>"$SMS_OUT.err"; then
      COUNT="$(node -e '
        const fs = require("fs");
        try {
          const parsed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
          console.log(Array.isArray(parsed) ? parsed.length : "not-an-array");
        } catch { console.log("unparseable"); }
      ' "$SMS_OUT")"

      case "$COUNT" in
        0)
          warn "termux-sms-list returned [] — 0 messages"
          sms_diagnostic
          ;;
        unparseable|not-an-array)
          warn "termux-sms-list returned something that is not a JSON array"
          info "stderr: $(head -c 400 "$SMS_OUT.err" 2>/dev/null || true)"
          sms_diagnostic
          ;;
        *)
          ok "termux-sms-list returned $COUNT message(s) — SMS read access works"
          info "(no message content was read, printed or stored by this script)"
          ;;
      esac
    else
      warn "termux-sms-list failed or timed out"
      info "stderr: $(head -c 400 "$SMS_OUT.err" 2>/dev/null || true)"
      info "A hang usually means the Termux:API app is not installed, only the termux-api package."
      sms_diagnostic
    fi

    rm -f "$SMS_OUT" "$SMS_OUT.err"
    trap - EXIT
  fi
fi

# ------------------------------------------------------------------------------------------------

step "Done"
cat <<EOF
    Application root : $PFA_HOME
    Native module    : $NATIVE_MODULE
    Database dir     : $PFA_HOME/data  (never touched by setup or deploy)

    Next:
      1. On the PC:    npm run deploy:s20
      2. On the phone: bash $PFA_HOME/app/scripts/start-server.sh

    Still to do by hand — see docs/termux-setup.md:
      * battery optimisation exemption for Termux
      * Termux:Boot script, so the server comes back after a reboot
EOF
