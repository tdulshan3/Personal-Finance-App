import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";

import { localDateOf } from "../core/domain/time.ts";
import { currentProcessor } from "../server/background.ts";
import { requireService } from "../server/runtime.ts";
import { accessState } from "../server/session.ts";
import { AppFrame } from "../ui/frame.tsx";
import { iconForCategory } from "../ui/labels.ts";
import { LiveSync } from "../ui/live-sync.tsx";
import { LookProvider } from "../ui/look.tsx";
import { LOOK_COOKIE, guessPhone } from "../ui/look-shared.ts";
import type { QuickData } from "../ui/transaction-sheet.tsx";
import "../ui/looks.css";
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
  // The iOS grouped background in each scheme, so a phone's browser chrome continues the page.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2f2f7" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

/**
 * The root: the Apple look for this screen, and — once the vault is open — the app frame around
 * every page. Setup and Unlock draw their own single-screen shells, since before the vault opens
 * there is nowhere to navigate to.
 *
 * Everything the frame needs is read here, and this layout re-renders on every live refresh, so
 * the Review badge and the New Transaction sheet's accounts follow the ledger by themselves.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const access = await accessState();
  const ready = access.kind === "ready";
  const phone = guessPhone((await cookies()).get(LOOK_COOKIE)?.value, (await headers()).get("user-agent"));

  let frame: { reviewCount: number; data: QuickData } | null = null;
  if (ready) {
    const service = requireService();
    frame = {
      reviewCount: currentProcessor()?.counts().openReviews ?? 0,
      data: {
        today: localDateOf(Date.now(), service.zone),
        accounts: service
          .listAccounts()
          .filter((a) => a.isUserVisible)
          .map((a) => ({ id: a.id, name: a.name, currency: a.currency.code, kind: a.kind, type: a.type })),
        categories: service.listCategories().map((c) => ({ id: c.id, name: c.name, kind: c.kind, icon: iconForCategory(c.iconKey, c.kind) })),
      },
    };
  }

  return (
    <html lang="en">
      <body>
        <LookProvider phone={phone}>
          {frame ? (
            <>
              <AppFrame reviewCount={frame.reviewCount} data={frame.data}>
                {children}
              </AppFrame>
              <LiveSync />
            </>
          ) : (
            children
          )}
        </LookProvider>
      </body>
    </html>
  );
}
