import Link from "next/link";
import { redirect } from "next/navigation";

import { createAgent, readAgentEndpoint, readPermissions } from "../../agent/agent-loop.ts";
import { requireDb, requireService } from "../../server/runtime.ts";
import { accessState } from "../../server/session.ts";
import { Button } from "../../ui/form.tsx";
import { Badge, Card, InfoNote, PageHeader, Shell } from "../../ui/primitives.tsx";
import { newChatAction, setPermissionsAction } from "./actions.ts";
import type { ChatMessageData, ProposalData } from "./chat.tsx";
import { Chat } from "./chat.tsx";

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
      id, hash: p.hash, status: p.status, title: p.preview.title, lines: p.preview.lines,
      effects: p.preview.effects, risk: p.preview.risk, expiresAt: p.expiresAt, resultText: p.resultText ?? null,
    };
  }

  const firstAccount = service.listAccounts().find((a) => a.isUserVisible);
  const suggestions = [
    "How much did I spend this month?",
    "What are my balances?",
    "Show my last 5 transactions",
    ...(firstAccount && permissions.mode === "assist" ? [`I spent 1250.00 on lunch today from ${firstAccount.name}`] : []),
    "Anything waiting for review?",
  ];

  const host = endpoint ? new URL(endpoint.baseUrl).hostname : null;

  return (
    <Shell>
      <PageHeader
        title="Assistant"
        subtitle={endpoint ? `${endpoint.model} · ${host}` : "Built-in answers only · no model chosen"}
        action={
          <form action={newChatAction}>
            <Button type="submit" variant="ghost">New chat</Button>
          </form>
        }
      />

      {!endpoint ? (
        <InfoNote>
          Balances, spending, recent transactions and &ldquo;I spent 1250.00 on lunch&rdquo; work right now, with no
          model. For freer questions, choose a tool-capable model in{" "}
          <Link href="/settings">Settings → Assistant model</Link>.
        </InfoNote>
      ) : null}

      <Card>
        <details>
          <summary style={{ cursor: "pointer", display: "flex", gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap", minHeight: "32px" }}>
            <span style={{ fontWeight: 600 }}>Permissions</span>
            <Badge tone={permissions.mode === "assist" ? "primary" : "neutral"}>
              {permissions.mode === "assist" ? "Can draft changes" : "Read-only"}
            </Badge>
            {permissions.allowDelete ? <Badge tone="warning">May draft deletions</Badge> : null}
          </summary>
          <form action={setPermissionsAction} style={{ display: "grid", gap: "var(--space-3)", marginTop: "var(--space-4)" }}>
            <input type="hidden" name="allowDeletePresent" value="1" />
            <label style={{ display: "flex", gap: "var(--space-3)", alignItems: "flex-start" }}>
              <input type="radio" name="mode" value="ask" defaultChecked={permissions.mode === "ask"} style={{ marginTop: "4px" }} />
              <span><strong>Ask</strong> — answers questions only. It cannot draft anything.</span>
            </label>
            <label style={{ display: "flex", gap: "var(--space-3)", alignItems: "flex-start" }}>
              <input type="radio" name="mode" value="assist" defaultChecked={permissions.mode === "assist"} style={{ marginTop: "4px" }} />
              <span><strong>Assist</strong> — may also draft transactions and transfers. Each one waits for your Confirm.</span>
            </label>
            <label style={{ display: "flex", gap: "var(--space-3)", alignItems: "flex-start" }}>
              <input type="checkbox" name="allowDelete" defaultChecked={permissions.allowDelete} style={{ marginTop: "4px" }} />
              <span>Let it draft moving a transaction to Trash. Still needs your Confirm, and Trash can be undone.</span>
            </label>
            <p style={{ fontSize: "var(--font-sm)", color: "var(--text-secondary)", margin: 0 }}>
              It can never confirm its own drafts, change settings, send anything, or read your raw messages.
            </p>
            <div><Button type="submit" variant="secondary">Save permissions</Button></div>
          </form>
        </details>
      </Card>

      <Chat
        sessionId={sessionId}
        messages={messages}
        proposals={proposals}
        suggestions={suggestions}
        now={Date.now()}
      />
    </Shell>
  );
}
