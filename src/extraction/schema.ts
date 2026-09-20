/**
 * The extraction wire schema and a small validator for it.
 *
 * buildspec.md §7.3: "The schema uses `additionalProperties:false`, finite enum values, length
 * limits, and a bounded event array. Required fields may be nullable. The model returns amount
 * strings and evidence; application code converts them to integer minor units after locale/currency
 * validation."
 *
 * This file is the single definition of that schema. The same object is sent to the server as a
 * grammar constraint *and* walked by `validateAgainstSchema` when the answer comes back, so the
 * two can never drift. Structured output constrains shape only — buildspec.md §7.3 is explicit that
 * "Structured output helps constrain shape; it does not prove factual correctness" — which is why
 * `validate-evidence.ts` exists as a separate, mandatory second gate.
 */

import { CURRENCIES } from "../core/domain/money.ts";

/* --------------------------------------------------------------------------------------------- */
/* Minimal JSON Schema subset                                                                      */
/* --------------------------------------------------------------------------------------------- */

export type JsonSchema = {
  readonly type?: string | readonly string[] | undefined;
  readonly enum?: readonly (string | number | null)[] | undefined;
  readonly properties?: Readonly<Record<string, JsonSchema>> | undefined;
  readonly required?: readonly string[] | undefined;
  readonly additionalProperties?: boolean | undefined;
  readonly items?: JsonSchema | undefined;
  readonly minItems?: number | undefined;
  readonly maxItems?: number | undefined;
  readonly minLength?: number | undefined;
  readonly maxLength?: number | undefined;
  readonly minimum?: number | undefined;
  readonly maximum?: number | undefined;
  readonly description?: string | undefined;
};

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/* --------------------------------------------------------------------------------------------- */
/* Finite value sets                                                                               */
/* --------------------------------------------------------------------------------------------- */

/**
 * buildspec.md §7.3: "Classify OTP, promotion, failure, pending payment, posted payment, bill,
 * refund, and balance notice separately."
 *
 * `transfer` and `fee` are the two additions beyond that list. buildspec.md §22 requires an
 * "ATM withdrawal + fee" fixture where the withdrawal is a bank→cash transfer and only the fee is
 * spending; without them the model would have to mislabel one of the two as a posted expense.
 */
export const EventType = {
  OTP: "otp",
  PROMOTION: "promotion",
  FAILED: "failed",
  PENDING_PAYMENT: "pending_payment",
  POSTED_EXPENSE: "posted_expense",
  POSTED_INCOME: "posted_income",
  BILL: "bill",
  REFUND: "refund",
  BALANCE_NOTICE: "balance_notice",
  TRANSFER: "transfer",
  FEE: "fee",
} as const;

export type EventType = (typeof EventType)[keyof typeof EventType];

export const EVENT_TYPES: readonly EventType[] = Object.freeze(Object.values(EventType));

/** buildspec.md §10: "type: `ledger`, `available`, `statement`, `credit_limit`, or `unknown`". */
export const BalanceType = {
  LEDGER: "ledger",
  AVAILABLE: "available",
  STATEMENT: "statement",
  CREDIT_LIMIT: "credit_limit",
  UNKNOWN: "unknown",
} as const;

export type BalanceType = (typeof BalanceType)[keyof typeof BalanceType];

export const BALANCE_TYPES: readonly BalanceType[] = Object.freeze(Object.values(BalanceType));

/** Finite currency enum, taken from the one table that also knows each code's minor-unit scale. */
export const SCHEMA_CURRENCY_CODES: readonly string[] = Object.freeze(Object.keys(CURRENCIES).sort());

export const EXTRACTION_SCHEMA_VERSION = 1;
export const EXTRACTION_SCHEMA_NAME = "financial_extraction";

/** buildspec.md §7.3: "a bounded event array". One SMS may legitimately describe a few events. */
export const MAX_EVENTS_PER_SOURCE = 6;

export const FIELD_LIMITS = Object.freeze({
  sourceId: 64,
  amountText: 32,
  merchantText: 80,
  accountSuffix: 8,
  occurredAtText: 40,
  referenceText: 48,
  balanceText: 32,
  evidence: 200,
});

/* --------------------------------------------------------------------------------------------- */
/* The schema                                                                                      */
/* --------------------------------------------------------------------------------------------- */

function nullableString(maxLength: number, description: string): JsonSchema {
  return { type: ["string", "null"], maxLength, description };
}

