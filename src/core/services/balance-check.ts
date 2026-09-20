import { randomUUID } from "node:crypto";

import { validateLedgerInvariants } from "../data/backup.ts";
import type { Db } from "../data/driver.ts";
import { asBigInt, asNumber, asText } from "../data/driver.ts";
import { AccountKind, availableCredit } from "../domain/ledger.ts";
import type { LedgerAccount } from "../domain/ledger.ts";
import type { Money } from "../domain/money.ts";
import { money } from "../domain/money.ts";
import type { Instant } from "../domain/time.ts";
import type { FinanceService } from "./finance-service.ts";

/**
 * "Is everything balanced?" — answered two ways, because they are two different questions.
 *
 * 1. **Do the books balance with themselves?** Double entry makes this checkable: every journal
 *    must sum to zero, so every currency must too. If that ever fails, the ledger is corrupt and
 *    no figure on any screen can be trusted. This should never happen — the repository refuses an
 *    unbalanced journal and SQL triggers freeze posted ones — which is exactly why it is worth
 *    proving on demand rather than assuming.
 *
 * 2. **Do the books agree with the bank?** A ledger can be perfectly self-consistent and still be
 *    wrong, because a payment was never recorded. The bank's own messages settle that: "Available
 *    balance Rs 12,450.00" is an independent observation. Each one is kept (buildspec.md §17.1:
 *    "Append observations; never directly overwrite balance") and compared with what the ledger
 *    says the balance was *at that moment*, so later transactions do not muddy the comparison.
 *
 * A difference is reported, never silently fixed. §10: an unexplained gap is shown as one, and the
 * owner may record it as an "Unexplained difference" — a real, reversible, labelled transaction.
 */

export type BooksCheck = {
  readonly ok: boolean;
  readonly journals: number;
  readonly entries: number;
  /** Sum of every posted entry per currency. Anything but zero is corruption. */
  readonly residuals: readonly { currency: string; residual: bigint }[];
  readonly problems: readonly { check: string; detail: string }[];
};

export type AccountCheck = {
  readonly account: LedgerAccount;
  readonly observedAt: Instant;
  /** What the bank said. */
  readonly reported: Money;
  /** What the ledger says the same figure was at that moment. */
  readonly ledger: Money;
  /** reported − ledger. Zero means they agree. */
  readonly difference: Money;
  readonly compares: "balance" | "available credit";
};

export function createBalanceCheckService(deps: { db: Db; service: FinanceService }) {
  const { db, service } = deps;

  function books(): BooksCheck {
    const problems = validateLedgerInvariants(db);
    const residuals = (db.prepare(
      `SELECT j.currency AS currency, SUM(e.amount_minor_signed) AS residual
         FROM journal_entries e JOIN journals j ON j.id = e.journal_id
        WHERE j.state = 'posted' GROUP BY j.currency`,
    ).all() as Record<string, unknown>[]).map((row) => ({ currency: asText(row.currency, "currency"), residual: asBigInt(row.residual, "residual") }));
    const counts = db.prepare(
      `SELECT (SELECT COUNT(*) FROM journals WHERE state = 'posted') AS journals,
              (SELECT COUNT(*) FROM journal_entries) AS entries`,
    ).get() as Record<string, unknown>;
    return {
      ok: problems.length === 0 && residuals.every((r) => r.residual === 0n),
      journals: asNumber(counts.journals, "journals"),
      entries: asNumber(counts.entries, "entries"),
      residuals,
      problems,
    };
  }

  /** Keeps what a bank message said the balance was. Never changes any balance. */
  function recordObservation(input: { accountId: string; reported: Money; observedAt: Instant; sourceId: string }): void {
    const account = service.findAccount(input.accountId);
    if (!account || account.currency.code !== input.reported.currency.code) return;
    const seen = db.prepare("SELECT 1 AS ok FROM balance_observations WHERE account_id = ? AND source_id = ?").get(input.accountId, input.sourceId);
    if (seen) return;
    db.prepare(
      `INSERT INTO balance_observations (id, account_id, amount_minor, currency, balance_type, observed_at, precision, source_id, entered_by, created_at)
       VALUES (?,?,?,?, 'available', ?, 'exact', ?, 'import', ?)`,
    ).run(`obs_${randomUUID().replace(/-/g, "").slice(0, 22)}`, input.accountId, input.reported.minor, account.currency.code, input.observedAt, input.sourceId, service.clock.now());
  }

  /** The newest bank-reported figure for each account, against the ledger as of that moment. */
  function accounts(): AccountCheck[] {
    const checks: AccountCheck[] = [];
    for (const account of service.listAccounts()) {
      if (!account.isUserVisible) continue;
      const row = db.prepare(
        "SELECT amount_minor, observed_at FROM balance_observations WHERE account_id = ? AND currency = ? ORDER BY observed_at DESC LIMIT 1",
      ).get(account.id, account.currency.code) as Record<string, unknown> | undefined;
      if (!row) continue;
      const observedAt = asNumber(row.observed_at, "observed_at");
      const reported = money(account.currency, asBigInt(row.amount_minor, "amount_minor"));
      const balance = service.balanceOf(account.id, observedAt);
      // A card's SMS reports what is left to spend, not what is owed; compare like with like.
      const isCard = account.kind === AccountKind.LIABILITY;
      const ledger = isCard ? availableCredit(account, balance) : balance;
      if (!ledger) continue;
      checks.push({
        account, observedAt, reported, ledger,
        difference: money(account.currency, reported.minor - ledger.minor),
        compares: isCard ? "available credit" : "balance",
      });
    }
    return checks;
  }

  return { books, recordObservation, accounts };
}

export type BalanceCheckService = ReturnType<typeof createBalanceCheckService>;
