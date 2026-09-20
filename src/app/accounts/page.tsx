import { redirect } from "next/navigation";

import { SUPPORTED_CURRENCIES, formatMoney, isNegative } from "../../core/domain/money.ts";
import { localDateOf } from "../../core/domain/time.ts";
import { createBalanceCheckService } from "../../core/services/balance-check.ts";
import { requireDb, requireService } from "../../server/runtime.ts";
import { accessState } from "../../server/session.ts";
import { labelForAccountType } from "../../ui/labels.ts";
import { Button } from "../../ui/form.tsx";
import { Badge, Card, Columns, EmptyState, List, ListRow, PageHeader, Shell, Stack } from "../../ui/primitives.tsx";
import type { AccountRowData } from "./account-row.tsx";
import { AccountRow } from "./account-row.tsx";
import { recordDifferenceAction } from "./balance-actions.ts";
import { NewAccountForm } from "./new-account-form.tsx";

export const dynamic = "force-dynamic";

/**
 * Accounts.
 *
 * buildspec.md §13: "Add/edit/archive bank, cash, wallet and card accounts; map masked identifiers;
 * display balance type, freshness and tracking start; reconcile." Alias mapping and reconciliation
 * belong to M2 and M4. What is here is labelled for what it is — a recorded balance, not a live
 * bank balance (§13: "Avoid presenting a stale SMS-derived balance as a live bank balance").
 *
 * On a desktop the accounts are the main column and the add form stays in view beside them; a
 * phone reads the same cards top to bottom, form last.
 */
export default async function AccountsPage() {
  const access = await accessState();
  if (access.kind === "needs-setup") redirect("/setup");
  if (access.kind !== "ready") redirect("/unlock");

  const service = requireService();
  const rows = service.accountBalances({ includeArchived: true });
  const today = localDateOf(Date.now(), service.zone);
  const balanceCheck = createBalanceCheckService({ db: requireDb(), service });
  const books = balanceCheck.books();
  const bankChecks = balanceCheck.accounts();
  const when = (instant: number) => new Date(instant).toLocaleString("en-GB", { timeZone: service.zone, dateStyle: "medium", timeStyle: "short" });

  const active = rows.filter((r) => r.account.archivedAt === undefined);
  const archived = rows.filter((r) => r.account.archivedAt !== undefined);

  const toRowData = (row: (typeof rows)[number]): AccountRowData => ({
    id: row.account.id,
    name: row.account.name,
    kind: row.account.kind,
    type: row.account.type,
    typeLabel: labelForAccountType(row.account.type),
    currency: row.account.currency.code,
    institution: row.account.institution ?? null,
    revision: row.account.revision,
    archived: row.account.archivedAt !== undefined,
    balanceText: formatMoney(row.balance),
    balanceIsNegative: isNegative(row.balance),
    creditLimitText: row.account.creditLimit ? formatMoney(row.account.creditLimit) : null,
    // The edit field wants a plain number, not the display form with its currency code.
    creditLimitValue: row.account.creditLimit
      ? formatMoney(row.account.creditLimit, { withCode: false, grouping: false })
      : null,
    availableText: row.available ? formatMoney(row.available) : null,
    utilisationPercent: row.utilisation === undefined ? null : Math.round(row.utilisation * 100),
    entries: service.accountUsage(row.account.id).entries,
  });

  return (
    <Shell>
      <PageHeader
        title="Accounts"
        subtitle="Recorded balances, calculated from what this app knows."
      />

      <Columns layout="main-aside">
        <Stack>
          <Card
            title="Balance check"
            action={books.ok ? <Badge tone="success">Books balance</Badge> : <Badge tone="danger">Books do not balance</Badge>}
            footer="The first line checks the books against themselves. The rest compares each account with the balance your bank last reported by SMS, as of that moment."
          >
            <List>
              <ListRow
                subtitle={
                  books.ok
                    ? `${books.journals} journals, ${books.entries} entries. Every one sums to zero, in every currency.`
                    : books.problems.slice(0, 3).map((p) => p.detail).join("; ") || books.residuals.filter((r) => r.residual !== 0n).map((r) => `${r.currency} is off by ${r.residual} minor units`).join("; ")
                }
                trailing={<Badge tone={books.ok ? "success" : "danger"}>{books.ok ? "OK" : "Problem"}</Badge>}
              >
                Double-entry ledger
              </ListRow>
              {bankChecks.map((check) => (
                <ListRow
                  key={check.account.id}
                  subtitle={
                    check.difference.minor === 0n
                      ? `Bank reported ${formatMoney(check.reported)} on ${when(check.observedAt)}. Your books said the same.`
                      : `Bank reported ${check.compares} ${formatMoney(check.reported)} on ${when(check.observedAt)}; your books said ${formatMoney(check.ledger)}.`
                  }
                  trailing={
                    check.difference.minor === 0n ? <Badge tone="success">Matches</Badge> : <Badge tone="warning">{formatMoney(check.difference, { signed: true })}</Badge>
                  }
                >
                  {check.account.name}
                </ListRow>
              ))}
            </List>
            {bankChecks.length === 0 ? (
              <p style={{ margin: "var(--space-3) 0 0", fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>
                No bank-reported balances yet. They are kept automatically when you accept a bank message that states one.
              </p>
            ) : null}
            {bankChecks.filter((c) => c.difference.minor !== 0n && c.compares === "balance").map((check) => (
              <form key={check.account.id} action={recordDifferenceAction} style={{ marginTop: "var(--space-4)", display: "grid", gap: "var(--space-2)" }}>
                <input type="hidden" name="accountId" value={check.account.id} />
                <p style={{ margin: 0, fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>
                  {check.account.name} is {formatMoney(check.difference, { signed: true })} against the bank. Best is to find and add the
                  missing transaction. If you cannot, record the gap so the balance is right; it is labelled
                  &ldquo;Unexplained difference&rdquo; and can be undone from Trash.
                </p>
                <div><Button variant="secondary">Record {formatMoney(check.difference, { signed: true })} as unexplained</Button></div>
              </form>
            ))}
          </Card>

          {active.length === 0 ? (
            <Card>
              <EmptyState
                title="No accounts yet"
                body="Add the accounts you want to track. You can supply a verified balance now or later."
              />
            </Card>
          ) : (
            <Card title="Your accounts">
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "var(--space-4)" }}>
                {active.map((row) => (
                  <AccountRow key={row.account.id} data={toRowData(row)} />
                ))}
              </ul>
            </Card>
          )}

          {archived.length > 0 ? (
            <Card title="Archived">
              <p style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)", marginBottom: "var(--space-4)" }}>
                These keep every transaction recorded against them, and their balances still compute.
                They simply do not accept new entries.
              </p>
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "var(--space-4)" }}>
                {archived.map((row) => (
                  <AccountRow key={row.account.id} data={toRowData(row)} />
                ))}
              </ul>
            </Card>
          ) : null}
        </Stack>

        <Stack sticky>
          <Card title="Add an account">
            <NewAccountForm currencies={SUPPORTED_CURRENCIES.map((c) => c.code)} today={today} />
          </Card>
        </Stack>
      </Columns>
    </Shell>
  );
}
