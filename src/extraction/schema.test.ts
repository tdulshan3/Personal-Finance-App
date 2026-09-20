import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { CURRENCIES } from "../core/domain/money.ts";
import {
  BALANCE_TYPES,
  EVENT_TYPES,
  EXTRACTION_JSON_SCHEMA,
  EXTRACTION_SCHEMA_NAME,
  EXTRACTION_SCHEMA_VERSION,
  extractionResponseFormat,
  evidenceValue,
  FIELD_LIMITS,
  MAX_EVENTS_PER_SOURCE,
  parseExtractionPayload,
  validateAgainstSchema,
  type JsonSchema,
} from "./schema.ts";

/** buildspec.md §7.3's worked example, copied from the specification. */
const SPEC_EXAMPLE = {
  schema_version: 1,
  source_id: "src_demo_1",
  events: [
    {
      event_type: "posted_expense",
      amount_text: "3,450.00",
      currency: "LKR",
      merchant_text: "KEELLS SUPER",
      account_suffix: "1234",
      occurred_at_text: "20/09/2026",
      reference_text: null,
      balance_text: "52,340.20",
      balance_type: "available",
      evidence: {
        amount: "Purchase of LKR 3,450.00",
        merchant: "at KEELLS SUPER",
        account: "card ****1234",
      },
    },
  ],
};

function walk(schema: JsonSchema, visit: (node: JsonSchema, path: string) => void, path = "$"): void {
  visit(schema, path);
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    walk(child, visit, `${path}.${key}`);
  }
  if (schema.items) walk(schema.items, visit, `${path}[]`);
}

describe("extraction schema shape", () => {
  test("every object closes additionalProperties", () => {
    // buildspec.md §7.3: "The schema uses `additionalProperties:false`".
    walk(EXTRACTION_JSON_SCHEMA, (node, path) => {
      const isObject = node.type === "object" || (Array.isArray(node.type) && node.type.includes("object"));
      if (isObject) {
        assert.equal(node.additionalProperties, false, `${path} must set additionalProperties:false`);
        assert.ok(node.properties, `${path} must declare its properties`);
      }
    });
  });

  test("every string field carries a length limit", () => {
    walk(EXTRACTION_JSON_SCHEMA, (node, path) => {
      const allows = typeof node.type === "string" ? [node.type] : (node.type ?? []);
      if (allows.includes("string") && node.enum === undefined) {
        assert.ok(
          typeof node.maxLength === "number" && node.maxLength > 0,
          `${path} is an unbounded string`,
        );
      }
    });
  });

  test("the event array is bounded", () => {
    const events = EXTRACTION_JSON_SCHEMA.properties?.["events"];
    assert.ok(events);
    assert.equal(events.type, "array");
    assert.equal(events.maxItems, MAX_EVENTS_PER_SOURCE);
    assert.equal(events.minItems, 0);
  });

  test("enums are finite and cover the classes buildspec §7.3 names separately", () => {
    for (const required of [
      "otp",
      "promotion",
      "failed",
      "pending_payment",
      "posted_expense",
      "posted_income",
      "bill",
      "refund",
      "balance_notice",
    ]) {
      assert.ok(EVENT_TYPES.includes(required as never), `event type '${required}' is missing`);
    }
    // buildspec.md §10's balance observation types.
    assert.deepEqual([...BALANCE_TYPES], ["ledger", "available", "statement", "credit_limit", "unknown"]);

    const currency = EXTRACTION_JSON_SCHEMA.properties?.["events"]?.items?.properties?.["currency"];
    assert.ok(currency?.enum);
    assert.ok(currency.enum.includes("LKR"));
    assert.ok(currency.enum.includes(null), "null must be inside the enum, not only in `type`");
    assert.equal(currency.enum.length, Object.keys(CURRENCIES).length + 1);
  });

  test("every top-level and event field is required, and the nullable ones admit null", () => {
    // buildspec.md §7.3: "Required fields may be nullable."
    assert.deepEqual([...(EXTRACTION_JSON_SCHEMA.required ?? [])], ["schema_version", "source_id", "events"]);
    const event = EXTRACTION_JSON_SCHEMA.properties?.["events"]?.items;
    assert.ok(event);
    assert.deepEqual([...(event.required ?? [])].sort(), Object.keys(event.properties ?? {}).sort());
  });

  test("the response_format wrapper is the OpenAI json_schema shape", () => {
    const wrapper = extractionResponseFormat();
    assert.equal(wrapper.type, "json_schema");
    assert.equal(wrapper.json_schema.name, EXTRACTION_SCHEMA_NAME);
    assert.equal(wrapper.json_schema.strict, true);
    assert.equal(wrapper.json_schema.schema, EXTRACTION_JSON_SCHEMA);
  });

  test("the schema object is frozen so no caller can widen it at runtime", () => {
    assert.ok(Object.isFrozen(EXTRACTION_JSON_SCHEMA));
    assert.ok(Object.isFrozen(EXTRACTION_JSON_SCHEMA.properties));
  });
});

