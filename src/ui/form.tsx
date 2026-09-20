"use client";

import { useId } from "react";
import { useFormStatus } from "react-dom";

import type { ReactNode } from "react";

/**
 * Accessible form controls.
 *
 * buildspec.md §13: "Forms validate money, dates, required accounts, split totals, and dependent
 * records before saving", with 48 dp minimum touch targets and labels that TalkBack can announce.
 * Every field here owns a real `<label for>` — no placeholder-as-label.
 */

const controlStyle = {
  width: "100%",
  minHeight: "var(--touch-target)",
  padding: "0 var(--space-4)",
  borderRadius: "var(--radius-input)",
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
} as const;

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: (props: { id: string; describedBy: string | undefined }) => ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div style={{ display: "grid", gap: "var(--space-2)" }}>
      <label htmlFor={id} style={{ fontSize: "var(--font-sm)", fontWeight: 560 }}>
        {label}
      </label>
      {children({ id, describedBy })}
      {hint ? (
        <span id={hintId} style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)" }}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={errorId} role="alert" style={{ fontSize: "var(--font-sm)", color: "var(--danger)" }}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

export function TextInput(
  props: React.InputHTMLAttributes<HTMLInputElement> & { describedBy?: string | undefined },
) {
  const { describedBy, style, ...rest } = props;
  return <input {...rest} aria-describedby={describedBy} style={{ ...controlStyle, ...style }} />;
}

/**
 * A money input.
 *
 * `inputMode="decimal"` brings up the numeric keypad on the phone, and the value stays a string all
 * the way to the server, where `parseMajorUnits` converts it. buildspec.md §1.6 keeps floats out of
 * money entirely, so the browser never parses this as a number.
 */
export function MoneyInput(
  props: React.InputHTMLAttributes<HTMLInputElement> & {
    currencyCode: string;
    describedBy?: string | undefined;
  },
) {
  const { currencyCode, describedBy, style, ...rest } = props;
  return (
    <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          left: "var(--space-4)",
          color: "var(--text-secondary)",
          fontSize: "var(--font-sm)",
          pointerEvents: "none",
        }}
      >
        {currencyCode}
      </span>
      <input
        {...rest}
        inputMode="decimal"
        autoComplete="off"
        aria-describedby={describedBy}
        className="money"
        style={{
          ...controlStyle,
          paddingLeft: `calc(var(--space-4) + ${currencyCode.length}ch + var(--space-2))`,
          textAlign: "right",
          ...style,
        }}
      />
    </div>
  );
}

export function Select(
  props: React.SelectHTMLAttributes<HTMLSelectElement> & { describedBy?: string | undefined },
) {
  const { describedBy, style, children, ...rest } = props;
  return (
    <select {...rest} aria-describedby={describedBy} style={{ ...controlStyle, ...style }}>
      {children}
    </select>
  );
}

export function Button({
  children,
  variant = "primary",
  type = "submit",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
}) {
  const palette = {
    primary: { bg: "var(--primary)", fg: "var(--primary-contrast)", border: "transparent" },
    secondary: { bg: "var(--surface)", fg: "var(--text)", border: "var(--border)" },
    danger: { bg: "var(--danger-soft)", fg: "var(--danger)", border: "transparent" },
    ghost: { bg: "transparent", fg: "var(--primary)", border: "transparent" },
  }[variant];

  return (
    <button
      {...rest}
      type={type}
      style={{
        minHeight: "var(--touch-target)",
        padding: "0 var(--space-5)",
        borderRadius: "var(--radius-pill)",
        border: `1px solid ${palette.border}`,
        background: palette.bg,
        color: palette.fg,
        fontWeight: 600,
        cursor: "pointer",
        ...rest.style,
      }}
    >
      {children}
    </button>
  );
}

/** Disables itself while the server action runs, so a double tap cannot submit twice. */
export function SubmitButton({
  children,
  pendingLabel = "Working…",
  variant = "primary",
}: {
  children: ReactNode;
  pendingLabel?: string;
  variant?: "primary" | "secondary" | "danger" | "ghost";
}) {
  const { pending } = useFormStatus();
  return (
    <Button variant={variant} disabled={pending} aria-busy={pending}>
      {pending ? pendingLabel : children}
    </Button>
  );
}

export function FormRow({ children }: { children: ReactNode }) {
  return <div style={{ display: "grid", gap: "var(--space-4)" }}>{children}</div>;
}
