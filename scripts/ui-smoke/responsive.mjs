// The adaptive switch: which look each screen gets, and that resizing keeps the page.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export default async function responsive(d) {
  const looks = () => d.evaluate(`[document.querySelectorAll('[class*="mac-"]').length > 0, document.querySelectorAll('[class*="ios-"]').length > 0]`);
  const shot = async (name) => { const r = await d.send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(d.out, `resp-${name}.png`), Buffer.from(r.result.data, "base64")); };
  const set = async (width, height, mobile, touch) => {
    await d.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile, screenOrientation: width > height ? { type: "landscapePrimary", angle: 90 } : { type: "portraitPrimary", angle: 0 } });
    await d.send("Emulation.setTouchEmulationEnabled", { enabled: touch, maxTouchPoints: touch ? 5 : 0 });
    // pointer: coarse needs the emulated media feature too.
    await d.send("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: touch ? "coarse" : "fine" }, { name: "hover", value: touch ? "none" : "hover" }] });
  };
  const report = [];
  const check = async (label, width, height, mobile, touch, expect) => {
    await set(width, height, mobile, touch);
    await d.go("/plan");
    const [mac, ios] = await looks();
    const got = mac && !ios ? "mac" : ios && !mac ? "ios" : `mixed(mac:${mac},ios:${ios})`;
    report.push(`${got === expect ? "PASS" : "FAIL"}  ${label} ${width}×${height} → ${got}`);
    await shot(label.replace(/\W+/g, "_"));
  };
  await check("desktop", 1280, 800, false, false, "mac");
  await check("small desktop", 800, 600, false, false, "mac");
  await check("tablet", 1024, 768, true, true, "mac");
  await check("phone", 402, 874, true, true, "ios");
  await check("phone sideways", 874, 402, true, true, "ios");

  // A desktop window dragged narrow and back: the look follows, the page stays.
  await set(1280, 800, false, false);
  await d.go("/transactions?category=groceries");
  await set(700, 800, false, false);
  await d.sleep(800);
  const narrow = await looks();
  const pathNarrow = await d.evaluate("location.pathname + location.search");
  await set(1280, 800, false, false);
  await d.sleep(800);
  const wide = await looks();
  const pathWide = await d.evaluate("location.pathname + location.search");
  const ok = !narrow[0] && narrow[1] && wide[0] && !wide[1] && pathNarrow === "/transactions?category=groceries" && pathWide === pathNarrow;
  report.push(`${ok ? "PASS" : "FAIL"}  resize 1280 → 700 → 1280 keeps ${pathWide} (narrow ios:${narrow[1]}, wide mac:${wide[0]})`);
  console.log("\n" + report.join("\n"));
}
