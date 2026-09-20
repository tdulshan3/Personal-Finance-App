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
export default async function NewTransactionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await accessState();
  if (access.kind === "needs-setup") redirect("/setup");
  if (access.kind !== "ready") redirect("/unlock");

  const service = requireService();
  const accounts = service.listAccounts();
  const categories = service.listCategories();
  const today = localDateOf(Date.now(), service.zone);

  // A link may pre-fill the form (Bills: "Record payment"). Only values that name a real account
  // or look like an amount are passed on; the form still validates everything on submit.
  const params = await searchParams;
  const param = (key: string) => (typeof params[key] === "string" ? (params[key] as string) : undefined);
  const known = (id: string | undefined) => (id && accounts.some((a) => a.id === id) ? id : undefined);
  const kindParam = param("kind");
  const to = known(param("to"));
  const initial = {
    kind: kindParam && ["expense", "income", "transfer", "refund"].includes(kindParam) ? kindParam : undefined,
    toAccountId: to,
    // Paying a card: start from the first account that is not the card itself.
    fromAccountId: known(param("from")) ?? (to ? accounts.find((a) => a.id !== to && a.kind === "asset")?.id : undefined),
    amount: /^\d{1,12}(\.\d{1,2})?$/.test(param("amount") ?? "") ? param("amount") : undefined,
  };

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
          initial={initial}
        />
      </Card>
    </Shell>
  );
}