const EVIDENCE_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  description: "Literal substrings copied from the message. Anything not present in the source is rejected.",
  properties: {
    amount: nullableString(FIELD_LIMITS.evidence, "Literal text that shows the transaction amount"),
    merchant: nullableString(FIELD_LIMITS.evidence, "Literal text that shows the merchant or counterparty"),
    account: nullableString(FIELD_LIMITS.evidence, "Literal text that shows the masked account or card"),
    date: nullableString(FIELD_LIMITS.evidence, "Literal text that shows the occurrence date"),
    reference: nullableString(FIELD_LIMITS.evidence, "Literal text that shows the reference number"),
    balance: nullableString(FIELD_LIMITS.evidence, "Literal text that shows the balance"),
  },
  /*
   * Deliberately not `required`. buildspec.md §7.3's worked example returns only
   * `{amount, merchant, account}`, so demanding all six keys would make the specification's own
   * example invalid. A missing key and an explicit null both mean "no evidence for this field".
   */
};

const EVENT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "event_type",
    "amount_text",
    "currency",
    "merchant_text",
    "account_suffix",
    "occurred_at_text",
    "reference_text",
    "balance_text",
    "balance_type",
    "evidence",
  ],
  properties: {
    event_type: {
      type: "string",
      enum: EVENT_TYPES,
      description: "What the message proves happened. A declined or OTP message is not spending.",
    },
    amount_text: nullableString(
      FIELD_LIMITS.amountText,
      "The transaction amount exactly as written, never a balance or a limit",
    ),
    /*
     * `null` is listed inside the enum rather than relying on `type` alone: llama.cpp's
     * json-schema-to-grammar builds its grammar from `enum` when one is present, so a null that
     * only appears in `type` would be ungrammatical and the model could never say "absent".
     */
    currency: {
      type: ["string", "null"],
      enum: [...SCHEMA_CURRENCY_CODES, null],
      description: "ISO 4217 code for the amount",
    },
    merchant_text: nullableString(FIELD_LIMITS.merchantText, "Merchant or counterparty exactly as written"),
    account_suffix: nullableString(
      FIELD_LIMITS.accountSuffix,
      "Only the masked trailing digits shown in the message, never a full number",
    ),
    occurred_at_text: nullableString(FIELD_LIMITS.occurredAtText, "Date or date-time exactly as written"),
    reference_text: nullableString(FIELD_LIMITS.referenceText, "Reference or transaction id exactly as written"),
    balance_text: nullableString(FIELD_LIMITS.balanceText, "Balance amount exactly as written"),
    balance_type: {
      type: ["string", "null"],
      enum: [...BALANCE_TYPES, null],
      description: "Which kind of balance the message stated",
    },
    evidence: EVIDENCE_SCHEMA,
  },
};

export const EXTRACTION_JSON_SCHEMA: JsonSchema = deepFreeze({
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "source_id", "events"],
  properties: {
    schema_version: {
      type: "integer",
      enum: [EXTRACTION_SCHEMA_VERSION],
      description: "Always 1",
    },
    source_id: {
      type: "string",
      maxLength: FIELD_LIMITS.sourceId,
      minLength: 1,
      description: "Copy the source_id supplied by the caller exactly",
    },
    events: {
      type: "array",
      minItems: 0,
      maxItems: MAX_EVENTS_PER_SOURCE,
      items: EVENT_SCHEMA,
      description: "Empty when the message contains no financial fact",
    },
  },
} satisfies JsonSchema);

/* --------------------------------------------------------------------------------------------- */
/* Parsed shape                                                                                    */
/* --------------------------------------------------------------------------------------------- */

export type ExtractionEvidence = {
  readonly amount?: string | null | undefined;
  readonly merchant?: string | null | undefined;
  readonly account?: string | null | undefined;
  readonly date?: string | null | undefined;
  readonly reference?: string | null | undefined;
  readonly balance?: string | null | undefined;
};

export const EVIDENCE_FIELDS: readonly (keyof ExtractionEvidence)[] = Object.freeze([
  "amount",
  "merchant",
  "account",
  "date",
  "reference",
  "balance",
]);

export type ExtractionEvent = {
  readonly event_type: EventType;
  readonly amount_text: string | null;
  readonly currency: string | null;
  readonly merchant_text: string | null;
  readonly account_suffix: string | null;
  readonly occurred_at_text: string | null;
  readonly reference_text: string | null;
  readonly balance_text: string | null;
  readonly balance_type: BalanceType | null;
  readonly evidence: ExtractionEvidence;
};

