# Extraction evaluation

`buildspec.md` §22 requires extraction quality to be measured by sender and message type rather than
as one aggregate score, and §7.2 requires "fixture evaluation before acceptance" whenever the model
or the prompt changes. This file records what has actually been measured.

**Everything here was run against the owner's real endpoint.** Nothing is estimated.

## What was measured

| | |
|---|---|
| Endpoint | `http://192.168.1.118:8081/v1` — llama.cpp, OpenAI-compatible ([ADR 0005](adr/0005-llama-cpp-openai-endpoint-instead-of-ollama.md)) |
| Model | `qwen3.5-0.8b`, GGUF `Q4_0`, 752,393,024 params, `n_ctx` 65,536 |
| Digest | **Not reported by this host** — `/v1/models` returns an empty `digest` |
| Settings | `temperature: 0`, `max_tokens: 1024`, `chat_template_kwargs: {enable_thinking: false}` |
| Corpus | The 14 labelled fixtures in [`fixtures/messages/`](../fixtures/messages) — all invented |
| Date | 2026-09-20 |

The corpus is small and English-heavy (11 English, 2 Sinhala, 1 Tamil). **These numbers are a
signal, not a release gate.** §22 sets a provisional target of 99.5% precision for auto-post-eligible
events on a representative held-out set; this corpus is nowhere near large enough to support that
claim, and nothing auto-posts today.

## Rules before models

buildspec.md §7.1 puts deterministic parsing first, and on this hardware that is not a stylistic
preference — it is what makes ingestion usable at all.

`src/extraction/templates.ts` run over the same 14 fixtures:

| | Rules | Ollama `qwen3.5:2b` | llama.cpp `qwen3.5-0.8b` |
|---|---|---|---|
| `event_type` | **13/14** | 13/14 | 11/14 |
| Amount exact | 10/11 | 10/11 (parses) | 10/11 (parses) |
| Settled with no model call | **13/14** | — | — |
| Time for all 14 | **6.1 ms** | ~34 s | ~5.5 min |
| Works offline | **yes** | no (LAN) | yes (on-phone) |

The rules match the best model's classification accuracy and run roughly **5,000 times faster**,
with no network and no queue. The model's job is the remainder.

The one deferral is `sms_atm_withdrawal_with_fee`, which states a withdrawal *and* a fee. The rules
find two transactional amounts, decline to guess which is which, and hand it on — which is the
behaviour §8 asks for ("One email can contain several payment lines"), not a failure.

What the rules will not do: guess. A field is either read from literal text in the message or left
null, and a result missing anything a ledger entry needs is passed to the model rather than
completed by inference. `needsModel()` returns false only for a complete result, or for a
classification that provably involves no money (OTP, promotion, declined).

Every pattern is linear with bounded repetition, and a test feeds the parser 20,000-character
hostile inputs to prove it cannot be made to hang (§7.1, §20).

## Model comparison

Same prompt (`qwen-extract-v3`), same 14 fixtures, same 1024-token budget.

| | llama.cpp `qwen3.5-0.8b` | Ollama `qwen3.5:2b` |
|---|---|---|
| Dialect | OpenAI-compatible | **Ollama native** |
| Schema valid | 14/14 | 14/14 |
| `event_type` | 11/14 (79%) | **13/14 (93%)** |
| Amount parses | 10/11 (91%) | 10/11 (91%) |
| Currency | 12/12 | 12/12 |
| `occurred_at_text` | 11/11 | 10/11 |
| `account_suffix` | 7/10 (70%) | 5/10 (50%) |
| **p50 latency** | 23,600 ms | **2,418 ms** |
| p95 latency | 56,985 ms | 13,480 ms |
| Digest reported | no | **yes** |

The 2B model is roughly **ten times faster and more accurate**, and it gets
`sms_scheduled_standing_order` right — the "will be debited" case that §7.1 singles out, and the one
misclassification that would book money which has not moved. It is weaker on `account_suffix`
(5/10 vs 7/10), which matters for account resolution and is worth watching.

It also reports a model digest, which closes the §7.2 provenance gap that llama.cpp leaves open.

### Ollama must use its native API, not its OpenAI shim

Ollama serves both. On the `/v1` shim there is no equivalent of `think: false`, and these models
think by default: `qwen3.5:2b` spent its entire 1024-token budget on hidden reasoning and returned
`content` of length **0**, with `finish_reason: "length"`. Extraction silently produced nothing.

