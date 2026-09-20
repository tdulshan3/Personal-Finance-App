import { stopTurn } from "../../../../agent/agent-loop.ts";
import { accessState } from "../../../../server/session.ts";

export const dynamic = "force-dynamic";

/**
 * Stop the assistant mid-turn (buildspec.md §14.4: "Stop cancels model generation and queued tool
 * calls").
 *
 * This is a route rather than a server action on purpose: Next.js runs one server action at a time
 * per browser, so a Stop *action* would wait in line behind the very request it is meant to cancel.
 * It sits behind the same session cookie as everything else (SameSite=Strict, so another site
 * cannot trigger it), and the worst it can do is end a reply early.
 */
export async function POST(request: Request): Promise<Response> {
  const access = await accessState();
  if (access.kind !== "ready") return Response.json({ stopped: false }, { status: 401 });

  let sessionId = "";
  try {
    const body = (await request.json()) as { sessionId?: unknown };
    if (typeof body.sessionId === "string") sessionId = body.sessionId.slice(0, 64);
  } catch {
    // An unreadable body just means there is nothing to stop.
  }
  return Response.json({ stopped: sessionId ? stopTurn(sessionId) : false });
}
