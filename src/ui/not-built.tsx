import type { Route } from "next";

import { CheckIcon, ClockIcon } from "./icons.tsx";
import { Badge, Card, List, ListRow, PageHeader, Shell } from "./primitives.tsx";

/**
 * The page behind a navigation destination that has not been built yet.
 *
 * buildspec.md §13 fixes the five main destinations — Home, Transactions, Bills, Plan, Assistant —
 * so the navigation shows all five from the start. Some of them belong to later milestones, and
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
    <Shell width="narrow">
      <PageHeader
        title={title}
        subtitle={`Not built yet — milestone ${milestone}`}
        action={<Badge tone="warning">Not built</Badge>}
      />

      <Card>
        <p>{summary}</p>
      </Card>

      <Card title="What this screen will do">
        <List>
          {willDo.map((item) => (
            <ListRow key={item} leading={<CheckIcon size={18} strokeWidth={2.5} />}>
              {item}
            </ListRow>
          ))}
        </List>
      </Card>

      {blockedBy && blockedBy.length > 0 ? (
        <Card title="What has to come first">
          <List>
            {blockedBy.map((item) => (
              <ListRow
                key={item}
                leading={<ClockIcon size={18} strokeWidth={2.25} />}
                leadingTone="warning"
              >
                {item}
              </ListRow>
            ))}
          </List>
        </Card>
      ) : null}

      {useInstead ? (
        <Card
          title="In the meantime"
          footer="Nothing on Home, Transactions or Accounts depends on this screen. Everything the ledger already knows works without it."
        >
          <List>
            {/* Every caller passes a literal in-app path; typed routes cannot see through `string`. */}
            <ListRow href={useInstead.href as Route}>{sentenceCase(useInstead.label)}</ListRow>
          </List>
        </Card>
      ) : (
        <p className="footnote" style={{ paddingInline: "var(--space-4)" }}>
          Nothing on Home, Transactions or Accounts depends on this screen. Everything the ledger
          already knows works without it.
        </p>
      )}
    </Shell>
  );
}

/** The labels were written to follow "In the meantime:", so they start in lower case. */
function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
