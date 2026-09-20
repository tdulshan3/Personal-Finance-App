import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { FinanceErrorCode, isFinanceError } from "./errors.ts";
import {
  CURRENCIES,
  LKR,
  addMoney,
  allocateProportionally,
  compareMoney,
  formatMoney,
  fromWire,
  majorUnits,
  money,
  parseMajorUnits,
  parseMinorUnits,
  requireCurrency,
  splitEvenly,
  subtractMoney,
  sumMoney,
  toWire,
  zero,
} from "./money.ts";

const JPY = CURRENCIES.JPY!;
const KWD = CURRENCIES.KWD!;
const USD = CURRENCIES.USD!;

function expectError(code: FinanceErrorCode, fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    assert.ok(isFinanceError(error), `expected a FinanceError, got ${String(error)}`);
    assert.equal(error.code, code);
    return;
  }
  assert.fail(`expected ${code} but nothing was thrown`);
}

describe("currency registry", () => {
  test("knows the scale of 0-, 2- and 3-decimal currencies", () => {
    assert.equal(LKR.minorUnitDigits, 2);
    assert.equal(JPY.minorUnitDigits, 0);
    assert.equal(KWD.minorUnitDigits, 3);
  });

  test("rejects an unknown code instead of assuming two decimals", () => {
    expectError(FinanceErrorCode.VALIDATION_ERROR, () => requireCurrency("XYZ"));
  });
});

describe("construction and formatting", () => {
  test("renders LKR 3,450.00 from 345000 minor units", () => {
    assert.equal(formatMoney(money(LKR, 345_000n)), "LKR 3,450.00");
  });

  test("renders a zero-decimal currency without a decimal point", () => {
    assert.equal(formatMoney(money(JPY, 345_000n)), "JPY 345,000");
  });

  test("renders a three-decimal currency with three digits", () => {
    assert.equal(formatMoney(money(KWD, 1_234n)), "KWD 1.234");
  });

  test("keeps the sign outside the currency code", () => {
    assert.equal(formatMoney(money(LKR, -345_000n)), "LKR -3,450.00");
    assert.equal(formatMoney(money(LKR, 345_000n), { signed: true }), "LKR +3,450.00");
  });

  test("majorUnits scales by the currency, not by a hardcoded 100", () => {
    assert.equal(majorUnits(LKR, 3_450n).minor, 345_000n);
    assert.equal(majorUnits(JPY, 3_450n).minor, 3_450n);
    assert.equal(majorUnits(KWD, 3_450n).minor, 3_450_000n);
  });

  // buildspec.md §20: "very large amounts" must still render correctly.
  test("handles amounts near the 64-bit boundary", () => {
    const large = money(LKR, 9_223_372_036_854_775_807n);
    assert.equal(formatMoney(large), "LKR 92,233,720,368,547,758.07");
  });

  test("rejects a value that would overflow 64 bits", () => {
    expectError(FinanceErrorCode.VALIDATION_ERROR, () => money(LKR, 2n ** 63n));
  });
});

describe("arithmetic", () => {
  test("adds and subtracts within one currency", () => {
    const a = majorUnits(LKR, 80_000n);
    const b = majorUnits(LKR, 3_450n);
    assert.equal(formatMoney(subtractMoney(a, b)), "LKR 76,550.00");
    assert.equal(formatMoney(addMoney(a, b)), "LKR 83,450.00");
  });

  // buildspec.md §9.1: "Never sum different currencies into one unlabeled number."
  test("refuses to mix currencies", () => {
    expectError(FinanceErrorCode.VALIDATION_ERROR, () =>
      addMoney(majorUnits(LKR, 1n), majorUnits(USD, 1n)),
    );
    expectError(FinanceErrorCode.VALIDATION_ERROR, () =>
      compareMoney(majorUnits(LKR, 1n), majorUnits(USD, 1n)),
    );
  });

  test("overflow during addition is caught rather than wrapping", () => {
    const max = money(LKR, 9_223_372_036_854_775_807n);
    expectError(FinanceErrorCode.VALIDATION_ERROR, () => addMoney(max, money(LKR, 1n)));
  });

  test("sums an empty list to a typed zero", () => {
    assert.deepEqual(sumMoney([], LKR), zero(LKR));
  });
});