Provider detection originally probed the OpenAI paths first, so **every Ollama host was misdetected
into the broken dialect**. `detectionCandidates` now probes `/api/tags` first; llama.cpp does not
serve it (verified HTTP 404) and still resolves correctly.

| Request | `content` | `thinking` | Result |
|---|---|---|---|
| `/v1` + `chat_template_kwargs` | 0 chars | 3,551 chars | silently empty |
| `/api/chat` + `think: false` | 595 chars | 0 | correct, 3.3 s |

The 34.7B MoE (`qwen36-uncensored`) also answered correctly but took 88.8 s on a cold call at
28 t/s, against 3.3 s at 86 t/s for the 2B. For short extraction prompts the small model wins
decisively.

## Prompt versions

| Version | Instruction | Output budget | Schema valid | `event_type` | Amount parses |
|---|---|---|---|---|---|
| `qwen-extract-v1` | §7.3 text verbatim | 512 | — | 7 / 14 | **2 / 14** |
| *(intermediate, never shipped)* | + field rules, one example | 512 | — | 9 / 14 | 11 / 14 |
| `qwen-extract-v3` | + ordered decision list, four mixed examples | 512 | 10 / 14 | 7 / 14 | 9 / 11 |
| `qwen-extract-v3` | *same prompt*, adequate budget | **1024** | **14 / 14** | **11 / 14 (79%)** | **10 / 11 (91%)** |

An amount counts as correct only when `parseMajorUnits` can actually turn it into minor units —
the same check `validate-evidence.ts` applies before an amount reaches the ledger.

Full field scores for the shipped configuration:

```text
schema valid       14/14 (100%)
event_type         11/14  (79%)
amount parses      10/11  (91%)
currency           12/12 (100%)
occurred_at_text   11/11 (100%)
account_suffix      7/10  (70%)
```

### The output budget mattered more than the prompt

buildspec.md §7.2's example configuration sets `num_predict: 512`. On this schema that truncates:
four fixtures hit `finish_reason: "length"` part-way through the JSON and came back unparseable, so
they scored zero on every field at once. Raising the budget — with the prompt unchanged — moved
schema validity from 10/14 to 14/14 and event-type accuracy from 7/14 to 11/14.

§7.3 says truncation must not silently lose amounts, so `EXTRACTION_DEFAULTS.numPredict` is 1024,
above the worst output observed (930 tokens). This is one of the places the specification's
illustrative numbers do not survive contact with the actual model.

### Why the spec's own prompt failed

Given the buildspec's own §7.3 example —

```text
Purchase of LKR 3,450.00 at KEELLS SUPER using card ****1234
on 20/09/2026. Available balance LKR 52,340.20.
```

— the model returned `amount_text: "Purchase of LKR 3,450.00"`: the whole phrase, not the number.
It also classified the purchase as `bill`. Both reproduced identically on every call, as expected at
temperature 0.

The JSON was schema-valid every time, so the **M0 gate passed**. But `validate-evidence` rejected
the amount as unparseable, which meant every message would have reached the review queue carrying a
candidate the owner had to retype by hand. That is a working pipeline producing useless output.

Nothing in the validation layer was loosened to fix this. The prompt was made to state the field
format and to order the classification decisions.

### Why the intermediate version was not shipped

Its single worked example was an expense, and the model started answering `posted_expense` for
nearly everything — it lost `promotion` and the Sinhala OTP, which v1 had classified correctly. The
shipped version uses four mixed examples (expense, income, promotion, balance notice) and an ordered
decision list that puts OTP and promotion checks *before* the money-movement checks.

## Per-message-type results for `qwen-extract-v3`

