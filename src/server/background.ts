import type { Db } from "../core/data/driver.ts";
import { systemClock } from "../core/domain/time.ts";
import type { MessageProcessor, ProcessReport } from "../ingestion/processing.ts";
import { createMessageProcessor } from "../ingestion/processing.ts";

/**
 * In-process background work, alive only while the vault is unlocked.
 *
 * ADR 0003 made the trade explicit: no key, no processing. So this starts on unlock and stops on
 * lock. While it runs it does what buildspec.md §19.F asks for — messages the model could not take
 * (host unreachable, phone off the LAN) wait as `needs_model` and are retried every minute, so the
 * backlog drains by itself when the host comes back. The rules path never waits for anything.
 */

type State = {
  timer: ReturnType<typeof setInterval> | null;
  running: boolean;
  processor: MessageProcessor | null;
  lastReport: (ProcessReport & { at: number }) | null;
};

const KEY = Symbol.for("pfa.background.state");
type GlobalWithState = typeof globalThis & { [KEY]?: State };
const globalRef = globalThis as GlobalWithState;

function state(): State {
  globalRef[KEY] ??= { timer: null, running: false, processor: null, lastReport: null };
  return globalRef[KEY];
}

async function tick(): Promise<void> {
  const s = state();
  if (!s.processor || s.running) return;
  s.running = true;
  try {
    const report = await s.processor.processPending({ limit: 25 });
    if (report.considered > 0) s.lastReport = { ...report, at: Date.now() };
  } catch {
    // A failed pass must never take the server down; the next tick tries again.
  } finally {
    s.running = false;
  }
}

export function startBackground(input: { db: Db; zone: string }): void {
  stopBackground();
  const s = state();
  s.processor = createMessageProcessor({
    db: input.db,
    clock: systemClock(() => input.zone),
    zone: input.zone,
  });
  s.timer = setInterval(() => void tick(), 60_000);
  // Do not hold the process open for the timer alone.
  s.timer.unref?.();
  // Catch up straight away: this is the "fill the gap on unlock" moment.
  setTimeout(() => void tick(), 1_500).unref?.();
}

export function stopBackground(): void {
  const s = state();
  if (s.timer) clearInterval(s.timer);
  s.timer = null;
  s.processor = null;
}

/** Called after a delivery so a new message is parsed within moments, not within a minute. */
export function kickProcessing(): void {
  void tick();
}

export function backgroundStatus() {
  const s = state();
  return { active: s.processor !== null, running: s.running, lastReport: s.lastReport };
}

export function currentProcessor(): MessageProcessor | null {
  return state().processor;
}
