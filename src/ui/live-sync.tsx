"use client";

import { useRouter } from "next/navigation";
import { startTransition, useEffect, useState, useSyncExternalStore } from "react";

import { liveStore } from "./live-store.ts";

/**
 * Keeps whatever screen is open in step with the ledger.
 *
 * It listens to `/api/events` and, when the server says something changed, asks Next.js to
 * re-render the current route on the server (`router.refresh()`). That swaps in fresh data without
 * a page load, and React keeps client state — a half-typed form, an open disclosure, scroll
 * position — exactly where it was. A message arriving on the phone, or a transaction recorded on
 * another device, shows up here about a second later.
 *
 * Three manners it keeps:
 *   - it never refreshes mid-keystroke; it waits for a pause in typing;
 *   - it holds no connection while the tab is hidden (browsers allow six per origin, and a phone
 *     should not keep a radio awake for a screen nobody is looking at), and catches up on return;
 *   - when the stream is refused (locked, or the session ended) it does one ordinary refresh, which
 *     lands on the unlock screen, and then stops.
 */

const TYPING_PAUSE_MS = 1_500;

export function LiveSync() {
  const router = useRouter();

  useEffect(() => {
    let source: EventSource | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let lastKeyAt = 0;
    let seen: { boot: string; version: number } | null = null;
    let gaveUp = false;

    const refreshSoon = (delay = 250) => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        const sinceKey = Date.now() - lastKeyAt;
        if (sinceKey < TYPING_PAUSE_MS) {
          refreshSoon(TYPING_PAUSE_MS - sinceKey);
          return;
        }
        startTransition(() => router.refresh());
      }, delay);
    };

    const note = (raw: string): boolean => {
      try {
        const next = JSON.parse(raw) as { boot: string; version: number };
        const changed = seen !== null && (seen.boot !== next.boot || seen.version !== next.version);
        seen = next;
        return changed;
      } catch {
        return true;
      }
    };

    const disconnect = () => {
      source?.close();
      source = null;
    };

    const connect = () => {
      if (source || gaveUp || document.visibilityState !== "visible") return;
      liveStore.set("connecting");
      const stream = new EventSource("/api/events");
      source = stream;

      // `hello` reports the version on connect: if it moved while this tab was away, catch up.
      stream.addEventListener("hello", (event) => {
        liveStore.set("live");
        if (note((event as MessageEvent<string>).data)) refreshSoon(0);
      });
      stream.addEventListener("change", (event) => {
        note((event as MessageEvent<string>).data);
        refreshSoon();
      });
      stream.addEventListener("locked", () => {
        gaveUp = true;
        disconnect();
        liveStore.set("offline");
        router.refresh();
      });
      stream.onerror = () => {
        if (stream.readyState === EventSource.CLOSED) {
          // Refused outright: locked, or this browser's session is over. One normal refresh lets
          // the page's own access check decide where to send the owner; retrying would not help.
          gaveUp = true;
          disconnect();
          liveStore.set("offline");
          router.refresh();
        } else {
          // Dropped; EventSource is already retrying on its own.
          liveStore.set("connecting");
        }
      };
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") connect();
      else {
        disconnect();
        liveStore.set("off");
      }
    };
    const onKey = () => {
      lastKeyAt = Date.now();
    };

    connect();
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("online", connect);

    return () => {
      clearTimeout(refreshTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("online", connect);
      disconnect();
      liveStore.set("off");
    };
  }, [router]);

  return <LiveToast />;
}

const LABELS = { live: "Live", connecting: "Connecting…", offline: "Offline", off: "Paused" } as const;

/** The sidebar's indicator. Colour is never the only cue: the word changes too. */
export function LiveStatus() {
  const state = useSyncExternalStore(liveStore.subscribe, liveStore.get, liveStore.getServer);
  return (
    <span className="live-status" data-state={state} role="status" title="Updates from your other devices and your phone's messages appear here as they happen.">
      <span className="live-dot" aria-hidden="true" />
      {LABELS[state]}
    </span>
  );
}

/** Phones have no sidebar, so there the link is silent while healthy and speaks up only when down. */
function LiveToast() {
  const state = useSyncExternalStore(liveStore.subscribe, liveStore.get, liveStore.getServer);
  const [visible, setVisible] = useState(false);

  // A reconnect that takes a second is not news; one that takes four is.
  useEffect(() => {
    if (state === "live" || state === "off") {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), 4_000);
    return () => clearTimeout(timer);
  }, [state]);

  if (!visible) return null;
  return (
    <div className="live-toast" role="status">
      <span className="live-dot" aria-hidden="true" />
      {state === "offline" ? "Not updating live" : "Reconnecting…"}
    </div>
  );
}
