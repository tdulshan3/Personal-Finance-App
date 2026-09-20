"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * buildspec.md §13: "Use five main destinations: Home, Transactions, Bills, Plan, Assistant."
 *
 * Bills, Plan and Assistant belong to milestones M4-M6. They are shown but marked as not yet built
 * rather than hidden, so the app never implies a feature works before it does (§13: "No feature
 * should depend on a spinning indicator forever").
 */
const DESTINATIONS = [
  { href: "/", label: "Home", icon: "◉", ready: true },
  { href: "/transactions", label: "Transactions", icon: "☰", ready: true },
  { href: "/bills", label: "Bills", icon: "▦", ready: false },
  { href: "/plan", label: "Plan", icon: "◔", ready: false },
  { href: "/assistant", label: "Assistant", icon: "✦", ready: false },
] as const;

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Main"
      className="glass"
      style={{
        position: "fixed",
        insetInline: 0,
        bottom: 0,
        display: "flex",
        justifyContent: "space-around",
        gap: "var(--space-1)",
        padding: `var(--space-2) var(--space-2) calc(var(--space-2) + env(safe-area-inset-bottom, 0px))`,
        borderTop: "1px solid var(--glass-border)",
        borderInline: "none",
        borderBottom: "none",
        zIndex: 20,
      }}
    >
      {DESTINATIONS.map((destination) => {
        const active =
          destination.href === "/"
            ? pathname === "/"
            : pathname.startsWith(destination.href);
        return (
          <Link
            key={destination.href}
            href={destination.href}
            aria-current={active ? "page" : undefined}
            style={{
              flex: 1,
              minHeight: "var(--touch-target)",
              display: "grid",
              placeItems: "center",
              gap: "2px",
              padding: "var(--space-1)",
              borderRadius: "var(--radius-input)",
              color: active ? "var(--primary)" : "var(--text-secondary)",
              background: active ? "var(--primary-soft)" : "transparent",
              textDecoration: "none",
              opacity: destination.ready ? 1 : 0.55,
            }}
          >
            <span aria-hidden="true" style={{ fontSize: "1.05rem", lineHeight: 1 }}>
              {destination.icon}
            </span>
            <span style={{ fontSize: "var(--font-xs)", fontWeight: 560 }}>
              {destination.label}
            </span>
            {!destination.ready ? <span className="visually-hidden">(not built yet)</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}

/** A secondary row of links for the screens that are not main destinations (§13). */
export function QuickLinks() {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
      {[
        { href: "/accounts", label: "Accounts" },
        { href: "/transactions/new", label: "Add transaction" },
        { href: "/settings", label: "Settings" },
      ].map((link) => (
        <Link
          key={link.href}
          href={link.href}
          style={{
            minHeight: "40px",
            display: "inline-flex",
            alignItems: "center",
            padding: "0 var(--space-4)",
            borderRadius: "var(--radius-pill)",
            border: "1px solid var(--border)",
            background: "var(--surface)",
            color: "var(--text)",
            fontSize: "var(--font-sm)",
            fontWeight: 560,
            textDecoration: "none",
          }}
        >
          {link.label}
        </Link>
      ))}
    </div>
  );
}
