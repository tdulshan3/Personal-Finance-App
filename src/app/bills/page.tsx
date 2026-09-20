import { NotBuiltYet } from "../../ui/not-built.tsx";

export const dynamic = "force-dynamic";

export default function BillsPage() {
  return (
    <NotBuiltYet
      title="Bills"
      milestone="M4"
      summary="Recurring plans, the bills they generate, and the payments allocated against them."
      willDo={[
        "A calendar and list of what is due, overdue, partly paid or paid",
        "Recurring plans detected from at least three similar transactions, never from one",
        "Mark paid, by linking an existing payment or recording a new one — it never moves money",
        "Partial payments, one payment across several bills, and reversals",
        "Reminders a few days before and on the due date",
      ]}
      blockedBy={[
        "Reconciliation, so a bill marked paid can be checked against a real balance",
        "Enough reviewed history for recurrence detection to have anything to detect",
      ]}
      useInstead={{ href: "/transactions/new", label: "record the payment as an ordinary expense" }}
    />
  );
}
