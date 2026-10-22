/**
 * Which Apple look a screen gets: macOS on desktops and tablets, iOS on phones.
 *
 * The two media queries are the apple-ui-ux skill's adaptive switch, copied exactly: together they
 * cover every screen once. 744 px is iOS's regular-width threshold, and a phone held sideways
 * (touch, under 500 px tall) still gets the iOS look.
 *
 * Plain constants in a plain module, so both the server layout and the client hook can read them —
 * a value exported from a `"use client"` file reaches the server only as a reference.
 */

export const PHONE_QUERY = "(max-width: 743.98px), (pointer: coarse) and (max-height: 500px)";
export const DESKTOP_QUERY = "(min-width: 744px) and (pointer: fine), (min-width: 744px) and (min-height: 500.02px)";

/** Remembers the last look this browser used, so the server renders the right one first time. */
export const LOOK_COOKIE = "pfa-look";

/**
 * The server's best guess before any JavaScript runs: the cookie if this browser has been here
 * before, otherwise the user agent. A wrong guess costs one re-render after hydration, never a
 * wrong look that sticks.
 */
export function guessPhone(cookie: string | undefined, userAgent: string | null): boolean {
  if (cookie === "phone") return true;
  if (cookie === "desktop") return false;
  return /Mobi|iPhone|iPod/i.test(userAgent ?? "");
}
