# 0007 — Authenticating the HTTP surface the Termux server exposes

**Date:** 2026-09-20
**Status:** Accepted
**Supersedes:** part of `buildspec.md` §3 ("Do not add a public HTTP server to the phone just to use
the contracts") and fills the §16 / §18 gap that [ADR 0001](0001-nextjs-node-on-termux-instead-of-kotlin-compose.md)
opened.

## Context

`buildspec.md` §3 is explicit that version 1 should call typed application services **inside the
Android process**, and that the §16 API names are in-process contracts with only a *future* REST
mapping. It says in as many words: "Do not add a public HTTP server to the phone just to use the
contracts."

ADR 0001 moved the app to Next.js under Termux. That decision makes an HTTP server unavoidable —
it is now the only way the owner reaches their own ledger. So the protection §3 got for free from
the Android process boundary has to be rebuilt explicitly, and §16's rule still stands:

> Owner identity and capabilities come from trusted session context, never from model-supplied
> `owner_id`, `role`, or `confirmed:true`.

§18 adds that a future network adapter "must authenticate paired clients, encrypt transport, scope
access, enforce the same confirmations, and defend browser-origin/CSRF paths where relevant".

Two constraints shape the answer:

1. **There is no separate credential store.** [ADR 0003](0003-sqlite-encryption-with-passphrase-derived-key.md)
   makes the owner's passphrase the source of the database key, and the server starts locked. So
   there is nothing to check a password against until the owner has already supplied the passphrase.
2. **The transport is plain HTTP on a LAN.** Termux has no certificate the phone's browser would
   trust, and §18 forbids globally disabling certificate validation to paper over that.

## Decision

**Unlocking *is* authentication.** There is no second credential.

- The server process starts **locked**: no key, no database handle, no service.
- `unlock(passphrase)` derives the key with scrypt and checks it against the vault's verifier
  *before* SQLCipher sees it, so a wrong passphrase is reported as `LOCKED` ("that passphrase is not
  correct") rather than as a corrupt database.
- A successful unlock mints a fresh 32-byte random token held only in process memory. The browser
  receives it as an `httpOnly`, `SameSite=Strict`, path-scoped cookie. The cookie carries **no** key
  material and no passphrase.
- Every request resolves to one of four states — `needs-setup`, `locked`, `needs-session`, `ready` —
  and every page and every mutating server action re-checks it. Nothing trusts a value supplied by
  the caller.
- The token is compared in constant time and is **regenerated on every unlock**, so a token captured
  before a lock cannot be replayed after one. `lock()` wipes it.
- CSRF: `SameSite=Strict` plus Next.js Server Actions, which reject cross-origin POSTs by default.
  There is no `GET` route that mutates state.
- **Binding stays on loopback.** `scripts/start-server.sh` requires an explicit `--expose-lan` flag
  to bind `0.0.0.0`, and the flag is documented as "not yet safe" because the transport is
  unencrypted.

`Secure` on the cookie is controlled by `PFA_REQUIRE_HTTPS`, left unset, because setting it over
plain HTTP would silently drop the cookie and make the app look broken rather than insecure.

## Consequences

**What this gets right.** The §16 rule holds: capability comes from server-side session state, never
from the request. Locking is real — it drops the key, not just a UI flag. There is exactly one
secret for the owner to manage, and losing the session cannot leak the ledger because the key is
not in the cookie.

**What we give up.**

- **No multi-client pairing.** §18's "authenticate paired clients" is not implemented. One browser
  session at a time is the practical model; a second browser must unlock again, which re-mints the
  token and **invalidates the first**. That is a real usability cost and is deliberate: it keeps
  exactly one live session.
- **No transport encryption.** Over `--expose-lan` the passphrase crosses the network in the clear.
  Until that is fixed the flag should not be used on a shared network. Loopback plus
  `adb forward tcp:3000 tcp:3000` is the safe way to reach the phone from the PC.
- **No rate limiting on unlock attempts.** scrypt at N=2^16 makes each attempt cost about a second,
  which is a weak but non-zero brake. A deliberate lockout policy is not implemented.
- **Anyone who can reach the port and knows the passphrase is the owner.** There is no second
  factor and no device binding.
- **Background work cannot run while locked.** Inherited from ADR 0003 and restated here because it
  is the visible product consequence: SMS polling stops when the server is locked or restarted.
  §18 forbids promising both mandatory authentication and unattended processing; this picks
  authentication.

## Alternatives considered

- **A separate app password, stored hashed.** Adds a second secret to lose and still cannot decrypt
  the database on its own, so the owner would have to type both. Rejected as worse for no gain.
- **Unix socket only, reached over `adb forward`.** Genuinely safer, and still the recommended way
  to reach the phone from the PC — but it makes the phone's own browser the awkward case, which is
  the primary way the owner will actually use this.
- **A self-signed certificate with a pinned CA.** Defensible later. It needs a certificate
  lifecycle, and getting the phone's browser to trust it is a manual step per device. Deferred
  rather than rejected; it is the prerequisite for `--expose-lan` becoming safe.

## Open

Before the server is ever exposed beyond loopback, this ADR needs a successor covering transport
encryption and client pairing. `buildspec.md` §21 M7's release gate ("signed installable Android
package") has no equivalent here and is still undecided — see `README.md` in this directory.
