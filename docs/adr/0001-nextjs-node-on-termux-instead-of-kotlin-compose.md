# 0001 — Next.js on Node in Termux instead of native Kotlin/Compose

- **Status:** Accepted
- **Date:** 2026-09-20
- **Supersedes:** `buildspec.md` §3 ("Recommended implementation and project structure")
- **Related:** [0002](0002-build-on-pc-deploy-standalone-to-phone.md), [0003](0003-sqlite-encryption-with-passphrase-derived-key.md), [0004](0004-sms-via-termux-api-polling.md)

## Context

`buildspec.md` §3 specifies native **Kotlin + Jetpack Compose**, coroutines/Flow, Room over SQLite,
a SQLCipher-compatible Room integration, WorkManager, OkHttp and Android Keystore. §4 draws the
trust boundary around a single "Trusted Android application" process. §3 also states, explicitly:
*"Do not add a public HTTP server to the phone just to use the contracts."*

The owner overrode that stack. The constraints that drove the override:

- The owner works in TypeScript, not Kotlin. A Kotlin/Compose build needs an Android Studio and
  Gradle toolchain the owner does not want to maintain for a single-user personal app.
- The same domain code should run unchanged on the PC (for fast tests) and on the phone (as the
  authority). A pure-TypeScript domain layer does that; a Kotlin domain layer does not.
- The phone already runs **Termux**, with **Termux:API** and **Termux:Boot** installed, which gives
  a normal POSIX userland, a Node runtime and an SMS read path without shipping an APK at all.
- §1 rule 4 — *"The Android database is the authority in version 1"* — is about **where the data
  lives**, not about which UI toolkit renders it. That rule is preserved.

## Decision

Build the app as **Next.js 16 (App Router) + React 19 + TypeScript on Node**, and run the whole
thing — server, database and UI — on the owner's Samsung Galaxy S20 (SM-G981U1, `x1q`, Android 13 /
SDK 33, arm64-v8a) inside Termux.

- The phone is the server **and** the database authority. Nothing else holds finance state.
- The domain layer stays pure TypeScript with no Next, React or Node-API imports, mirroring §3's
  "keep the domain layer pure Kotlin" intent (`src/core/domain/`).
- §3's module layout is mapped onto `src/`: `core/domain/`, `core/data/`, `core/security/`,
  `core/contracts/`, `ingestion/sms/`, `ingestion/gmail/`, `extraction/`, `agent/`, `app/` (Next
  routes replacing `features/`), `fixtures/`, `docs/`.
- §17's schema is kept as **hand-written SQL migrations** rather than Room entities. The table and
  constraint design in §17 survives intact; only the ORM disappears.
- The UI implements §13's visual brief in CSS rather than Compose. The tokens, spacing rhythm and
  accessibility requirements in §13 still apply.

## Consequences

### What we accept

- **We now run exactly the HTTP server §3 told us not to add.** This is the largest deviation. The
  mitigation is in `scripts/start-server.sh`: the server binds `127.0.0.1` by default and exposing
  it on `0.0.0.0` requires an explicit opt-in flag. buildspec §16 and §18 require authenticated,
  scoped, CSRF-defended access before any LAN bind is legitimate; until that exists, the LAN flag
  should not be used. *Untested on device.*
- **No Android Keystore.** Key wrapping has to be redesigned. See
  [ADR 0003](0003-sqlite-encryption-with-passphrase-derived-key.md).
- **No WorkManager.** Background work becomes a loop inside the Node process, kept alive by
  `termux-wake-lock` and battery-optimisation exemptions. The OS will not restart it after a
  force-stop or an OEM kill; Termux:Boot only covers reboot. This is strictly weaker than
  WorkManager's guarantees, and §5.5's "handle reboot, force-stop, phone sleep, OEM battery
  restrictions" requirement now depends on operational setup rather than on the OS.
- **No SMS broadcast receiver and no `READ_SMS` in our own process.** See
  [ADR 0004](0004-sms-via-termux-api-polling.md).
- **No signed APK.** §21 M7's "signed installable Android package" gate does not apply as written;
  it is reinterpreted in [docs/milestones.md](../milestones.md) as a reproducible deploy bundle plus
  documented install steps.
- **Accessibility moves from TalkBack/Compose to the web stack.** §13's large text, reduced motion,
  contrast and screen-reader requirements must be met with semantic HTML, ARIA and media queries.
  Android-specific checks in §22 ("UI and device tests") become browser checks on the phone.
- **No Android auto-backup to disable** (§18) — but also no OS-managed private storage. Everything
  is a file in the Termux home directory, protected only by Android's per-app data directory
  isolation plus the database encryption in ADR 0003.

### What we keep

- One owner, one authority, no cloud database. §1 rules 1–10 are unchanged and all still apply.
- Integer-minor-unit money, double-entry journals, evidence/provenance and the review queue are
  runtime-agnostic and carry over verbatim.
- The §16 service contracts still describe the internal API. In this stack they are genuinely
  reachable over HTTP, which makes authentication a hard requirement rather than a future concern.
