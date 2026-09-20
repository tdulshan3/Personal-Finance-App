# Architecture decision records

`buildspec.md` §1 asks for *"short architecture decision records"* for important implementation
decisions. These are those records.

The buildspec is version 1.0, dated 20 September 2026, and it specifies a native Kotlin/Compose
Android app. **The owner overrode that stack.** Each ADR below states what the buildspec said, what
we do instead, why, and what we give up. Where an ADR says "supersedes", the buildspec section it
names is no longer the instruction to follow — but its *requirements* usually still are, and each
ADR spells out which.

| # | Decision | Supersedes |
|---|---|---|
| [0001](0001-nextjs-node-on-termux-instead-of-kotlin-compose.md) | Next.js on Node in Termux instead of native Kotlin/Compose | §3 |
| [0002](0002-build-on-pc-deploy-standalone-to-phone.md) | Build on the PC, deploy `standalone` output to the phone | — |
| [0003](0003-sqlite-encryption-with-passphrase-derived-key.md) | SQLite encryption with a passphrase-derived key, because there is no Keystore | §18 (at-rest) |
| [0004](0004-sms-via-termux-api-polling.md) | SMS capture by polling `termux-sms-list`, not Android broadcasts | §5.4, §5.5 |
| [0005](0005-llama-cpp-openai-endpoint-instead-of-ollama.md) | llama.cpp's OpenAI-compatible endpoint instead of Ollama's native API | §7.2, §7.3 (transport) |
| [0006](0006-money-as-bigint-minor-units.md) | Money as `bigint` minor units, decimal strings on the wire | — (implements §9.1, §16) |
| [0007](0007-http-session-auth-for-the-phone-server.md) | Unlocking is authentication: one passphrase, an in-memory session token, loopback by default | §3 (the "no HTTP server" rule), fills §16/§18 |
| [0008](0008-bind-the-ledger-to-the-lan.md) | Bound to the LAN by owner choice, accepting a cleartext passphrase until TLS lands | amends 0007 |
| [0009](0009-assistant-rules-first-and-proposal-boundary.md) | Assistant answers by rules first; the model can only draft proposals, and only the owner's Confirm executes one | §14.1 tool calling, §14.4 60 s turn |
| [0010](0010-live-updates-over-sse.md) | Live updates: one SSE stream carrying only a version number, driven by SQLite's `total_changes()` | — (fills §13 "offline/loading states", §18 minimisation) |

## Known conflicts without an ADR yet

- **§21 M7's "signed installable Android package"** has no equivalent here. What replaces it as a
  release gate is sketched in [../milestones.md](../milestones.md) but not decided.
- **§6 Gmail authorization.** §6 assumes Android's identity library, which does not apply to a Node
  server. There is also an ordering problem created by [ADR 0003](0003-sqlite-encryption-with-passphrase-derived-key.md):
  the server starts locked, so there is no key available to encrypt a stored refresh token until the
  owner unlocks. Needed before M3.
- **Transport encryption and client pairing.** [ADR 0008](0008-bind-the-ledger-to-the-lan.md) put the
  server on the LAN over plain HTTP, so the passphrase now crosses the network in cleartext on every
  unlock. §18's "authenticate paired clients, encrypt transport" is unmet, and this is no longer
  theoretical: it is the highest-priority security work outstanding.

## Format

Context / Decision / Consequences. Short. Dated. Numbered in the order they were taken, never
renumbered. A superseded ADR is marked superseded rather than deleted.
