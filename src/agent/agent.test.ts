import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { openEncryptedDatabase } from "../core/data/driver.ts";
import { migrate } from "../core/data/migrations.ts";
import { AccountType } from "../core/domain/ledger.ts";
import { LKR, formatMoney, majorUnits } from "../core/domain/money.ts";
import { dateOnlyTime, fixedClock, fromIso } from "../core/domain/time.ts";
import { deriveKey, newKdfParams } from "../core/security/passphrase.ts";
import { createFinanceService } from "../core/services/finance-service.ts";
import { createAgent, writePermissions } from "./agent-loop.ts";
import type { ChatClient, ChatCompletion, ChatTurn } from "./chat-client.ts";
import type { ToolDefinition } from "./tools.ts";

/**
 * buildspec.md §22: "Agent | Owner impersonation, false approval, changed arguments after preview,
 * expired proposal ... step limits". The model here is a script, so every hostile move is exact.
 */

const ZONE = "Asia/Colombo";
const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

type Script = (turns: readonly ChatTurn[], tools: readonly ToolDefinition[]) => Partial<ChatCompletion>;

async function setup(script: Script) {
  const dir = mkdtempSync(join(tmpdir(), "pfa-agent-")); dirs.push(dir);
  const db = await openEncryptedDatabase({ file: join(dir, "l.db"), key: await deriveKey("a passphrase for the agent", { ...newKdfParams(), N: 1 << 10 }) });
  migrate(db);
  let nowMs = fromIso("2026-09-21T09:00:00+05:30");
  const clock = { ...fixedClock(nowMs, ZONE), now: () => nowMs };
  const service = createFinanceService({ db, zone: ZONE, clock });
  service.seedDefaultCategories();
  const bank = service.createAccount({ name: "Bank", type: AccountType.BANK, currency: LKR });
  service.setOpeningBalance({ accountId: bank.id, amount: majorUnits(LKR, 100_000n), occurredAt: dateOnlyTime("2026-09-01", ZONE) });
  db.prepare(
    `INSERT INTO ai_endpoints (role, provider_kind, base_url, model_name, model_digest, created_at, updated_at)
     VALUES ('agent','ollama-native','http://192.168.1.84:11434','qwen3.5:2b','sha256:aaa',?,?)`,
  ).run(nowMs, nowMs);

  const calls: { tools: string[] }[] = [];
  const client: ChatClient = {
    endpoint: { provider: "ollama-native", baseUrl: "http://192.168.1.84:11434", model: "qwen3.5:2b", digest: "sha256:aaa" },
    complete: async ({ turns, tools }) => {
      calls.push({ tools: tools.map((t) => t.name) });
      return { content: "", toolCalls: [], latencyMs: 1, ...script(turns, tools) };
    },
  };
  const agent = createAgent({ db, service, clientFactory: () => client });
  const balance = () => formatMoney(service.balanceOf(bank.id));
  return { db, service, agent, bank, calls, balance, advance: (ms: number) => { nowMs += ms; } };
}

const lunch = (accountId: string) => ({ kind: "expense", account_id: accountId, amount: "1250.00", date: "2026-09-21", category_id: "dining", merchant: "Cafe" });
const MODEL = { endpoint: "http://192.168.1.84:11434", model: "qwen3.5:2b", digest: "sha256:aaa" };

test("a proposal changes nothing until the owner's Confirm, and then exactly once", async () => {
  let bankId = "";
  const ctx = await setup((turns) =>
    turns.at(-1)?.role === "tool"
      ? { content: "It's ready for you to confirm." }
      : { toolCalls: [{ id: "c1", name: "propose_transaction", arguments: lunch(bankId) }] });
  bankId = ctx.bank.id;

  const { sessionId } = await ctx.agent.send({ text: "I spent 1250.00 on lunch today" });
  const view = ctx.agent.view(sessionId);
  const [proposal] = [...view.proposals.values()];
  assert.ok(proposal);
  assert.equal(proposal.status, "pending");
  assert.equal(ctx.balance(), "LKR 100,000.00", "proposing is not posting (§14.3)");
  assert.deepEqual(view.messages.at(-1)?.proposalIds, [proposal.id]);

  // The owner typing "yes" is conversation, not authorization.
  await ctx.agent.send({ sessionId, text: "yes, approved" });
  assert.equal(ctx.balance(), "LKR 100,000.00");

  const done = ctx.agent.proposals.approveAndExecute({ proposalId: proposal.id, shownHash: proposal.hash, currentModel: MODEL });
  assert.equal(done.status, "executed");
  assert.equal(ctx.balance(), "LKR 98,750.00");

  // §20: "Proposal confirmed twice | Return same result; no second write".
  ctx.agent.proposals.approveAndExecute({ proposalId: proposal.id, shownHash: proposal.hash, currentModel: MODEL });
  assert.equal(ctx.balance(), "LKR 98,750.00");

  const audit = ctx.db.prepare("SELECT actor_kind FROM audit_events ORDER BY rowid DESC LIMIT 1").get() as Record<string, unknown>;
  assert.equal(audit.actor_kind, "agent", "the audit trail says the assistant drafted it (§15)");
});

