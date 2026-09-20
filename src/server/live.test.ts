import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

/**
 * The live-update hub against a real (throwaway) vault: it must notice writes it was never told
 * about, notice ones made while nobody was connected, and say so when the ledger locks.
 */

const dir = mkdtempSync(join(tmpdir(), "pfa-live-"));
process.env.PFA_DATA_DIR = dir;

// Imported after the env var is set, because the vault reads its directory from it.
const { AccountType } = await import("../core/domain/ledger.ts");
const { LKR } = await import("../core/domain/money.ts");
const runtime = await import("./runtime.ts");
const { liveSnapshot, subscribe } = await import("./live.ts");
type LiveEvent = import("./live.ts").LiveEvent;

after(() => {
  runtime.lock();
  rmSync(dir, { recursive: true, force: true });
});

const waitFor = async (check: () => boolean, ms = 3_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
};

test("writes are noticed without being announced, including while nobody listened", async () => {
  await runtime.initialise({ passphrase: "a synthetic passphrase for the live hub test", zone: "Asia/Colombo", currency: "LKR" });
  const service = runtime.requireService();

  const events: LiveEvent[] = [];
  const stop = subscribe((event) => events.push(event));

  // Nothing announces this write; the hub has to see it in the connection's change counter.
  service.createAccount({ name: "Bank", type: AccountType.BANK, currency: LKR });
  assert.ok(await waitFor(() => events.some((e) => e.type === "change")), "a change event follows a write");
  const afterFirst = liveSnapshot().version;

  // A quiet ledger stays quiet: no events for reads.
  const quietCount = events.length;
  service.listAccounts();
  await new Promise((resolve) => setTimeout(resolve, 1_300));
  assert.equal(events.length, quietCount, "reading changes nothing, so nothing is sent");

  // The tab goes to the background: no listeners, no polling. A write happens meanwhile.
  stop();
  assert.equal(liveSnapshot().listeners, 0);
  service.createAccount({ name: "Wallet", type: AccountType.CASH, currency: LKR });

  // On return the version must already have moved by the time the newcomer asks for it, which is
  // what lets the browser tell that it missed something.
  const late: LiveEvent[] = [];
  const stopLate = subscribe((event) => late.push(event));
  assert.ok(liveSnapshot().version > afterFirst, "the missed write bumped the version on reconnect");

  // Locking ends every stream.
  runtime.lock();
  assert.ok(await waitFor(() => late.some((e) => e.type === "locked")), "a locked event follows a lock");
  stopLate();
});
