# apple-ui-ux kit

`src/ui/macos/` (`macos.tsx`, `macos.css`) and `src/ui/ios/` (`ios.tsx`, `ios.css`) are copied
unchanged from the owner's apple-ui-ux skill (macOS 27 and iOS 27 looks with the classic blur
materials), apart from a `// @ts-nocheck` first line. See
[ADR 0011](../adr/0011-adaptive-apple-interface.md). Its icons are the kit's own drawings, inlined
as data URIs; no SF Symbols artwork is shipped.

No Apple font is shipped either: the kits name SF Pro first in their font stacks, which only
resolves on Apple devices where it is installed, and fall back to Inter, Roboto or the system UI
font everywhere else.

The skill also carries Apple's *License Agreement for Apple Design Resources* (in the skill's
`docs/`). That licence covers Apple's own design files and limits them to mock-ups of software for
Apple platforms. This app is private, single-owner and not distributed; if that ever changes,
review the kit's provenance against that licence before shipping it.

The previous interface's icons were derived from Lucide (ISC); none of that artwork remains.
