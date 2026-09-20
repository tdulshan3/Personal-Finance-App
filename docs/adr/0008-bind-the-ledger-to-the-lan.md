# 0008 — Binding the ledger to the LAN

**Date:** 2026-09-20
**Status:** Accepted
**Amends:** [ADR 0007](0007-http-session-auth-for-the-phone-server.md), which bound the server to loopback.

## Context

ADR 0007 kept the server on `127.0.0.1` and said plainly that exposing it beyond loopback needed
transport encryption first. The termox dashboard then grew a link to the ledger, and from any
machine other than the phone that link could not resolve — the panel advertised the service and
then declined to take you to it.

There were three ways out, and the owner was asked to choose:

1. An SSH tunnel over the sshd already running on port 8022. Encrypted, exposes nothing, and
   verified working end to end from the PC before the question was put.
2. Bind `0.0.0.0`, accepting a cleartext passphrase on the LAN.
3. Leave it phone-only.

**The owner chose (2) on 2026-09-20**, with the cost stated explicitly in the question.

## Decision

`scripts/phone/finance.sh` defaults `PFA_HOST` to `0.0.0.0`. `PFA_HOST=127.0.0.1` returns it to
loopback, and the SSH tunnel in option 1 keeps working either way.

## Consequences

**What this costs, stated without hedging.** The transport is plain HTTP. The passphrase is also the
database key (ADR 0003), so on every unlock the key to the entire ledger crosses the network in
cleartext. Anyone who can observe traffic on this LAN — another device, a compromised router, the
Wi-Fi itself — can read it and then decrypt everything, including any backup made with the same
secret. Binding to `0.0.0.0` also means the port answers every host on the network, not just the
laptop, so the unlock screen is exposed to unlimited passphrase guessing with no rate limit
(ADR 0007 records that there is none).

**What it does not cost.** The database stays encrypted at rest, an unauthenticated request still
sees only the unlock screen and `/api/health`, and the health endpoint carries no financial data.

**Context that makes it defensible, but does not make it safe.** Every other service on this phone —
termox, AdGuard Home, Immich, both model servers — already answers the LAN with no authentication
at all. This is the only one that asks for a secret. The exposure is consistent with the rest of the
deployment on a home network the owner controls.

**This is temporary.** It is the reason ADR 0007's successor on transport encryption is now the
highest-priority security work, not a deferred nicety. A self-signed certificate with a pinned CA
closes the cleartext window; rate limiting on unlock closes the guessing one. Until both land, the
honest description of this deployment is "encrypted at rest, unencrypted in transit, on a trusted
LAN".

**Reversing it** is one environment variable and a restart. Nothing else in the app depends on the
bind address.
