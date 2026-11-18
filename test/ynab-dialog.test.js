// The YNAB dialog (ynab.js) in a simulated browser (jsdom). It loads the real
// shared.js and ynab.js, with a fake chrome.storage and a fake YNAB bridge that
// uses the real write guard (guard.js).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM, VirtualConsole } = require("jsdom");
const guard = require("../extension/guard.js");

const src = (f) => fs.readFileSync(path.join(__dirname, "../extension", f), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

const ORDER = (n) => `111-000000${n}-000000${n}`;
const goodOrder = (title) => ({ items: [{ title, qty: 1 }], shipTo: { name: "Pat Doe", addressLines: ["1 MAIN ST", "SPRINGFIELD, IL 62701"] }, orderer: "Pat" });

// Default data: two good rows, one still loading, a tie (one good, one failed), and one memo that has text.
function defaultData() {
  const amazonTxns = {
    a1: { key: "a1", date: "2026-11-10", amountCents: -1000, orderIds: [ORDER(1)] },
    a2: { key: "a2", date: "2026-11-09", amountCents: -2000, orderIds: [ORDER(2)] },
    a3: { key: "a3", date: "2026-11-08", amountCents: -3000, orderIds: [ORDER(3)] },
    a4: { key: "a4", date: "2026-11-06", amountCents: -4000, orderIds: [ORDER(4)] },
    a5: { key: "a5", date: "2026-11-06", amountCents: -4000, orderIds: [ORDER(5)] },
    a6: { key: "a6", date: "2026-11-05", amountCents: -6000, orderIds: [ORDER(6)] },
  };
  const orders = { [ORDER(1)]: goodOrder("Widget one"), [ORDER(2)]: goodOrder("Widget two"), [ORDER(4)]: goodOrder("Tie A"), [ORDER(5)]: { error: "Could not read order" }, [ORDER(6)]: goodOrder("Six") };
  const ynab = [
    { entityId: "y1", date: "2026-11-10", amount: -10000, memo: null },
    { entityId: "y2", date: "2026-11-10", amount: -20000, memo: null },
    { entityId: "y3", date: "2026-11-09", amount: -30000, memo: null },
    { entityId: "y4", date: "2026-11-07", amount: -40000, memo: null },
    { entityId: "y5", date: "2026-11-07", amount: -40000, memo: null },
    { entityId: "y6", date: "2026-11-05", amount: -60000, memo: "keep this" },
  ];
  return { storage: { amazonTxns, orders }, ynab };
}

function setup({ storage, ynab } = defaultData(), html = "") {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>
    <div class="nav-add-accounts"><button class="ynab-button button-sidebar nav-bank-connections">Bank Connections</button></div>${html}</body></html>`, {
    runScripts: "outside-only", pretendToBeVisual: true, url: "https://app.ynab.com/budget", virtualConsole: new VirtualConsole(),
  });
  const w = dom.window;
  // Like Chrome: a message posted by the page has the window as its source (jsdom leaves it null).
  w.postMessage = (data) => w.setTimeout(() => w.dispatchEvent(new w.MessageEvent("message", { data, source: w })), 0);
  const data = structuredClone(storage);
  const listeners = [];
  w.chrome = {
    runtime: { id: "test" },
    storage: {
      onChanged: { addListener: (f) => listeners.push(f) },
      local: {
        get: async (keys) => Object.fromEntries((typeof keys === "string" ? [keys] : keys).filter((k) => k in data).map((k) => [k, structuredClone(data[k])])),
        set: async (obj) => {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) { data[k] = structuredClone(v); changes[k] = { newValue: v }; }
          listeners.forEach((f) => f(changes, "local"));
        },
      },
    },
  };
  w.ResizeObserver = class { observe() {} disconnect() {} };
  const opened = [];
  w.open = (url) => opened.push(url);

  // Fake YNAB page side of the bridge.
  const txns = ynab.map((t) => ({ payeeName: "Amazon", account: "Slush", ...t, setMemo(v) { this.memo = v; } }));
  const em = { performAsSingleChangeSet: (f) => f(), getTransactionById: (id) => txns.find((t) => t.entityId === id) };
  const bridge = { answer: true, writes: [] };
  w.addEventListener("message", (e) => {
    const d = e.data;
    if (d?.__yah !== "req" || !bridge.answer) return;
    let result;
    if (d.op === "list") result = txns.map((t) => ({ id: t.entityId, date: t.date, amountMilli: t.amount, memo: t.memo || "", memoEmpty: guard.isMemoEmpty(t.memo), payee: t.payeeName, account: t.account }));
    if (d.op === "apply") { bridge.writes.push(...d.args.updates); result = guard.applyMemoUpdates(em, d.args.updates, (t) => t.payeeName); }
    w.postMessage({ __yah: "res", id: d.id, ok: true, result }, "*");
  });

  w.eval(src("shared.js"));
  w.eval(src("ynab.js"));
  const root = () => w.document.getElementById("yah-host").shadowRoot;
  const $ = (id) => root().getElementById(id);
  const rows = () => [...$("bd").querySelectorAll("table:first-of-type tbody tr")].map((tr) => ({
    id: tr.querySelector("input[data-id]")?.dataset.id ?? null,
    checked: tr.querySelector("input[data-id]")?.checked ?? null,
    memo: tr.querySelector(".memo-text")?.textContent ?? null,
    note: [...tr.querySelectorAll(".note, .err")].map((n) => n.textContent).join(" "),
    amount: tr.children[3]?.textContent,
  }));
  const open = async () => {
    (await waitFor(() => w.document.querySelector(".yah-sidebar-button"), "sidebar button")).click();
    await waitFor(() => $("bd").querySelector("table, .allset"), "table");
  };
  const touch = async (key) => w.chrome.storage.local.set({ [key]: data[key] }); // simulate the Amazon tab saving
  return { w, $, rows, open, data, txns, bridge, opened, touch, root };
}

test("sidebar button is placed after Bank Connections", async () => {
  const t = setup();
  const btn = await waitFor(() => t.w.document.querySelector(".yah-sidebar-button"), "button");
  assert.equal(btn.textContent, "Amazon Helper");
  assert.equal(btn.previousElementSibling.classList.contains("nav-bank-connections"), true);
  assert.equal(t.$("fab").hidden, true, "floating button stays hidden while YNAB is loading");
});

test("rows: complete data is selected; ties, failures, and loading orders are not", async () => {
  const t = setup();
  await t.open();
  const r = t.rows();
  const byAmount = (a) => r.filter((x) => x.amount === a);
  assert.equal(byAmount("-$10.00")[0].checked, true);
  assert.match(byAmount("-$10.00")[0].memo, /^Widget one \| To: Pat Doe, Springfield \| By: Pat \| https:/);
  assert.equal(byAmount("-$30.00")[0].checked, null, "order still loading: no checkbox");
  assert.match(byAmount("-$30.00")[0].note, /not loaded yet/);
  const tie = byAmount("-$40.00");
  assert.equal(tie.length, 2);
  const good = tie.find((x) => x.memo);
  const failed = tie.find((x) => !x.memo);
  assert.equal(good.checked, false, "ambiguous row starts unchecked");
  assert.match(good.note, /same amount and date/);
  assert.match(failed.note, /failed to load/);
  assert.equal(byAmount("-$60.00").length, 0, "a memo with text is never proposed");
  assert.equal(t.$("apply").textContent, "Write 2 memos");
});

test("write sends only selected rows, with amounts, and reports skip reasons", async () => {
  const t = setup();
  await t.open();
  // Untick the first row.
  const first = t.$("bd").querySelector('input[data-id="y1"]');
  first.click();
  await waitFor(() => t.$("apply").textContent === "Write 1 memo", "count update");
  // Someone types a memo in YNAB on y2 after the preview: the guard must skip it.
  t.txns.find((x) => x.entityId === "y2").memo = "typed in YNAB";
  t.$("apply").click();
  await waitFor(() => t.$("msg").textContent, "result message", 5000);
  assert.deepEqual(t.bridge.writes.map((u) => [u.id, u.amountMilli]), [["y2", -20000]]);
  assert.equal(t.txns.find((x) => x.entityId === "y2").memo, "typed in YNAB");
  assert.match(t.$("msg").textContent, /^Wrote 0 memos\. Skipped 1: 1 already had a memo\./);
});

test("an open editor blocks writing and survives updates; Escape cancels only the edit", async () => {
  const t = setup();
  await t.open();
  t.$("bd").querySelector("button[data-edit]").click();
  assert.equal(t.$("apply").disabled, true);
  assert.equal(t.$("apply").textContent, "Save or cancel your edit first");
  await t.touch("orders");
  await sleep(1300); // the update waits about 1 s
  assert.ok(t.$("bd").querySelector("textarea"), "editor still open");
  const ta = t.$("bd").querySelector("textarea");
  ta.dispatchEvent(new t.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(t.$("bd").querySelector("textarea"), null);
  assert.equal(t.$("back").hidden, false, "dialog stays open");
  assert.equal(t.$("apply").textContent, "Write 2 memos");
  // Escape with no editor closes the dialog.
  t.root().querySelector(".modal").dispatchEvent(new t.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(t.$("back").hidden, true);
});

test("an edited memo is written, and kept across updates", async () => {
  const t = setup();
  await t.open();
  t.$("bd").querySelector('td[data-memo] button[data-edit]').click();
  const ta = t.$("bd").querySelector("textarea");
  ta.value = "My own memo";
  t.$("bd").querySelector("[data-save]").click();
  await t.touch("amazonTxns");
  await sleep(1300);
  assert.equal(t.rows()[0].memo, "My own memo");
  t.$("apply").click();
  await waitFor(() => t.$("msg").textContent, "result message", 5000);
  assert.equal(t.txns.find((x) => x.entityId === "y1").memo, "My own memo");
});

test("an unchecked row stays unchecked across updates; new rows arrive selected", async () => {
  const t = setup();
  await t.open();
  t.$("bd").querySelector('input[data-id="y1"]').click();
  // Order 3 finishes loading on the Amazon tab.
  t.data.orders[ORDER(3)] = goodOrder("Widget three");
  await t.touch("orders");
  await waitFor(() => t.rows().some((r) => r.amount === "-$30.00" && r.memo), "row 3 memo");
  const r = Object.fromEntries(t.rows().filter((x) => x.id).map((x) => [x.id, x.checked]));
  assert.equal(r.y1, false);
  assert.equal(r.y3, true);
});

test("empty states: waiting, no match, and congrats", async () => {
  const d = defaultData();
  d.ynab.forEach((x) => (x.memo = "filled"));
  const t = setup(d);
  await t.open();
  assert.match(t.$("bd").querySelector(".allset").textContent, /Waiting for Amazon orders to load \(1 left\)/);
  t.data.orders[ORDER(3)] = goodOrder("Widget three");
  await t.touch("orders");
  await waitFor(() => /Congrats/.test(t.$("bd").querySelector(".allset")?.textContent || ""), "congrats");

  const d2 = defaultData();
  d2.ynab.forEach((x) => (x.memo = "filled"));
  d2.storage.orders[ORDER(3)] = goodOrder("three");
  d2.ynab.push({ entityId: "y9", date: "2026-11-10", amount: -99000, memo: null });
  const t2 = setup(d2);
  await t2.open();
  assert.match(t2.$("bd").querySelector(".allset").textContent, /no Amazon match/);
});

test("no Amazon data yet shows the instructions hint", async () => {
  const t = setup({ storage: {}, ynab: [] });
  await t.w.document.querySelector(".yah-sidebar-button")?.click();
  (await waitFor(() => t.w.document.querySelector(".yah-sidebar-button"), "button")).click();
  await waitFor(() => /No Amazon data yet/.test(t.$("bd").textContent), "hint");
});

test("links open in a new tab; instructions collapse is remembered", async () => {
  const t = setup();
  await t.open();
  t.$("bd").querySelector("a[href]").click();
  assert.match(t.opened[0], /orderID=/);
  const summary = await waitFor(() => t.$("st").querySelector("#instr summary"), "instructions");
  summary.click();
  await waitFor(() => t.data.uiPrefs?.instructionsCollapsed === true, "pref saved");
});

test("register memos with an order link get an Amazon order button", async () => {
  const t = setup(defaultData(), `<div class="ynab-grid-cell ynab-grid-cell-memo"><span>Widget | https://www.amazon.com/gp/css/summary/edit.html?orderID=111-0000001-0000001</span></div>
    <div class="ynab-grid-cell ynab-grid-cell-memo"><span>Plain memo</span></div>`);
  const links = await waitFor(() => { const l = t.w.document.querySelectorAll(".yah-order-link"); return l.length && l; }, "order link");
  assert.equal(links.length, 1);
  assert.equal(links[0].textContent, "Amazon order ↗");
  links[0].click();
  assert.equal(t.opened[0], "https://www.amazon.com/gp/css/summary/edit.html?orderID=111-0000001-0000001");
});
