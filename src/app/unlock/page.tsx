import { redirect } from "next/navigation";

import { accessState } from "../../server/session.ts";
import { UnlockForm } from "./unlock-form.tsx";

export const dynamic = "force-dynamic";

/**
 * buildspec.md §18 strict lock mode: the key is only in memory, so a restart means a fresh unlock.
 * The copy says plainly that background capture is paused while locked rather than implying the
 * app keeps working (§18: do not "promise both mandatory biometric authentication for every key
 * use and fully unattended processing").
 */
export default async function UnlockPage() {
  const access = await accessState();
  if (access.kind === "needs-setup") redirect("/setup");
  if (access.kind === "ready") redirect("/");

  return <UnlockForm needsSessionOnly={access.kind === "needs-session"} />;
}
