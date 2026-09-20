import Link from "next/link";

import { Badge, Card, PageHeader, Shell } from "./primitives.tsx";

/**
 * The page behind a navigation destination that has not been built yet.
 *
 * buildspec.md §13 fixes the five main destinations — Home, Transactions, Bills, Plan, Assistant —
 * so the navigation shows all five from the start. Three of them belong to later milestones, and
 * linking to a route that does not exist produced a 404: the app appeared broken rather than
 * unfinished.
 *
 * §13 also says "No feature should depend on a spinning indicator forever", and the same honesty
 * applies here. A screen that says what it will do, what it needs first, and what to use instead is
 * a truthful empty state. A 404 is a bug.
 */
export function NotBuiltYet({
  title,
  milestone,
  summary,
  willDo,
  blockedBy,
  useInstead,
}: {
  title: string;
  /** e.g. "M4" — which buildspec milestone this screen belongs to. */
  milestone: string;
  summary: string;
  willDo: readonly string[];
  /** What has to exist first, in plain terms. Empty when nothing blocks it. */
  blockedBy?: readonly string[];
  useInstead?: { href: string; label: string };
}) {
  return (
    <Shell>
      <PageHeader
        title={title}
        subtitle={`Not built yet — milestone ${milestone}`}
        action={<Badge tone="warning">Not built</Badge>}
      />

      <Card>
        <p style={{ color: "var(--text-secondary)" }}>{summary}</p>

        <h3 style={{ marginTop: "var(--space-5)", marginBottom: "var(--space-3)" }}>
          What this screen will do
        </h3>
        <ul
          style={{
            margin: 0,
            paddingLeft: "1.1rem",
            display: "grid",
            gap: "var(--space-2)",
            color: "var(--text-secondary)",
          }}
        >
          {willDo.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>

        {blockedBy && blockedBy.length > 0 ? (
          <>
            <h3 style={{ marginTop: "var(--space-5)", marginBottom: "var(--space-3)" }}>
              What has to come first
            </h3>
            <ul
              style={{
                margin: 0,
                paddingLeft: "1.1rem",
                display: "grid",
                gap: "var(--space-2)",
                color: "var(--text-secondary)",
              }}
            >
              {blockedBy.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </>
        ) : null}

        {useInstead ? (
          <p style={{ marginTop: "var(--space-5)" }}>
            In the meantime: <Link href={useInstead.href}>{useInstead.label}</Link>
          </p>
        ) : null}
      </Card>

      <Card>
        <p style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>
          Nothing on Home, Transactions or Accounts depends on this screen. Everything the ledger
          already knows works without it.
        </p>
      </Card>
    </Shell>
  );
}