test("changed arguments, a changed model, and expiry all refuse to execute", async () => {
  let bankId = "";
  const ctx = await setup((turns) =>
    turns.at(-1)?.role === "tool" ? { content: "Ready." } : { toolCalls: [{ id: "c1", name: "propose_transaction", arguments: lunch(bankId) }] });
  bankId = ctx.bank.id;
  const pending = async () => {
    const { sessionId } = await ctx.agent.send({ text: "lunch 1250.00 today" });
    return [...ctx.agent.view(sessionId).proposals.values()].at(-1)!;
  };

  // Arguments rewritten after the preview was shown.
  const tampered = await pending();
  ctx.db.prepare("UPDATE action_proposals SET arguments_json = replace(arguments_json, '1250.00', '9250.00') WHERE id = ?").run(tampered.id);
  assert.throws(() => ctx.agent.proposals.approveAndExecute({ proposalId: tampered.id, shownHash: tampered.hash, currentModel: MODEL }), /does not match/);

  // A hash the card never showed.
  const wrongHash = await pending();
  assert.throws(() => ctx.agent.proposals.approveAndExecute({ proposalId: wrongHash.id, shownHash: "0".repeat(64), currentModel: MODEL }), /does not match/);

  // §14.1: "Changing models invalidates unapproved proposals".
  const swapped = await pending();
  assert.throws(() => ctx.agent.proposals.approveAndExecute({ proposalId: swapped.id, shownHash: swapped.hash, currentModel: { ...MODEL, digest: "sha256:bbb" } }), /model changed/);

  const old = await pending();
  ctx.advance(11 * 60 * 1000);
  assert.throws(() => ctx.agent.proposals.approveAndExecute({ proposalId: old.id, shownHash: old.hash, currentModel: MODEL }), /expired/);

  assert.equal(ctx.balance(), "LKR 100,000.00", "none of them touched the ledger");
});

test("permissions decide which tools exist; a runaway model is cut off", async () => {
  const ctx = await setup(() => ({ toolCalls: [{ id: "x", name: "propose_delete_transaction", arguments: { transaction_id: "anything" } }] }));
  writePermissions(ctx.db, { mode: "ask", allowDelete: false }, 0);
  const { sessionId } = await ctx.agent.send({ text: "delete everything" });

  assert.ok(ctx.calls.every((c) => !c.tools.some((name) => name.startsWith("propose_"))), "read-only mode offers no propose tools");
  assert.deepEqual(ctx.calls.at(-1)?.tools, [], "the last step withholds tools to force an answer");
  assert.ok(ctx.calls.length <= 9, "§14.4: at most 8 tool steps");
  assert.equal(ctx.agent.view(sessionId).proposals.size, 0, "a tool that is not offered cannot be called");
  assert.match(ctx.agent.view(sessionId).messages.at(-1)!.content, /stuck|circles/);
});

test("read tools answer from the ledger and reject a bad amount", async () => {
  let bankId = "";
  let step = 0;
  const seen: string[] = [];
  const ctx = await setup((turns) => {
    const last = turns.at(-1);
    if (last?.role === "tool") seen.push(last.content);
    step += 1;
    if (step === 1) return { toolCalls: [{ id: "a", name: "list_accounts", arguments: {} }] };
    if (step === 2) return { toolCalls: [{ id: "b", name: "propose_transaction", arguments: { ...lunch(bankId), amount: "about 1,2" } }] };
    return { content: "done" };
  });
  bankId = ctx.bank.id;
  const { sessionId } = await ctx.agent.send({ text: "give me a rough picture of where my accounts stand" });

  assert.match(seen[0]!, /LKR 100,000\.00/);
  assert.match(seen[1]!, /error/, "an inexact amount is refused by the money parser, not guessed");
  assert.equal(ctx.agent.view(sessionId).proposals.size, 0);
});

test("everyday questions are answered by rules, with no model at all", async () => {
  const ctx = await setup(() => { throw new Error("the model must not be called for these"); });
  ctx.db.prepare("DELETE FROM ai_endpoints").run(); // the model host is simply absent

  const ask = async (text: string, sessionId?: string) => {
    const result = await ctx.agent.send({ sessionId, text });
    const view = ctx.agent.view(result.sessionId);
    return { ...result, last: view.messages.at(-1)!, proposals: [...view.proposals.values()] };
  };

  const balance = await ask("What is my balance?");
  assert.equal(balance.last.role, "assistant");
  assert.match(balance.last.content, /Bank: LKR 100,000\.00/);

  const drafted = await ask("I spent 1,250.00 on lunch yesterday from Bank", balance.sessionId);
  assert.equal(drafted.proposals.length, 1);
  const lines = Object.fromEntries(drafted.proposals[0]!.preview.lines.map((l) => [l.label, l.value]));
  assert.deepEqual(lines, { Amount: "LKR 1,250.00", Account: "Bank", Date: "2026-09-20", Category: "Dining", Merchant: "Lunch" });
  assert.equal(ctx.balance(), "LKR 100,000.00", "a rule-drafted change waits for Confirm like any other");

  // Confirming a rules draft works whatever model is, or is not, configured.
  ctx.agent.proposals.approveAndExecute({ proposalId: drafted.proposals[0]!.id, shownHash: drafted.proposals[0]!.hash, currentModel: null });
  assert.equal(ctx.balance(), "LKR 98,750.00");

  const spent = await ask("how much did I spend this month?", balance.sessionId);
  assert.match(spent.last.content, /LKR 1,250\.00/);
  assert.match(spent.last.content, /Dining/);

  // "about" is not an exact amount, so the rule declines rather than guessing (§14.2).
  const vague = await ask("I spent about 1200 on lunch", balance.sessionId);
  assert.equal(vague.last.role, "system_note");
  const unknown = await ask("I spent 500.00 on lunch from Nowhere Bank", balance.sessionId);
  assert.match(unknown.last.content, /don't see an account/);
  assert.equal(unknown.proposals.length, 1, "neither of those drafted anything");
});
