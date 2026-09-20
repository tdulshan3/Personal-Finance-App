# Termux setup on the Galaxy S20

This is the one-time setup that turns the phone into the app's server and database authority. It
assumes you are a developer but have never used Termux.

**Target device:** Samsung Galaxy S20, SM-G981U1 (codename `x1q`), Android 13 / SDK 33, arm64-v8a.
Other devices will mostly work; the Samsung-specific battery steps will not match.

**Time:** about 45 minutes, most of it waiting for the native SQLite module to compile.

**What you need:** the phone, a USB cable, and a PC with this repo checked out and `adb` installed.

> Steps 1, 2 and 4 are the ones that have been verified on this device. Everything after that is
> written from the documented behaviour of the tools involved and is **untested on device** — treat
> the verification commands as the thing that decides, not the instructions.

---

## Overview

| # | Step | Where |
|---|---|---|
| 1 | Install Termux, Termux:API, Termux:Boot | Phone (F-Droid) |
| 2 | Install Termux packages | Phone (Termux) |
| 3 | Grant shared-storage access | Phone (Termux) |
| 4 | Grant SMS permission — **two commands** | PC (adb) |
| 5 | Run `setup-termux.sh` | Phone (Termux) |
| 6 | Deploy the app | PC |
| 7 | Keep Termux alive: wake lock + battery | Both |
| 8 | Restart on reboot with Termux:Boot | Phone |
| 9 | Optional: sshd for nicer deploys | Phone |

---

## 1. Install the apps — from F-Droid, not Play

