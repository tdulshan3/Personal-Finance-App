import type { Metadata, Viewport } from "next";

import { BottomNav } from "../ui/navigation.tsx";
import { accessState } from "../server/session.ts";
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
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f3f6fc" },
    { media: "(prefers-color-scheme: dark)", color: "#0b1220" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const access = await accessState();

  return (
    <html lang="en">
      <body>
        {children}
        {/* Navigation only appears once the vault is open; there is nothing to navigate to before. */}
        {access.kind === "ready" ? <BottomNav /> : null}
      </body>
    </html>
  );
}
