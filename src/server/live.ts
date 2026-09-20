import { randomUUID } from "node:crypto";

import { isUnlocked, requireDb } from "./runtime.ts";

/**
 * Live change notifications, for every screen that is open.
 *
 * The question a browser needs answered is only "has anything changed since I last looked?". SQLite
 * already keeps that answer: `total_changes()` counts every row this connection has inserted,
 * updated or deleted. The process holds exactly one connection (see `runtime.ts`), so that single
 * integer covers *every* write path — the manual forms, a message arriving from the phone, the
 * background reader, an accepted review, a confirmed assistant proposal — without any of them
 * having to remember to announce itself. A write path added next year is covered on the day it is
 * written. Reading the counter touches no disk.
 *
 * What goes over the wire is a version number and nothing else: no amounts, no names, no text
 * (buildspec.md §18, data minimisation). The browser responds by re-requesting the page it is on,
 * through the same session-checked route as any other page load.
 */

export type LiveEvent =
  | { readonly type: "change"; readonly boot: string; readonly version: number }
  | { readonly type: "locked"; readonly boot: string; readonly version: number };

type Listener = (event: LiveEvent) => void;

type Hub = {
  /** Distinguishes this process from the one before a restart, whose versions mean nothing now. */
  readonly boot: string;
  readonly listeners: Set<Listener>;
  timer: ReturnType<typeof setInterval> | null;
  lastChanges: number | null;
  version: number;
  wasUnlocked: boolean;
};

const POLL_MS = 1_000;

// Parked on globalThis for the same reason as the runtime state: one hub per process, even if the
// module is evaluated more than once.
const HUB_KEY = Symbol.for("pfa.live.hub");
type GlobalWithHub = typeof globalThis & { [HUB_KEY]?: Hub };
const hub: Hub = ((globalThis as GlobalWithHub)[HUB_KEY] ??= {
  boot: randomUUID().slice(0, 8),
  listeners: new Set(),
  timer: null,
  lastChanges: null,
  version: 0,
  wasUnlocked: false,
});

function emit(type: LiveEvent["type"]): void {
  const event: LiveEvent = { type, boot: hub.boot, version: hub.version };
  for (const listener of [...hub.listeners]) {
    try {
      listener(event);
    } catch {
      // A broken stream must not stop the others from hearing about the change.
      hub.listeners.delete(listener);
    }
  }
}

function tick(): void {
  if (!isUnlocked()) {
    hub.lastChanges = null;
    if (hub.wasUnlocked) {
      hub.wasUnlocked = false;
      emit("locked");
    }
    return;
  }

  let changes: number;
  try {
    const row = requireDb().prepare("SELECT total_changes() AS n").get() as Record<string, unknown>;
    changes = Number(row.n);
  } catch {
    // Locked between the check and the read. The next tick reports it.
    return;
  }

  hub.wasUnlocked = true;
  // A fresh connection after an unlock starts its count again, so the first reading only anchors.
  if (hub.lastChanges !== null && changes !== hub.lastChanges) {
    hub.version += 1;
    emit("change");
  }
  hub.lastChanges = changes;
}

/**
 * Starts polling with the first listener and stops with the last, so an idle server does nothing.
 *
 * The last reading is deliberately *kept* while idle. A phone whose tab was in the background has
 * no stream open; when it returns, the first tick compares against that old reading, sees whatever
 * was written in between, and bumps the version before the newcomer is told what version it is on.
 */
export function subscribe(listener: Listener): () => void {
  hub.listeners.add(listener);
  if (hub.timer === null) {
    tick();
    hub.timer = setInterval(tick, POLL_MS);
    // Never the reason the process stays alive.
    hub.timer.unref?.();
  }
  return () => {
    hub.listeners.delete(listener);
    if (hub.listeners.size === 0 && hub.timer !== null) {
      clearInterval(hub.timer);
      hub.timer = null;
    }
  };
}

export function liveSnapshot(): { boot: string; version: number; listeners: number } {
  return { boot: hub.boot, version: hub.version, listeners: hub.listeners.size };
}
