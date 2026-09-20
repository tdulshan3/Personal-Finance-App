import { cookies } from "next/headers";

import { isInitialised, isUnlocked, sessionMatches, sessionTokenHex } from "./runtime.ts";

/**
 * Browser session binding.
 *
 * The server holds the database key; this cookie only proves that *this browser* is the one that
 * performed the unlock. buildspec.md §16: "Owner identity and capabilities come from trusted
 * session context, never from model-supplied `owner_id`, `role`, or `confirmed:true`."
 *
 * The cookie carries an opaque random token, never the passphrase or any key material, and it is
 * regenerated on every unlock so a token captured before a lock cannot be replayed after one.
 */

const COOKIE_NAME = "pfa_session";

export async function startSession(): Promise<void> {
  const store = await cookies();
  store.set(COOKIE_NAME, sessionTokenHex(), {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    // The server may be reached over plain HTTP on the LAN, so `secure` would drop the cookie
    // entirely. ADR 0001 records that exposing this beyond loopback needs TLS first.
    secure: process.env.PFA_REQUIRE_HTTPS === "true",
    maxAge: 60 * 60 * 12,
  });
}

export async function endSession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

export type AccessState =
  | { readonly kind: "needs-setup" }
  | { readonly kind: "locked" }
  | { readonly kind: "needs-session" }
  | { readonly kind: "ready" };

/** What the current request is allowed to see. Pages branch on this before reading any data. */
export async function accessState(): Promise<AccessState> {
  if (!isInitialised()) return { kind: "needs-setup" };
  if (!isUnlocked()) return { kind: "locked" };
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  return sessionMatches(token) ? { kind: "ready" } : { kind: "needs-session" };
}
