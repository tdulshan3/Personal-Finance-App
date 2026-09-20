"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

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

const isActive = (pathname: string, href: string) =>
  // "/transactions/new" still belongs to Transactions; "/planner" would not belong to Plan.
  href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);

/** The screens reached from Home's shortcuts on a phone; on a desktop they live in the sidebar. */
const MANAGE = [
  { href: "/accounts", label: "Accounts", Icon: AccountsIcon },
  { href: "/review", label: "Review", Icon: ReviewIcon },
  { href: "/activity", label: "Activity", Icon: ActivityIcon },
  { href: "/settings", label: "Settings", Icon: SettingsIcon },
] as const;

/**
 * The app's navigation, in whichever form fits the window.
 *
 * A phone gets the floating tab bar. From 1024 px up there is room for a sidebar, which can carry
 * *every* screen rather than five, plus the things that are awkward to reach on a wide display:
 * Add, the review count, the live indicator and Lock. Both are rendered and CSS shows one, so the
 * choice follows the window as it is resized and costs no JavaScript; `display: none` also removes
 * the hidden one from the accessibility tree, so a screen reader meets a single "Main" landmark.
 *
 * `reviewCount` comes from the server layout, which re-renders on every live refresh — so the
 * badge ticks up by itself when a message arrives.
 */
export function AppNav({ reviewCount, footer }: { reviewCount: number; footer?: ReactNode }) {
  const pathname = usePathname();

  return (
    <>
      <nav aria-label="Main" className="sidebar">
        <Link href="/" className="sidebar-brand">
          <span className="sidebar-mark" aria-hidden="true">
            <AccountsIcon size={20} strokeWidth={2.25} />
          </span>
          Finance
        </Link>

        <Link href="/transactions/new" className="btn btn-primary btn-block">
          <PlusIcon size={18} strokeWidth={2.5} />
          Add transaction
        </Link>

        <div className="sidebar-group">
          {DESTINATIONS.map(({ href, label, Icon }) => (
            <Link key={href} href={href} className="sidebar-item" aria-current={isActive(pathname, href) ? "page" : undefined}>
              <Icon size={20} />
              {label}
            </Link>
          ))}
        </div>

        <div className="sidebar-group">
          <span className="sidebar-label" aria-hidden="true">Manage</span>
          {MANAGE.map(({ href, label, Icon }) => (
            <Link key={href} href={href} className="sidebar-item" aria-current={isActive(pathname, href) ? "page" : undefined}>
              <Icon size={20} />
              {label}
              {href === "/review" && reviewCount > 0 ? (
                <span className="sidebar-count" aria-label={`${reviewCount} waiting`}>
                  {reviewCount > 99 ? "99+" : reviewCount}
                </span>
              ) : null}
            </Link>
          ))}
        </div>

        {footer ? <div className="sidebar-footer">{footer}</div> : null}
      </nav>

      <nav aria-label="Main" className="tabbar-wrap">
        <div className="tabbar glass">
          {DESTINATIONS.map(({ href, label, Icon }) => (
            <Link key={href} href={href} aria-current={isActive(pathname, href) ? "page" : undefined} className="tabbar-item">
              <Icon size={24} />
              <span>{label}</span>
            </Link>
          ))}
        </div>
      </nav>
    </>
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

export function QuickLinks({ order }: { order?: number | undefined } = {}) {
  return (
    // `order` places the row among a page's cards on a phone; see `Card`'s prop of the same name.
    <nav aria-label="Shortcuts" className="chip-row quick-links" style={order === undefined ? undefined : { order }}>
      {QUICK_LINKS.map(({ href, label, Icon, ariaLabel }) => (
        <Link key={href} href={href} className="chip" aria-label={ariaLabel}>
          <Icon size={18} strokeWidth={2.25} />
          {label}
        </Link>
      ))}
    </nav>
  );
}
