import { redirect } from "next/navigation";

import { requireService } from "../../../server/runtime.ts";
import { accessState } from "../../../server/session.ts";
import type { TxKind } from "../../../ui/transaction-sheet.tsx";
import { OpenNewTransaction } from "./open-new-transaction.tsx";

export const dynamic = "force-dynamic";

/**
 * A link to "add a transaction", for whatever still points here (bookmarks, older links such as
 * Bills' "Record payment"). Adding now happens in a sheet over the current screen, so this route
 * opens that sheet with the link's values and steps aside to the Transactions list.
 *
 * Only values that name a real account or look like an amount are passed on; the sheet and the
 * service still validate everything on Save.
 */
export default async function NewTransactionPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const access = await accessState();
  if (access.kind === "needs-setup") redirect("/setup");
  if (access.kind !== "ready") redirect("/unlock");

  const accounts = requireService().listAccounts().filter((a) => a.isUserVisible);
  const params = await searchParams;
  const param = (key: string) => (typeof params[key] === "string" ? (params[key] as string) : undefined);
  const known = (id: string | undefined) => (id && accounts.some((a) => a.id === id) ? id : undefined);
  const kind = param("kind");
  const to = known(param("to"));

  return (
    <OpenNewTransaction
      hasAccounts={accounts.length > 0}
      prefill={{
        kind: kind && ["expense", "income", "transfer", "refund"].includes(kind) ? (kind as TxKind) : undefined,
        toAccountId: to,
        // Paying a card: start from the first account that is not the card itself.
        accountId: known(param("from")) ?? (to ? accounts.find((a) => a.id !== to && a.kind === "asset")?.id : undefined),
        amount: /^\d{1,12}(\.\d{1,2})?$/.test(param("amount") ?? "") ? param("amount") : undefined,
      }}
    />
  );
}
