import type { CSSProperties, ReactNode } from "react";

import type { Money } from "../core/domain/money.ts";
import { formatMoney, isNegative } from "../core/domain/money.ts";

/**
 * Shared presentational pieces.
 *
 * buildspec.md §13 asks for accurate labels and for income/expense to be distinguished "with signs
 * and labels, not color alone", which is why every amount here can carry a text label and never
 * relies on red/green by itself.
 */

export function Card({
  children,
  title,
  action,
  tone = "solid",
  style,
}: {
  children: ReactNode;
  title?: ReactNode;
  action?: ReactNode;
  /** §13: glass is for navigation, sheets "and a few summary surfaces" only. */
  tone?: "solid" | "glass";
  style?: CSSProperties;
}) {
  return (
    <section
      className={tone === "glass" ? "glass" : undefined}
      style={{
        background: tone === "glass" ? undefined : "var(--surface)",
        border: tone === "glass" ? undefined : "1px solid var(--border)",
        borderRadius: "var(--radius-card)",
        padding: "var(--space-5)",
        boxShadow: "var(--shadow-card)",
        ...style,
      }}
    >
      {(title || action) && (
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "var(--space-3)",
            marginBottom: "var(--space-4)",
          }}
        >
          {typeof title === "string" ? <h2>{title}</h2> : title}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

/**
 * Renders an amount with tabular digits.
 *
 * `srLabel` exists because a screen reader announcing "minus 3,450" without context is ambiguous;
 * the caller supplies e.g. "expense" so the row reads as a sentence.
 */
export function Amount({
  value,
  signed = false,
  emphasis = "normal",
  srLabel,
}: {
  value: Money;
  signed?: boolean;
  emphasis?: "normal" | "large" | "muted";
  srLabel?: string;
}) {
  const text = formatMoney(value, { signed });
  const color =
    emphasis === "muted"
      ? "var(--text-secondary)"
      : isNegative(value)
        ? "var(--danger)"
        : "var(--text)";
  return (
    <span
      className="money"
      style={{
        color,
        fontSize: emphasis === "large" ? "var(--font-xl)" : "inherit",
        fontWeight: emphasis === "large" ? 700 : 560,
        letterSpacing: emphasis === "large" ? "-0.02em" : undefined,
      }}
    >
      {srLabel ? <span className="visually-hidden">{srLabel} </span> : null}
      {text}
    </span>
  );
}

export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div style={{ display: "grid", gap: "var(--space-1)" }}>
      <span style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>{label}</span>
      {value}
      {hint ? (
        <span style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>{hint}</span>
      ) : null}
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "warning" | "danger" | "success" | "primary";
}) {
  const palette: Record<string, { bg: string; fg: string }> = {
    neutral: { bg: "var(--surface-sunken)", fg: "var(--text-secondary)" },
    warning: { bg: "var(--warning-soft)", fg: "var(--warning)" },
    danger: { bg: "var(--danger-soft)", fg: "var(--danger)" },
    success: { bg: "var(--success-soft)", fg: "var(--success)" },
    primary: { bg: "var(--primary-soft)", fg: "var(--primary)" },
  };
  const colors = palette[tone] ?? palette.neutral!;
  return (
    <span
      style={{
        background: colors.bg,
        color: colors.fg,
        borderRadius: "var(--radius-pill)",
        padding: "2px 10px",
        fontSize: "var(--font-sm)",
        fontWeight: 560,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  // buildspec.md §13: "Include empty, loading, offline, permission-denied ... states."
  return (
    <div
      style={{
        display: "grid",
        gap: "var(--space-3)",
        justifyItems: "center",
        textAlign: "center",
        padding: "var(--space-6) var(--space-4)",
        color: "var(--text-secondary)",
      }}
    >
      <h3 style={{ color: "var(--text)" }}>{title}</h3>
      <p style={{ maxWidth: "34ch" }}>{body}</p>
      {action}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header
      style={{
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "space-between",
        gap: "var(--space-4)",
        marginBottom: "var(--space-5)",
      }}
    >
      <div style={{ display: "grid", gap: "var(--space-1)" }}>
        <h1>{title}</h1>
        {subtitle ? (
          <p style={{ color: "var(--text-secondary)", fontSize: "var(--font-sm)" }}>{subtitle}</p>
        ) : null}
      </div>
      {action}
    </header>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  return (
    <main
      style={{
        maxWidth: "760px",
        margin: "0 auto",
        // §13: "16–24 dp screen padding"
        padding: "var(--space-5) var(--space-4) var(--space-6)",
        display: "grid",
        gap: "var(--space-5)",
      }}
    >
      {children}
    </main>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      style={{
        background: "var(--danger-soft)",
        color: "var(--danger)",
        borderRadius: "var(--radius-input)",
        padding: "var(--space-3) var(--space-4)",
        fontSize: "var(--font-sm)",
      }}
    >
      {children}
    </p>
  );
}

export function InfoNote({ children }: { children: ReactNode }) {
  return (
    <p
      style={{
        background: "var(--primary-soft)",
        color: "var(--primary)",
        borderRadius: "var(--radius-input)",
        padding: "var(--space-3) var(--space-4)",
        fontSize: "var(--font-sm)",
      }}
    >
      {children}
    </p>
  );
}