Install all three from **[F-Droid](https://f-droid.org/)**:

- **Termux**
- **Termux:API**
- **Termux:Boot**

### Why F-Droid specifically

`READ_SMS` is a *hard-restricted* permission on modern Android. It can only be granted to an app
whose installer marked it exempt. On this device, `com.termux.api` carries
`RESTRICTION_INSTALLER_EXEMPT` because it was sideloaded through
`com.google.android.packageinstaller`.

A **Play-installed Termux:API does not have that exemption**, and step 4's `pm grant` will simply
fail. There is no workaround short of reinstalling from F-Droid.

All three must come from the same source — Termux add-ons only talk to a Termux installed with the
same signing key. Mixing a Play Termux with an F-Droid Termux:API silently does nothing.

### Verify

Open Termux. You should get a shell prompt. Then, from the PC:

```bash
adb shell pm list packages | grep termux
```

Expect `com.termux`, `com.termux.api` and `com.termux.boot`.

Launch **Termux:API** and **Termux:Boot** once each from the launcher. Termux:Boot in particular
does nothing at all until it has been opened once.

---

## 2. Install the Termux packages

In Termux:

```bash
pkg update && pkg upgrade
pkg install -y nodejs termux-api openssh rsync tar build-essential python binutils
```

What each one is for:

| Package | Why |
|---|---|
| `nodejs` | Runs the app. The app ships as prebuilt JavaScript — nothing is compiled on the phone except the item below. |
| `termux-api` | Provides `termux-sms-list`, `termux-wake-lock`, etc. **The commands only work if the Termux:API *app* is also installed.** |
| `build-essential`, `python`, `binutils` | node-gyp's toolchain. Needed once, to compile `better-sqlite3-multiple-ciphers` against bionic libc. See [ADR 0002](adr/0002-build-on-pc-deploy-standalone-to-phone.md). |
| `openssh`, `rsync` | Optional deploy transport (step 9). |
| `tar` | Unpacks the deploy payload from the adb transport. |

`setup-termux.sh` in step 5 installs these too, so you can skip ahead if you prefer — but you need
`tar` before you can extract the payload that carries the script.

### Verify

```bash
node --version && npm --version && clang --version | head -1
```

---

## 3. Grant shared-storage access

`adb push` cannot write into Termux's private home directory (`/data/data/com.termux/files/home` is
not readable by adb's `shell` user), so deploys land on shared storage and Termux picks them up from
there.

```bash
termux-setup-storage
```

Grant the Android permission prompt that appears.

### Verify

```bash
ls ~/storage/shared
```

You should see the usual `Download`, `DCIM`, `Pictures` and so on.

---

## 4. Grant SMS permission — both commands

This is the step that goes wrong quietly. Run **both** of these from the PC:

```bash
adb shell pm grant com.termux.api android.permission.READ_SMS
adb shell appops set com.termux.api READ_SMS allow
```

**The second command is not optional.** Android enforces the hard restriction on `READ_SMS` through
appops, separately from the permission grant. With the grant but without the appops entry,
`termux-sms-list` returns an **empty JSON array rather than an error**. It looks exactly like an
empty inbox, and nothing anywhere reports a problem.

### Verify

From the PC:

```bash
adb shell dumpsys package com.termux.api | grep READ_SMS
adb shell appops get com.termux.api READ_SMS
```

Expect `granted=true` from the first, and `allow` from the second.

Then, in Termux — the test that actually matters:

```bash
termux-sms-list -l 1
```

You should get a JSON array containing one message. If you get `[]`, go back and run the appops
command; see [Troubleshooting](#troubleshooting).

### Notes on this device

- The default SMS role holder here is **`com.samsung.android.messaging`** (Samsung Messages), not
  Google Messages. That is fine — a non-default app holding `READ_SMS` reads the same system
  provider. The buildspec's assumption of Google Messages throughout §5 does not describe this
  phone.
- Only SMS is covered. **RCS/chat messages are a different store and are not readable this way.**
  If a bank has moved to RCS, those messages are invisible to the app. See
  [ADR 0004](adr/0004-sms-via-termux-api-polling.md).
- Re-check this after any Termux:API update. An update can reset the appops state.

### Revoking

To take the permission away again, in this order:

```bash
adb shell appops set com.termux.api READ_SMS ignore
adb shell pm revoke com.termux.api android.permission.READ_SMS
```

Verify with the same two `dumpsys`/`appops get` commands: expect `granted=false` and `ignore`.
Revoking stops all SMS capture. The app keeps working — manual entry and the XML-file import path
are unaffected.

---

## 5. Run the setup script

The script lives in this repo. Get it onto the phone with adb:

```bash
# On the PC, from the repo root:
adb push scripts/setup-termux.sh /sdcard/Download/
```

Then in Termux:

```bash
bash ~/storage/shared/Download/setup-termux.sh
```

It will:

1. install the packages from step 2 (skip with `--skip-packages`),
2. create `~/personal-finance-app/{app,data,logs,native}`,
3. compile `better-sqlite3-multiple-ciphers` on-device — **several minutes**, and it will look like
   it has hung. It has not,
4. run an encryption smoke test: it writes a throwaway encrypted database, reads it back, confirms
   integers survive as `bigint`, and confirms the file is **unreadable without the key**,
5. check `termux-sms-list` and print the appops diagnostic if it comes back empty.

The script never touches `~/personal-finance-app/data`. It is safe to re-run at any time.

### Verify

Everything the script checks, it reports. You want `ok` on the toolchain, on
`SQLCipher encryption verified on this device`, and a non-zero message count from
`termux-sms-list`.

If a `nodejs` major upgrade ever breaks the native module with an `ERR_DLOPEN_FAILED` or
`NODE_MODULE_VERSION` error, rebuild it:

```bash
bash ~/personal-finance-app/app/scripts/setup-termux.sh --rebuild-native
```

---

## 6. Deploy the app

From the PC, in the repo root:

```bash
npm run deploy:s20
```

That builds with `output: 'standalone'`, packages `.next/standalone` plus `.next/static`, `public/`
and `scripts/`, and pushes a tarball to `/sdcard/Download/`. It then prints the single command to
run in Termux to unpack it.

The script never writes to `~/personal-finance-app/data`, in any mode. The database lives outside
the deployed tree on purpose.

Then start the server in Termux:

```bash
bash ~/personal-finance-app/app/scripts/start-server.sh
```

It binds **127.0.0.1** by default and the app starts **locked** — the database key is derived from
your passphrase at login and exists only in the running process's memory
([ADR 0003](adr/0003-sqlite-encryption-with-passphrase-derived-key.md)).

### Verify

In a second Termux session:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/
```

Then open `http://127.0.0.1:3000` in the phone's browser.

### About `--expose-lan`

`start-server.sh --expose-lan` binds `0.0.0.0` and makes the app reachable from the LAN. **Do not
use it yet.** buildspec §16 and §18 require authentication, scoped access and CSRF defence before
this surface goes on a network, and none of that exists. buildspec §3 says not to put an HTTP server
on the phone at all; we did, for the reasons in
[ADR 0001](adr/0001-nextjs-node-on-termux-instead-of-kotlin-compose.md), and the loopback default is
part of that bargain.

---

## 7. Keep Termux alive

There is no WorkManager here. If the Termux process dies, SMS capture stops and nothing tells you.
Three things guard against that.

### 7a. Wake lock

`start-server.sh` acquires `termux-wake-lock` automatically. To hold one by hand:

```bash
termux-wake-lock     # acquire
termux-wake-unlock   # release
```

**Verify:** the Termux notification in the shade changes to show a wake lock is held.

### 7b. Battery optimisation

On the phone: **Settings → Apps → Termux → Battery → Unrestricted**. Repeat for **Termux:API**.

Samsung adds a second mechanism on top of Android's: **Settings → Battery and device care → Battery
→ Background usage limits**. Make sure Termux is **not** in *Sleeping apps* or *Deep sleeping apps*,
and consider adding it to *Never sleeping apps*.

Equivalent from the PC:

```bash
adb shell dumpsys deviceidle whitelist +com.termux
adb shell dumpsys deviceidle whitelist +com.termux.api
```

**Verify:**

```bash
adb shell dumpsys deviceidle whitelist | grep termux
```

### 7c. Accept what this does not cover

A force-stop, an OEM memory kill, or a crash ends the server. Nothing restarts it until reboot
(step 8) or until you start it by hand. The app must show source-coverage gaps honestly rather than
implying continuous capture — see buildspec §23's data-health screen and
[ADR 0004](adr/0004-sms-via-termux-api-polling.md).

---

## 8. Restart on reboot with Termux:Boot

Termux:Boot runs every script in `~/.termux/boot/` when the phone finishes booting.

```bash
mkdir -p ~/.termux/boot
cat > ~/.termux/boot/10-personal-finance-app.sh <<'SH'
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
exec bash "$HOME/personal-finance-app/app/scripts/start-server.sh" >> \
  "$HOME/personal-finance-app/logs/boot.log" 2>&1
SH
chmod +x ~/.termux/boot/10-personal-finance-app.sh
```

**Termux:Boot must have been opened from the launcher at least once**, or it never registers for the
boot broadcast.

### Verify

Reboot the phone, wait a couple of minutes, then open Termux:

```bash
tail -20 ~/personal-finance-app/logs/boot.log
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/
```

Remember: the server comes back **locked**. It serves the unlock screen, but nothing touches the
database until you enter the passphrase. That is a deliberate consequence of having no Android
Keystore ([ADR 0003](adr/0003-sqlite-encryption-with-passphrase-derived-key.md)) — background
capture does not advance while locked.

---

## 9. Optional: sshd, for nicer deploys

The adb transport works but needs a manual unpack step every time. With sshd, deploys go straight in.

In Termux:

```bash
passwd                    # set a password for the Termux user
sshd                      # start the daemon — it listens on 8022, not 22
whoami                    # note the username
ifconfig                  # note the phone's LAN address (wlan0)
```

Better than a password: append your PC's public key to `~/.ssh/authorized_keys` on the phone.

From the PC:

```bash
ssh -p 8022 <user>@<phone-ip>
npm run deploy:s20 -- --transport ssh --host <phone-ip>
```

sshd does not survive a reboot on its own; add `sshd` to the Termux:Boot script in step 8 if you
want it always available.

---

## Troubleshooting

### `termux-sms-list` returns `[]`

**Check appops first.** This is almost always it.

Android's hard restriction on `READ_SMS` is enforced through appops, independently of the permission
grant. When it is active, `termux-sms-list` returns an empty array with **exit status 0 and no error
message**. It is indistinguishable from an empty inbox.

```bash
adb shell appops get com.termux.api READ_SMS
```

If that is anything other than `allow`:

```bash
adb shell appops set com.termux.api READ_SMS allow
```

Then re-test with `termux-sms-list -l 1`.

If `appops get` says `allow` but you still get `[]`:

1. Confirm the permission itself —
   `adb shell dumpsys package com.termux.api | grep READ_SMS` should say `granted=true`.
2. Confirm Termux:API came from F-Droid. If `pm grant` ever failed with a "not a changeable
   permission" style error, it is the Play build and has no installer exemption. Reinstall from
   F-Droid and redo step 4.
3. Confirm the inbox genuinely has SMS in it, in Samsung Messages. Send yourself one and retry.
4. Re-check after a Termux:API update — updates can reset the appops state.

### `termux-sms-list` hangs, or says "command not found"

- **Command not found:** the `termux-api` *package* is missing → `pkg install termux-api`.
- **Hangs forever:** the `termux-api` package is installed but the **Termux:API app** is not. The
  package is only a set of shell wrappers; the app is what talks to Android. Install it from
  F-Droid and open it once.
- Both must come from the same installer as Termux itself.

### `pm grant` fails

Termux:API was installed from Google Play, or from a different source than Termux. The Play build
lacks `RESTRICTION_INSTALLER_EXEMPT` and cannot be granted a hard-restricted permission. Uninstall
it and install the F-Droid build.

### The native module fails to build

```
gyp ERR! find Python
```
→ `pkg install python`

```
gyp ERR! stack Error: not found: make
```
→ `pkg install build-essential binutils`

Out of space → `df -h $HOME`. The build needs a few hundred MB of scratch.

### The server starts but every database operation fails

The native module is not linked into the deployed tree. A deploy replaces `node_modules/`, and the
symlink to the on-device build has to be re-created:

```bash
bash ~/personal-finance-app/app/scripts/setup-termux.sh
```

`start-server.sh` warns about this at startup.

### `ERR_DLOPEN_FAILED` or `NODE_MODULE_VERSION` mismatch

Termux upgraded `nodejs` to a new major version and the compiled module no longer matches its ABI:

```bash
bash ~/personal-finance-app/app/scripts/setup-termux.sh --rebuild-native
```

### The app 404s its own CSS and JavaScript

`.next/static` did not make it across. `next build` does not trace it into the standalone output;
`deploy-to-termux.sh` copies it in explicitly. Re-run the deploy without `--skip-build`.

### `adb push` fails with "permission denied"

adb cannot write into Termux's private directory — that is expected and is why the deploy stages
through `/sdcard/Download`. If shared storage itself is refusing writes, try
`--sdcard-dir /storage/emulated/0/Download`, or switch to the ssh transport.

### Capture stops overnight

Termux was killed. Work through step 7: wake lock held, Termux **and** Termux:API both set to
Unrestricted, and neither in Samsung's *Sleeping apps* list. Check
`adb shell dumpsys deviceidle whitelist | grep termux`. If it keeps happening, the app's
source-coverage display should be showing the gap — that is the honest answer, not a fix.

---

## Related

- [ADR 0001 — Next.js on Node in Termux](adr/0001-nextjs-node-on-termux-instead-of-kotlin-compose.md)
- [ADR 0002 — build on the PC, deploy standalone](adr/0002-build-on-pc-deploy-standalone-to-phone.md)
- [ADR 0003 — database encryption without a Keystore](adr/0003-sqlite-encryption-with-passphrase-derived-key.md)
- [ADR 0004 — SMS by polling `termux-sms-list`](adr/0004-sms-via-termux-api-polling.md)
- [Milestones and acceptance gates](milestones.md)
