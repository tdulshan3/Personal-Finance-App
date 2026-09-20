# 0009 — The assistant: rules first, and a proposal boundary the model cannot cross

**Date:** 2026-09-20
**Status:** Accepted
**Resolves:** the "§14.1 agent model discovery / tool calling" conflict listed in the README.

## Context

buildspec.md §14 describes a chat assistant on a larger local model with native tool calling. Two
things were true when it came to building it:

- The owner's agent models are a 2B dense model and a 35B MoE, both on a PC that is not always on.
  A live run against the 2B model showed it answering ledger questions correctly through tools, but
  also drafting a transaction from "around 400 I think" and filing lunch under Uncategorized. Small
  models follow prompt rules most of the time, which is not the standard money needs.
- The owner asked, for message extraction, for "basic rules and model together" rather than leaning
  on the model. The same reasoning applies here: most of what anyone asks a finance app is a ledger
  query with regular phrasing.

## Decision

**1. Rules answer first (`src/agent/intents.ts`).** Balances, spending for a period, recent
transactions, the review count, and statements of the form "I spent 1250.00 on lunch [yesterday]
[from Account]" are handled by whole-message patterns and ledger queries. No model is called; the
Assistant works with none configured. Patterns are anchored at both ends so a half-understood
question falls through to the model instead of being hijacked. An account is matched only by a
fragment *of its own name* — "Nowhere Bank" must not select the account called "Bank" — and two
candidates produce a question, never a pick.

**2. The model gets tools, and only these (`src/agent/tools.ts`).** Read tools return figures the
finance engine computed (§1.1: the model never adds money). `propose_*` tools create a row in
`action_proposals` and nothing else. There is no tool that approves, executes, changes settings,
reads raw message bodies or touches an endpoint. Delete proposals are off unless the owner turns
them on. Two rules the prompt states are also *enforced in code*, because a small model will not
reliably follow them: a hedged amount ("about", "around", "I think") makes every `propose_*` call
return an error telling the model to ask, and a missing category is filled from the owner's own
history, then keywords.

**3. Confirm is the only path to the ledger (`src/agent/proposals.ts`).** `approveAndExecute` is
called from one place: a server action behind the session cookie, fired by a button on the proposal
card. It re-checks, inside one database transaction: status, expiry (10 minutes), that the hash the
card carried equals the hash of the stored arguments and targets (so arguments changed after preview
cannot execute), that the agent model and digest are the ones that drafted it (§14.1), and that the
proposal still builds against current records (archived account, edited or deleted target → stale).
It writes a one-use `approval_receipts` row, posts through the same `finance-service` the manual
forms use with `idempotency_key = proposal:<id>`, and records the actor as `agent` with the model
identity. A second Confirm returns the first result. Owner text such as "yes, approved" is
conversation; it is never authorization.

**4. Both wire formats, one policy.** Ollama-native `/api/chat` and OpenAI-compatible
`/chat/completions` are normalised in `src/agent/chat-client.ts`, which can reach exactly one
allowlisted path through the existing endpoint policy (no redirects, capped response, deadline).

## Consequences

- **Deviation from §14.4's "60 seconds per turn".** The read deadline is 240 s, because a cold load
  of the 35B model alone can exceed a minute on the owner's hardware. The other limits hold (8 tool
  steps, repeated-call detection, truncated tool results, 5 proposals per turn — stricter than the
  spec's 10), and Stop is always available. Stop is a route, not a server action, because Next.js
  serialises server actions per client and a Stop action would queue behind the turn it cancels.
- The assistant's replies on the rules path are templated and English-only. The model path answers
  in the owner's language.
- Chat history replays only owner and assistant text (last 12), not stored tool output, so tool
  results never re-enter context as if they were conversation.
- Tested in `src/agent/agent.test.ts` with a scripted model that makes each hostile move exactly:
  false approval, tampered arguments, wrong hash, swapped model, expiry, double confirm, a tool not
  offered in the current mode, and a runaway loop. Tool calling itself was verified once, live,
  against `qwen3.5:2b` on a throwaway ledger with synthetic data.
- Not built: citations linking an answer to the transactions behind it (§14.4), per-tool permission
  profiles beyond Ask/Assist/allow-delete, and streaming.