describe("parsing", () => {
  test("parses plain and grouped major-unit decimals", () => {
    assert.equal(parseMajorUnits(LKR, "3,450.00").minor, 345_000n);
    assert.equal(parseMajorUnits(LKR, "3450.5").minor, 345_050n);
    assert.equal(parseMajorUnits(LKR, "0.07").minor, 7n);
    assert.equal(parseMajorUnits(LKR, "-3,450.00").minor, -345_000n);
  });

  // buildspec.md §9.1: "Reject excess fractional digits instead of silently rounding imported money."
  test("rejects more fraction digits than the currency allows", () => {
    expectError(FinanceErrorCode.VALIDATION_ERROR, () => parseMajorUnits(LKR, "3450.005"));
    expectError(FinanceErrorCode.VALIDATION_ERROR, () => parseMajorUnits(JPY, "3450.5"));
  });

  test("accepts three fraction digits for a three-decimal currency", () => {
    assert.equal(parseMajorUnits(KWD, "1.234").minor, 1_234n);
  });

  test("rejects junk that a lenient parser would coerce", () => {
    for (const bad of ["", "  ", "abc", "1.2.3", "1e5", "0x10", "--1", "NaN", "Infinity"]) {
      expectError(FinanceErrorCode.VALIDATION_ERROR, () => parseMajorUnits(LKR, bad));
    }
  });

  /*
   * A parser that just deletes commas reads the European `3.450,00` as `3.45000`, i.e. LKR 3.45
   * instead of LKR 3,450.00. Grouping is validated instead, so a mis-formatted amount goes to
   * review rather than posting a wrong number (buildspec.md §7.4).
   */
  test("rejects malformed thousands grouping instead of silently stripping it", () => {
    for (const bad of ["1,,2.0", "1,2.0", "12,34,567.00", "3.450,00", ",100.00", "1,000,00"]) {
      expectError(FinanceErrorCode.VALIDATION_ERROR, () => parseMajorUnits(LKR, bad));
    }
  });

  test("accepts well-formed grouping", () => {
    assert.equal(parseMajorUnits(LKR, "1,000.00").minor, 100_000n);
    assert.equal(parseMajorUnits(LKR, "92,233,720.36").minor, 9_223_372_036n);
  });

  test("minor-unit strings are strictly integers", () => {
    assert.equal(parseMinorUnits(LKR, "345000").minor, 345_000n);
    assert.equal(parseMinorUnits(LKR, "-345000").minor, -345_000n);
    for (const bad of ["345000.0", "3.45e5", "", "abc", " 12 34 "]) {
      expectError(FinanceErrorCode.VALIDATION_ERROR, () => parseMinorUnits(LKR, bad));
    }
  });

  // buildspec.md §16: money crosses contracts as decimal strings so a JS client cannot lose digits.
  test("wire round-trip preserves a value beyond Number.MAX_SAFE_INTEGER", () => {
    const original = money(LKR, 9_007_199_254_740_995n);
    const wire = toWire(original);
    assert.equal(wire.amount_minor, "9007199254740995");
    // Routing the same value through a JS number loses the last digit; the string does not.
    assert.equal(String(Number(wire.amount_minor)), "9007199254740996");
    assert.deepEqual(fromWire(wire), original);
  });
});

describe("splitting and allocation", () => {
  // buildspec.md §7.5: "sum of splits must equal the total".
  test("an indivisible split still sums to the original", () => {
    const parts = splitEvenly(money(LKR, 1_000n), 3);
    assert.deepEqual(
      parts.map((p) => p.minor),
      [334n, 333n, 333n],
    );
    assert.equal(sumMoney(parts, LKR).minor, 1_000n);
  });

  test("a negative amount splits without losing a unit", () => {
    const parts = splitEvenly(money(LKR, -1_000n), 3);
    assert.equal(sumMoney(parts, LKR).minor, -1_000n);
  });

  test("proportional allocation reproduces the total exactly", () => {
    const parts = allocateProportionally(money(LKR, 10_000n), [1n, 1n, 1n]);
    assert.equal(sumMoney(parts, LKR).minor, 10_000n);

    const weighted = allocateProportionally(money(LKR, 839_000n), [3n, 5n, 7n]);
    assert.equal(sumMoney(weighted, LKR).minor, 839_000n);
  });

  test("randomised splits always conserve the total", () => {
    // Deterministic pseudo-random sweep: a seeded LCG keeps failures reproducible.
    let seed = 20260920;
    const nextInt = (bound: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % bound;
    };
    for (let i = 0; i < 2000; i += 1) {
      const total = BigInt(nextInt(20_000_000) - 10_000_000);
      const parts = nextInt(11) + 1;
      const shares = splitEvenly(money(LKR, total), parts);
      assert.equal(shares.length, parts);
      assert.equal(sumMoney(shares, LKR).minor, total, `split of ${total} into ${parts}`);
    }
  });

  test("rejects a split into zero or fractional parts", () => {
    expectError(FinanceErrorCode.VALIDATION_ERROR, () => splitEvenly(money(LKR, 100n), 0));
    expectError(FinanceErrorCode.VALIDATION_ERROR, () => splitEvenly(money(LKR, 100n), 2.5));
  });
});