export type ExtractionPayload = {
  readonly schema_version: number;
  readonly source_id: string;
  readonly events: readonly ExtractionEvent[];
};

/* --------------------------------------------------------------------------------------------- */
/* Validation                                                                                      */
/* --------------------------------------------------------------------------------------------- */

function typeMatches(expected: string, value: unknown): boolean {
  switch (expected) {
    case "null":
      return value === null;
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    default:
      return false;
  }
}

/**
 * Walks the schema above against a parsed value and returns every problem found.
 *
 * A real JSON Schema library would be overkill and would accept far more than this schema uses;
 * a server that quietly ignores part of the grammar must still be caught here, so the checker
 * stays deliberately strict and covers only the keywords this schema actually contains.
 */
export function validateAgainstSchema(schema: JsonSchema, value: unknown, path = "$"): string[] {
  const problems: string[] = [];

  if (schema.type !== undefined) {
    const allowed = typeof schema.type === "string" ? [schema.type] : schema.type;
    if (!allowed.some((candidate) => typeMatches(candidate, value))) {
      problems.push(`${path}: expected ${allowed.join(" or ")}, got ${describe(value)}`);
      return problems;
    }
  }

  if (schema.enum !== undefined) {
    if (value !== null && typeof value !== "string" && typeof value !== "number") {
      problems.push(`${path}: enum values must be strings, numbers or null`);
    } else if (!schema.enum.includes(value)) {
      problems.push(`${path}: '${String(value)}' is not one of the ${schema.enum.length} allowed values`);
    }
  }

  if (typeof value === "string") {
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      problems.push(`${path}: ${value.length} characters exceeds the ${schema.maxLength}-character limit`);
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      problems.push(`${path}: shorter than the ${schema.minLength}-character minimum`);
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      problems.push(`${path}: ${value} is below the minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      problems.push(`${path}: ${value} is above the maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      problems.push(`${path}: ${value.length} items exceeds the bound of ${schema.maxItems}`);
    }
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      problems.push(`${path}: fewer than the ${schema.minItems} required items`);
    }
    if (schema.items) {
      value.forEach((item, index) => {
        problems.push(...validateAgainstSchema(schema.items as JsonSchema, item, `${path}[${index}]`));
      });
    }
  }

  if (typeMatches("object", value)) {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(record, key)) problems.push(`${path}.${key}: required property is missing`);
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(record)) {
        if (!Object.hasOwn(schema.properties, key)) {
          problems.push(`${path}.${key}: property is not allowed by the schema`);
        }
      }
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(record, key)) {
        problems.push(...validateAgainstSchema(child, record[key], `${path}.${key}`));
      }
    }
  }

  return problems;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export type SchemaParseResult =
  | { readonly ok: true; readonly payload: ExtractionPayload }
  | { readonly ok: false; readonly problems: readonly string[] };

/** Validates model output against the extraction schema and narrows it to `ExtractionPayload`. */
export function parseExtractionPayload(value: unknown): SchemaParseResult {
  const problems = validateAgainstSchema(EXTRACTION_JSON_SCHEMA, value);
  if (problems.length > 0) return { ok: false, problems: Object.freeze(problems) };
  return { ok: true, payload: value as ExtractionPayload };
}

/**
 * The OpenAI-compatible structured-output wrapper.
 *
 * buildspec.md §7.2 describes Ollama's native `format` field; the deployment this repository targets
 * is llama.cpp behind `/v1`, which takes the OpenAI `response_format` shape instead. Both carry the
 * same schema object — see `provider.ts` for the other spelling.
 */
export function extractionResponseFormat(): {
  type: "json_schema";
  json_schema: { name: string; strict: boolean; schema: JsonSchema };
} {
  return {
    type: "json_schema",
    json_schema: {
      name: EXTRACTION_SCHEMA_NAME,
      strict: true,
      schema: EXTRACTION_JSON_SCHEMA,
    },
  };
}

/** Normalises a validated payload so a missing evidence key reads the same as an explicit null. */
export function evidenceValue(evidence: ExtractionEvidence, field: keyof ExtractionEvidence): string | null {
  const raw = evidence[field];
  return typeof raw === "string" ? raw : null;
}
