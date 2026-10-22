import { redirect } from "next/navigation";

import { SUPPORTED_CURRENCIES } from "../../core/domain/money.ts";
import { localDateOf } from "../../core/domain/time.ts";
import { createBalanceCheckService } from "../../core/services/balance-check.ts";
import { currentVault, requireDb, requireService } from "../../server/runtime.ts";
import { accessState } from "../../server/session.ts";
import type { AccountsData } from "./accounts-view.tsx";
import { AccountsView } from "./accounts-view.tsx";

export const dynamic = "force-dynamic";

/**
 * Accounts.
 *
 * buildspec.md §13: "Add/edit/archive bank, cash, wallet and card accounts; map masked identifiers;
 * display balance type, freshness and tracking start; reconcile." What is here is labelled for what
 * it is — a recorded balance, not a live bank balance (§13: "Avoid presenting a stale SMS-derived
 * balance as a live bank balance") — and a card's figure says **Current balance**, the word its
 * statement uses, so a card in credit reads as a credit balance rather than as debt (§20).
 *
 * The balance check comes first: whether the books balance at all, and whether each account agrees
 * with the last balance its bank reported by SMS.
 */
export default async function AccountsPage() {
  const access = await accessState();
  if (access.kind === "needs-setup") redirect("/setup");
  if (access.kind !== "ready") redirect("/unlock");

  const service = requireService();
  const balanceCheck = createBalanceCheckService({ db: requireDb(), service });
  const books = balanceCheck.books();
  const when = (instant: number) =>
    new Date(instant).toLocaleString("en-GB", { timeZone: service.zone, dateStyle: "medium", timeStyle: "short" });

  const data: AccountsData = {
    today: localDateOf(Date.now(), service.zone),
    currencies: SUPPORTED_CURRENCIES.map((c) => c.code),
    defaultCurrency: currentVault()?.currency ?? "LKR",
    accounts: service.accountBalances({ includeArchived: true }).map((row) => ({
      id: row.account.id,
      name: row.account.name,
      kind: row.account.kind,
      type: row.account.type,
      currency: row.account.currency.code,
      institution: row.account.institution ?? null,
      revision: row.account.revision,
      archived: row.account.archivedAt !== undefined,
      balance: row.balance,
      creditLimit: row.account.creditLimit ?? null,
      available: row.available ?? null,
      utilisation: row.utilisation === undefined ? null : Math.round(row.utilisation * 100),
      entries: service.accountUsage(row.account.id).entries,
    })),
    books: {
      ok: books.ok,
      journals: books.journals,
      entries: books.entries,
      problems: books.ok
        ? []
        : books.problems.length > 0
          ? books.problems.slice(0, 3).map((p) => p.detail)
          : books.residuals.filter((r) => r.residual !== 0n).map((r) => `${r.currency} is off by ${r.residual} minor units`),
    },
    checks: balanceCheck.accounts().map((check) => ({
      accountId: check.account.id,
      accountName: check.account.name,
      reported: check.reported,
      ledger: check.ledger,
      difference: check.difference,
      observedAt: when(check.observedAt),
      compares: check.compares,
    })),
  };

  return <AccountsView data={data} />;
}
