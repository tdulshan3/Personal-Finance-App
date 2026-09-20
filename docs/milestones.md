# Milestones and acceptance gates

A living checklist of `buildspec.md` §21's milestones M0–M7, remapped onto the stack this project
actually uses (see the [ADRs](adr/)).

**Last checked:** 2026-09-20, at commit `a6773f3`.

**Observed:**

```
npm test            97 tests, 97 pass, 0 fail
npm run typecheck   clean
npx next build      succeeds (7 routes)
npx next start      boots; an uninitialised install redirects to /setup,
                    a locked one to /unlock
```

All of these were run on the PC (x86-64 Linux), **not on the phone**. Nothing here has been
observed running on the S20 except the SMS read capability in M0. In particular the native SQLite
module has never been compiled or loaded under Termux, and no page has been rendered on the device.

Nothing below is marked done unless it has been observed working. Where the buildspec's mechanism no
longer applies, the *requirement* is restated rather than dropped.

| Status | Meaning |
|---|---|
| ✅ | Done and verified |
| 🟡 | Partly done — the note says exactly how far |
| 🔨 | In flight: files exist in the working tree but are not committed |
| ⬜ | Not started |
| ➖ | Superseded by an ADR; the replacement requirement is named |

---

## Summary

| Milestone | Status | Gate |
|---|---|---|
| [M0 — Foundation and device capability spike](#m0--foundation-and-device-capability-spike) | 🟡 | ⬜ Not met |
| [M1 — Accurate offline manual finance](#m1--accurate-offline-manual-finance) | 🟡 | ⬜ Not met |
| [M2 — SMS history and live ingestion](#m2--sms-history-and-live-ingestion) | 🟡 | ⬜ Not met |
| [M3 — Gmail and cross-source matching](#m3--gmail-and-cross-source-matching) | ⬜ | ⬜ Not met |
| [M4 — Reconciliation and bills](#m4--reconciliation-and-bills) | 🟡 | ⬜ Not met |
| [M5 — Forecast and savings](#m5--forecast-and-savings) | ⬜ | ⬜ Not met |
| [M6 — Agent with independent model selection](#m6--agent-with-independent-model-selection) | ⬜ | ⬜ Not met |
| [M7 — Hardening and personal release](#m7--hardening-and-personal-release) | ⬜ | ⬜ Not met |

**What exists and is verified today:**

- the finance engine core — `src/core/domain/` (money, time, ledger, posting, transaction, errors);
- the encrypted data layer — `src/core/data/` (driver, 18-table schema, migrations,
  ledger repository) with the database proven encrypted on disk, journals immutable once posted and
  audit events append-only;
- passphrase-derived key handling — `src/core/security/passphrase.ts` (scrypt, verifier,
  key wiping), matching [ADR 0003](adr/0003-sqlite-encryption-with-passphrase-derived-key.md);
- the finance application service — `src/core/services/finance-service.ts` (accounts, posting,
  edit/delete/restore, search, totals, idempotency);
- OS-level SMS read capability on the device.

**What does not exist:** the UI and server session layer are in flight and not committed. Ingestion,
Gmail, bills, recurrence, forecast, savings and the agent are unwritten. There is no encrypted
backup or restore. Nothing has run on the phone.

---

## M0 — Foundation and device capability spike

| ☐ | Item | Status | Notes |
|---|---|---|---|
| ☐ | Project, architecture modules, dependency pins | 🟡 | `core/domain`, `core/data`, `core/security`, `core/services`, `extraction/`, `app/`, `server/`, `ui/` all exist and typecheck. Still missing entirely: `ingestion/`, `agent/`, `core/contracts/`. |
| ☐ | CI | ⬜ | No pipeline. `npm run check` (typecheck + test) is the intended entry point and currently passes. |
| ☐ | Encrypted storage proof | 🟡 | Proven **on the PC**: `src/core/data/database.test.ts` asserts the file is encrypted on disk, that a wrong passphrase reports *locked* rather than *corrupt*, that the same passphrase reopens it, and that a value beyond 2^53 survives the round trip. **Not proven on the S20** — the on-device native build has not been run. `scripts/setup-termux.sh` carries an equivalent smoke test for that. |
| ☐ | Migrations | 🟡 | `src/core/data/migrations.ts`: 18 tables from §17.1, applied idempotently, with an edited migration refused rather than silently diverging. §17.3 invariants are enforced in SQL and tested. Untested on device. |
| ☐ | Fictional fixtures | 🟡 | Synthetic ledger fixtures in `src/core/domain/test-support.ts` and the §22 scenarios in `posting.test.ts` / `finance-service.test.ts`. **No labeled message corpus** for §22's "Extraction evaluation" exists. |
| ☐ | Visual tokens | ✅ | `src/app/globals.css` carries the §13 token table in light and dark, with tabular money digits, 48dp targets, opt-in glass with a solid fallback and a reduce-transparency override. Rendered in a browser on the PC only. |
| ☐ | Prove Room/encryption/migrations on a device | ➖ | No Room ([ADR 0001](adr/0001-nextjs-node-on-termux-instead-of-kotlin-compose.md)). Replacement requirement — prove `better-sqlite3-multiple-ciphers` plus the SQL migrations **on the S20** — is the outstanding half of the two rows above. |
| ☐ | Verify non-default SMS read/receive capability | ✅ | **Verified on the S20 over adb.** `com.termux.api` held `READ_SMS` with `RESTRICTION_INSTALLER_EXEMPT` (sideloaded via `com.google.android.packageinstaller`); granted with `pm grant` **and** `appops set … allow`; `termux-sms-list` then returns messages. Without the appops step it returns `[]` silently. Default SMS role holder is `com.samsung.android.messaging`. See [ADR 0004](adr/0004-sms-via-termux-api-polling.md) and [termux-setup.md](termux-setup.md). |
| ☐ | Working file-import fallback if SMS is blocked | ⬜ | §5.2 requires the SMS Backup & Restore XML path regardless of permission state. `fast-xml-parser` is a dependency; no importer written. |
| ☐ | Prove the endpoint lists models and returns bounded extraction JSON | 🟡 | Endpoint **identified**: llama.cpp, OpenAI-compatible, `http://192.168.1.118:8081/v1`, model `qwen3.5-0.8b`; Ollama's `/api/tags` and `/api/chat` 404 there ([ADR 0005](adr/0005-llama-cpp-openai-endpoint-instead-of-ollama.md)). `src/extraction/schema.ts` and `endpoint-policy.ts` are committed; the client is 🔨 in flight. **No extraction has been run against the endpoint, and no latency, valid-result rate or accuracy measured.** |
| ☐ | Record Android/API requirements and decisions | 🟡 | Device facts and stack decisions recorded in the [ADRs](adr/) and [termux-setup.md](termux-setup.md). Gmail authorization setup is not recorded. "Distribution variant" does not apply — there is no APK. |

**Gate — a device capability report with observed results, no unsupported promises, and a runnable
offline shell:** ⬜ **not met.**

- SMS half of the capability report: ✅ real and written down.
- Storage half: proven on the PC, not on the device.
- Model half: endpoint identified, nothing measured.
- Runnable offline shell: 🟡 `next build` succeeds and the server boots with no network access,
  so `npm run build` has not been run successfully and nothing has been deployed.

---

## M1 — Accurate offline manual finance

| ☐ | Item | Status | Notes |
|---|---|---|---|
| ☐ | Money invariants: integer minor units, currency scale, overflow, parsing | ✅ | `src/core/domain/money.ts`, 26 tests. `bigint` minor units, 0/2/3-decimal currencies, 64-bit bound checks, strict parsing, decimal-string wire format ([ADR 0006](adr/0006-money-as-bigint-minor-units.md)). The data layer confirms a value beyond 2^53 survives SQLite unchanged. |
| ☐ | Balanced double-entry journals, per-currency zero sum | ✅ | `src/core/domain/ledger.ts`, enforced again in SQL by `migrations.ts`. Unbalanced, single-sided and zero-value entries are all rejected. |
| ☐ | Revisions, reversal-and-replacement editing, delete/restore | ✅ | `posting.ts` + `finance-service.ts`. Posted journals cannot be updated or deleted at the SQL level; a journal can only be reversed once. |
| ☐ | Time: UTC instants, local financial dates, precision, injectable clock | ✅ | `src/core/domain/time.ts`, `Asia/Colombo` default. Exercised through the posting and service tests; it still has **no dedicated test file**, and `addMonthsFromAnchor` (the §22 Jan-31 clamp helper) is untested. |
| ☐ | Accounts, opening balances, transfers, card purchase/repayment, refunds, splits | ✅ | `finance-service.ts`, tested through encrypted SQLite. Internal account types cannot be created from the Accounts screen; category and system accounts stay hidden. |
| ☐ | Search | ✅ | Filters by date, account, category and text; page size bounded to 200 per §16. |
| ☐ | Atomic audit | 🟡 | `audit_events` and `executed_actions` tables exist and append-only-ness is enforced and tested at the SQL level. Whether every service path writes a complete audit record has not been asserted end to end. |
| ☐ | Basic undo | 🟡 | Delete → Trash → restore works and is tested. There is no general "undo this action" path over `executed_actions`. |
| ☐ | Idempotency | ✅ | Replaying a key returns the original result and writes nothing new; the same key with different arguments is a conflict. Uniqueness is enforced per scope in SQL. |
| ☐ | Encrypted backup/restore | ⬜ | §18's separate backup password, manifest checksums and schema version are not implemented. `restoreTransaction` restores a *transaction* from Trash — it is not a database restore. |
| ☐ | Home and Transactions screens, light/dark, accessible forms | 🟡 | Home, Transactions, Transactions/new, Accounts, Setup and Unlock are built and typecheck; the build succeeds and the routes render on the PC. Not yet verified: dark mode by eye, TalkBack order, large text, and every screen on the phone. No UI test suite. |

### §22 required fixture scenarios

Eight of the nineteen are implemented and passing — the six that belong to M1, plus the two
idempotency fixtures that M6's gate also needs.

| Fixture | Status | Where |
|---|---|---|
| Opening bank 100,000; purchase 3,450 | ✅ | `posting.test.ts`, `finance-service.test.ts` |
| Salary 100,000; bank→cash 4,000; fee 250 | ✅ | both |
| Card purchase 3,450 then repayment | ✅ | both |
| Partial refund 500 | ✅ | both |
| Balance 84,250 vs 80,000 → unknown decrease 4,250 | ✅ | both |
| Start today at 80,000; import older spending 20,000 | ✅ | both |
| Repeated execution with same key | ✅ | `finance-service.test.ts` |
| Same key with changed arguments | ✅ | `finance-service.test.ts` |
| Reimport same 10,000 sources | ⬜ | M2 — needs the source layer |
| SMS and email strong identity match | ⬜ | M3 |
| Equal amount and merchant without reference | ⬜ | M3 |
| Replace adjustment with withdrawal 4,000 + fee 250 | ⬜ | M4 — no `adjustment_explanations` writes yet |
| Only 4,000 of adjustment explained | ⬜ | M4 |
| Bill 6,200; payments 3,000 then 3,200 | ⬜ | M4 — no bill tables |
| Bill payment reversed | ⬜ | M4 |
| Monthly plan on Jan 31 → Feb clamps, March uses 31 | ⬜ | M4 — `addMonthsFromAnchor` exists in `time.ts`, untested |
| Forecast: 80,000 start, 35,000 outflow, 15,000 buffer | ⬜ | M5 |
| Low cash today and salary next week | ⬜ | M5 |
| Old approval after record edit | ⬜ | M6 — revision conflicts *are* enforced and tested ("a stale expected revision is refused"), but there are no proposals to go stale |

Also passing, beyond the fixture list: randomised property sweeps proving every generated book
balances, that transfers conserve total assets, and that repeated edits leave the book balanced with
the balance tracking the last amount (§22 "randomized valid journals").

**Gate — every money invariant passes; a fresh restore reproduces totals; full manual operation works
without a network:** ⬜ **not met.**

- Money invariants: ✅ pass, in the domain **and** through encrypted SQLite.
- Fresh restore: ⬜ there is no backup or restore. A weaker property is proven — reopening the
  database reproduces every balance.
- Full manual operation: ⬜ the UI is uncommitted and unverified, and nothing has been deployed.

---

## M2 — SMS history and live ingestion

Mechanism superseded by [ADR 0004](adr/0004-sms-via-termux-api-polling.md): `termux-sms-list`
polling, not `ContentResolver` plus `SMS_RECEIVED_ACTION`. The §5.4/§5.5 *requirements* below are
unchanged.

| ☐ | Item | Status | Notes |
|---|---|---|---|
| ☐ | OS-level SMS read capability | ✅ | See M0. |
| ☐ | Extraction schema and endpoint policy | 🟡 | `schema.ts`, `endpoint-policy.ts`, `prompt.ts`, `provider.ts`, `extraction-client.ts` and `validate-evidence.ts` all exist and typecheck. Not yet wired into any ingestion path, and no extraction has been run against the live endpoint from application code. |
| ☐ | History import with sender/date filters and a preview count | ⬜ | Via `termux-sms-list` paging, filtered application-side. |
| ☐ | Selected-file import (SMS Backup & Restore XML) | ⬜ | Mandatory fallback per §5.2. |
| ☐ | Consent and filter preview | ⬜ | |
| ☐ | Durable capture with staging before parsing | ⬜ | No `source_messages` table in the schema yet. |
| ☐ | Multipart support | ➖ | The provider returns reassembled rows, so §5.5's `getMessagesFromIntent()` work does not apply. Nothing to do. |
| ☐ | Recovery scans, overlap window, watermarks | ⬜ | More important here than in the buildspec's design: polling *guarantees* re-reads. |
| ☐ | Coverage dashboard | ⬜ | Must show polling gaps and any period where Termux was dead. |
| ☐ | Versioned parsers, fixed 0.8B fallback, evidence validation | 🟡 | Evidence-validation code exists but is uncommitted and untested. |
| ☐ | Account mapping, review queue, duplicate candidates | ⬜ | `account_aliases` exists in the schema; nothing reads it. |
| ☐ | Learnable merchant/category rules with explicit previews | ⬜ | |

**Gate — repeated/overlapping imports and simulated crashes produce no duplicate financial effects;
live supported SMS capture works on a real device:** ⬜ **not met.** The capture *capability* is
verified; no capture code exists.

---

## M3 — Gmail and cross-source matching

| ☐ | Item | Status |
|---|---|---|
| ☐ | Read-only OAuth (`gmail.readonly`) | ⬜ |
| ☐ | Scoped historical scan, incremental `history.list` replay | ⬜ |
| ☐ | Reconnect and error handling (401/403/429, expired marker → scoped full sync) | ⬜ |
| ☐ | MIME decode and HTML sanitization with no remote loads | ⬜ |
| ☐ | Source/event matching across SMS and email | ⬜ |
| ☐ | Bill and receipt event separation | ⬜ |

**Note:** §6's Android identity-library flow does not apply here. A Node server needs a different
OAuth flow, with its own refresh-token storage decision — and
[ADR 0003](adr/0003-sqlite-encryption-with-passphrase-derived-key.md)'s "server starts locked" means
there is no key to encrypt a refresh token with until the owner unlocks. **This needs its own ADR
before M3 starts.**

**Gate:** ⬜ not met.

---

## M4 — Reconciliation and bills

| ☐ | Item | Status | Notes |
|---|---|---|---|
| ☐ | Current-balance entry and unknown adjustments | 🟡 | `balance_observations`, `reconciliation_checkpoints`, `unknown_adjustments` and `adjustment_explanations` tables exist; posting an unknown adjustment works and is tested (§22 fixture 8). No observation entry flow, no candidate search, no explanation writes. |
| ☐ | Candidate search, partial/full explanations | ⬜ | |
| ☐ | Stale-checkpoint handling after backdated changes | ⬜ | |
| ☐ | Recurrence detection and owner-approved plans | ⬜ | No `recurring_plans` table yet. |
| ☐ | Bill instances, payment allocations, paid/overdue state | ⬜ | No `bill_instances` table yet. |
| ☐ | Reminders | ⬜ | |

**Gate — the worked examples in §10–§11 pass exactly, including backdated evidence, partial payment
and undo:** ⬜ not met.

---

## M5 — Forecast and savings

| ☐ | Item | Status |
|---|---|---|
| ☐ | Daily projections and next-month view | ⬜ |
| ☐ | Covered-history estimates, credit-card cash timing | ⬜ |
| ☐ | Base and conservative scenarios | ⬜ |
| ☐ | Goals and virtual reservations | ⬜ |
| ☐ | Explainable savings amount, low-balance dates, stale-data indicators | ⬜ |
| ☐ | Accessible chart **and** table | ⬜ |

**Gate:** ⬜ not met.

---

## M6 — Agent with independent model selection

| ☐ | Item | Status |
|---|---|---|
| ☐ | Separate agent endpoint settings, independent of extraction | ⬜ |
| ☐ | Model dropdown | ➖ — §14.1's `/api/tags` does not exist on llama.cpp. Needs its own ADR; see [adr/README.md](adr/README.md). |
| ☐ | Capability tests before enabling tool use | ⬜ |
| ☐ | Ask / Assist modes, typed tools, scoped reads | ⬜ |
| ☐ | Structured confirmations, exact proposal binding | ⬜ |
| ☐ | Permissions, cancellation, bounded loops | ⬜ |
| ☐ | Idempotency | ✅ — already enforced in the service layer and tested (§22 fixtures 17 and 18) |
| ☐ | Audit and undo | 🟡 — append-only audit tables exist; no action-level undo |
| ☐ | App-data customization through the same services as the UI | ⬜ |

**Gate — adversarial messages cannot bypass policy; every mutation is attributable and confirmed;
changing the agent model leaves extraction unchanged:** ⬜ not met.

---

## M7 — Hardening and personal release

| ☐ | Item | Status | Notes |
|---|---|---|---|
| ☐ | Full restore drill | ⬜ | Nothing to restore from. |
| ☐ | Migration testing from each shipped schema | 🟡 | Migrations are proven idempotent, and an edited migration is refused. Nothing has shipped, so there is no prior schema to migrate from. |
| ☐ | Accessibility and visual review | ⬜ | Browser/TalkBack-on-web, not Compose ([ADR 0001](adr/0001-nextjs-node-on-termux-instead-of-kotlin-compose.md)). |
| ☐ | Battery and performance checks | ⬜ | New concern here: a long-lived Node process plus SMS polling. |
| ☐ | Secret and log audit | ⬜ | The database key is in process memory ([ADR 0003](adr/0003-sqlite-encryption-with-passphrase-derived-key.md)) — it must never reach a log, an audit payload or an error message. `passphrase.ts` has a `wipe()` helper; whether every path uses it has not been audited. |
| ☐ | Source-gap recovery | ⬜ | |
| ☐ | Signed installable Android package | ➖ | No APK exists. **Replacement gate is undecided** — a candidate is a reproducible deploy bundle with a recorded checksum plus the install steps in [termux-setup.md](termux-setup.md). Needs a decision. |
| ☐ | README covering setup, architecture, schema, endpoints, permissions, privacy, limitations, troubleshooting | 🟡 | [README.md](../README.md) and [termux-setup.md](termux-setup.md) cover all of those except the schema, which is now written but not documented. |
| ☐ | Authentication before any LAN exposure | ⬜ | Not in §21, but [ADR 0001](adr/0001-nextjs-node-on-termux-instead-of-kotlin-compose.md) creates the HTTP surface §3 forbade. `scripts/start-server.sh` binds loopback by default and refuses a non-loopback bind without `--expose-lan`. That is a stopgap, not the §16/§18 requirement. |
| ☐ | Play SMS/OAuth/privacy review | ➖ | Not applicable — nothing is distributed through Play. |

**Gate:** ⬜ not met.

---

## Cross-cutting: §22 "Definition of done"

| ☐ | Item | Status |
|---|---|---|
| ☐ | All mandatory workflows implemented and exercised | ⬜ |
| ☐ | Domain invariants pass | ✅ 97/97 tests, including randomised property sweeps, §17.3 invariants enforced in SQL, and the vault lock/unlock lifecycle |
| ☐ | Integration and security tests pass | 🟡 storage, migration, immutability, append-only-audit and idempotency tests exist. None of §22's "Security tests" (prompt injection, forged approvals, replay, scope escape) exist, because there is no agent. |
| ☐ | SMS/Gmail/model capabilities labelled verified, blocked or unsupported with evidence | 🟡 SMS ✅ verified on device; Gmail ⬜ untried; model 🟡 endpoint identified, extraction unproven |
| ☐ | Both AI roles independently configurable, extractor fixed | ⬜ |
| ☐ | Every agent write has an approved preview, atomic audit, meaningful undo | ⬜ |
| ☐ | Backups restore on a clean install with correct balances and bill state | ⬜ |
| ☐ | Build, setup, migration, permission and troubleshooting docs | 🟡 setup, permissions and troubleshooting done ([termux-setup.md](termux-setup.md)); the schema and its migrations are undocumented |
| ☐ | No real user data in the repository | ✅ every fixture is synthetic; `.gitignore` excludes `/data/`, `*.db`, `/fixtures/real/` and `*.sms-backup.xml` |
| ☐ | Anything proven on the device | ⬜ only the SMS capability. No build has been deployed, no server started, no native module compiled on the S20. |

---

## How to re-check this

```bash
npm run check      # typecheck + tests
npm test           # tests only, with per-suite names
git status --short # what is in flight and not yet committed
```

Update the "Last checked" block at the top when you do, including the commit hash and the observed
test and typecheck counts. Do not tick a box on the strength of code existing — tick it when
something observed it working, and say where.
