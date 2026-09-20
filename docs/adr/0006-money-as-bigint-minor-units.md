# 0006 — Money as `bigint` minor units, decimal strings on the wire

- **Status:** Accepted
- **Date:** 2026-09-20
- **Implements:** `buildspec.md` §1 rule 6, §9.1, §16 ("Shared contract rules")
- **Related:** [0001](0001-nextjs-node-on-termux-instead-of-kotlin-compose.md)

## Context

`buildspec.md` §1 rule 6: *"Amounts use integer minor units. Never use floating-point arithmetic for
money."* §9.1: *"Use Kotlin `Long` with checked arithmetic and currency scale metadata. In JSON
contracts encode minor-unit values as decimal strings to avoid loss of precision in future
JavaScript clients."* §16: *"Store money as 64-bit integers internally. Validate JSON strings with a
strict signed-integer parser and overflow checks."*

The buildspec is writing for Kotlin, where `Long` is the obvious carrier. In the JavaScript runtime
chosen by [ADR 0001](0001-nextjs-node-on-termux-instead-of-kotlin-compose.md) there is no `Long`,
and `number` is an IEEE-754 double:

- Integers above `2^53 − 1` (`Number.MAX_SAFE_INTEGER`, 9,007,199,254,740,991) stop being exactly
  representable. In LKR minor units that ceiling is about **LKR 90 trillion** — comfortably beyond
  any real balance, but *not* beyond a fuzz test, a corrupted import, or an adversarial message
  claiming a nine-figure transfer. §22 explicitly requires "checked arithmetic near integer limits".
- Worse, `number` makes fractional values *possible*. `0.1 + 0.2 !== 0.3` is exactly the class of bug
  rule 6 exists to forbid, and a `number` field invites someone to store LKR 3450.00 in it.
- The buildspec's §9.1 note about "future JavaScript clients" losing precision now describes the
  **primary** runtime, not a hypothetical one.

## Decision

Money is `{ currency: Currency, minor: bigint }` throughout the application
(`src/core/domain/money.ts`).

- **`bigint`, not `number`.** `bigint` is exact and arbitrary-precision, so there is no silent
  rounding anywhere in the money path. `bigint` has no fractional values at all, which makes "minor
  units only" a type-level guarantee rather than a convention.
- **Currency carries its own scale.** 0-, 2- and 3-decimal currencies are all supported; the scale
  lives on the `Currency` record and drives parsing, formatting and split allocation. `LKR` is the
  onboarding default per §2.
- **Range is checked, not assumed.** Because `bigint` will happily hold a number no ledger should
  ever contain, parsing enforces an explicit signed 64-bit bound so the value still fits SQLite's
  `INTEGER` column (§17: "money and revisions are INTEGER internally") and so absurd imported
  amounts are rejected at the boundary rather than stored.
- **Excess fractional digits are rejected, never rounded** (§9.1). `parseMajorUnits` fails on a
  third decimal in a 2-decimal currency instead of quietly dropping it.
- **The wire format is a decimal string.** `toWire` / `fromWire` produce and consume
  `{ amount_minor: string, currency: string }`. JSON has no integer type and `JSON.stringify` throws
  on `bigint`, so a string is both the §9.1-mandated format and the only one that survives the
  round trip. The same representation is used for the HTTP API, for React Server Component payloads
  crossing to the client, and for model-facing contracts.
- **Splits allocate exact minor units.** `splitEvenly` and `allocateProportionally` distribute
  remainders deterministically so the sum of parts always equals the total (§7.5, §22).
- **Currencies never mix.** Arithmetic on two different currencies throws rather than producing an
  unlabeled number (§9.1).

## Consequences

- **`bigint` does not survive JSON, `structuredClone` into some transports, or a naive
  `res.json()`.** Every boundary needs an explicit conversion. This is a papercut on every new
  endpoint and component prop, and the discipline has to be enforced by review and types — the
  compiler will catch a `bigint` in a `number` slot, but not a forgotten `toWire`.
- **`bigint` is slower than `number`** and allocates. Irrelevant for ledger arithmetic at personal
  scale; it would matter in a hot loop over hundreds of thousands of rows, which this app does not
  have.
- **`bigint` literals need `ES2020`+ and cannot be mixed with `number` in arithmetic.** Mixing
  throws a `TypeError` at runtime rather than coercing — which is the desired behaviour, and one the
  test suite relies on.
- **SQLite stores these as `INTEGER`**, and `better-sqlite3-multiple-ciphers` must be read in a mode
  that returns them as `bigint` rather than lossy `number` on the way back out. Getting that wrong
  reintroduces exactly the precision loss this ADR exists to prevent, so it needs a test at the data
  layer when that layer is built.
- Formatting for display uses tabular digits and per-currency scale (§13), derived from the same
  `Currency` record — there is no second source of truth for how many decimals a currency has.
