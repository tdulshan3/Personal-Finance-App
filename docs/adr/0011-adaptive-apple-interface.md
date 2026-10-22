# 0011 — One app, two Apple looks: macOS on desktops, iOS on phones

**Date:** 2026-10-22
**Status:** Accepted

## Context

The ledger is used from two kinds of screen: the owner's phone, and a desktop browser on the PC. The
interface had been hand-built in the iOS idiom with its own CSS (`globals.css`, a dozen CSS modules,
home-made cards, list rows, a glass tab bar and a sidebar that appeared from 1024 px). It looked
like iOS on a phone and like a stretched iOS on a desktop, and every control was a look-alike that
had to be kept in step with Apple's kit by hand.

The owner asked for a redesign with the apple-ui-ux skill. That skill's rule for an app used on both
desktops and phones is its *adaptive* look: macOS 27 on desktops and tablets, iOS 27 on phones, with
the classic blur materials (no Liquid Glass), switching at 744 px.

## Decision

**Vendor the kit, unchanged.** `src/ui/macos/` and `src/ui/ios/` hold the skill's React components
(`macos.tsx`, `ios.tsx`) and stylesheets (`macos.css`, `ios.css`) exactly as shipped, apart from a
`// @ts-nocheck` line: they are written for looser compiler flags than this repo's
(`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), and their exported prop types still
check every caller. Nothing in the app restyles a `mac-*` or `ios-*` class. Updating the kit is a
file copy.

**Each stylesheet loads only for its own screens.** `src/ui/looks.css` imports both with the skill's
two media queries; the build wraps each in its `@media` block, so the two never apply at once.

**One state, two views.** Every route keeps its server component, which reads the ledger and passes
plain data (including `Money`; React serialises `bigint`) to a client view. The view asks
`usePhone()` and renders its macOS or its iOS tree from the same data. `usePhone()` follows the
window live and is seeded on the server from a `pfa-look` cookie (or, on a first visit, the user
agent), so a phone never flashes the desktop layout on load.

**The frame is the layout.** `src/ui/frame.tsx` wraps every page once the vault is open: a macOS
window with a sidebar of every place, or the iOS tab bar with the five destinations of
buildspec.md §13 (the transactions tab reads "Ledger": an iPhone tab label must be one short word).
The URL is the navigation state, so reloads, links and the back button land in the same place in
both looks, and resizing across 744 px keeps the page. The kits draw navigation as plain
`<a href>`; the frame turns an ordinary click on one into a client navigation.

**Charts stay ours,** because neither kit draws one (`src/ui/charts.tsx`). They follow the dataviz
skill's specs, and their series colours are its validated reference steps: Apple's raw system
colours failed the colour-vision check in dark mode (`scripts/validate_palette.js`, deutan ΔE 4.9).

**Mutations stay server actions.** Kit controls report values, not form events, so views build a
`FormData` from state and call the existing actions inside a transition. The rules, idempotency keys
and revision guards are unchanged.

## Consequences

- Every screen exists twice in code, once per look. That is the skill's design ("same data, same
  features, same routes; only the view layer differs") and the price of each look being right
  rather than a compromise between them.
- The vendored files are large (about 600 KB of CSS before compression); each screen downloads only
  its own look's stylesheet's effect, but both files are fetched.
- SF Pro is never shipped (Apple's licence). Off Apple platforms the kits fall back to Inter, then
  Roboto or the system UI font.
- Typed text in an open form is lost if a desktop window is dragged narrower than 744 px mid-edit,
  because the other look mounts its own form. Navigation, selection held in the URL and data survive.
