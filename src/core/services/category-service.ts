import { randomUUID } from "node:crypto";

import type { Db } from "../data/driver.ts";
import { asNumber, asText } from "../data/driver.ts";
import { notFound, validationError } from "../domain/errors.ts";
import type { Category, CategoryKind, FinanceService } from "./finance-service.ts";

/**
 * Categories the owner can shape.
 *
 * buildspec.md §7.5 calls the default set "editable", and §13 says a category with transactions is
 * archived rather than deleted, so nothing it labels is ever orphaned. Archiving only takes a
 * category out of the pickers; every past record, total and budget that used it still resolves.
 *
 * A category's direction is fixed at creation. The ledger account behind it is created with that
 * direction the first time it is used, and changing it afterwards would leave history booked to an
 * account of the other kind.
 */

/** Ids the posting code and the ingestion pipeline name directly. They must always be pickable. */
const PROTECTED = new Set(["income", "uncategorized", "fees"]);

export type CategoryRow = Category & {
  readonly sortOrder: number;
  /** Transactions whose current revision carries this category. */
  readonly uses: number;
};

export function createCategoryService(deps: { db: Db; service: FinanceService }) {
  const { db, service } = deps;
  const now = () => service.clock.now();

  function list(includeArchived = true): CategoryRow[] {
    const uses = new Map(
      (
        db
          .prepare(
            `SELECT r.category_id AS id, COUNT(*) AS n
               FROM transactions t
               JOIN transaction_revisions r ON r.transaction_id = t.id AND r.revision = t.current_revision
              WHERE t.status = 'posted' AND r.category_id IS NOT NULL
              GROUP BY r.category_id`,
          )
          .all() as Record<string, unknown>[]
      ).map((row) => [asText(row.id, "id"), asNumber(row.n, "n")]),
    );
    const sortOrders = new Map(
      (db.prepare("SELECT id, sort_order FROM categories").all() as Record<string, unknown>[]).map((row) => [
        asText(row.id, "id"),
        asNumber(row.sort_order, "sort_order"),
      ]),
    );
    return service
      .listCategories(includeArchived)
      .map((category) => ({ ...category, sortOrder: sortOrders.get(category.id) ?? 0, uses: uses.get(category.id) ?? 0 }));
  }

  function find(id: string): CategoryRow | undefined {
    return list(true).find((category) => category.id === id);
  }

  function cleanName(name: string): string {
    const trimmed = name.trim().replace(/\s+/g, " ");
    if (trimmed.length === 0) throw validationError("Give the category a name.");
    if (trimmed.length > 40) throw validationError("Keep the name under 40 characters.");
    return trimmed;
  }

  function assertUniqueName(name: string, exceptId?: string): void {
    const clash = db
      .prepare("SELECT id FROM categories WHERE lower(name) = lower(?) AND archived_at IS NULL")
      .get(name) as Record<string, unknown> | undefined;
    if (clash && asText(clash.id, "id") !== exceptId) throw validationError(`There is already a category called “${name}”.`);
  }

  function create(input: { name: string; kind: CategoryKind; icon?: string | undefined }): CategoryRow {
    const name = cleanName(input.name);
    if (input.kind !== "expense" && input.kind !== "income") throw validationError("Choose spending or income.");
    assertUniqueName(name);
    const id = `cat_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const nextOrder = db.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM categories").get() as Record<string, unknown>;
    const at = now();
    db.prepare(
      `INSERT INTO categories (id, name, kind, icon_key, sort_order, is_system, created_at, updated_at)
       VALUES (?,?,?,?,?,0,?,?)`,
    ).run(id, name, input.kind, input.icon ?? null, asNumber(nextOrder.n, "n"), at, at);
    return find(id)!;
  }

  function update(input: { id: string; name?: string | undefined; icon?: string | null | undefined }): CategoryRow {
    const existing = find(input.id);
    if (!existing) throw notFound("Category", input.id);
    const name = input.name === undefined ? existing.name : cleanName(input.name);
    if (name.toLowerCase() !== existing.name.toLowerCase()) assertUniqueName(name, existing.id);
    db.prepare("UPDATE categories SET name = ?, icon_key = ?, updated_at = ? WHERE id = ?").run(
      name,
      input.icon === undefined ? (existing.iconKey ?? null) : input.icon,
      now(),
      existing.id,
    );
    // The hidden ledger accounts carry the category's name for the audit trail; keep them in step.
    for (const row of db.prepare("SELECT ledger_account_id, currency FROM category_accounts WHERE category_id = ?").all(existing.id) as Record<string, unknown>[]) {
      db.prepare("UPDATE ledger_accounts SET name = ?, updated_at = ? WHERE id = ?").run(
        `${name} (${asText(row.currency, "currency")})`,
        now(),
        asText(row.ledger_account_id, "ledger_account_id"),
      );
    }
    return find(existing.id)!;
  }

  function setArchived(id: string, archived: boolean): CategoryRow {
    const existing = find(id);
    if (!existing) throw notFound("Category", id);
    if (archived && PROTECTED.has(id)) throw validationError(`“${existing.name}” is used by the app itself and can't be archived.`);
    if (!archived) assertUniqueName(existing.name, existing.id);
    db.prepare("UPDATE categories SET archived_at = ?, updated_at = ? WHERE id = ?").run(archived ? now() : null, now(), id);
    if (archived) db.prepare("DELETE FROM category_budgets WHERE category_id = ?").run(id);
    return find(id)!;
  }

  return {
    list,
    find,
    create,
    update,
    archive: (id: string) => setArchived(id, true),
    unarchive: (id: string) => setArchived(id, false),
    isProtected: (id: string) => PROTECTED.has(id),
  };
}

export type CategoryService = ReturnType<typeof createCategoryService>;
