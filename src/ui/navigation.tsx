"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import {
  AccountsIcon,
  ActivityIcon,
  AssistantIcon,
  BillsIcon,
  HomeIcon,
  PlanIcon,
  PlusIcon,
  ReviewIcon,
  SettingsIcon,
  TransactionsIcon,
} from "./icons.tsx";

/**
 * buildspec.md §13: "Use five main destinations: Home, Transactions, Bills, Plan, Assistant."
 *
 * All five are real routes. The bar floats above the content as a glass capsule, inset from the
 * screen edges and from the home indicator; §13 allows glass "for navigation", and the `.glass`
 * fallbacks in globals.css turn it solid when blur is unsupported or transparency is reduced.
 *
 * The selected tab is never marked by colour alone: it also gets a capsule behind it and
 * `aria-current="page"`.
 */
const DESTINATIONS = [
  { href: "/", label: "Home", Icon: HomeIcon },
  { href: "/transactions", label: "Transactions", Icon: TransactionsIcon },
  { href: "/bills", label: "Bills", Icon: BillsIcon },
  { href: "/plan", label: "Plan", Icon: PlanIcon },
  { href: "/assistant", label: "Assistant", Icon: AssistantIcon },
] as const;

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Main" className="tabbar-wrap">
      <div className="tabbar glass">
        {DESTINATIONS.map(({ href, label, Icon }) => {
          // "/transactions/new" still belongs to Transactions; "/planner" would not belong to Plan.
          const active =
            href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className="tabbar-item"
            >
              <Icon size={24} />
              <span>{label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

/**
 * The screens that are not main destinations (§13), as a row of tinted capsules that scrolls
 * sideways. "Add" stays here so that recording a transaction is always one tap from Home — §13:
 * "Keep a visible Add button available without chat."
 */
const QUICK_LINKS = [
  { href: "/accounts", label: "Accounts", Icon: AccountsIcon, ariaLabel: undefined },
  { href: "/transactions/new", label: "Add", Icon: PlusIcon, ariaLabel: "Add transaction" },
  { href: "/review", label: "Review", Icon: ReviewIcon, ariaLabel: undefined },
  { href: "/activity", label: "Activity", Icon: ActivityIcon, ariaLabel: undefined },
  { href: "/settings", label: "Settings", Icon: SettingsIcon, ariaLabel: undefined },
] as const;

export function QuickLinks() {
  return (
    <nav aria-label="Shortcuts" className="chip-row">
      {QUICK_LINKS.map(({ href, label, Icon, ariaLabel }) => (
        <Link key={href} href={href} className="chip" aria-label={ariaLabel}>
          <Icon size={18} strokeWidth={2.25} />
          {label}
        </Link>
      ))}
    </nav>
  );
}
