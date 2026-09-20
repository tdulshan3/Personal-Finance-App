import { redirect } from "next/navigation";

import { AccountKind } from "../../core/domain/ledger.ts";
import { SUPPORTED_CURRENCIES } from "../../core/domain/money.ts";
import { localDateOf } from "../../core/domain/time.ts";
import { requireService } from "../../server/runtime.ts";
import { accessState } from "../../server/session.ts";
import { labelForAccountType } from "../../ui/labels.ts";
import { Amount, Badge, Card, EmptyState, PageHeader, Shell } from "../../ui/primitives.tsx";
import { NewAccountForm } from "./new-account-form.tsx";

export const dynamic = "force-dynamic";

/**
 * Accounts.
 *
 * buildspec.md §13: "Add/edit/archive bank, cash, wallet and card accounts; map masked identifiers;
 * display balance type, freshness and tracking start; reconcile." Alias mapping and reconciliation
 * arrive with M2 and M4; what is here is labelled for what it actually is — a recorded balance, not
 * a live bank balance (§13: "Avoid presenting a stale SMS-derived balance as a live bank balance").
 */
export default async function AccountsPage() {
  const access = await accessState();
  if (access.kind === "needs-setup") redirect("/setup");
  if (access.kind !== "ready") redirect("/unlock");

  const service = requireService();
  const balances = service.accountBalances();
  const today = localDateOf(Date.now(), service.zone);

  return (
    <Shell>
      <PageHeader
        title="Accounts"
        subtitle="Recorded balances, calculated from what this app knows."
      />

      {balances.length === 0 ? (
        <Card>
          <EmptyState
            title="No accounts yet"
            body="Add the accounts you want to track. You can supply a verified opening balance now or later."
          />
        </Card>
      ) : (
        <Card title="Your accounts">
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "var(--space-4)" }}>
            {balances.map(({ account, balance }) => (
              <li
                key={account.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  gap: "var(--space-4)",
                }}
              >
                <div style={{ display: "grid", gap: "var(--space-1)" }}>
                  <span style={{ fontWeight: 560 }}>{account.name}</span>
                  <span style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>
                    {labelForAccountType(account.type)} · {account.currency.code}
                    {account.institution ? ` · ${account.institution}` : ""}
                  </span>
                  <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
                    {account.kind === AccountKind.LIABILITY ? (
                      <Badge tone="warning">
                        {balance.minor < 0n ? "In credit" : "Amount owed"}
                      </Badge>
                    ) : null}
                    {account.trackingStartAt ? (
                      <Badge>
                        Tracked from {localDateOf(account.trackingStartAt, service.zone)}
                      </Badge>
                    ) : null}
                  </div>
                </div>
                <div style={{ display: "grid", gap: "2px", justifyItems: "end" }}>
                  <Amount
                    value={balance}
                    srLabel={
                      account.kind === AccountKind.LIABILITY ? "amount owed" : "recorded balance"
                    }
                  />
                  <span style={{ fontSize: "var(--font-xs)", color: "var(--text-secondary)" }}>
                    Recorded balance
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Add an account">
        <NewAccountForm currencies={SUPPORTED_CURRENCIES.map((c) => c.code)} today={today} />
      </Card>
    </Shell>
  );
}
