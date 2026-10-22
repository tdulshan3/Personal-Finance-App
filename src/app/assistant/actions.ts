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

/*
 * The access check runs before each `try`: `redirect` works by throwing, and a catch would show the
 * owner "NEXT_REDIRECT" instead of sending them to the unlock screen.
 */
export async function sendMessageAction(_prev: ChatState, formData: FormData): Promise<ChatState> {
  const { agent: a } = await agent();
  try {
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
  const { db, agent: a } = await agent();
  try {
    const proposalId = String(formData.get("proposalId") ?? "");
    const endpoint = readAgentEndpoint(db);
    const result = a.proposals.approveAndExecute({
      proposalId,
      shownHash: String(formData.get("hash") ?? ""),
      currentModel: endpoint ? { endpoint: endpoint.baseUrl, model: endpoint.model, digest: endpoint.digest } : null,
    });
    const sessionId = String(formData.get("sessionId") ?? "");
    if (sessionId && result.resultText) a.note(sessionId, `Confirmed by you. ${result.resultText}`);
    for (const path of ["/assistant", "/", "/transactions", "/accounts", "/activity", "/bills", "/plan"]) revalidatePath(path);
    return { nonce: Date.now() };
  } catch (error) {
    revalidatePath("/assistant");
    return { error: describe(error), nonce: Date.now() };
  }
}

export async function cancelProposalAction(_prev: ChatState, formData: FormData): Promise<ChatState> {
  const { agent: a } = await agent();
  try {
    a.proposals.cancel(String(formData.get("proposalId") ?? ""));
    revalidatePath("/assistant");
    return { nonce: Date.now() };
  } catch (error) {
    return { error: describe(error), nonce: Date.now() };
  }
}

export async function newChatAction(): Promise<ChatState> {
  const { agent: a } = await agent();
  a.newSession();
  revalidatePath("/assistant");
  return { nonce: Date.now() };
}

/** Applies at once, the way a setting does; the screens have no separate Save. */
export async function setPermissionsAction(_prev: ChatState, formData: FormData): Promise<ChatState> {
  const { db } = await agent();
  try {
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
    return { nonce: Date.now() };
  } catch (error) {
    return { error: describe(error), nonce: Date.now() };
  }
}
