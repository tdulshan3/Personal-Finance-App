"use client";

import type { Route } from "next";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { Tab, TabView } from "./ios/ios.tsx";
import type { IconName } from "./labels.ts";
import { usePhone } from "./look.tsx";
import { Sidebar, SidebarItem, SidebarSection, Window, WindowMain } from "./macos/macos.tsx";
import type { AddPrefill, QuickData } from "./transaction-sheet.tsx";
import { TransactionSheet } from "./transaction-sheet.tsx";

/**
 * The app's frame, in whichever Apple look fits the screen (apple-ui-ux adaptive guide).
 *
 * Desktop: one macOS window filling the tab — a sidebar with every place, and the page's own title
 * bar and content beside it. Phone: the iOS tab bar with the five main destinations of buildspec.md
 * §13 (Home, Transactions, Bills, Plan, Assistant); everything else is a screen pushed from Home.
 *
 * Both are driven by the URL, so a reload, a link or the back button lands on the same place in
 * either look, and resizing a window across 744 px keeps the page.
 */

type Place = { key: string; href: Route; label: string; icon: IconName; /** The iPhone tab's one short word, when the label is too long for it. */ tab?: string };

const MAIN: readonly Place[] = [
  { key: "home", href: "/", label: "Home", icon: "house" },
  { key: "transactions", href: "/transactions", label: "Transactions", icon: "list-bullet", tab: "Ledger" },
  { key: "bills", href: "/bills", label: "Bills", icon: "calendar" },
  { key: "plan", href: "/plan", label: "Plan", icon: "chart-bar" },
  { key: "assistant", href: "/assistant", label: "Assistant", icon: "bubble-left" },
];

const MANAGE: readonly Place[] = [
  { key: "accounts", href: "/accounts", label: "Accounts", icon: "creditcard" },
  { key: "categories", href: "/categories", label: "Categories", icon: "tag" },
  { key: "review", href: "/review", label: "Review", icon: "tray" },
  { key: "activity", href: "/activity", label: "Activity", icon: "clock" },
  { key: "settings", href: "/settings", label: "Settings", icon: "gear" },
];

/** The sidebar row for a path: "/transactions/abc" belongs to Transactions, "/planner" would not belong to Plan. */
function placeOf(pathname: string): string {
  for (const place of [...MAIN, ...MANAGE]) {
    if (place.href === "/") continue;
    if (pathname === place.href || pathname.startsWith(`${place.href}/`)) return place.key;
  }
  return "home";
}

/** On a phone the managed screens are pushed from Home, so Home's tab stays selected under them. */
function tabOf(pathname: string): string {
  const place = placeOf(pathname);
  return MAIN.some((p) => p.key === place) ? place : "home";
}

type FrameState = {
  /** Opens the New Transaction sheet, optionally filled in (Bills: "Record payment"). */
  addTransaction: (prefill?: AddPrefill) => void;
  data: QuickData;
  reviewCount: number;
};

const FrameContext = createContext<FrameState | null>(null);

export function useFrame(): FrameState {
  const state = useContext(FrameContext);
  if (!state) throw new Error("useFrame() is only available inside <AppFrame>.");
  return state;
}

export function AppFrame({ reviewCount, data, children }: { reviewCount: number; data: QuickData; children: ReactNode }) {
  const phone = usePhone();
  const pathname = usePathname();
  const router = useRouter();
  const [adding, setAdding] = useState<AddPrefill | null>(null);
  useInAppLinks();

  const addTransaction = useCallback((prefill: AddPrefill = {}) => setAdding(prefill), []);
  const state = useMemo(() => ({ addTransaction, data, reviewCount }), [addTransaction, data, reviewCount]);
  const place = placeOf(pathname);
  const tab = tabOf(pathname);

  return (
    <FrameContext.Provider value={state}>
      {phone ? (
        <TabView
          value={tab}
          // Tapping a tab — including the one already selected — goes to that section's first screen.
          onChange={(value) => router.push(MAIN.find((p) => p.key === value)?.href ?? "/")}
          minimizeOnScroll
        >
          {MAIN.map((p) => (
            <Tab key={p.key} value={p.key} icon={p.icon} label={p.tab ?? p.label}>
              {tab === p.key ? children : null}
            </Tab>
          ))}
        </TabView>
      ) : (
        <Window>
          <Sidebar id="sidebar" label="Places">
            <SidebarSection>
              {MAIN.map((p) => (
                <SidebarItem key={p.key} href={p.href} icon={p.icon} label={p.label} selected={place === p.key} />
              ))}
            </SidebarSection>
            <SidebarSection title="Manage">
              {MANAGE.map((p) => (
                <SidebarItem
                  key={p.key}
                  href={p.href}
                  icon={p.icon}
                  label={p.label}
                  selected={place === p.key}
                  detail={p.key === "review" && reviewCount > 0 ? (reviewCount > 99 ? "99+" : reviewCount) : undefined}
                />
              ))}
            </SidebarSection>
          </Sidebar>
          <WindowMain>{children}</WindowMain>
        </Window>
      )}
      <TransactionSheet open={adding !== null} prefill={adding ?? {}} onClose={() => setAdding(null)} data={data} />
    </FrameContext.Provider>
  );
}

/**
 * The kits draw navigation as plain `<a href>` (sidebar rows, list rows). Left alone, every one of
 * them would reload the whole app. This turns a plain left-click on an in-app link into a client
 * navigation, and leaves everything else — a new tab, a download, an API route — to the browser.
 */
function useInAppLinks() {
  const router = useRouter();
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target || anchor.hasAttribute("download")) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname.startsWith("/api/")) return;
      event.preventDefault();
      router.push(`${url.pathname}${url.search}${url.hash}` as Route);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [router]);
}
