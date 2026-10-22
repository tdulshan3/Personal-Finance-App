import { redirect } from "next/navigation";

import { createAgent, readAgentEndpoint, readPermissions } from "../../agent/agent-loop.ts";
import { requireDb, requireService } from "../../server/runtime.ts";
import { accessState } from "../../server/session.ts";
import type { AssistantData, ChatMessageData, ProposalData } from "./assistant-view.tsx";
import { AssistantView } from "./assistant-view.tsx";

export const dynamic = "force-dynamic";

/**
 * Assistant (buildspec.md §14).
 *
 * The conversation is the visible part. The part that matters is what the model cannot do: it has
 * read tools and `propose_*` tools, and nothing else. A proposal is a row in a table and a card on
 * this screen; the Confirm button on that card is the only path to the ledger, and it re-checks the
 * proposal's hash, expiry, targets and originating model before anything is written.
 */
export default async function AssistantPage() {
  const access = await accessState();
  if (access.kind === "needs-setup") redirect("/setup");
  if (access.kind !== "ready") redirect("/unlock");

  const db = requireDb();
  const service = requireService();
  const agent = createAgent({ db, service });
  const endpoint = readAgentEndpoint(db);
  const permissions = readPermissions(db);

  const current = agent.view(undefined);
  const sessionId = current.sessionId ?? agent.newSession();

  const messages: ChatMessageData[] = current.messages.map((m) => ({
    id: m.id,
    role: m.role as ChatMessageData["role"],
    content: m.content,
    proposalIds: m.proposalIds,
  }));
  const proposals: Record<string, ProposalData> = {};
  for (const [id, p] of current.proposals) {
    proposals[id] = {
      id,
      hash: p.hash,
      status: p.status,
      title: p.preview.title,
      lines: p.preview.lines,
      effects: p.preview.effects,
      risk: p.preview.risk,
      expiresAt: p.expiresAt,
      resultText: p.resultText ?? null,
    };
  }

  const firstAccount = service.listAccounts().find((a) => a.isUserVisible);
  const suggestions = [
    "How much did I spend this month?",
    "What are my balances?",
    "What bills are due?",
    "How much can I save this month?",
    "Show my last 5 transactions",
    ...(firstAccount && permissions.mode === "assist" ? [`I spent 1250.00 on lunch today from ${firstAccount.name}`] : []),
    "Anything waiting for review?",
  ];

  const data: AssistantData = {
    sessionId,
    messages,
    proposals,
    suggestions,
    now: Date.now(),
    endpoint: endpoint ? { model: endpoint.model, host: new URL(endpoint.baseUrl).hostname } : null,
    permissions: { mode: permissions.mode, allowDelete: permissions.allowDelete },
  };

  return <AssistantView data={data} />;
}
