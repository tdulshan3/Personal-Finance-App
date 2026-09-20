# 0003 — SQLite encryption with a passphrase-derived key, because there is no Keystore

- **Status:** Accepted
- **Date:** 2026-09-20
- **Supersedes:** `buildspec.md` §18 "At-rest protection and app lifecycle" (the Keystore parts)
- **Related:** [0001](0001-nextjs-node-on-termux-instead-of-kotlin-compose.md), [0002](0002-build-on-pc-deploy-standalone-to-phone.md)

## Context

`buildspec.md` §18 says: *"Generate a random database key and wrap it using Android Keystore."* §17
requires the **whole** database encrypted — main file, WAL, journal and any full-text index — and
warns that an encrypted main file does not make unencrypted caches safe. §18 also asks for app lock
with device authentication, and for a documented policy on whether background capture runs while
locked.

Android Keystore is not reachable from a Termux process. There is no API for it in Node, no
`termux-*` command that wraps a key with hardware-backed material, and no way to bind a key to
device unlock or to biometric authentication from here. The Keystore half of §18 is simply not
available in this stack.

The remaining options were:

1. **Key file on disk next to the database.** Trivially defeats the encryption — anyone who can read
   the database can read the key.
2. **Key from an environment variable in the start script.** Same problem, plus the key leaks into
   the process table and shell history.
3. **Key derived from a passphrase the owner types.** No stored secret, but the server cannot start
   unattended with the database already open.

## Decision

Use **SQLite via `better-sqlite3-multiple-ciphers`** (SQLCipher-compatible, whole-database
encryption including WAL and journal) with the key derived at login from a passphrase the owner
types.

- **KDF:** `scrypt` from Node's built-in `node:crypto`. No native Argon2 dependency — every extra
  native module is another thing that has to compile on the phone against bionic
  ([ADR 0002](0002-build-on-pc-deploy-standalone-to-phone.md)). scrypt is memory-hard, is in the
  standard library, and its parameters (`N`, `r`, `p`) are stored alongside a random per-install
  salt so they can be raised later without invalidating existing databases.
- **The server starts locked.** `node server.js` comes up with no key and no open database. Every
  route that touches finance data returns "locked" until the owner unlocks.
- **The key is held in memory only**, for the lifetime of the server process. It is never written to
  disk, never logged, never placed in an environment variable, never included in an audit payload,
  and never sent to either model endpoint.
- **Locking clears it**: the derived key is zeroed and the database handle closed on explicit lock
  and on process exit.
- **Backups do not reuse this key.** Per §18, encrypted backups get their own independently
  recoverable password with a random salt and recorded algorithm parameters, so a backup can be
  restored on another device that has no access to this install's salt.
- `better-sqlite3-multiple-ciphers` is the project's **only** native dependency, and it is built on
  the phone by `scripts/setup-termux.sh` (`npm install` / `npm rebuild` under Termux's clang).

## Consequences

### This is weaker than the buildspec's design. Concretely:

- **No hardware-backed key protection.** A Keystore-wrapped key cannot be extracted from the secure
  element even with full filesystem access. A scrypt-derived key can be brute-forced offline by
  anyone who copies the database file, at whatever cost the scrypt parameters impose. The passphrase
  is the entire security margin — a weak passphrase means weak encryption.
- **An attacker with the unlocked device and the running process can reach the key.** It is in the
  Node heap. Anyone who can read that process's memory, attach a debugger, or run code as the
  Termux user while the server is unlocked has the key and therefore the database. Android's per-app
  data isolation is what keeps other apps out; root, an exploit, or a Termux session opened by
  someone holding the unlocked phone all defeat it.
- **No device-authentication binding.** §18's "require recent owner authentication to decrypt
  finance data" cannot be enforced by the OS. It can only be an application-level session timeout,
  which a compromised process ignores.
- **No unattended restart.** After a reboot or an OEM kill, Termux:Boot can restart the server but
  the server comes up **locked**. Background capture, extraction and bill state do not advance until
  the owner unlocks. This is §18's "strict lock mode" by necessity, not by choice, and the app must
  show source-coverage gaps honestly (§23's data-health screen).
- **The passphrase is unrecoverable.** Lose it and the database is gone. The encrypted backup's
  separate password is the only recovery path, and it has to be stored somewhere else.

### What we get

- Whole-database encryption including WAL, which §17 explicitly requires and which a
  naive "encrypt the main file" approach would miss.
- No secret at rest anywhere on the device. A stolen, powered-off phone yields a file that is
  useless without the passphrase.
- One native dependency instead of two or three.
