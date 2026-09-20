# 0010 — Live updates: one SSE stream, driven by SQLite's change counter

**Date:** 2026-09-20
**Status:** Accepted

## Context

The ledger changes without the person looking at it doing anything: a bank SMS arrives from the
other phone, the background reader turns it into a review item, a transaction is recorded from the
desktop while the phone is open on Home. Every screen was a snapshot until reloaded. The owner asked
for real-time sync, and for a desktop layout — which makes two windows on one ledger the normal case.

Two questions had to be answered: how does the server know something changed, and how does it tell
the browsers.

## Decision

**Detecting change: poll `total_changes()` once a second.** SQLite counts every row a connection
inserts, updates or deletes. This process holds exactly one connection
([ADR 0003](0003-sqlite-encryption-with-passphrase-derived-key.md), `src/server/runtime.ts`), so that
one integer covers *every* write path — manual forms, the webhook, the background reader, review,
assistant proposals, settings — with no write path having to announce itself. The alternative, an
event bus that each writer calls, is correct only until someone adds a writer and forgets; this
cannot be forgotten. Reading the counter is an in-memory call, and polling runs only while at least
one browser is connected (`src/server/live.ts`).

`PRAGMA data_version` was considered and rejected: it reports changes made by *other* connections,
and there are none.

**Telling browsers: Server-Sent Events** at `GET /api/events`. One-way traffic is all that is
needed, SSE is plain HTTP through the standalone server with no upgrade handling, and `EventSource`
reconnects by itself. The response sets `Cache-Control: no-transform`, without which the server's
gzip layer buffers events until it has enough to compress.

**What travels: `{boot, version}` and nothing else.** No amounts, names or message text
(buildspec.md §18). The browser reacts with `router.refresh()`, which re-renders the current route
on the server through the ordinary session check and swaps the result in without a page load, so
client state — a half-typed form, scroll position — survives. `boot` identifies the process, so a
restart is never mistaken for "nothing changed".

**Access.** The stream opens only with the session cookie, and every stream is closed when the
ledger locks. A refused stream (401) makes the client do one ordinary refresh — which lands on the
unlock screen — and then stop retrying.

**Manners** (`src/ui/live-sync.tsx`): no refresh mid-keystroke (it waits for a 1.5 s pause); no
connection while the tab is hidden, because browsers allow six connections per origin and a phone
should not hold a radio open for a screen nobody is looking at; on return, the `hello` event's
version tells the client whether it missed anything. The hub deliberately keeps its last reading
while idle so that a write made with nobody connected is still seen by the next arrival.

## Consequences

- Measured in a two-window test: a change confirmed in one window appeared in the other 608 ms
  later, with no reload. Locking in one window moves the other to the unlock screen.
- Latency is bounded by the 1 s poll plus a 250 ms coalescing delay. Good enough for a ledger; the
  poll interval is one constant.
- A change triggers a refresh of *whatever* page is open, whether or not that page shows the data
  that changed. Pages are cheap to render and there is one owner, so precision was not worth topics.
- The window that made a change refreshes once more than it needs to (its own server action already
  re-rendered it). Harmless.
- `total_changes()` also counts statements later rolled back, so a failed write can cause a refresh
  that shows nothing new. Harmless.
- Still plain HTTP on the LAN ([ADR 0008](0008-bind-the-ledger-to-the-lan.md)). The stream adds no
  new exposure — it carries a counter — but it inherits that ADR's caveat like everything else.
- If the app ever opens a second database connection, this design silently stops seeing that
  connection's writes. `runtime.ts` says there is exactly one; this ADR depends on it.
