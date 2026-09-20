import type { Db } from "../data/driver.ts";
import { asNumber, asText } from "../data/driver.ts";
import { validationError } from "../domain/errors.ts";
import { AccountKind } from "../domain/ledger.ts";
import type { LedgerAccount } from "../domain/ledger.ts";
import type { Money } from "../domain/money.ts";
import type { LocalDate } from "../domain/time.ts";
import { daysBetween, daysInMonth, parseLocalDate, toLocalDate } from "../domain/time.ts";
import type { FinanceService } from "./finance-service.ts";

/**
 * What is owed on each credit line, and when.
 *
 * A card's spending this month is billed and paid next month, so the payment shown is always the
 * one falling due in the *next* calendar month, on the day the owner says their card is due. The
 * amount is the card's current balance from the ledger — never a figure read from a statement or
 * guessed — which means it grows as the month's spending is recorded, and the owner sees the bill
 * forming rather than being surprised by it.
 *
 * Nothing here moves money. Paying is an ordinary transfer into the card, recorded by the owner.
 */

export type CardDue = {
  readonly account: LedgerAccount;
  /** Positive when money is owed; a card in credit owes nothing. */
  readonly owed: Money;
  readonly dueDay: number | null;
  readonly dueOn: LocalDate | null;
  readonly daysLeft: number | null;
};

/** The due day in the month after `today`, clamped: "the 31st" in a 30-day month is the 30th. */
export function nextMonthDue(today: LocalDate, dueDay: number): LocalDate {
  const { year, month } = parseLocalDate(today);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return toLocalDate(nextYear, nextMonth, Math.min(dueDay, daysInMonth(nextYear, nextMonth)));
}

export function createCardDueService(deps: { db: Db; service: FinanceService }) {
  const { db, service } = deps;

  function dueDayOf(accountId: string): number | null {
    const row = db.prepare("SELECT due_day FROM account_payment_terms WHERE account_id = ?").get(accountId) as Record<string, unknown> | undefined;
    return row ? asNumber(row.due_day, "due_day") : null;
  }

  function setDueDay(accountId: string, day: number | null): void {
    const account = service.findAccount(accountId);
    if (!account || account.kind !== AccountKind.LIABILITY) throw validationError("A payment due day belongs to a credit card or a loan.");
    if (day === null) {
      db.prepare("DELETE FROM account_payment_terms WHERE account_id = ?").run(accountId);
      return;
    }
    if (!Number.isInteger(day) || day < 1 || day > 31) throw validationError("The due day must be between 1 and 31.");
    db.prepare(
      `INSERT INTO account_payment_terms (account_id, due_day, updated_at) VALUES (?,?,?)
       ON CONFLICT(account_id) DO UPDATE SET due_day = excluded.due_day, updated_at = excluded.updated_at`,
    ).run(accountId, day, service.clock.now());
  }

  /** Every active credit line, soonest due first; those without a due day last. */
  function list(today: LocalDate): CardDue[] {
    return service
      .accountBalances()
      .filter(({ account }) => account.kind === AccountKind.LIABILITY && account.isUserVisible)
      .map(({ account, balance }): CardDue => {
        const dueDay = dueDayOf(account.id);
        const dueOn = dueDay === null ? null : nextMonthDue(today, dueDay);
        return { account, owed: balance, dueDay, dueOn, daysLeft: dueOn === null ? null : daysBetween(today, dueOn) };
      })
      .sort((a, b) => (a.dueOn ?? "9999").localeCompare(b.dueOn ?? "9999") || asText(a.account.name, "name").localeCompare(b.account.name));
  }

  return { list, setDueDay, dueDayOf };
}

export type CardDueService = ReturnType<typeof createCardDueService>;
