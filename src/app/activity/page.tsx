import { redirect } from "next/navigation";

import { asNumber, asOptionalText, asText } from "../../core/data/driver.ts";
import { formatMoney, fromWire } from "../../core/domain/money.ts";
import { localDateOf } from "../../core/domain/time.ts";
import { TransactionStatus } from "../../core/domain/transaction.ts";
import { requireDb, requireService } from "../../server/runtime.ts";
import { accessState } from "../../server/session.ts";
import { iconForCategory, iconForKind, labelForKind } from "../../ui/labels.ts";
import { accountNamesFor } from "../transactions/ledger-rows.ts";
import type { ActivityData } from "./activity-view.tsx";
import { ActivityView } from "./activity-view.tsx";

export const dynamic = "force-dynamic";

const EVENT_LIMIT = 100;
const TRASH_LIMIT = 50;

/**
 * Activity and Trash.
 *
 * buildspec.md §13: "Human-readable changes by owner/import/agent, before/after, undo eligibility,
 * restore, conflict explanations." This is the read side: the audit trail as sentences, what an
 * edit actually changed, and Trash with its restore. §15 makes `audit_events` append-only, so
 * nothing on this screen can alter what it shows.
 */
export default async function ActivityPage() {
  const access = await accessState();
  if (access.kind === "needs-setup") redirect("/setup");
  if (access.kind !== "ready") redirect("/unlock");

  const service = requireService();
  const categories = service.listCategories(true);
  const categoryNames = new Map(categories.map((c) => [c.id, c.name]));
  const categoryOf = new Map(categories.map((c) => [c.id, c]));

  /*
   * `rowid` breaks ties in write order. Two changes can share a millisecond, and the audit id is
   * random, so ordering by it would shuffle them.
   */
  const rows = requireDb()
    .prepare(
      `SELECT id, action_id, actor_kind, actor_session, model_identity, origin, entity_refs_json,
              before_json, after_json, reason, recorded_at
         FROM audit_events
        ORDER BY recorded_at DESC, rowid DESC
        LIMIT ?`,
    )
    .all(EVENT_LIMIT) as Record<string, unknown>[];

  const events = rows.map((row) => {
    const before = revisionIn(parseJson(asOptionalText(row.before_json, "before_json")));
    const after = revisionIn(parseJson(asOptionalText(row.after_json, "after_json")));
    const subject = after ?? before;
    const recordedAt = asNumber(row.recorded_at, "recorded_at");
    return {
      id: asText(row.id, "id"),
      actor: labelForActor(asText(row.actor_kind, "actor_kind")),
      actorKind: asText(row.actor_kind, "actor_kind"),
      modelIdentity: asOptionalText(row.model_identity, "model_identity") ?? null,
      origin: asText(row.origin, "origin"),
      reason: asText(row.reason, "reason"),
      at: recordedAt,
      when: new Date(recordedAt).toLocaleString("en-GB", { timeZone: service.zone, dateStyle: "medium", timeStyle: "short" }),
      transactionId: transactionRefIn(parseJson(asText(row.entity_refs_json, "entity_refs_json"))) ?? null,
      subject: subject ? [textOf(subject.merchantName), amountText(subject)].filter(Boolean).join(" · ") : "",
      changes: before && after ? describeChanges(before, after, categoryNames) : [],
    };
  });

  const trash = service.searchTransactions({
    status: TransactionStatus.DELETED,
    // Trash holds whatever was deleted, including records that never touched a balance.
    includeHistoryOnly: true,
    limit: TRASH_LIMIT,
  });
  const accountNames = accountNamesFor(requireDb(), trash);

  const data: ActivityData = {
    today: localDateOf(Date.now(), service.zone),
    events,
    eventLimitReached: events.length === EVENT_LIMIT,
    trash: trash.map((row) => {
      const category = row.categoryId ? categoryOf.get(row.categoryId) : undefined;
      return {
        id: row.id,
        kind: row.kind,
        kindLabel: labelForKind(row.kind),
        title: row.merchantName ?? labelForKind(row.kind),
        categoryName: row.categoryId ? (category?.name ?? row.categoryId) : null,
        icon: category ? iconForCategory(category.iconKey, category.kind) : iconForKind(row.kind),
        account: accountNames.get(row.id) ?? null,
        date: row.occurredLocalDate,
        // §16: a date-only record must never be shown as though the time were known.
        // Trash lists dates, never times, so §16's precision note would say nothing here.
        labels: row.accountingScope === "history_only" ? "History only" : "",
        amount: row.amount,
        revision: row.revision,
      };
    }),
    trashLimitReached: trash.length === TRASH_LIMIT,
  };

  return <ActivityView data={data} />;
}

/* -------------------------------------------------------------------------------------------- */
/* Reading the audit JSON                                                                         */
/* -------------------------------------------------------------------------------------------- */

/*
 * The audit columns are JSON written by `posting.ts`, but they are also the one place a future
 * writer — an importer, the assistant — may put a different shape. Everything below therefore
 * treats them as untrusted: a shape it does not recognise yields nothing, never an error page.
 */

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The serialised revision inside a `before`/`after` payload, if there is one. */
function revisionIn(payload: unknown): Json | undefined {
  if (!isRecord(payload)) return undefined;
  return isRecord(payload.revision) ? payload.revision : undefined;
}

function transactionRefIn(refs: unknown): string | undefined {
  if (!Array.isArray(refs)) return undefined;
  for (const ref of refs) {
    if (isRecord(ref) && ref.type === "transaction" && typeof ref.id === "string" && ref.id) {
      return ref.id;
    }
  }
  return undefined;
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Money arrives in the §16 wire form — minor units as a string — and is never parsed as a float. */
function amountText(revision: Json): string | undefined {
  const amount = revision.amount;
  if (!isRecord(amount)) return undefined;
  if (typeof amount.amount_minor !== "string" || typeof amount.currency !== "string") {
    return undefined;
  }
  try {
    return formatMoney(fromWire({ amount_minor: amount.amount_minor, currency: amount.currency }));
  } catch {
    return undefined;
  }
}

function dateText(revision: Json): string | undefined {
  const at = revision.occurredAt;
  if (!isRecord(at) || typeof at.instant !== "number" || typeof at.zone !== "string") {
    return undefined;
  }
  try {
    return localDateOf(at.instant, at.zone);
  } catch {
    return undefined;
  }
}

/** buildspec.md §13's "before/after": only the fields that actually differ, in the owner's words. */
function describeChanges(before: Json, after: Json, categoryNames: Map<string, string>): string[] {
  const category = (value: unknown) => {
    const id = textOf(value);
    return id ? (categoryNames.get(id) ?? id) : undefined;
  };
  const changes: string[] = [];
  const compare = (label: string, was: string | undefined, now: string | undefined) => {
    if (was !== now) changes.push(`${label}: ${was ?? "none"} → ${now ?? "none"}`);
  };
  compare("Amount", amountText(before), amountText(after));
  compare("Date", dateText(before), dateText(after));
  compare("Category", category(before.categoryId), category(after.categoryId));
  compare("Merchant", textOf(before.merchantName), textOf(after.merchantName));
  if (textOf(before.notes) !== textOf(after.notes)) changes.push("Notes changed");
  return changes;
}

function labelForActor(kind: string): string {
  switch (kind) {
    case "owner":
      return "You";
    case "agent":
      return "Assistant";
    case "import":
      return "Import";
    case "system":
      return "System";
    case "migration":
      return "Migration";
    default:
      return kind;
  }
}
