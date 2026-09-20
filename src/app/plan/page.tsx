import { NotBuiltYet } from "../../ui/not-built.tsx";

export const dynamic = "force-dynamic";

export default function PlanPage() {
  return (
    <NotBuiltYet
      title="Plan"
      milestone="M5"
      summary="A daily cash-flow projection, and how much can be set aside without dropping below your buffer."
      willDo={[
        "A projection through the next 30 days and the end of next month",
        "Base and conservative scenarios, labelled as planning ranges rather than guarantees",
        "A suggested amount to save, with the bills and assumptions that produced it",
        "Low-balance dates, and an honest note when history is too thin to say anything",
        "Savings goals, including reservations that are planning-only and move no money",
      ]}
      blockedBy={[
        "Bills, so committed outflows are known",
        "At least three complete months of reviewed spending — fewer means a low-confidence guess, and missing data is not zero spending",
      ]}
      useInstead={{ href: "/", label: "see this month's recorded spending on Home" }}
    />
  );
}
