import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, afterEach, describe } from "node:test";

import { FinanceErrorCode, isFinanceError } from "../core/domain/errors.ts";
import { AccountType } from "../core/domain/ledger.ts";
import { LKR, formatMoney, majorUnits } from "../core/domain/money.ts";
import { dateOnlyTime } from "../core/domain/time.ts";
import {
  initialise,
  isInitialised,
  isUnlocked,
  lock,
  requireService,
  sessionMatches,
  sessionTokenHex,
  unlock,
} from "./runtime.ts";
import { readVault, vaultFile } from "./vault.ts";

/**
 * Proof that the lock/unlock lifecycle of buildspec.md §18 actually works end to end: the vault
 * file holds no key material, a wrong passphrase is refused, locking drops the key, and the data
 * survives a lock/unlock cycle.
 *
 * These tests share one process-wide runtime, so they run sequentially and lock between cases.
 */

const workspaces: string[] = [];
const PASSPHRASE = "a long enough passphrase";

function useTempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pfa-runtime-test-"));
  workspaces.push(dir);
  process.env.PFA_DATA_DIR = dir;
  return dir;
}

afterEach(() => {
  lock("test teardown");
});

after(() => {
  delete process.env.PFA_DATA_DIR;
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

describe("vault lifecycle", () => {
  test("a fresh install reports that it needs setup", () => {
    useTempDataDir();
    assert.equal(isInitialised(), false);
    assert.equal(isUnlocked(), false);
  });

  test("initialise creates the vault, seeds categories and leaves the app unlocked", async () => {
    useTempDataDir();
    await initialise({ passphrase: PASSPHRASE, zone: "Asia/Colombo", currency: "LKR" });

    assert.equal(isInitialised(), true);
    assert.equal(isUnlocked(), true);

    const service = requireService();
    assert.equal(service.listCategories().length > 0, true, "default categories are installed");
    assert.equal(service.zone, "Asia/Colombo");
  });

  // buildspec.md §18: "Never place secrets in Git, regular preferences, URLs, audit payloads, or
  // exported logs." The vault file sits unencrypted beside the database, so it must hold no key.
  test("the vault file contains no passphrase and no key material", async () => {
    useTempDataDir();
    await initialise({ passphrase: PASSPHRASE, zone: "Asia/Colombo", currency: "LKR" });

    const raw = readFileSync(vaultFile(), "utf8");
    assert.equal(raw.includes(PASSPHRASE), false, "the passphrase must never be written down");

    const vault = await readVault();
    assert.equal(vault.kdf.algorithm, "scrypt");
    assert.equal(vault.kdf.salt.length > 0, true);
    assert.equal(vault.verifier.length > 0, true);
    // The verifier must not be usable as the key: it is a separate HMAC.
    assert.notEqual(vault.verifier, vault.kdf.salt);
  });

  test("a second initialise on the same device is refused", async () => {
    useTempDataDir();
    await initialise({ passphrase: PASSPHRASE, zone: "Asia/Colombo", currency: "LKR" });
    await assert.rejects(
      () => initialise({ passphrase: "another passphrase here", zone: "UTC", currency: "USD" }),
      /already has a vault/,
    );
  });

  test("a short passphrase is rejected before anything is written", async () => {
    const dir = useTempDataDir();
    await assert.rejects(
      () => initialise({ passphrase: "short", zone: "Asia/Colombo", currency: "LKR" }),
      /at least 12 characters/,
    );
    assert.equal(isInitialised(), false, `no vault should exist in ${dir}`);
  });

  test("an unknown timezone or currency is rejected", async () => {
    useTempDataDir();
    await assert.rejects(
      () => initialise({ passphrase: PASSPHRASE, zone: "Mars/Olympus", currency: "LKR" }),
      /Unknown timezone/,
    );
    await assert.rejects(
      () => initialise({ passphrase: PASSPHRASE, zone: "Asia/Colombo", currency: "XYZ" }),
      /Unsupported currency/,
    );
  });
});

describe("lock and unlock", () => {
  test("data survives a lock and unlock cycle", async () => {
    useTempDataDir();
    await initialise({ passphrase: PASSPHRASE, zone: "Asia/Colombo", currency: "LKR" });

    const service = requireService();
    const account = service.createAccount({
      name: "Everyday bank",
      type: AccountType.BANK,
      currency: LKR,
    });
    service.setOpeningBalance({
      accountId: account.id,
      amount: majorUnits(LKR, 80_000n),
      occurredAt: dateOnlyTime("2026-09-01", "Asia/Colombo"),
    });
    assert.equal(formatMoney(service.balanceOf(account.id)), "LKR 80,000.00");

    lock();
    assert.equal(isUnlocked(), false);
    assert.throws(() => requireService(), (error: unknown) => {
      assert.ok(isFinanceError(error));
      assert.equal(error.code, FinanceErrorCode.LOCKED);
      return true;
    });

    await unlock(PASSPHRASE);
    assert.equal(formatMoney(requireService().balanceOf(account.id)), "LKR 80,000.00");
  });

  test("a wrong passphrase is refused and leaves the app locked", async () => {
    useTempDataDir();
    await initialise({ passphrase: PASSPHRASE, zone: "Asia/Colombo", currency: "LKR" });
    lock();

    await assert.rejects(() => unlock("definitely not it"), (error: unknown) => {
      assert.ok(isFinanceError(error));
      assert.equal(error.code, FinanceErrorCode.LOCKED);
      assert.match(error.message, /not correct/);
      return true;
    });
    assert.equal(isUnlocked(), false, "a failed attempt must not half-open the vault");

    await unlock(PASSPHRASE);
    assert.equal(isUnlocked(), true);
  });

  test("unlocking without a vault tells the owner to run setup", async () => {
    useTempDataDir();
    await assert.rejects(() => unlock(PASSPHRASE), /Run setup first/);
  });
});

describe("session binding", () => {
  // buildspec.md §16: capabilities come from trusted session context, never from the caller.
  test("the session token is regenerated on each unlock, so an old one cannot be replayed", async () => {
    useTempDataDir();
    await initialise({ passphrase: PASSPHRASE, zone: "Asia/Colombo", currency: "LKR" });

    const first = sessionTokenHex();
    assert.equal(sessionMatches(first), true);

    lock();
    assert.equal(sessionMatches(first), false, "a locked runtime matches no token");

    await unlock(PASSPHRASE);
    const second = sessionTokenHex();
    assert.notEqual(second, first, "a new unlock issues a new token");
    assert.equal(sessionMatches(first), false, "the pre-lock token is dead");
    assert.equal(sessionMatches(second), true);
  });

  test("malformed and empty tokens are rejected without throwing", async () => {
    useTempDataDir();
    await initialise({ passphrase: PASSPHRASE, zone: "Asia/Colombo", currency: "LKR" });

    for (const bad of [undefined, "", "zzzz", "00", "a".repeat(63)]) {
      assert.equal(sessionMatches(bad), false, `token ${String(bad)} must not match`);
    }
  });
});
