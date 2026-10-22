"use client";

import type { CSSProperties, ReactNode } from "react";

import { FormRow, Icon } from "./ios/ios.tsx";
import type { IconName } from "./labels.ts";

/**
 * The iOS summary card, copied from the apple-ui-ux SummaryApp template: the inset grouped card
 * (grouped secondary background, the kit's 26 pt group radius, 16 padding, no shadow, no border, no
 * material), made only of kit tokens. A coloured symbol and title head it; the colour names the
 * card's subject and the text stays in label colours.
 */

const CARD: CSSProperties = {
  boxSizing: "border-box",
  display: "flex",
  flexDirection: "column",
  gap: 12,
  width: "100%",
  minWidth: 0,
  margin: 0,
  padding: 16,
  border: 0,
  borderRadius: 26,
  background: "var(--ios-grouped-bg-secondary)",
  color: "var(--ios-label-primary)",
  font: "inherit",
  letterSpacing: "inherit",
  textAlign: "start",
};

/** The side margins of an inset grouped List, for content placed between lists so the edges line up. */
export const READABLE_MARGIN = "max(var(--ios-margin), calc((100% - 648px) / 2))";

export function IosCard({
  icon,
  title,
  color = "var(--ios-accent)",
  trailing,
  href,
  onClick,
  children,
  label,
}: {
  icon: IconName;
  title: string;
  /** A system colour token for the header: it carries the card's subject. */
  color?: string;
  /** Small secondary text on the header's right ("This month"). */
  trailing?: ReactNode;
  /** The whole card opens this screen (a chevron shows it). */
  href?: string | undefined;
  onClick?: (() => void) | undefined;
  children?: ReactNode;
  /** Accessible name for a tappable card when its text alone would not say where it goes. */
  label?: string;
}) {
  const header = (
    <span className="ios-row ios-subheadline ios-emphasized" style={{ color }}>
      <Icon name={icon} />
      <span style={{ flex: "1 1 auto", minWidth: 0 }}>{title}</span>
      {trailing ? <span className="ios-footnote ios-label-secondary">{trailing}</span> : null}
      {href || onClick ? <Icon name="chevron-right" className="ios-label-tertiary" /> : null}
    </span>
  );
  if (href) {
    return (
      <a href={href} style={{ ...CARD, textDecoration: "none" }} aria-label={label}>
        {header}
        {children}
      </a>
    );
  }
  if (onClick) {
    return (
      <button type="button" style={{ ...CARD, cursor: "pointer" }} onClick={onClick} aria-label={label}>
        {header}
        {children}
      </button>
    );
  }
  return (
    <section style={CARD} aria-label={label ?? title}>
      {header}
      {children}
    </section>
  );
}

/** A big rounded figure with its currency code, as the template's Reading: "LKR 379,000.00". */
export function IosReading({ code, value, size = "title1" }: { code?: string | undefined; value: string; size?: "title1" | "title2" | "title3" }) {
  return (
    <span style={{ display: "flex", alignItems: "baseline", gap: 4, flexWrap: "wrap", minWidth: 0 }}>
      {code ? <span className="ios-subheadline ios-emphasized ios-label-secondary">{code}</span> : null}
      <span className={`ios-${size} ios-emphasized ios-rounded pfa-hero`}>{value}</span>
    </span>
  );
}

/** Label-over-value pairs under a reading: "In accounts · LKR 382,000.00". */
export function IosFacts({ items }: { items: readonly { label: string; value: string }[] }) {
  return (
    <span style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10 }}>
      {items.map((item) => (
        <span key={item.label} style={{ display: "grid", gap: 2, minWidth: 0 }}>
          <span className="ios-footnote ios-label-secondary">{item.label}</span>
          <span className="ios-subheadline pfa-money">{item.value}</span>
        </span>
      ))}
    </span>
  );
}

/**
 * A labelled text field in a list: "Amount" on the leading side, the field filling the rest of the
 * row, as in Contacts' edit form or Health's Medical ID. The kit draws a text field as a row of its
 * own named only by its placeholder, which leaves an edit form of prefilled values unlabelled; put
 * beside a `FormRow` label as it is, its field claims the row and the label wraps a letter at a
 * time. The wrapper only places the field (it takes the free width and shrinks first); the field
 * and the row are the kit's, unchanged.
 */
export function IosFieldRow({ label, footer, children }: { label: string; footer?: ReactNode; children: ReactNode }) {
  return (
    <FormRow label={label} subtitle={footer}>
      <span style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", flex: "1 1 0", minWidth: 0 }}>{children}</span>
    </FormRow>
  );
}

/** A sentence of explanation inside a card. */
export function IosNote({ children }: { children: ReactNode }) {
  return <span className="ios-footnote ios-label-secondary">{children}</span>;
}
