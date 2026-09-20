import Link from "next/link";

import type { Route } from "next";
import type { CSSProperties, ReactNode } from "react";

import type { Money } from "../core/domain/money.ts";
import { formatMoney, isNegative } from "../core/domain/money.ts";
import { cx } from "./cx.ts";
import { AlertIcon, ChevronRightIcon, InfoIcon } from "./icons.tsx";

/**
 * Shared presentational pieces.
 *
 * buildspec.md §13 asks for accurate labels and for income/expense to be distinguished "with signs
 * and labels, not color alone", which is why every amount here can carry a text label and never
 * relies on red/green by itself.
 *
 * The look lives in `src/app/globals.css` as classes rather than inline styles, so that pressed,
 * hover, focus and disabled states — which an inline style cannot express — all work. Every
 * component still accepts `style` for a one-off override.
 */

/**
 * An iOS inset-grouped section.
 *
 * The `title` and `action` sit above the rounded container, the way a grouped list names its
 * sections, rather than inside it. `footer` is the small explanatory text iOS puts underneath.
 */
export function Card({
  children,
  title,
  action,
  tone = "solid",
  style,
  footer,
  order,
}: {
  children: ReactNode;
  title?: ReactNode;
  action?: ReactNode;
  /** §13: glass is for navigation, sheets "and a few summary surfaces" only. */
  tone?: "solid" | "glass";
  /** Applied to the rounded container itself. */
  style?: CSSProperties;
  footer?: ReactNode | undefined;
  /**
   * Where this section sits when `Columns` collapses to one column on a phone. The two stacks
   * dissolve there and their cards interleave by `order`, so a card that lives in the desktop
   * sidebar column can still come second on a phone instead of last. Lower comes first.
   */
  order?: number | undefined;
}) {
  return (
    <section className="card-section" style={order === undefined ? undefined : { order }}>
      {title || action ? (
        <header className="section-header">
          {typeof title === "string" ? <h2 className="section-title">{title}</h2> : title}
          {action ? <div className="section-action">{action}</div> : null}
        </header>
      ) : null}
      <div className={tone === "glass" ? "card card-glass glass" : "card"} style={style}>
        {children}
      </div>
      {footer ? <p className="section-footer">{footer}</p> : null}
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
  return (
    <span
      className={cx(
        "money",
        "amount",
        emphasis === "large" && "amount-large",
        // Red is a second cue only: the sign in the text and `srLabel` carry the meaning.
        emphasis === "muted" ? "amount-muted" : isNegative(value) && "amount-negative",
      )}
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
    <div className="stat">
      <span className="stat-label">{label}</span>
      {value}
      {hint ? <span className="stat-hint">{hint}</span> : null}
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
  return <span className={cx("badge", tone !== "neutral" && `badge-${tone}`)}>{children}</span>;
}

export function EmptyState({
  title,
  body,
  action,
  icon,
}: {
  title: string;
  body: string;
  action?: ReactNode;
  icon?: ReactNode | undefined;
}) {
  // buildspec.md §13: "Include empty, loading, offline, permission-denied ... states."
  return (
    <div className="empty-state">
      {icon ? (
        <span className="empty-state-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <h3 className="empty-state-title">{title}</h3>
      <p className="empty-state-body">{body}</p>
      {action ? <div className="empty-state-action">{action}</div> : null}
    </div>
  );
}

/** An iOS large title, with an optional trailing action and a footnote underneath. */
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
    <header className="page-header">
      <div className="page-header-text">
        <h1>{title}</h1>
        {subtitle ? <p className="page-subtitle">{subtitle}</p> : null}
      </div>
      {action ? <div className="page-header-action">{action}</div> : null}
    </header>
  );
}

/**
 * The page frame.
 *
 * On a phone every page is one column and `width` changes nothing. From 1024 px up the app has a
 * sidebar and room to spare: `wide` (the default) lets a page spread into `Columns` (which split
 * from 1200 px), while `narrow` keeps a single form or a short read at a comfortable measure
 * instead of stretching it.
 */
export function Shell({
  children,
  width = "wide",
}: {
  children: ReactNode;
  width?: "wide" | "narrow" | undefined;
}) {
  return <main className={cx("shell", width === "narrow" && "shell-narrow")}>{children}</main>;
}

/**
 * Side-by-side regions on a desktop, one column on a phone.
 *
 * Children should be `Stack`s. `main-aside` gives the first stack the room and the second a
 * sidebar's width; `aside-main` is the mirror image; `halves` and `thirds` split evenly. Below
 * 1200 px the stacks dissolve (`display: contents`), so their cards flow as one list in DOM order —
 * adjusted by `Card`'s `order` where the phone wants a different sequence.
 */
export function Columns({
  children,
  layout = "main-aside",
}: {
  children: ReactNode;
  layout?: "main-aside" | "aside-main" | "halves" | "thirds" | undefined;
}) {
  return <div className={cx("columns", `columns-${layout}`)}>{children}</div>;
}

/** One column inside `Columns`. `sticky` keeps a short column in view beside a long one. */
export function Stack({
  children,
  sticky = false,
}: {
  children: ReactNode;
  sticky?: boolean | undefined;
}) {
  return <div className={cx("stack", sticky && "stack-sticky")}>{children}</div>;
}

/** The icon means an error is never signalled by red alone. */
export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="note note-danger">
      <AlertIcon size={20} />
      <div className="note-body">{children}</div>
    </div>
  );
}

