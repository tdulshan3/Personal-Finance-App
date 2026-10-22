import { redirect } from "next/navigation";

import { accessState } from "../../server/session.ts";
import { UnlockView } from "./unlock-view.tsx";

export const dynamic = "force-dynamic";

/** The passphrase screen, for a locked vault or a browser without a session. See `unlock-view.tsx`. */
export default async function UnlockPage() {
  const access = await accessState();
  if (access.kind === "needs-setup") redirect("/setup");
  if (access.kind === "ready") redirect("/");

  return <UnlockView needsSessionOnly={access.kind === "needs-session"} />;
}
