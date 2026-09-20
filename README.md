# Personal Finance App

A private, single-owner finance app that turns financial SMS and Gmail messages into a reliable
ledger, bills, forecasts, savings suggestions and a chat assistant.

The phone is the whole system. It runs the server, holds the database and is the only authority for
financial state. Nothing syncs to a cloud service.

Built from [`buildspec.md`](buildspec.md). **The buildspec specifies a native Kotlin/Compose Android
app; the owner overrode that.** The real stack is below, and every deviation has an
[ADR](docs/adr/).

> **Status: early.** The finance engine core, the encrypted data layer and the finance application
> service are done and tested — on the PC. The UI and server session layer are in flight. Ingestion,
> Gmail, bills, forecast and the agent are unwritten, and **nothing has yet run on the phone**. See
> [docs/milestones.md](docs/milestones.md) for an honest, per-item checklist.

---

## Stack

| | |
|---|---|
| **Runtime** | Node ≥ 22.6, TypeScript 5.9 |
| **Framework** | Next.js 16 (App Router) + React 19 |
| **Database** | SQLite via `better-sqlite3-multiple-ciphers` — SQLCipher-compatible, whole-database encryption |
| **Host** | Termux on a Samsung Galaxy S20 (SM-G981U1 / `x1q`, Android 13 / SDK 33, arm64-v8a) |
| **Build** | On the PC, `output: 'standalone'`. The phone never compiles application code. |
| **Money** | `bigint` minor units internally; decimal strings on the wire |
| **SMS** | Termux:API `termux-sms-list`, polled |
| **Extraction model** | llama.cpp, OpenAI-compatible, `http://192.168.1.118:8081/v1`, `qwen3.5-0.8b` |
| **Tests** | `node:test` (Node's built-in runner) |

Why each of those, and what it costs: [docs/adr/](docs/adr/).

---

## Quickstart (development, on the PC)

```bash
npm install
npm run check        # typecheck + tests
npm run dev          # Next dev server on http://localhost:3000
```

`better-sqlite3-multiple-ciphers` is an `optionalDependency`, so `npm install` succeeds on a machine
that cannot build it — but the storage and service tests need it, so `npm test` will not pass
without it. On the phone it is built separately, on-device; see
[ADR 0002](docs/adr/0002-build-on-pc-deploy-standalone-to-phone.md).

### Tests

```bash
npm test             # node --test over src/**/*.test.ts
npm run test:watch
npm run typecheck    # tsc --noEmit
npm run check        # both
```

At the last check: **86 tests, all passing** — money arithmetic and parsing, double-entry invariants,
eight of the nineteen §22 fixture scenarios, randomised property sweeps proving every generated book
balances and that transfers conserve total assets, and storage tests proving the database file is
encrypted on disk, that posted journals are immutable, that audit events are append-only and that a
value beyond 2^53 survives the SQLite round trip.

`npm run typecheck` currently reports errors in files that are still being written; check
`git status --short` before assuming a failure is yours.

Tests run against a real encrypted SQLite database in a temporary directory. There is no fixture
file with real content in it — see [Data and privacy](#data-and-privacy).

---

## Deploying to the phone

One-time device setup — Termux packages, SMS permission, the on-device native build, wake lock,
boot script — is in **[docs/termux-setup.md](docs/termux-setup.md)**. Do that first.

After that, from the PC:

```bash
npm run deploy:s20                                        # USB, via adb (default)
npm run deploy:s20 -- --transport ssh --host 192.168.1.42  # over Termux's sshd on port 8022
```

and on the phone:

```bash
bash ~/personal-finance-app/app/scripts/start-server.sh
```

The server binds `127.0.0.1` by default and starts **locked**. Exposing it on the LAN needs an
explicit `--expose-lan`, and should not be done until the app has authentication — buildspec §16 and
§18 both require it, and buildspec §3 says not to put an HTTP server on the phone at all. We did;
see [ADR 0001](docs/adr/0001-nextjs-node-on-termux-instead-of-kotlin-compose.md).

### Scripts

| Script | Runs on | Does |
|---|---|---|
| [`scripts/setup-termux.sh`](scripts/setup-termux.sh) | Phone | Installs packages, creates directories, builds the native SQLite module on-device, smoke-tests encryption, checks `termux-sms-list` |
| [`scripts/deploy-to-termux.sh`](scripts/deploy-to-termux.sh) | PC | Builds and ships the standalone output over adb or ssh. Never touches `data/`. |
| [`scripts/start-server.sh`](scripts/start-server.sh) | Phone | Wake lock, bind policy, logging, `node server.js` |

---

## Architecture map

```
                 Samsung Galaxy S20 — the only authority
  ┌──────────────────────────────────────────────────────────────┐
  │  Termux                                                      │
  │                                                              │
  │   termux-sms-list ──poll──┐                                  │
  │                           ▼                                  │
  │              ┌────────────────────────┐                      │
  │  Gmail ─────►│  ingestion + filtering │                      │
  │  (read-only) └───────────┬────────────┘                      │
  │                          ▼                                   │
  │              ┌────────────────────────┐   uncertain text     │
  │              │ deterministic templates│──────────────┐       │
  │              └───────────┬────────────┘              │       │
  │                          ▼                           │       │
  │              ┌────────────────────────┐              │       │
  │              │ schema + evidence      │◄─ candidate ─┘       │
  │              │ validation → review    │     JSON             │
  │              └───────────┬────────────┘                      │
  │                          ▼                                   │
  │   React UI ◄──►  finance services  ──►  encrypted SQLite     │
  │   (Next.js)          (pure domain)        (key in memory)    │
  └──────────────────────────────┬───────────────────────────────┘
                                 │ LAN, owner-operated
                                 ▼
                    llama.cpp  192.168.1.118:8081/v1
                    qwen3.5-0.8b  (extraction only)
```

### Source layout

```
src/core/domain/       Money, time, double-entry ledger, posting rules   done
src/core/data/         SQLite driver, schema, migrations, repositories   done
src/core/security/     Passphrase → scrypt key derivation, lock state    done
src/core/services/     Finance application service (§16 contracts)       done
src/extraction/        Bounded schema, endpoint policy, llama.cpp client partial
src/server/            Session and vault wiring                          in flight
src/ui/  src/app/      Next.js App Router routes and components          in flight
src/ingestion/sms/     termux-sms-list polling, XML file import          not started
src/ingestion/gmail/   OAuth, filtering, incremental sync                not started
src/agent/             Agent client, tool registry, proposals            not started
```

Per-item status, with what has and has not been observed working:
[docs/milestones.md](docs/milestones.md).

`src/core/domain/` is pure TypeScript: no Next, no React, no Node APIs. It is a set of functions
that read a snapshot and return a posting plan for the data layer to apply in one database
transaction. That is what lets the same rules serve the manual UI, the import workers and the agent
(buildspec §1).

---

## Limitations

These are real and permanent unless something changes. None of them is a bug to be fixed later.

### SMS capture is not real-time

Messages are read by polling `termux-sms-list`. There is no broadcast receiver. A message is
invisible until the next poll, so worst-case capture latency is one polling interval.
([ADR 0004](docs/adr/0004-sms-via-termux-api-polling.md))

### RCS is not covered

`termux-sms-list` reads the SMS provider. RCS/chat messages live in a private store and are a
different source. Any bank that has moved to RCS is invisible. The device's default SMS handler is
Samsung Messages, and no claim is made about what it does or does not mirror into the shared
provider.

### Termux has to stay alive

There is no WorkManager. If Termux is force-stopped, killed by Samsung's battery manager, or
crashes, capture stops and nothing announces it. Wake lock, battery-optimisation exemption and
Termux:Boot reduce the odds; they do not eliminate them. The app is expected to show coverage gaps
honestly rather than imply continuous capture.

### The database key lives in memory

There is no Android Keystore in Termux. The key is derived with `scrypt` from a passphrase the owner
types at login and held in the server process only. This is **weaker than hardware-backed
protection**: an attacker with the unlocked device and the running process can reach the key, and
anyone who copies the database file can attack the passphrase offline. The server starts locked, so
nothing touches the database after a reboot until the owner unlocks it — which also means background
capture does not advance while locked.
([ADR 0003](docs/adr/0003-sqlite-encryption-with-passphrase-derived-key.md))

### The extraction model is 0.8B and its output always needs review

`qwen3.5-0.8b` is a very small model. Per buildspec §7.4, **model-derived financial entries require
review in version 1** — deterministic templates run first, and only validated known templates may
auto-post, after the owner enables that source rule. A model's self-reported confidence is not a
calibrated probability and is not used as one. Extraction has not been benchmarked on the actual
endpoint yet.

### No LAN exposure yet

The server binds loopback. There is no authentication, no session model and no CSRF defence, so
there is nothing safe to expose. `--expose-lan` exists but should stay unused.

### Not a payment system

No bank payments, no SMS sending, no email sending, no shell execution, no model-generated SQL.
"Mark paid" records a payment; it does not move money. (buildspec §1 rule 10)

---

## Data and privacy

- **All fixtures in this repository are synthetic.** Every account, balance, merchant, message and
  reference in the tests and docs is invented.
- **No real financial data belongs in this repository** — not messages, not exports, not database
  files, not screenshots. `.gitignore` excludes `/data/`, `*.db`, `*.db-wal`, `*.backup.pfa`,
  `/fixtures/real/` and `*.sms-backup.xml`, but the rule is the rule regardless of what the ignore
  file catches.
- If the owner supplies real examples to build parsers from, redact them locally before anything
  becomes a reusable fixture (buildspec §22).
- Sending a message for extraction transmits it across the LAN to the llama.cpp host. "Local" model
  does not mean "on the phone".
- The scripts in this repository never print or store message content. `setup-termux.sh` reports
  only how many messages `termux-sms-list` returned.

---

## Decision records

Every deviation from `buildspec.md` is written down in [docs/adr/](docs/adr/), including what the
buildspec said, what we do instead, and what we give up:

| # | Decision |
|---|---|
| [0001](docs/adr/0001-nextjs-node-on-termux-instead-of-kotlin-compose.md) | Next.js on Node in Termux instead of native Kotlin/Compose |
| [0002](docs/adr/0002-build-on-pc-deploy-standalone-to-phone.md) | Build on the PC, deploy `standalone` output to the phone |
| [0003](docs/adr/0003-sqlite-encryption-with-passphrase-derived-key.md) | SQLite encryption with a passphrase-derived key, because there is no Keystore |
| [0004](docs/adr/0004-sms-via-termux-api-polling.md) | SMS capture by polling `termux-sms-list`, not Android broadcasts |
| [0005](docs/adr/0005-llama-cpp-openai-endpoint-instead-of-ollama.md) | llama.cpp's OpenAI-compatible endpoint instead of Ollama's native API |
| [0006](docs/adr/0006-money-as-bigint-minor-units.md) | Money as `bigint` minor units, decimal strings on the wire |

[docs/adr/README.md](docs/adr/README.md) also lists the conflicts between the buildspec and this
stack that do **not** have an ADR yet.

---

## Documentation

- [docs/termux-setup.md](docs/termux-setup.md) — one-time device setup, verification, troubleshooting
- [docs/milestones.md](docs/milestones.md) — M0–M7 checklist with honest status
- [docs/adr/](docs/adr/) — architecture decision records
- [buildspec.md](buildspec.md) — the full specification. Read it with the ADRs beside it; §3, §5.4,
  §5.5, §7.2 and parts of §18 no longer describe this project.
