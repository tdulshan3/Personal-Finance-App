import type { Metadata, Viewport } from "next";

import { currentProcessor } from "../server/background.ts";
import { accessState } from "../server/session.ts";
import { LiveStatus, LiveSync } from "../ui/live-sync.tsx";
import { AppNav } from "../ui/navigation.tsx";
import { LockButton } from "./lock-button.tsx";
import "./globals.css";

export const metadata: Metadata = {
  title: "Personal Finance",
  description: "A private ledger built from financial messages.",
  // buildspec.md §18: nothing about this app should be discoverable or indexed.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // Tells the browser both schemes are handled, so a dark-mode load does not flash white first.
  colorScheme: "light dark",
  // The grouped page background in each scheme (--bg in globals.css), so the browser chrome and
  // the status bar continue the page rather than framing it.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2f2f7" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const access = await accessState();
  const ready = access.kind === "ready";
  // Re-read on every live refresh, so the sidebar's badge follows the inbox without a reload.
  const reviewCount = ready ? (currentProcessor()?.counts().openReviews ?? 0) : 0;

  return (
    <html lang="en">
      {/* `has-nav` is what makes room for the desktop sidebar; the pre-unlock screens have none. */}
      <body className={ready ? "has-nav" : undefined}>
        {children}
        {/* Navigation only appears once the vault is open; there is nothing to navigate to before. */}
        {ready ? (
          <>
            <AppNav
              reviewCount={reviewCount}
              footer={
                <>
                  <LiveStatus />
                  <LockButton />
                </>
              }
            />
            <LiveSync />
          </>
        ) : null}
      </body>
    </html>
  );
}
