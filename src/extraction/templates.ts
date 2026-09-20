import { CURRENCIES, parseMajorUnits } from "../core/domain/money.ts";
import type { EventType } from "./schema.ts";
import { EventType as Event } from "./schema.ts";

/**
 * Deterministic parsing, before any model is asked.
 *
 * buildspec.md §7.1: "Build versioned templates by sender, language, and format... Use bounded
 * regex or a safe parser; do not allow pathological inputs to block the app."
 *
 * This matters more than the model does. On the owner's hardware a model call costs 2.4 s at best
 * (PC, on the LAN) and 14-57 s at worst (the phone's own llama.cpp), while these rules run in
 * microseconds and work with no network at all. Every message handled here is a message that never
 * queues. The model is the fallback for what these rules cannot answer with certainty — not the
 * pipeline.
 *
 * Two deliberate limits:
 *   - Nothing here guesses. A rule either extracts a field from literal text in the message or
 *     returns null for it, and a result missing a required field is handed to the model rather than
 *     completed by inference.
 *   - Every pattern is linear. There are no nested quantifiers and every repetition is bounded, so
 *     a hostile or malformed message cannot make the parser hang (§7.1, §20).
 */

export const TEMPLATE_ENGINE_VERSION = "rules-v3";

/* -------------------------------------------------------------------------------------------- */
/* Field patterns                                                                                 */
/* -------------------------------------------------------------------------------------------- */

/**
 * Currency written before the number: `LKR 3,450.00`, `Rs. 3,450.00`, `USD1,200`.
 * The digit group is bounded at 15 characters so a long run of digits cannot drive backtracking.
 */
const CURRENCY_WORDS: Readonly<Record<string, string>> = Object.freeze({
  lkr: "LKR",
  rs: "LKR",
  "rs.": "LKR",
  rupees: "LKR",
  usd: "USD",
  "us$": "USD",
  eur: "EUR",
  gbp: "GBP",
  inr: "INR",
  aud: "AUD",
  sgd: "SGD",
  aed: "AED",
  // Sinhala and Tamil write the rupee as a word, not as an ISO code.
  "රු": "LKR",
  "රු.": "LKR",
  "ரூ": "LKR",
  "ரூ.": "LKR",
});

const AMOUNT_WITH_CURRENCY =
  /(?:\b(LKR|RS\.?|USD|US\$|EUR|GBP|INR|AUD|SGD|AED|RUPEES)|(රු\.?|ரூ\.?))\s?([0-9][0-9,]{0,14}(?:\.[0-9]{1,3})?)/gi;

/** A masked account or card tail: `****1234`, `xxxx1234`, `...1234`, `ending 1234`. */
const ACCOUNT_SUFFIX =
  /(?:\*{2,6}|x{2,6}|X{2,6}|\.{3}|ending(?:\s+in)?\s+|no\.?\s?|\b(?:a\/c|acct?|account)\s+)([0-9]{3,6})\b/;

/** `20/09/2026`, `2026/09/14`, `14-03-2026`, `20.09.2026`. */
const NUMERIC_DATE = /\b(\d{1,4}[/\-.]\d{1,2}[/\-.]\d{2,4})\b/;

/** `20 Sep 2026`, `Sep 20, 2026`. */
const NAMED_DATE =
  /\b(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]{0,6}\s+\d{4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]{0,6}\s+\d{1,2},?\s+\d{4})\b/i;

/**
 * The phrase that introduces a *balance* rather than a transaction amount.
 *
 * buildspec.md §7.1: "An amount near 'available balance' is not the purchase amount." Finding the
 * balance explicitly is what lets the transaction amount be chosen safely from what is left.
 */
const BALANCE_LEAD =
  /(?:\b(?:available balance|avail(?:able)?\.? bal|avl\.? ?bal(?:ance)?|a\/c bal|acc(?:oun)?t\.? bal(?:ance)?|current balance|closing balance|balance|bal)\b|ශේෂය|இருப்பு)/i;

