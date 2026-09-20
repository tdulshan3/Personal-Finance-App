/**
 * Connection state of the live-update stream, shared between the component that owns the
 * connection (`LiveSync`) and the ones that only display it. A module-level store read through
 * `useSyncExternalStore` keeps that to a dozen lines with no context provider.
 */

export type LiveState = "off" | "connecting" | "live" | "offline";

let state: LiveState = "off";
const listeners = new Set<() => void>();

export const liveStore = {
  get: (): LiveState => state,
  /** What the server renders: there is no connection during SSR. */
  getServer: (): LiveState => "off",
  set(next: LiveState): void {
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
