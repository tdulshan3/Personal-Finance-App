# 0002 — Build on the PC, deploy `standalone` output to the phone

- **Status:** Accepted
- **Date:** 2026-09-20
- **Related:** [0001](0001-nextjs-node-on-termux-instead-of-kotlin-compose.md), [0003](0003-sqlite-encryption-with-passphrase-derived-key.md)

## Context

`buildspec.md` §3 assumed a Gradle build producing an APK that Android installs. With the stack in
[ADR 0001](0001-nextjs-node-on-termux-instead-of-kotlin-compose.md) there is no APK; there is a Node
application that has to start on the phone.

Building on the phone does not work:

- Next.js compiles with **SWC**, a Rust toolchain shipped as prebuilt platform binaries
  (`@next/swc-linux-arm64-gnu`, `@next/swc-linux-arm64-musl`, …). Those are linked against **glibc
  or musl**. Termux uses Android's **bionic** libc. The `-gnu` build will not load there, and there
  is no `android-arm64` SWC artifact to fall back to.
- Termux has no Gradle, no Android SDK and — by design in this project — no compiler in the hot
  path. We do not want the phone to be a build machine.
- Even if it worked, a full Next build on a phone SoC is slow and burns battery.

## Decision

**Compile on the PC. Ship a runnable tree to the phone. Never compile application code on-device.**

- `next.config.ts` sets `output: "standalone"`. `npm run build` on the PC produces
  `.next/standalone/` containing `server.js`, a traced `node_modules/`, and the server bundle.
- The deploy payload is `.next/standalone/` **plus** `.next/static/` (copied to
  `.next/standalone/.next/static/`) and `public/` — Next does not trace those two into standalone
  output, and the app 404s its own assets without them.
- On the phone the app starts with a plain `node server.js`. No SWC, no bundler, no transpiler runs
  there.
- `scripts/deploy-to-termux.sh` does the build, assembles the payload and pushes it, over either
  `adb push` (USB, default) or `rsync`/`scp` over Termux's sshd on port 8022.

### The one exception: the native SQLite module

`better-sqlite3-multiple-ciphers` is a real `.node` binary and **must** be compiled on the phone
against Termux's own clang and bionic libc (see
[ADR 0003](0003-sqlite-encryption-with-passphrase-derived-key.md)). The copy that ends up in the
PC's `node_modules` is the wrong architecture and would overwrite a working on-device build.

So the deployment splits it out:

- It is declared in `optionalDependencies`, so a PC install and typecheck succeed without it.
- `scripts/setup-termux.sh` builds it **once, on the phone**, into `$PFA_HOME/native/node_modules/`
  and symlinks it into the deployed app's `node_modules/`.
- `scripts/deploy-to-termux.sh` **excludes** `node_modules/better-sqlite3-multiple-ciphers` from the
  payload, so a redeploy can never clobber the on-device build.
- `next.config.ts` lists it in `serverExternalPackages` so Next leaves it as a runtime `require`
  instead of trying to bundle a `.node` file.

## Consequences

- The phone cannot rebuild itself. Every code change requires a PC with the repo checked out. There
  is no "edit on device" path, and there is no CI runner that can produce the phone build without
  also being able to run `npm run build`.
- Deploys are **not** atomic. Files are written in place while the old server may still be running.
  The deploy script does not restart the server; the owner stops it, deploys, and starts it again.
- Node's major version on the phone should match what the PC built against. Standalone output is
  plain JavaScript so this is forgiving in practice, but a native-module ABI mismatch is not —
  after a Termux `nodejs` major upgrade the native module must be rebuilt
  (`bash scripts/setup-termux.sh --rebuild-native`).
- `adb push` cannot write into Termux's private home directory (`/data/data/com.termux/files/home`
  is not readable by the `shell` user). The adb transport therefore pushes a tarball to shared
  storage and the owner extracts it from inside Termux. The ssh transport writes directly and is
  the smoother option. *Both paths are untested on device.*
- Content-hashed asset names mean stale files accumulate under `.next/static/` across deploys. The
  ssh transport has an opt-in `--prune` flag; the adb path leaves them. They are inert, just disk.
- `data/` lives **outside** the deployed tree (`$PFA_HOME/data`, not `$PFA_HOME/app`), so no deploy
  mode — including `--prune` — can reach the encrypted database.
