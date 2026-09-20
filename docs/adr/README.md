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

## Known conflicts without an ADR yet

- **§14.1 agent model discovery** still specifies Ollama's `/api/tags` and native tool calling, and
  §16 maps `ModelService.listAgentModels` onto it. If the agent endpoint is also llama.cpp, it needs
  the same treatment as [ADR 0005](0005-llama-cpp-openai-endpoint-instead-of-ollama.md), plus a
  decision about tool calling. Needed before M6.
- **§16 / §18 authentication for the HTTP surface.** [ADR 0001](0001-nextjs-node-on-termux-instead-of-kotlin-compose.md)
  introduces a real HTTP server on the phone, which §3 forbade. How sessions, CSRF defence and the
  lock state interact has not been decided. Needed before the server is ever bound to a LAN address.
- **§21 M7's "signed installable Android package"** has no equivalent here. What replaces it as a
  release gate is sketched in [../milestones.md](../milestones.md) but not decided.

## Format

Context / Decision / Consequences. Short. Dated. Numbered in the order they were taken, never
renumbered. A superseded ADR is marked superseded rather than deleted.
