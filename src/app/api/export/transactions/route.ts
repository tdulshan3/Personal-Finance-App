import { formatMoney } from "../../../../core/domain/money.ts";
import { localDateOf } from "../../../../core/domain/time.ts";
import type { TransactionListItem } from "../../../../core/services/finance-service.ts";
import { requireDb, requireService } from "../../../../server/runtime.ts";
import { accessState } from "../../../../server/session.ts";
import { labelForKind } from "../../../../ui/labels.ts";
import { accountNamesFor, readFilters, searchArgs } from "../../../transactions/ledger-rows.ts";

export const dynamic = "force-dynamic";

/**
 * The Transactions list as a CSV file, with exactly the filters the screen was showing.
 *
 * Like the backup download, this is the owner's ledger, so it needs the vault unlocked *and* this
 * browser's session cookie (`SameSite=Strict`, so another site cannot trigger it). Nothing is
 * written anywhere: the file is built in memory and handed straight to the browser.
 *
 * Amounts are plain major units ("3450.00") with the currency in its own column, never a float,
 * and the kind column says which way the money went. A cell that a spreadsheet would read as a
 * formula (=, +, -, @ at the start — a merchant name comes from a bank message, which anyone can
 * send) gets a leading apostrophe so it stays text.
 */

const NO_STORE = { "cache-control": "no-store" } as const;
const PAGE = 200;
/** A ceiling well above any personal ledger, so a runaway query cannot build an unbounded file. */
const MAX_ROWS = 100_000;

export async function GET(request: Request): Promise<Response> {
  const access = await accessState();
  if (access.kind !== "ready") {
    return Response.json({ error: "unauthorized", detail: "Unlock the app in this browser first." }, { status: 401, headers: NO_STORE });
  }

  const service = requireService();
  const filters = readFilters(new URL(request.url).searchParams);
  const args = searchArgs(filters);
  const categories = new Map(service.listCategories(true).map((c) => [c.id, c.name]));

  const rows: TransactionListItem[] = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
    const page = service.searchTransactions({ ...args, limit: PAGE, offset });
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  const accounts = accountNamesFor(requireDb(), rows);

  const lines = [
    ["date", "kind", "merchant_or_payer", "category", "accounts", "amount", "currency", "notes", "status"],
    ...rows.map((row) => [
      row.occurredLocalDate,
      labelForKind(row.kind),
      row.merchantName ?? "",
      row.categoryId ? (categories.get(row.categoryId) ?? row.categoryId) : "",
      accounts.get(row.id) ?? "",
      formatMoney(row.amount, { withCode: false, grouping: false }),
      row.amount.currency.code,
      row.notes ?? "",
      row.accountingScope === "history_only" ? `${row.status} (history only)` : row.status,
    ]),
  ];
  // A byte-order mark so a spreadsheet opens names in Sinhala or Tamil as UTF-8.
  const body = `﻿${lines.map((cells) => cells.map(cell).join(",")).join("\r\n")}\r\n`;
  const stamp = localDateOf(Date.now(), service.zone).replace(/-/g, "");

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      // Safe to interpolate: the name is fixed text and digits only.
      "content-disposition": `attachment; filename="${filters.trash ? "trash" : "transactions"}-${stamp}.csv"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

/** One CSV field: formula-looking text defused, then quoted if it holds a comma, quote or line break. */
function cell(value: string): string {
  // Amounts are never defused: "-12.50" must stay a number. Only free text can start a formula.
  const text = /^[=+\-@\t\r]/.test(value) && !/^-?\d+(\.\d+)?$/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
