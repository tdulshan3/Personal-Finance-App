/**
 * Owner-facing wording.
 *
 * buildspec.md §13: "Use accurate labels: 'Recorded balance', 'Last checked', 'Estimated next
 * month', and 'Unexplained difference'." Keeping the strings in one place stops a screen from
 * quietly inventing a friendlier but less true word for something.
 */

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