describe("payload validation", () => {
  test("accepts buildspec §7.3's worked example verbatim", () => {
    const result = parseExtractionPayload(SPEC_EXAMPLE);
    assert.equal(result.ok, true, result.ok ? "" : result.problems.join("; "));
    if (result.ok) {
      assert.equal(result.payload.events.length, 1);
      assert.equal(evidenceValue(result.payload.events[0]!.evidence, "amount"), "Purchase of LKR 3,450.00");
      // The three evidence keys the specification omits read as absent, not as invalid.
      assert.equal(evidenceValue(result.payload.events[0]!.evidence, "date"), null);
    }
  });

  test("accepts an empty event list", () => {
    const result = parseExtractionPayload({ schema_version: 1, source_id: "src_x", events: [] });
    assert.equal(result.ok, true);
  });

  test("rejects an unexpected top-level property", () => {
    const result = parseExtractionPayload({ ...SPEC_EXAMPLE, confidence: 0.99 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.problems.join("; "), /confidence/);
  });

  test("rejects an unexpected event property", () => {
    const payload = structuredClone(SPEC_EXAMPLE) as Record<string, unknown>;
    (payload["events"] as Record<string, unknown>[])[0]!["category_id"] = "cat_groceries";
    const result = parseExtractionPayload(payload);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.problems.join("; "), /category_id/);
  });

  test("rejects an unknown event type and an unknown balance type", () => {
    const payload = structuredClone(SPEC_EXAMPLE) as Record<string, unknown>;
    (payload["events"] as Record<string, unknown>[])[0]!["event_type"] = "wire_transfer_out";
    assert.equal(parseExtractionPayload(payload).ok, false);

    const payload2 = structuredClone(SPEC_EXAMPLE) as Record<string, unknown>;
    (payload2["events"] as Record<string, unknown>[])[0]!["balance_type"] = "spendable";
    assert.equal(parseExtractionPayload(payload2).ok, false);
  });

  test("rejects a missing required field", () => {
    const payload = structuredClone(SPEC_EXAMPLE) as Record<string, unknown>;
    delete (payload["events"] as Record<string, unknown>[])[0]!["account_suffix"];
    const result = parseExtractionPayload(payload);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.problems.join("; "), /account_suffix/);
  });

  test("rejects more events than the bound allows", () => {
    const one = SPEC_EXAMPLE.events[0]!;
    const result = parseExtractionPayload({
      schema_version: 1,
      source_id: "src_x",
      events: Array.from({ length: MAX_EVENTS_PER_SOURCE + 1 }, () => one),
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.problems.join("; "), /exceeds the bound/);
  });

  test("rejects an over-long string", () => {
    const payload = structuredClone(SPEC_EXAMPLE) as Record<string, unknown>;
    (payload["events"] as Record<string, unknown>[])[0]!["merchant_text"] = "x".repeat(
      FIELD_LIMITS.merchantText + 1,
    );
    const result = parseExtractionPayload(payload);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.problems.join("; "), /character limit/);
  });

  test("rejects a wrong schema_version", () => {
    assert.equal(
      parseExtractionPayload({ ...SPEC_EXAMPLE, schema_version: EXTRACTION_SCHEMA_VERSION + 1 }).ok,
      false,
    );
  });

  test("rejects anything that is not an object", () => {
    for (const value of [null, "{}", 7, [], undefined]) {
      assert.equal(parseExtractionPayload(value).ok, false, `${String(value)} should not validate`);
    }
  });

  test("the validator reports the path of each problem", () => {
    const problems = validateAgainstSchema(EXTRACTION_JSON_SCHEMA, {
      schema_version: 1,
      source_id: "",
      events: [{ event_type: "otp" }],
    });
    assert.ok(problems.some((p) => p.startsWith("$.source_id")));
    assert.ok(problems.some((p) => p.startsWith("$.events[0].amount_text")));
  });
});
