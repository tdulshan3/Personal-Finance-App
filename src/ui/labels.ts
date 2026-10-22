import type { IconName } from "./ios/ios.tsx";

/**
 * Owner-facing wording.
 *
 * buildspec.md §13: "Use accurate labels: 'Recorded balance', 'Last checked', 'Estimated next
 * month', and 'Unexplained difference'." Keeping the strings in one place stops a screen from
 * quietly inventing a friendlier but less true word for something.
 *
 * Icons are the apple-ui-ux kit's names. Both looks draw the same set, so one name serves the
 * macOS sidebar and the iOS list row alike.
 */

export type { IconName };

export function labelForKind(kind: string): string {
  switch (kind) {
    case "expense":
      return "Expense";
    case "income":
      return "Income";
    case "transfer":
      return "Transfer";
    case "refund":
      return "Refund";
    case "opening_balance":
      return "Opening balance";
    case "unknown_adjustment":
      return "Unexplained difference";
    default:
      return kind;
  }
}

export function iconForKind(kind: string): IconName {
  switch (kind) {
    case "income":
      return "arrow-down-circle";
    case "transfer":
      return "arrow-up-arrow-down";
    case "refund":
      return "arrow-uturn-left";
    case "opening_balance":
      return "flag";
    case "unknown_adjustment":
      return "questionmark-circle";
    default:
      return "cart";
  }
}

export function labelForAccountType(type: string): string {
  switch (type) {
    case "bank":
      return "Bank";
    case "cash":
      return "Cash";
    case "wallet":
      return "Wallet";
    case "credit_card":
      return "Credit card";
    case "savings":
      return "Savings";
    case "loan":
      return "Loan";
    default:
      return type;
  }
}

export function iconForAccountType(type: string): IconName {
  switch (type) {
    case "credit_card":
      return "creditcard";
    case "cash":
      return "tray";
    case "wallet":
      return "phone";
    case "savings":
      return "archivebox";
    case "loan":
      return "doc-text";
    default:
      return "house";
  }
}

/** The kit icons offered when the owner makes a category, in a sensible order. */
export const CATEGORY_ICONS: readonly IconName[] = [
  "cart", "flame-fill", "figure-walk", "house", "bolt", "heart", "book", "tag", "film", "doc-text",
  "arrow-down-circle", "drop-fill", "leaf", "phone", "wifi", "globe", "paperplane", "person-2",
  "star", "music-note", "eyeglasses", "bed", "cloud", "key", "gear", "questionmark-circle",
];

/**
 * The default categories were seeded with Lucide icon names (buildspec.md §7.5's list). They map
 * onto the nearest kit symbol here, and a key that is already a kit name is used as it is.
 */
const LEGACY_ICONS: Readonly<Record<string, IconName>> = {
  "shopping-cart": "cart",
  utensils: "flame-fill",
  bus: "figure-walk",
  home: "house",
  plug: "bolt",
  "heart-pulse": "heart",
  "graduation-cap": "book",
  bag: "tag",
  film: "film",
  receipt: "doc-text",
  "arrow-down-circle": "arrow-down-circle",
  "help-circle": "questionmark-circle",
};

const KIT_ICONS = new Set<string>(CATEGORY_ICONS);

export function iconForCategory(iconKey: string | null | undefined, kind: "expense" | "income" = "expense"): IconName {
  if (iconKey && LEGACY_ICONS[iconKey]) return LEGACY_ICONS[iconKey];
  if (iconKey && KIT_ICONS.has(iconKey)) return iconKey as IconName;
  return kind === "income" ? "arrow-down-circle" : "tag";
}

/** A tile colour per category, from the kit's system colours, stable for a given id. */
const TILE_COLORS = ["blue", "orange", "green", "indigo", "pink", "teal", "purple", "red", "mint", "brown", "cyan", "yellow"] as const;

export function colorForCategory(id: string): (typeof TILE_COLORS)[number] {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  return TILE_COLORS[hash % TILE_COLORS.length]!;
}

/**
 * buildspec.md §7.1 and §16: a date-only record must not be presented as though the time were
 * known. This is the phrase that keeps that distinction visible in the UI.
 */
export function labelForPrecision(precision: string): string | undefined {
  switch (precision) {
    case "date_only":
      return "Date only";
    case "inferred":
      return "Time inferred";
    default:
      return undefined;
  }
}
