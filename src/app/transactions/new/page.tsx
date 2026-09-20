import { redirect } from "next/navigation";

import { localDateOf } from "../../../core/domain/time.ts";
import { requireService } from "../../../server/runtime.ts";
import { accessState } from "../../../server/session.ts";
import { Card, EmptyState, PageHeader, Shell } from "../../../ui/primitives.tsx";
import { NewTransactionForm } from "./new-transaction-form.tsx";

export const dynamic = "force-dynamic";

/**
 * buildspec.md §13: "Keep a visible Add button available without chat." This is where it leads.
 *
 * One form, so the page stays `narrow` on a desktop rather than stretching its fields.
 */
export default async function NewTransactionPage() {
  const access = await accessState();
  if (access.kind === "needs-setup") redirect("/setup");
  if (access.kind !== "ready") redirect("/unlock");

  const service = requireService();
  const accounts = service.listAccounts();
  const categories = service.listCategories();
  const today = localDateOf(Date.now(), service.zone);

  if (accounts.length === 0) {
    return (
      <Shell width="narrow">
        <PageHeader title="Add a transaction" />
        <Card>
          <EmptyState
            title="Add an account first"
            body="A transaction has to come from somewhere. Create a bank, cash, wallet or card account, then come back."
            action={<a href="/accounts">Go to Accounts</a>}
          />
        </Card>
      </Shell>
    );
  }

  return (
    <Shell width="narrow">
      <PageHeader title="Add a transaction" subtitle="Recorded locally. Nothing is sent anywhere." />
      <Card>
        <NewTransactionForm
          accounts={accounts.map((a) => ({
            id: a.id,
            name: a.name,
            currency: a.currency.code,
            kind: a.kind,
          }))}
          categories={categories.map((c) => ({ id: c.id, name: c.name }))}
          today={today}
        />
      </Card>
    </Shell>
  );
}
