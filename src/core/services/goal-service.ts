import { randomUUID } from "node:crypto";

import type { Db } from "../data/driver.ts";
import { asBigInt, asOptionalText, asText } from "../data/driver.ts";
import { notFound, validationError } from "../domain/errors.ts";
import { AccountKind } from "../domain/ledger.ts";
import type { Money } from "../domain/money.ts";
import { money, requireCurrency } from "../domain/money.ts";
import type { LocalDate } from "../domain/time.ts";
import { daysBetween, parseLocalDate } from "../domain/time.ts";
import type { FinanceService } from "./finance-service.ts";

/**
 * Savings goals (buildspec.md §12: "Goals and virtual reservations").
 *
 * A goal never moves money. Its progress is either the recorded balance of the savings account it
 * is linked to — so it rises when the owner transfers into that account — or a figure the owner
 * keeps by hand, which is a reservation in name only. The monthly figure is the arithmetic of
 * what is left over the months that remain, nothing cleverer.
 */

export type GoalRow = {
  readonly id: string;
  readonly name: string;
  readonly target: Money;
  readonly saved: Money;
  readonly remaining: Money;
  /** 0–1, capped at 1. */
  readonly progress: number;
  readonly targetDate: LocalDate | null;
  /** Whole calendar months from this one to the target's month, counting this one; null without a date. */
  readonly monthsLeft: number | null;
  /** What to put aside each month to arrive on time; null without a date or once reached. */
  readonly perMonth: Money | null;
  readonly accountId: string | null;
  readonly accountName: string | null;
  readonly reached: boolean;
  readonly overdue: boolean;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function createGoalService(deps: { db: Db; service: FinanceService }) {
  const { db, service } = deps;

  function toRow(row: Record<string, unknown>, today: LocalDate): GoalRow {
    const currency = requireCurrency(asText(row.currency, "currency"));
    const target = asBigInt(row.target_minor, "target_minor");
    const accountId = asOptionalText(row.account_id, "account_id") ?? null;
    const account = accountId ? service.findAccount(accountId) : undefined;
    const savedMinor = account ? service.balanceOf(account.id).minor : asBigInt(row.saved_minor, "saved_minor");
    const saved = savedMinor < 0n ? 0n : savedMinor;
    const remaining = target > saved ? target - saved : 0n;
    const targetDate = asOptionalText(row.target_date, "target_date") ?? null;
    let monthsLeft: number | null = null;
    if (targetDate) {
      const a = parseLocalDate(today);
      const b = parseLocalDate(targetDate);
      monthsLeft = Math.max(0, (b.year - a.year) * 12 + (b.month - a.month) + 1);
    }
    const reached = remaining === 0n;
    return {
      id: asText(row.id, "id"),
      name: asText(row.name, "name"),
      target: money(currency, target),
      saved: money(currency, saved),
      remaining: money(currency, remaining),
      progress: Math.min(1, Number(saved) / Number(target)),
      targetDate,
      monthsLeft,
      perMonth: reached || monthsLeft === null || monthsLeft === 0 ? null : money(currency, (remaining + BigInt(monthsLeft) - 1n) / BigInt(monthsLeft)),
      accountId,
      accountName: account?.name ?? null,
      reached,
      overdue: !reached && targetDate !== null && daysBetween(today, targetDate) < 0,
    };
  }

  function list(today: LocalDate): GoalRow[] {
    return (db.prepare("SELECT * FROM savings_goals WHERE archived_at IS NULL ORDER BY COALESCE(target_date, '9999'), created_at").all() as Record<string, unknown>[]).map(
      (row) => toRow(row, today),
    );
  }

  function validate(input: { name: string; target: Money; targetDate?: string | null | undefined; accountId?: string | null | undefined }) {
    const name = input.name.trim().replace(/\s+/g, " ");
    if (name.length === 0) throw validationError("Give the goal a name, such as “Emergency fund”.");
    if (name.length > 60) throw validationError("Keep the name under 60 characters.");
    if (input.target.minor <= 0n) throw validationError("The target must be more than zero.");
    if (input.targetDate && !DATE.test(input.targetDate)) throw validationError("Pick a target date.");
    if (input.accountId) {
      const account = service.findAccount(input.accountId);
      if (!account || !account.isUserVisible || account.kind !== AccountKind.ASSET) throw validationError("Link a bank, cash, wallet or savings account.");
      if (account.currency.code !== input.target.currency.code) throw validationError(`That account holds ${account.currency.code}, not ${input.target.currency.code}.`);
    }
    return name;
  }

  function create(input: { name: string; target: Money; targetDate?: string | null | undefined; accountId?: string | null | undefined; saved?: Money | undefined }): string {
    const name = validate(input);
    const id = `goal_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const at = service.clock.now();
    db.prepare(
      `INSERT INTO savings_goals (id, name, target_minor, currency, target_date, account_id, saved_minor, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(id, name, input.target.minor, input.target.currency.code, input.targetDate || null, input.accountId || null, input.saved && input.saved.minor > 0n ? input.saved.minor : 0n, at, at);
    return id;
  }

  function update(input: { id: string; name: string; target: Money; targetDate?: string | null | undefined; accountId?: string | null | undefined; saved?: Money | undefined }): void {
    const existing = db.prepare("SELECT * FROM savings_goals WHERE id = ? AND archived_at IS NULL").get(input.id) as Record<string, unknown> | undefined;
    if (!existing) throw notFound("Goal", input.id);
    const name = validate(input);
    const saved = input.saved === undefined ? asBigInt(existing.saved_minor, "saved_minor") : input.saved.minor;
    if (saved < 0n) throw validationError("The amount set aside can't be negative.");
    db.prepare(
      "UPDATE savings_goals SET name = ?, target_minor = ?, currency = ?, target_date = ?, account_id = ?, saved_minor = ?, updated_at = ? WHERE id = ?",
    ).run(name, input.target.minor, input.target.currency.code, input.targetDate || null, input.accountId || null, saved, service.clock.now(), input.id);
  }

  /** Adds to (or, with a negative amount, takes from) the hand-kept figure of a goal with no account. */
  function contribute(id: string, amount: Money): void {
    const existing = db.prepare("SELECT * FROM savings_goals WHERE id = ? AND archived_at IS NULL").get(id) as Record<string, unknown> | undefined;
    if (!existing) throw notFound("Goal", id);
    if (asOptionalText(existing.account_id, "account_id")) throw validationError("This goal follows its account's balance. Transfer money into that account instead.");
    if (asText(existing.currency, "currency") !== amount.currency.code) throw validationError("That amount is in a different currency from the goal.");
    const next = asBigInt(existing.saved_minor, "saved_minor") + amount.minor;
    db.prepare("UPDATE savings_goals SET saved_minor = ?, updated_at = ? WHERE id = ?").run(next < 0n ? 0n : next, service.clock.now(), id);
  }

  function archive(id: string): void {
    db.prepare("UPDATE savings_goals SET archived_at = ?, updated_at = ? WHERE id = ?").run(service.clock.now(), service.clock.now(), id);
  }

  return { list, create, update, contribute, archive };
}

export type GoalService = ReturnType<typeof createGoalService>;
