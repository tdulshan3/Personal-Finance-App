// Drives headless Chrome over the DevTools protocol (Node's built-in WebSocket; no Playwright).
// Unlocks the seeded vault, runs PFA_FLOWS if given, then screenshots each shot.
// Usage: node drive.mjs <baseUrl> <outDir> <shot>...   where shot = path|look|theme|height  (look: mac|ios)
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [base, out, ...shots] = process.argv.slice(2);
const PASS = process.env.PFA_PASS ?? "synthetic smoke passphrase";
const port = 9333 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), "pfa-chrome-"));
const chrome = spawn(process.env.PFA_CHROME ?? "/usr/bin/google-chrome-stable", [
  "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--hide-scrollbars", "--disable-gpu", "about:blank",
], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let targets;
for (let i = 0; i < 50; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.length) break; } catch {}
  await sleep(200);
}
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const pending = new Map();
const errors = [];
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  if (msg.method === "Runtime.exceptionThrown") errors.push(`exception: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
  if (msg.method === "Runtime.consoleAPICalled" && (msg.params.type === "error" || msg.params.type === "warning")) errors.push(`${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 400)}`);
  if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") errors.push(`log: ${msg.params.entry.text} ${msg.params.entry.url ?? ""}`);
});
const send = (method, params = {}) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
await send("Runtime.enable"); await send("Log.enable"); await send("Page.enable");

async function look(kind, theme, height) {
  if (kind === "ios") {
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: height ?? 844, deviceScaleFactor: 2, mobile: true });
    await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  } else {
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: height ?? 900, deviceScaleFactor: 1, mobile: false });
    await send("Emulation.setTouchEmulationEnabled", { enabled: false });
  }
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
}
async function go(path) {
  await send("Page.navigate", { url: base + path });
  for (let i = 0; i < 40; i++) { await sleep(150); if ((await evaluate("document.readyState")) === "complete") break; }
  await sleep(1200);
}
async function setValue(selector, value) {
  await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
}
globalThis.drive = { send, evaluate, go, look, setValue, sleep };

await look("mac", "light");
if (!process.env.PFA_NOUNLOCK) {
await go("/unlock");
await setValue('input[type="password"]', PASS);
await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(b => /unlock/i.test(b.textContent) && b.offsetParent !== null) || document.querySelector('button[type=submit]'); b?.click(); return !!b; })()`);
await sleep(2500);
console.log("after unlock:", await evaluate("location.pathname"));
}

if (process.env.PFA_FLOWS) {
  const { default: flows } = await import(pathToFileURL(resolve(process.env.PFA_FLOWS)).href);
  await flows({ ...globalThis.drive, errors, out, base });
}
const ids = existsSync(join(out, "ids.json")) ? JSON.parse(readFileSync(join(out, "ids.json"), "utf8")) : {};
for (const shot of shots) {
  const [rawPath, kind = "mac", theme = "light", h] = shot.split("|");
  const path = rawPath.replace("@TX", ids.tx ?? "");
  await look(kind, theme, h ? Number(h) : undefined);
  errors.length = 0;
  await go(path);
  const shotData = await send("Page.captureScreenshot", { format: "png" });
  const name = `${rawPath.replace(/[^a-z0-9]+/gi, "_") || "home"}-${kind}-${theme}.png`;
  writeFileSync(join(out, name), Buffer.from(shotData.result.data, "base64"));
  const looks = await evaluate(`[document.querySelectorAll('[class*="mac-"]').length, document.querySelectorAll('[class*="ios-"]').length]`);
  console.log(`${name}  mac:${looks?.[0]} ios:${looks?.[1]}  ${errors.length ? "ERRORS:\n  " + [...new Set(errors)].join("\n  ") : "no console errors"}`);
}
ws.close();
chrome.kill("SIGKILL");
await sleep(300);
rmSync(profile, { recursive: true, force: true });
process.exit(0);
