import { redirect } from "next/navigation";

import { SUPPORTED_CURRENCIES } from "../../core/domain/money.ts";
import { accessState } from "../../server/session.ts";
import { SetupView } from "./setup-view.tsx";

export const dynamic = "force-dynamic";

/**
 * First launch: only reachable while no vault exists (buildspec.md §19.A step 1). See
 * `setup-view.tsx` for what the owner is told before the first write.
 */
export default async function SetupPage() {
  const access = await accessState();
  if (access.kind !== "needs-setup") redirect(access.kind === "locked" ? "/unlock" : "/");

  const zones = ["Asia/Colombo", "Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Europe/London", "America/New_York", "UTC"];

  return <SetupView currencies={SUPPORTED_CURRENCIES.map((c) => c.code)} zones={zones} defaultZone="Asia/Colombo" defaultCurrency="LKR" />;
}
