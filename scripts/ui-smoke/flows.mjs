// End-to-end flows in the macOS look (and a few in iOS): every write path the screens offer.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const HELPERS = `window.__h = window.__h || {
  vis: (e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden',
  norm: (t) => (t || '').replace(/\\s+/g, ' ').trim(),
  all: (sel, root) => [...(root || document).querySelectorAll(sel)].filter((e) => __h.vis(e)),
  byText: (sel, text, root) => __h.all(sel, root).find((e) => __h.norm(e.textContent) === text) || __h.all(sel, root).find((e) => __h.norm(e.textContent).includes(text)),
  byLabel: (label, root) => __h.all('[aria-label]', root).find((e) => e.getAttribute('aria-label') === label) || __h.all('[title]', root).find((e) => e.getAttribute('title') === label),
  set: (el, value) => { const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; },
  dialog: () => [...document.querySelectorAll('dialog[open]')].pop() || null,
  field: (text, root) => { const scope = root || document;
    const label = __h.all('label', scope).find((l) => __h.norm(l.textContent).replace(/:$/, '').startsWith(text));
    if (!label) return null;
    if (label.htmlFor) return document.getElementById(label.htmlFor);
    return label.querySelector('input,textarea,select,button') || label.parentElement.querySelector('input,textarea'); },
};true`;

export default async function flows(d) {
  const results = [];
  const js = async (code) => { await d.evaluate(HELPERS); return d.evaluate(code); };
  const wait = async (code, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await js(code)) return true; await d.sleep(200); } return false; };
  const shot = async (name) => { const r = await d.send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(d.out, `flow-${name}.png`), Buffer.from(r.result.data, "base64")); };
  const clickLabel = (label) => js(`(() => { const e = __h.byLabel(${JSON.stringify(label)}); if (!e) return false; e.click(); return true; })()`);
  const clickText = (sel, text, inDialog = false) => js(`(() => { const e = __h.byText(${JSON.stringify(sel)}, ${JSON.stringify(text)}, ${inDialog ? "__h.dialog()" : "document"}); if (!e) return false; e.click(); return true; })()`);
  const fill = (label, value, inDialog = true) => js(`(() => { const f = __h.field(${JSON.stringify(label)}, ${inDialog ? "__h.dialog()" : "document"}); if (!f) return 'no field'; return __h.set(f, ${JSON.stringify(value)}); })()`);
  const choose = async (label, option, inDialog = true) => {
    const opened = await js(`(() => { const f = __h.field(${JSON.stringify(label)}, ${inDialog ? "__h.dialog()" : "document"}); if (!f) return false; f.click(); return true; })()`);
    if (!opened) return `no pop-up ${label}`;
    await d.sleep(250);
    return js(`(() => { const items = __h.all('[role^="menuitem"]'); const i = items.find((e) => __h.norm(e.textContent) === ${JSON.stringify(option)}) || items.find((e) => __h.norm(e.textContent).includes(${JSON.stringify(option)})); if (!i) return 'no option: ' + items.map(e => __h.norm(e.textContent)).join('|'); i.click(); return true; })()`);
  };
  const text = () => js("document.body.innerText");
  const has = async (needle) => (await text()).includes(needle);
  const step = async (name, fn) => {
    d.errors.length = 0;
    try {
      const detail = await fn();
      const errs = [...new Set(d.errors)].filter((e) => !/favicon/.test(e));
      results.push(`${errs.length ? "WARN" : "PASS"}  ${name}${detail ? ` — ${detail}` : ""}${errs.length ? `\n        console: ${errs.join("\n        ")}` : ""}`);
    } catch (error) {
      results.push(`FAIL  ${name} — ${error.message}`);
      await shot(name.replace(/[^a-z0-9]+/gi, "_"));
    }
  };
  const must = (cond, message) => { if (!cond) throw new Error(message); };

  await d.look("mac", "light");

  await step("mac: New Transaction sheet records an expense", async () => {
    await d.go("/transactions");
    must(await clickLabel("New Transaction"), "no New Transaction button");
    must(await wait("!!__h.dialog()"), "sheet did not open");
    must((await fill("Amount", "1234.50")) === true, "no Amount field");
    must((await fill("Merchant", "Smoke Test Cafe")) === true, "no Merchant field");
    const c = await choose("Category", "Dining"); must(c === true, `category: ${c}`);
    must(await clickText("button", "Save", true), "no Save");
    must(await wait("!__h.dialog()"), "sheet stayed open: " + (await js("__h.dialog()?.innerText")));
    must(await wait("document.body.innerText.includes('Smoke Test Cafe')"), "new row not shown");
  });

  await step("mac: a refused amount keeps the sheet open with the reason", async () => {
    must(await clickLabel("New Transaction"), "no New Transaction button");
    must(await wait("!!__h.dialog()"), "sheet did not open");
    await fill("Amount", "12.345.6");
    await clickText("button", "Save", true);
    await d.sleep(1200);
    const open = await js("__h.dialog()?.innerText || ''");
    must(open.length > 0, "sheet closed on an invalid amount");
    await clickText("button", "Cancel", true);
    must(await wait("!__h.dialog()"), "Cancel did not close");
    return open.split("\n").find((l) => /amount|number|decimal|valid/i.test(l)) ?? "";
  });

  let txPath = "";
  await step("mac: open a record, edit its amount", async () => {
    await js(`(() => { const row = __h.all('tr').find((r) => r.innerText.includes('Smoke Test Cafe')); row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; })()`);
    must(await wait("location.pathname.startsWith('/transactions/txn_')"), "double-click did not open the record");
    txPath = await js("location.pathname");
    must(await clickLabel("Edit") || await clickText("button", "Edit…"), "no Edit");
    must(await wait("!!__h.dialog()"), "edit sheet did not open");
    must((await fill("Amount", "1500.00")) === true, "no Amount field in edit");
    must(await clickText("button", "Save", true), "no Save");
    must(await wait("!__h.dialog()"), "edit sheet stayed open: " + (await js("__h.dialog()?.innerText")));
    must(await wait("document.body.innerText.includes('1,500.00')"), "new amount not shown");
    must(await wait("/Edited 1 time|edited once|1 change/i.test(document.body.innerText)"), "edit count not shown");
  });

  await step("mac: move to Trash and restore", async () => {
    must(await clickLabel("Move to Trash"), "no Move to Trash");
    must(await wait("!!__h.dialog()"), "no confirmation");
    must(await clickText("button", "Move to Trash", true), "no confirm button");
    must(await wait("/In Trash|Restore/.test(document.body.innerText)"), "not in Trash");
    must(await clickLabel("Restore") || await clickText("button", "Restore"), "no Restore");
    must(await wait("document.body.innerText.includes('Posted')"), "not restored");
  });

  await step("mac: create an account", async () => {
    await d.go("/accounts");
    must(await clickLabel("New Account"), "no New Account button");
    must(await wait("!!__h.dialog()"), "sheet did not open");
    must((await fill("Name", "Smoke Wallet")) === true, "no Name field");
    const t = await choose("Type", "Wallet"); must(t === true, `type: ${t}`);
    const filledOpening = await js(`(() => { const label = __h.all('label', __h.dialog()).find((l) => /balance|owed/i.test(l.textContent)); const f = label && document.getElementById(label.htmlFor); return f ? __h.set(f, '2500.00') : false; })()`);
    must(filledOpening, "no opening balance field");
    await clickText("button", "Create", true) || await clickText("button", "Add", true) || await clickText("button", "Save", true);
    must(await wait("!__h.dialog()"), "sheet stayed open: " + (await js("__h.dialog()?.innerText")));
    must(await wait("document.body.innerText.includes('Smoke Wallet')"), "account not listed");
    must(await has("2,500.00"), "opening balance not shown");
  });

  await step("mac: create a category and give it a budget", async () => {
    await d.go("/categories");
    must(await clickLabel("New Category"), "no New Category button");
    must(await wait("!!__h.dialog()"), "sheet did not open");
    must((await fill("Name", "Smoke Hobbies")) === true, "no Name field");
    await clickText("button", "Create", true) || await clickText("button", "Add", true) || await clickText("button", "Save", true);
    must(await wait("!__h.dialog()"), "sheet stayed open: " + (await js("__h.dialog()?.innerText")));
    must(await wait("document.body.innerText.includes('Smoke Hobbies')"), "category not listed");
    await js(`(() => { const row = __h.all('tr').find((r) => r.innerText.includes('Smoke Hobbies')); row.click(); return true; })()`);
    await d.sleep(300);
    must(await clickText("button", "Set…") || await clickLabel("Set Budget"), "no Set budget");
    must(await wait("!!__h.dialog()"), "budget sheet did not open");
    const filled = await js(`(() => { const i = __h.all('input', __h.dialog()).find((x) => x.type !== 'hidden'); return i ? __h.set(i, '4000') : false; })()`);
    must(filled, "no budget field");
    await clickText("button", "Save", true) || await clickText("button", "Set", true);
    must(await wait("!__h.dialog()"), "budget sheet stayed open: " + (await js("__h.dialog()?.innerText")));
    must(await wait("document.body.innerText.includes('4,000.00')"), "budget not shown");
  });

  await step("mac: add a recurring bill, then a suggestion", async () => {
    await d.go("/bills");
    must(await clickLabel("Add Bill or Income") || await clickLabel("Add Bill") || await clickLabel("New Bill"), "no Add button: " + (await js("__h.all('[aria-label]').map(e=>e.getAttribute('aria-label')).join('|')")));
    must(await wait("!!__h.dialog()"), "sheet did not open");
    must((await fill("Name", "Smoke Gym")) === true, "no Name field");
    must((await fill("Amount", "5000")) === true, "no Amount field");
    await clickText("button", "Add", true) || await clickText("button", "Save", true);
    must(await wait("!__h.dialog()"), "sheet stayed open: " + (await js("__h.dialog()?.innerText")));
    must(await wait("document.body.innerText.includes('Smoke Gym')"), "bill not listed");
    const before = (await text()).split("Suggested from your history")[1]?.split("\n").filter((l) => / · LKR /.test(l)).length ?? 0;
    must(await clickText("button", "Add"), "no suggestion Add");
    await d.sleep(1500);
    const after = (await text()).split("Suggested from your history")[1]?.split("\n").filter((l) => / · LKR /.test(l)).length ?? 0;
    must(after === before - 1, `suggestions ${before} → ${after}`);
  });

  await step("mac: Record Payment opens the sheet prefilled", async () => {
    must(await clickText("button", "Record Payment…") || await clickText("button", "Record Payment"), "no Record Payment");
    must(await wait("!!__h.dialog()"), "sheet did not open");
    const amount = await js(`__h.field('Amount', __h.dialog())?.value`);
    must(amount && amount.length > 0, "amount not prefilled");
    await clickText("button", "Cancel", true);
    return `amount ${amount}`;
  });

  await step("mac: Plan buffer and a goal", async () => {
    await d.go("/plan");
    const ok = await js(`(() => { const f = __h.field('Keep at least'); if (!f) return false; __h.set(f, '60000'); f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); f.blur(); return true; })()`);
    must(ok, "no buffer field");
    must(await wait("document.body.innerText.includes('60,000.00')", 6000), "buffer not applied");
    must(await clickLabel("Add Goal") || await clickText("button", "Add Goal…"), "no Add Goal");
    must(await wait("!!__h.dialog()"), "goal sheet did not open");
    must((await fill("Name", "Smoke Laptop")) === true, "no Name");
    must((await fill("Target", "250000")) === true, "no Target");
    await clickText("button", "Add", true) || await clickText("button", "Save", true);
    must(await wait("!__h.dialog()"), "goal sheet stayed open: " + (await js("__h.dialog()?.innerText")));
    must(await wait("document.body.innerText.includes('Smoke Laptop')"), "goal not shown");
  });

  await step("mac: accept a message on Review", async () => {
    await d.go("/review");
    const before = await js("__h.all('[role=option]').length");
    const c = await choose("Account", "Everyday Bank", false); must(c === true, `account: ${c}`);
    must(await clickText("button", "Accept and Record"), "no Accept");
    must(await wait(`__h.all('[role=option]').length === ${before} - 1`), `list did not shrink from ${before}: ` + (await js("document.querySelector('main')?.innerText.slice(0,400)")));
  });

  await step("mac: Assistant answers a planning question without a model", async () => {
    await d.go("/assistant");
    const f = await js(`(() => { const t = __h.all('textarea')[0]; return t ? __h.set(t, 'What bills are due?') : false; })()`);
    must(f, "no composer");
    must(await clickText("button", "Send"), "no Send");
    must(await wait("/Smoke Gym|Rent|Salary/.test(document.body.innerText.split('What bills are due?').pop())", 10000), "no answer");
  });

  await step("CSV export and history-import preview routes", async () => {
    const csv = await js(`fetch('/api/export/transactions?q=Smoke').then(r => r.text())`);
    must(/date,kind,merchant_or_payer/.test(csv), "csv header missing: " + csv.slice(0, 80));
    const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><smses count="2"><sms address="Sample Bank (invented)" date="${Date.now() - 86400000}" type="1" body="Purchase of LKR 990.00 at SAMPLE SHOP using card ****1234 on 20/10/2026. Available balance LKR 10,000.00" /><sms address="Friend (invented)" date="${Date.now() - 86400000}" type="1" body="See you at six" /></smses>`;
    const preview = await js(`fetch('/api/import/sms-xml?step=preview', { method: 'POST', body: ${JSON.stringify(xml)} }).then(r => r.json())`);
    must(preview && (preview.senders?.length === 2 || preview.preview?.senders?.length === 2), "preview: " + JSON.stringify(preview).slice(0, 200));
    return `csv ${csv.split("\n").length - 1} rows; preview ok`;
  });

  await step("mac: create a backup from Settings", async () => {
    await d.go("/settings?pane=data");
    const f1 = await js(`(() => { const p = __h.all('input[type=password]'); if (p.length < 2) return 'found ' + p.length; __h.set(p[0], 'a backup password of length'); __h.set(p[1], 'a backup password of length'); return true; })()`);
    must(f1 === true, `password fields: ${f1}`);
    must(await clickText("button", "Create Backup") || await clickText("button", "Create backup"), "no Create Backup");
    must(await wait("/Backup created|ledger-\\d{8}-\\d{6}\\.pfa/.test(document.body.innerText)", 15000), "no backup result");
  });

  await d.look("ios", "light");
  await step("ios: New Transaction sheet records income", async () => {
    await d.go("/");
    must(await clickLabel("New Transaction"), "no + button");
    must(await wait("!!__h.dialog()"), "sheet did not open");
    must(await clickText('[role="radio"],label', "Income", true), "no Income segment");
    const amount = await js(`(() => { const rows = __h.all('li', __h.dialog()); const r = rows.find((x) => __h.norm(x.innerText).startsWith('Amount')); const i = r?.querySelector('input'); return i ? __h.set(i, '777.00') : false; })()`);
    must(amount, "no amount field");
    const payer = await js(`(() => { const rows = __h.all('li', __h.dialog()); const r = rows.find((x) => __h.norm(x.innerText).startsWith('Payer')); const i = r?.querySelector('input'); return i ? __h.set(i, 'Smoke Payer') : false; })()`);
    must(payer, "no payer field");
    must(await clickText("button", "Save", true), "no Save");
    must(await wait("!__h.dialog()"), "sheet stayed open: " + (await js("__h.dialog()?.innerText")));
    await d.go("/transactions");
    must(await wait("document.body.innerText.includes('Smoke Payer')"), "income not listed");
  });

  await step("ios: push a transaction and come back", async () => {
    must(await js(`(() => { const row = __h.all('li').find((l) => l.innerText.includes('Smoke Payer')); const target = row?.querySelector('a,button'); target?.click(); return !!target; })()`), "row not tappable");
    must(await wait("location.pathname.startsWith('/transactions/txn_')"), "did not push");
    must(await clickText("button", "Transactions"), "no back button");
    must(await wait("location.pathname === '/transactions'"), "back did not return");
  });

  await d.look("mac", "light");
  await step("lock, then unlock again", async () => {
    await d.go("/");
    must(await clickLabel("Lock"), "no Lock");
    must(await wait("location.pathname === '/unlock'", 8000), "did not lock");
    await d.setValue('input[type="password"]', process.env.PFA_PASS ?? "synthetic smoke passphrase");
    must(await clickText("button", "Unlock"), "no Unlock button");
    must(await wait("location.pathname === '/'", 15000), "did not unlock");
  });

  console.log("\n" + results.join("\n"));
}
