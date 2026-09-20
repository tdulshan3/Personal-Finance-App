"use client";

import { useId } from "react";
import { useFormStatus } from "react-dom";

import type { ReactNode } from "react";

import { cx } from "./cx.ts";
import { ChevronsUpDownIcon } from "./icons.tsx";

/**
 * Accessible form controls.
 *
 * buildspec.md §13: "Forms validate money, dates, required accounts, split totals, and dependent
 * records before saving", with 48 dp minimum touch targets and labels that TalkBack can announce.
 * Every field here owns a real `<label for>` — no placeholder-as-label.
 *
 * Controls are filled rather than outlined, 50 px tall, and set in 17 px type: iOS Safari zooms the
 * whole page when a field smaller than 16 px takes focus. The visual rules are the `.control`,
 * `.btn` and `.field` classes in `src/app/globals.css`; `style` and `className` still pass through.
 */

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
    <div className="field">
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      {children({ id, describedBy })}
      {hint ? (
        <span id={hintId} className="field-hint">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={errorId} role="alert" className="field-error">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export function TextInput(
  props: React.InputHTMLAttributes<HTMLInputElement> & { describedBy?: string | undefined },
) {
  const { describedBy, className, ...rest } = props;
  return <input {...rest} aria-describedby={describedBy} className={cx("control", className)} />;
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
  const { currencyCode, describedBy, className, style, ...rest } = props;
  return (
    <div className="money-field">
      <span aria-hidden="true" className="money-field-code">
        {currencyCode}
      </span>
      <input
        {...rest}
        inputMode="decimal"
        autoComplete="off"
        aria-describedby={describedBy}
        className={cx("control", "money", className)}
        style={{
          // Leaves room for the currency code, however many letters it has.
          paddingLeft: `calc(var(--space-4) + ${currencyCode.length}ch + var(--space-2))`,
          ...style,
        }}
      />
    </div>
  );
}

/**
 * The native select, restyled. `appearance: none` removes the platform arrow, so an up-down chevron
 * is drawn over it — the mark iOS uses for a control that opens a list of choices. Tapping it still
 * opens the phone's own picker.
 */
export function Select(
  props: React.SelectHTMLAttributes<HTMLSelectElement> & { describedBy?: string | undefined },
) {
  const { describedBy, className, children, ...rest } = props;
  return (
    <span className="select-wrap">
      <select {...rest} aria-describedby={describedBy} className={cx("control", className)}>
        {children}
      </select>
      <ChevronsUpDownIcon size={18} className="select-chevron" />
    </span>
  );
}

/**
 * primary = filled capsule · secondary = tinted capsule · ghost = plain accent text ·
 * danger = tinted red. Pass `style` for a one-off size; a button drawn shorter than 48 px keeps a
 * 48 px touch target (see `.btn::before`).
 */
export function Button({
  children,
  variant = "primary",
  type = "submit",
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
}) {
  return (
    <button {...rest} type={type} className={cx("btn", `btn-${variant}`, className)}>
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
  return <div className="form-row">{children}</div>;
}
