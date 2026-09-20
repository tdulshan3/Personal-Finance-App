import { NotBuiltYet } from "../../ui/not-built.tsx";

export const dynamic = "force-dynamic";

export default function AssistantPage() {
  return (
    <NotBuiltYet
      title="Assistant"
      milestone="M6"
      summary="Ask questions about your own records, and have changes proposed for you to confirm."
      willDo={[
        "Answers drawn from your records, citing the transactions they came from",
        "Proposed changes shown as an exact before-and-after you confirm or cancel",
        "Reads by default; writing anything needs a confirmation every time",
        "It can never change endpoints, permissions, retention or exports",
      ]}
      blockedBy={[
        "A tool layer that enforces the same rules as the manual screens",
        "Proposal binding, so a confirmed action cannot execute with different arguments than it showed",
      ]}
      useInstead={{ href: "/settings", label: "choose the assistant model in Settings" }}
    />
  );
}