| Fixture | Expected | Returned | `event_type` | Amount |
|---|---|---|---|---|
| `sms_posted_purchase_keells` | `posted_expense` | `posted_expense` | ✅ | ✅ |
| `sms_sinhala_posted_purchase` | `posted_expense` | `posted_expense` | ✅ | ✅ |
| `sms_tamil_posted_purchase` | `posted_expense` | `posted_expense` | ✅ | ✅ |
| `sms_salary_credit` | `posted_income` | `posted_income` | ✅ | ✅ |
| `sms_refund_online_store` | `refund` | `refund` | ✅ | ✅ |
| `sms_failed_declined_fuel` | `failed` | `failed` | ✅ | ✅ |
| `sms_balance_notice_available` | `balance_notice` | `balance_notice` | ✅ | — |
| `email_bill_reminder_broadband` | `bill` | `bill` | ✅ | ✅ |
| `sms_otp_payment_code` | `otp` | `otp` | ✅ | — |
| `sms_sinhala_otp` | `otp` | `otp` | ✅ | — |
| `sms_promotion_card_offer` | `promotion` | `promotion` | ✅ | — |
| `email_prompt_injection_receipt` | `posted_expense` | `bill` | ❌ | ✅ |
| `sms_scheduled_standing_order` | `pending_payment` | `posted_expense` | ❌ | ✅ |
| `sms_atm_withdrawal_with_fee` | `transfer` | `posted_expense` | ❌ | ✅ |

Per expected type: `posted_expense` 3/4, and 1/1 on each of `posted_income`, `refund`, `failed`,
`balance_notice`, `bill`, `promotion`, plus `otp` 2/2. `pending_payment` and `transfer` are 0/1.

### Reading the three misses

- **`sms_scheduled_standing_order` is the one that matters.** buildspec.md §7.1 is explicit: "A
  message saying 'will debit' is scheduled, not posted." Calling it `posted_expense` is the failure
  mode that would book money that has not moved. It is caught downstream — §7.4 sends every
  model-derived entry to review — but this is the classification to watch as the corpus grows.
- **`sms_atm_withdrawal_with_fee`** expects `transfer`, which is not one of §7.3's nine types; it was
  added for §22's ATM-plus-fee fixture. `posted_expense` for a cash withdrawal is defensible, and
  §9.2 says the bank-to-cash decision belongs to the owner anyway.
- **`email_prompt_injection_receipt`** was read as a `bill` rather than a completed payment. Worth
  noting what did *not* happen: the embedded "ignore previous instructions" text had no effect on
  the output at all. The misclassification is ordinary model error, not a successful injection.

## Latency

Across the full 14-fixture run at the shipped settings:

```text
p50 23,600 ms    p95 56,985 ms    min 13,769 ms    max 56,985 ms
prompt ~940 tokens, output 220-930 tokens
13-20 tokens/second
```

§7.2 plans around "roughly 10 output tokens/second"; raw generation here is about twice that. But
the wall-clock number is what matters for the product: **a single message costs 14-57 seconds.**

That is the constraint that shapes ingestion. A 500-message history import is hours of model time,
not minutes, which makes §7.2's queue progress, pause/cancel, charging/Wi-Fi preferences and
estimated completion hard requirements rather than polish. It is also why the deterministic sender
templates of §7.1 matter more than the model does: every message a template handles is a message
that never waits 20 seconds. The model is the fallback, not the pipeline.

**Thinking output must be disabled.** Without `chat_template_kwargs: {enable_thinking: false}` this
model emits `reasoning_content`, leaves `content` empty and hits `finish_reason: "length"` — 23–25
seconds spent to return nothing. §7.3 requires thinking to be disabled "when supported and verified
for the model/server"; that switch is the verified one for this host. `reasoning_content` is read
only to set a flag and is never stored, per §7.3's "never save hidden reasoning as a financial
record".

## Known gaps

- **Only one fixture has been sent to the model three times**; the rest were sent once per prompt
  version. There is no variance measurement.
- **No per-sender breakdown.** §22 wants scoring by sender and template. The corpus has no repeated
  senders yet.
- **Validation and development samples are not separated.** §22 requires held-out validation; the
  same 14 fixtures were used to develop the prompt and to score it, so these numbers are optimistic.
  A held-out set is needed before any auto-post rule is considered.
- **No digest to pin.** §7.2 wants the model digest stored with every extraction. This build reports
  an empty digest, so `ModelCallRecord.digest` is `null`. Hashing the GGUF on the host would fix it.
- **Nothing auto-posts.** §7.4: "Version 1: ... model-derived financial entries require review."
  These numbers change how useful the review queue is, not whether review happens.

## Reproducing

```bash
npm run probe:extraction     # provider detection, models, health, 3 timed calls, M0 gate
```

Re-run this evaluation and update the tables whenever the prompt, the schema, the model or the
server changes. §7.2: "Model updates require fixture evaluation before acceptance."