export function InfoNote({ children }: { children: ReactNode }) {
  return (
    <div className="note note-info">
      <InfoIcon size={20} />
      <div className="note-body">{children}</div>
    </div>
  );
}

/**
 * Rows separated by hairlines that start under the text rather than at the card's edge, the way
 * iOS draws them. Put a `List` straight inside a `Card` and it fills the card edge to edge.
 *
 * `role="list"` is deliberate: Safari drops list semantics from a `<ul>` with `list-style: none`,
 * and VoiceOver then stops announcing "list, 5 items".
 */
export function List({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties | undefined;
}) {
  return (
    <ul className="list" role="list" style={style}>
      {children}
    </ul>
  );
}

export function ListRow<T extends string>({
  children,
  subtitle,
  leading,
  leadingTone,
  trailing,
  href,
  chevron,
}: {
  /** The row's main line. */
  children: ReactNode;
  subtitle?: ReactNode | undefined;
  /** Usually a 18 px icon; it is drawn inside a tinted rounded tile. */
  leading?: ReactNode | undefined;
  leadingTone?: "primary" | "success" | "warning" | "danger" | "neutral" | undefined;
  /** A value, an `Amount` or a `Badge` on the trailing side. */
  trailing?: ReactNode | undefined;
  /** Makes the whole row a link. */
  href?: Route<T> | undefined;
  /** Defaults to true for a row with an `href`. */
  chevron?: boolean | undefined;
}) {
  const showChevron = chevron ?? href !== undefined;
  const content = (
    <>
      {leading ? (
        <span className="list-row-leading" data-tone={leadingTone}>
          {leading}
        </span>
      ) : null}
      <span className="list-row-body">
        <span>{children}</span>
        {subtitle ? <span className="list-row-subtitle">{subtitle}</span> : null}
      </span>
      {trailing ? <span className="list-row-trailing">{trailing}</span> : null}
      {showChevron ? <ChevronRightIcon size={18} className="list-row-chevron" /> : null}
    </>
  );

  return (
    <li className={cx("list-row", leading ? "has-leading" : undefined)}>
      {href !== undefined ? (
        <Link href={href} className="list-row-content">
          {content}
        </Link>
      ) : (
        <div className="list-row-content">{content}</div>
      )}
    </li>
  );
}

/**
 * A link that looks like a `Button`, for navigation that should read as an action ("Add").
 *
 * Use this rather than styling a `Link` by hand: in dark mode the accent used for text
 * (`--primary`) is too light to sit behind white, which is why filled surfaces have their own
 * `--primary-fill` token.
 */
export function ButtonLink<T extends string>({
  href,
  children,
  variant = "primary",
  block = false,
  style,
  "aria-label": ariaLabel,
}: {
  href: Route<T>;
  children: ReactNode;
  variant?: "primary" | "secondary" | "danger" | "ghost" | undefined;
  /** Stretch to the full width of the container. */
  block?: boolean | undefined;
  style?: CSSProperties | undefined;
  "aria-label"?: string | undefined;
}) {
  return (
    <Link
      href={href}
      className={cx("btn", `btn-${variant}`, block && "btn-block")}
      style={style}
      aria-label={ariaLabel}
    >
      {children}
    </Link>
  );
}