/*
 * How far back to look for that phrase. A real message puts a clause between the word "balance"
 * and the number — "the available balance of your account ****6620 as at 2026-09-19 21:45 is
 * LKR 118,004.55" has 50 characters between them — so a short window silently reads the balance as
 * the transaction amount, which is precisely the error buildspec.md §7.1 warns about.
 */
const BALANCE_LOOKBACK = 90;

const CREDIT_LIMIT_LEAD = /\b(credit limit|available limit|limit is)\b/i;

/** `at KEELLS SUPER`, `to Demo Internet`, `from ODEL`. Bounded to 48 characters. */
const MERCHANT_LEAD =
  /\b(?:at|to|from|for)\s+([A-Z][A-Za-z0-9&'. \-]{1,47}?)(?=\s+(?:using|on|via|with|card|acct|account|a\/c|ref|no|number|was|is|has|successful(?:ly)?|\.|,)|[.,]|$)/;

/** `Ref K928`, `Reference: 482913`, `Txn ID 12345`. */
const REFERENCE =
  /\b(?:ref(?:erence)?|txn(?:\s?id)?|transaction(?:\s?id)?|trace)\s*(?:no\.?|#|:)?\s*([A-Z0-9][A-Z0-9\-]{2,23})\b/i;

/* -------------------------------------------------------------------------------------------- */
/* Event classification                                                                           */
/* -------------------------------------------------------------------------------------------- */

type Rule = {
  readonly type: EventType;
  /** Checked in order; the first hit wins. */
  readonly any: readonly RegExp[];
  /** When present, none of these may appear, or the rule is skipped. */
  readonly not?: readonly RegExp[];
};

/**
 * Ordered classification rules.
 *
 * The order encodes buildspec.md §7.1's warnings directly: an OTP that mentions an amount is not a
 * payment, a declined transaction is not spending, and "will debit" is scheduled rather than
 * posted. Those checks therefore come before the generic money-movement ones, because a scheduled
 * debit message also contains the word "debit".
 *
 * Sinhala and Tamil keywords sit alongside the English ones rather than in a separate table, so a
 * mixed-script message is classified by whichever phrase actually appears.
 */
const RULES: readonly Rule[] = Object.freeze([
  {
    type: Event.OTP,
    any: [
      /\b(otp|one[\s-]?time (?:password|pin|code)|verification code|security code)\b/i,
      /\bdo not share\b/i,
      /එක් වරක්|රහස් අංකය/u,
      /ஒருமுறை|கடவுக்குறியீடு/u,
    ],
  },
  {
    type: Event.PROMOTION,
    any: [
      /\b\d{1,2}%\s?(?:off|discount|cashback)\b/i,
      /\b(t&c|terms and conditions) (?:apply|applies)\b/i,
      /\b(unsubscribe|opt[\s-]?out|promo(?:tion)?|special offer|win a|enjoy)\b/i,
      /ප්‍රවර්ධන|විශේෂ දීමනා/u,
    ],
    // A real receipt can say "enjoy", so a promotion must not also be a completed transaction.
    not: [/\b(debited|credited|withdrawn|purchase of|has been paid)\b/i],
  },
  {
    type: Event.FAILED,
    any: [
      /\b(declined|failed|unsuccessful|rejected|could not be processed|insufficient funds)\b/i,
      /ප්‍රතික්ෂේප|අසාර්ථක/u,
      /நிராகரிக்க|தோல்வி/u,
    ],
  },
  {
    type: Event.PENDING_PAYMENT,
    any: [
      /\bwill be (?:debited|charged|deducted|paid)\b/i,
      /\b(standing order|scheduled (?:for|payment)|auto[\s-]?debit on)\b/i,
      /\bis due (?:on|by)\b/i,
    ],
  },
  {
    type: Event.REFUND,
    any: [
      /\b(refund(?:ed)?|reversal|reversed|credited back|money back)\b/i,
      /ආපසු ගෙවීම/u,
    ],
  },
  {
    type: Event.BILL,
    any: [
      /\b(bill|invoice|statement)\b.{0,40}\b(due|payable|amount)\b/i,
      /\b(due|payable)\b.{0,40}\b(bill|invoice)\b/i,
      /\byour .{0,30}bill (?:for|of|is)\b/i,
    ],
  },
  {
    type: Event.POSTED_INCOME,
    any: [
      /\b(credited to|has been credited|salary|deposit(?:ed)?|received from|transferred to your)\b/i,
      /බැර කර|වැටුප/u,
      /வரவு|சம்பளம்/u,
    ],
  },
  {
    // "is credited with", "credited by", "has credited": any crediting of the owner's account.
    // Skipped when the message also says "debited" - "debited from your a/c and credited to X" is
    // money leaving, and must fall through to the expense rule below.
    type: Event.POSTED_INCOME,
    any: [/\bcredited\b/i, /\bcredit of\b/i],
    not: [/\bdebited\b/i, /\bcredit (?:card|limit)\b/i],
  },
  {
    type: Event.POSTED_EXPENSE,
    any: [
      /\b(purchase of|debited|debit of|spent|withdrawn|withdrawal|payment of|charged)\b/i,
      // A biller's own receipt: "Recharge of Rs.50.00 successful", "Reload ... completed". Tied to
      // a success word so "Recharge Rs.100 and get 2GB" stays a promotion, not spending.
      /\b(?:recharge|reload|top-?up|bill payment)\b[\s\S]{0,60}?\b(?:successful(?:ly)?|success|completed|received|done)\b/i,
      /\b(?:successful(?:ly)?|completed|received)\b[\s\S]{0,60}?\b(?:recharge|reload|top-?up|bill payment)\b/i,
      /\b(?:you |has been |was )?paid\b/i,
      /\bpos\b/i,
      // ගෙවා / ගෙවීම = paid; අඩු කර = deducted.
      /ගෙවා|ගෙවීම|මිලදී ගැනීම|අඩු කර/u,
      // செலுத்த = paid; பற்று = debit.
      /செலுத்த|கொள்முதல்|பற்று/u,
    ],
  },
]);

/* -------------------------------------------------------------------------------------------- */
/* Result                                                                                         */
/* -------------------------------------------------------------------------------------------- */

export type TemplateField<T> = {
  readonly value: T | null;
  /** The literal text this value came from, for buildspec.md §7.3's evidence check. */
  readonly evidence: string | null;
};

export type TemplateResult = {
  readonly engineVersion: string;
  readonly eventType: EventType | null;
  readonly amountText: TemplateField<string>;
  readonly currency: TemplateField<string>;
  readonly balanceText: TemplateField<string>;
  readonly balanceType: "available" | "ledger" | null;
  readonly accountSuffix: TemplateField<string>;
  readonly occurredAtText: TemplateField<string>;
  readonly merchantText: TemplateField<string>;
  readonly referenceText: TemplateField<string>;
  /**
   * True when every field a ledger entry needs was found in the text.
   *
   * buildspec.md §7.4: only a "validated known template" may auto-post, and only after the owner
   * enables that source rule. This flag says the rules were *sufficient*, not that posting is
   * authorised.
   */
  readonly complete: boolean;
  /** Why the result is not complete, for the review screen and for improving the rules. */
  readonly missing: readonly string[];
};

const NONE: TemplateField<string> = Object.freeze({ value: null, evidence: null });

function field(value: string | null, evidence: string | null): TemplateField<string> {
  return value === null ? NONE : Object.freeze({ value, evidence });
}

/** Events that describe money actually moving, and therefore need an amount and a date. */
const MONEY_EVENTS: readonly EventType[] = Object.freeze([
  Event.POSTED_EXPENSE,
  Event.POSTED_INCOME,
  Event.REFUND,
]);

/** Currency written after the figure, as some billers do: `50.00rs`, `1,250.00 LKR`. */
const AMOUNT_CURRENCY_LAST = /(?<![\w.,])([0-9][0-9,]{0,14}(?:\.[0-9]{1,2})?)\s?(LKR|RS\.?|RUPEES)(?![A-Za-z])/gi;

type AmountHit = { readonly currency: string; readonly amount: string; readonly text: string; readonly index: number };

function collectAmounts(text: string): AmountHit[] {
  const hits: AmountHit[] = [];
  // `matchAll` on a bounded global pattern; no manual lastIndex bookkeeping to get wrong.
  for (const match of text.matchAll(AMOUNT_WITH_CURRENCY)) {
    // Group 1 is the Latin code, group 2 the Sinhala/Tamil mark; only one can match.
    const raw = match[1] ?? match[2] ?? "";
    const word = raw.toLowerCase().replace(/\.$/, "");
    const code = CURRENCY_WORDS[word] ?? CURRENCY_WORDS[`${word}.`] ?? CURRENCY_WORDS[raw];
    const amount = match[3] ?? "";
    if (!code || amount.length === 0) continue;
    if (!CURRENCIES[code]) continue;
    hits.push({ currency: code, amount, text: match[0], index: match.index ?? 0 });
  }
  for (const match of text.matchAll(AMOUNT_CURRENCY_LAST)) {
    const index = match.index ?? 0;
    // "Rs 50.00 Rs" must not count twice: skip anything a currency-first match already covers.
    if (hits.some((hit) => index < hit.index + hit.text.length && hit.index < index + match[0].length)) continue;
    hits.push({ currency: "LKR", amount: match[1] ?? "", text: match[0], index });
  }
  hits.sort((a, b) => a.index - b.index);
  return hits;
}

/**
 * Splits the amounts into "the balance" and "everything else".
 *
 * buildspec.md §7.1 is explicit that the number after "available balance" is not the purchase
 * amount, and §10 adds that a credit limit is not a balance at all. Both are found by their
 * introducing phrase rather than by position, so a message that puts the balance first is still
 * read correctly.
 */
function classifyAmounts(text: string, hits: readonly AmountHit[]) {
  let balance: AmountHit | undefined;
  let limit: AmountHit | undefined;

  for (const hit of hits) {
    const before = text.slice(Math.max(0, hit.index - BALANCE_LOOKBACK), hit.index);
    if (CREDIT_LIMIT_LEAD.test(before)) {
      limit = limit ?? hit;
      continue;
    }
    if (BALANCE_LEAD.test(before)) {
      balance = balance ?? hit;
    }
  }

  const transactional = hits.filter((hit) => hit !== balance && hit !== limit);
  return { balance, limit, transactional };
}

function firstMatch(text: string, pattern: RegExp): { value: string; evidence: string } | null {
  const match = pattern.exec(text);
  if (!match) return null;
  const captured = match[1];
  if (captured === undefined) return null;
  return { value: captured.trim(), evidence: match[0].trim() };
}

function classify(text: string): EventType | null {
  for (const rule of RULES) {
    if (rule.not && rule.not.some((pattern) => pattern.test(text))) continue;
    if (rule.any.some((pattern) => pattern.test(text))) return rule.type;
  }
  return null;
}

/**
 * Runs the deterministic rules over one message.
 *
 * Returns a result for every input; `complete` says whether the model still needs to be asked.
 * Never throws — a message that matches nothing produces a result full of nulls, which routes to
 * the model or to review rather than failing the import.
 */
export function applyTemplates(sourceText: string): TemplateResult {
  // Normalise for matching only. buildspec.md §7.1 keeps the original for evidence.
  const text = sourceText.normalize("NFKC").replace(/[   ]/g, " ");

  const hits = collectAmounts(text);
  const { balance, transactional } = classifyAmounts(text, hits);

  let eventType = classify(text);

  /*
   * A message that reports only a balance is a balance notice, however it is worded. This is
   * decided after classification because "your balance is X" contains none of the movement verbs
   * the rules look for, and because a purchase message also contains a balance.
   */
  if (transactional.length === 0 && balance) {
    eventType = eventType === null || eventType === Event.POSTED_EXPENSE ? Event.BALANCE_NOTICE : eventType;
  }

  const primary = transactional[0];
  const dateHit = firstMatch(text, NUMERIC_DATE) ?? firstMatch(text, NAMED_DATE);
  const suffixHit = firstMatch(text, ACCOUNT_SUFFIX);
  const merchantHit = firstMatch(text, MERCHANT_LEAD);
  const referenceHit = firstMatch(text, REFERENCE);

  // An OTP or a promotion must never carry a transaction amount forward (§7.1).
  const amountBearing =
    eventType !== null && eventType !== Event.OTP && eventType !== Event.PROMOTION && eventType !== Event.BALANCE_NOTICE;

  const amountField = amountBearing && primary ? field(primary.amount, primary.text) : NONE;
  const currencyField = amountBearing && primary ? field(primary.currency, primary.text) : NONE;

  const missing: string[] = [];
  if (eventType === null) missing.push("event_type");
  if (amountBearing && amountField.value === null) missing.push("amount_text");
  if (MONEY_EVENTS.includes(eventType as EventType) && !dateHit) missing.push("occurred_at_text");

  /*
   * A second transactional amount means the message describes more than one thing — an ATM
   * withdrawal plus its fee, say. buildspec.md §8: "One email can contain several payment lines."
   * The rules deliberately stop rather than guess which is which.
   */
  if (transactional.length > 1) missing.push("multiple_amounts");

  // The amount must survive the same parser the ledger will use, or it is not usable.
  if (amountField.value !== null && currencyField.value !== null) {
    const currency = CURRENCIES[currencyField.value];
    if (!currency) {
      missing.push("currency");
    } else {
      try {
        parseMajorUnits(currency, amountField.value);
      } catch {
        missing.push("amount_text");
      }
    }
  }

  return Object.freeze({
    engineVersion: TEMPLATE_ENGINE_VERSION,
    eventType,
    amountText: amountField,
    currency: currencyField,
    balanceText: balance ? field(balance.amount, balance.text) : NONE,
    balanceType: balance ? "available" : null,
    accountSuffix: suffixHit ? field(suffixHit.value, suffixHit.evidence) : NONE,
    occurredAtText: dateHit ? field(dateHit.value, dateHit.evidence) : NONE,
    merchantText: merchantHit ? field(merchantHit.value, merchantHit.evidence) : NONE,
    referenceText: referenceHit ? field(referenceHit.value, referenceHit.evidence) : NONE,
    complete: missing.length === 0,
    missing: Object.freeze(missing),
  });
}

/**
 * Whether the model needs to be asked at all.
 *
 * buildspec.md §7.1 puts deterministic parsing first and sends only "uncertain" text onward. A
 * complete rule result, or a classification that provably involves no money (OTP, promotion), ends
 * the pipeline right here — no queue, no network, no 2-to-57 second wait.
 */
export function needsModel(result: TemplateResult): boolean {
  if (result.complete) return false;
  // A receipt that simply does not state its date ("Recharge of Rs.50.00 successful") is not
  // unclear: the moment it arrived is the date. Sending it to the model would only delay it, and
  // with the model host off it would never reach review at all.
  if (result.missing.length === 1 && result.missing[0] === "occurred_at_text") return false;
  return !(
    result.eventType === Event.OTP ||
    result.eventType === Event.PROMOTION ||
    result.eventType === Event.FAILED
  );
}
