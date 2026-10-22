"use client";

import { createContext, useContext, useEffect, useSyncExternalStore } from "react";
import type { ReactNode } from "react";

import { LOOK_COOKIE, PHONE_QUERY } from "./look-shared.ts";

/**
 * One state, two views: every screen asks `usePhone()` and renders its iOS or its macOS view from
 * the same data (the apple-ui-ux adaptive guide). The answer follows the window live, so dragging a
 * desktop window narrower than 744 px switches it to the phone look and back.
 */

const ServerGuess = createContext(false);

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

const readNow = () => window.matchMedia(PHONE_QUERY).matches;

export function usePhone(): boolean {
  const guess = useContext(ServerGuess);
  return useSyncExternalStore(subscribe, readNow, () => guess);
}

export function LookProvider({ phone, children }: { phone: boolean; children: ReactNode }) {
  return (
    <ServerGuess.Provider value={phone}>
      <RememberLook />
      {children}
    </ServerGuess.Provider>
  );
}

/** Writes the look back to a cookie, so the next server render needs no guess. */
function RememberLook() {
  const phone = usePhone();
  useEffect(() => {
    document.cookie = `${LOOK_COOKIE}=${phone ? "phone" : "desktop"}; path=/; max-age=31536000; samesite=strict`;
  }, [phone]);
  return null;
}
