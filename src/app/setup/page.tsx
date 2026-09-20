import { redirect } from "next/navigation";

import { SUPPORTED_CURRENCIES } from "../../core/domain/money.ts";
import { accessState } from "../../server/session.ts";
import { SetupForm } from "./setup-form.tsx";

export const dynamic = "force-dynamic";

/**
 * First launch.
 *
 * buildspec.md §19.A step 1: "Choose theme, currency/timezone, privacy mode, and app lock." The
 * passphrase chosen here is both the app lock and the database key (ADR 0003), which is why the
 * copy is explicit that losing it means losing the data.
 */
export default async function SetupPage() {
  const access = await accessState();
  if (access.kind !== "needs-setup") redirect(access.kind === "locked" ? "/unlock" : "/");

  const zones = [
    "Asia/Colombo",
    "Asia/Kolkata",
    "Asia/Dubai",
    "Asia/Singapore",
    "Europe/London",
    "America/New_York",
    "UTC",
  ];

  return (
    <SetupForm
      currencies={SUPPORTED_CURRENCIES.map((c) => c.code)}
      zones={zones}
      defaultZone="Asia/Colombo"
      defaultCurrency="LKR"
    />
  );
}
