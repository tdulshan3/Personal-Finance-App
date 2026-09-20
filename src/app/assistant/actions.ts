"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createAgent, readAgentEndpoint, readPermissions, writePermissions } from "../../agent/agent-loop.ts";
import { isFinanceError } from "../../core/domain/errors.ts";
import { requireDb, requireService } from "../../server/runtime.ts";
import { accessState } from "../../server/session.ts";

export type ChatState = { readonly error?: string | undefined; readonly nonce?: number | undefined };

/** Every action re-checks the session: the cookie is the owner, nothing in the form is. */
async function agent() {
  const access = await accessState();
  if (access.kind !== "ready") redirect(access.kind === "needs-setup" ? "/setup" : "/unlock");
  const db = requireDb();
  return { db, agent: createAgent({ db, service: requireService() }) };
}

const describe = (error: unknown) =>
  isFinanceError(error) ? error.message : error instanceof Error ? error.message : "Something went wrong.";

export async function sendMessageAction(_prev: ChatState, formData: FormData): Promise<ChatState> {
  try {
    const { agent: a } = await agent();
    const text = String(formData.get("text") ?? "").trim() || String(formData.get("suggestion") ?? "").trim();
    if (!text) return { nonce: Date.now() };
    await a.send({ sessionId: String(formData.get("sessionId") ?? "") || undefined, text });
    revalidatePath("/assistant");
    return { nonce: Date.now() };
  } catch (error) {
    return { error: describe(error), nonce: Date.now() };
  }
}

/**
 * The owner pressed Confirm on a card.
 *
 * buildspec.md §14.3: this, and only this, is authorization. It is reached by a button in the
 * trusted UI behind the session cookie. The model has no tool that leads here, and nothing typed
 * into the chat — by the owner or by the model — is treated as approval.
 */
export async function confirmProposalAction(_prev: ChatState, formData: FormData): Promise<ChatState> {
  try {
    const { db, agent: a } = await agent();
    const proposalId = String(formData.get("proposalId") ?? "");
    const endpoint = readAgentEndpoint(db);
    const result = a.proposals.approveAndExecute({
      proposalId,
      shownHash: String(formData.get("hash") ?? ""),
      currentModel: endpoint ? { endpoint: endpoint.baseUrl, model: endpoint.model, digest: endpoint.digest } : null,
    });
    const sessionId = String(formData.get("sessionId") ?? "");
    if (sessionId && result.resultText) a.note(sessionId, `Confirmed by you. ${result.resultText}`);
    for (const path of ["/assistant", "/", "/transactions", "/accounts", "/activity"]) revalidatePath(path);
    return { nonce: Date.now() };
  } catch (error) {
    revalidatePath("/assistant");
    return { error: describe(error), nonce: Date.now() };
  }
}

export async function cancelProposalAction(formData: FormData): Promise<void> {
  const { agent: a } = await agent();
  a.proposals.cancel(String(formData.get("proposalId") ?? ""));
  revalidatePath("/assistant");
}

export async function newChatAction(): Promise<void> {
  const { agent: a } = await agent();
  a.newSession();
  revalidatePath("/assistant");
}

export async function setPermissionsAction(formData: FormData): Promise<void> {
  const { db } = await agent();
  const current = readPermissions(db);
  const mode = formData.get("mode");
  writePermissions(
    db,
    {
      mode: mode === "ask" || mode === "assist" ? mode : current.mode,
      allowDelete: formData.has("allowDeletePresent") ? formData.get("allowDelete") === "on" : current.allowDelete,
    },
    Date.now(),
  );
  revalidatePath("/assistant");
}
