# 0004 — SMS capture by polling `termux-sms-list`, not Android broadcasts

- **Status:** Accepted
- **Date:** 2026-09-20
- **Supersedes:** `buildspec.md` §5.4 and §5.5 (the *mechanisms*; their requirements still hold)
- **Related:** [0001](0001-nextjs-node-on-termux-instead-of-kotlin-compose.md), [docs/termux-setup.md](../termux-setup.md)

## Context

`buildspec.md` §5.4 says to read history with `ContentResolver` over
`Telephony.Sms.CONTENT_URI`. §5.5 says to capture new messages with a manifest receiver for
`SMS_RECEIVED_ACTION`, reconstruct multipart with `Telephony.Sms.Intents.getMessagesFromIntent()`,
and schedule WorkManager jobs for the rest.

None of that is reachable from a Node process in Termux
([ADR 0001](0001-nextjs-node-on-termux-instead-of-kotlin-compose.md)). There is no app manifest to
register a receiver in, no `ContentResolver` binding, and no `READ_SMS` permission held by our own
process.

What we do have — and what was **verified over adb on this device**:

- Termux, **Termux:API** and **Termux:Boot** are installed on the S20.
- `com.termux.api` held `READ_SMS` with the flag `RESTRICTION_INSTALLER_EXEMPT`, because it was
  sideloaded via `com.google.android.packageinstaller`. The hard restriction was therefore liftable.
- It was granted with **both** of:
  ```
  adb shell pm grant com.termux.api android.permission.READ_SMS
  adb shell appops set com.termux.api READ_SMS allow
  ```
  The second command is essential. Without the appops step `termux-sms-list` returns an **empty
  list rather than an error** — a silent failure that is indistinguishable from "no messages".
- The default SMS role holder on this device is **`com.samsung.android.messaging`** (Samsung
  Messages), not Google Messages as §5 assumes throughout. This changes nothing about provider
  access — a non-default app with `READ_SMS` reads the same provider — but §5.6's instructions to
  "keep Google Messages installed and set as the default messenger" do not describe this phone.
- A **Play-installed** Termux:API would **not** carry the installer exemption, and `pm grant` would
  fail. The F-Droid (or equivalent sideloaded) build is required.

## Decision

Capture SMS by **polling `termux-sms-list`** from the Node server.

- `termux-sms-list -l <n> -o <offset>` returns provider rows as JSON. That is both the history
  import path (§5.4) and the ongoing capture path (§5.5) — one mechanism, not two.
- The ingestion loop runs on a timer inside the server process, with a configurable interval, and
  writes staged occurrences into the encrypted store before any parsing or model call.
- §5.4's and §5.5's **requirements survive unchanged** and are, if anything, more necessary here:
  - **Idempotency** — every poll re-reads rows already seen. Occurrence identity (§8) does the
    deduplication; overlapping polls must produce zero extra financial effects.
  - **Watermarks** — the scan watermark records what was *durably staged*, not what the model
    finished, exactly as §5.4 states.
  - **Overlap scans** — every poll deliberately re-reads a window behind the watermark, because a
    message can land while a poll is in flight.
  - **Coverage gaps** — the time between polls, and any period where Termux was dead, is a gap and
    must be shown as one (§23's data-health screen).
  - **Provider generation** — `_id` reuse across restores is still possible, so the dataset
    generation and evidence-based deduplication in §5.4 still apply.
- Filtering by sender and date range happens **application-side after the read**, same as §5.4
  describes. The OS permission is broad; our storage is not.

## Consequences

- **Capture is not real-time.** There is no broadcast. A message is invisible until the next poll,
  so worst-case latency is one polling interval. §5.5's "do not promise immediate processing" was
  already the rule; here it is a structural fact.
- **RCS is not covered.** `termux-sms-list` reads the SMS provider. Per §5.3, RCS/chat messages live
  in a private store and are a different source. On this device Samsung Messages is the default
  handler, and no claim is made about what it does or does not mirror into the shared provider.
  Any bank that has moved to RCS is invisible to this path.
- **Termux must stay alive.** No OS component restarts our poller. This requires, at minimum:
  `termux-wake-lock`, battery-optimisation exemption for Termux, Samsung's "sleeping apps" list kept
  clear of it, and Termux:Boot for reboot recovery. A force-stop or an OEM memory kill ends capture
  silently until the owner notices. See [docs/termux-setup.md](../termux-setup.md).
- **The permission belongs to another app.** `com.termux.api` holds `READ_SMS`, not us. If the owner
  updates Termux:API from a different installer, or Android revokes the permission on an OS upgrade,
  capture stops. The appops state in particular must be re-checked after any Termux:API update.
- **Multipart is the provider's problem, not ours.** Rows come back already reassembled by the
  platform, so §5.5's `getMessagesFromIntent()` reconstruction is not needed. Conversely we lose the
  broadcast-vs-provider cross-check §5.5 describes; there is only one stream.
- **Polling costs battery and CPU** proportional to interval and inbox size. The interval is a real
  trade-off between capture latency and battery, and should be configurable.
- §5.2's fallbacks remain mandatory: the SMS Backup & Restore XML import and manual paste must work,
  and §5.6's "Continue without SMS" path must stay functional.

### Revoking

```
adb shell appops set com.termux.api READ_SMS ignore
adb shell pm revoke com.termux.api android.permission.READ_SMS
```
