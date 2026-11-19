// The Venmo YNAB dialog in a simulated browser (jsdom), with the Amazon helper
// loaded too, as in the extension. It loads the real shared dialog
// (ynab-helper.js), both helpers, and a fake YNAB bridge that uses the real
// write guard. YNAB's page cancels the default action of every click, so the
// page here does the same.
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

const me = { id: "1", displayName: "you" };
const story = (id, amount, date, other, note) => ({
  id, amount, date: `${date}T12:00:00`, type: "payment", note: { content: note },
  title: { payload: { action: "pay", subType: "p2p" }, sender: me, receiver: { id: "x" + id, displayName: other } },
});
const saved = (s) => ({ key: s.id, story: s, myId: "1" });

function setup() {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>
    <div class="nav-add-accounts"><button class="ynab-button button-sidebar nav-bank-connections">Bank Connections</button></div></body></html>`, {
    runScripts: "outside-only", pretendToBeVisual: true, url: "https://app.ynab.com/budget", virtualConsole: new VirtualConsole(),
  });
  const w = dom.window;
  w.document.addEventListener("click", (e) => e.preventDefault(), true); // like YNAB
  w.postMessage = (data) => w.setTimeout(() => w.dispatchEvent(new w.MessageEvent("message", { data, source: w })), 0);
  const data = {
    venmoTxns: Object.fromEntries([
      story("v1", "- $24.00", "2026-11-10", "Alex Doe", "Concert"),
      story("v2", "- $50.00", "2026-11-08", "Kim Roe", "Dinner"),
    ].map((s) => [s.id, saved(s)])),
  };
  w.chrome = {
    runtime: { id: "test" },
    storage: {
      onChanged: { addListener: () => {} },
      local: {
        get: async (keys) => Object.fromEntries((typeof keys === "string" ? [keys] : keys).filter((k) => k in data).map((k) => [k, structuredClone(data[k])])),
        set: async (obj) => Object.assign(data, structuredClone(obj)),
      },
    },
  };
  w.ResizeObserver = class { observe() {} disconnect() {} };
  const opened = [];
  w.open = (url) => opened.push(url);

  // YNAB: v1 matches y1; v2 ties between y2 and y3 (same amount and date); y4 has no match.
  const txns = [
    { entityId: "y1", date: "2026-11-11", amount: -24000, memo: null },
    { entityId: "y2", date: "2026-11-09", amount: -50000, memo: null },
    { entityId: "y3", date: "2026-11-09", amount: -50000, memo: "Paid Kim" },
    { entityId: "y4", date: "2026-11-09", amount: -7000, memo: null },
  ].map((t) => ({ payeeName: "Venmo", account: "Checking", ...t, setMemo(v) { this.memo = v; } }));
  const em = { performAsSingleChangeSet: (f) => f(), getTransactionById: (id) => txns.find((t) => t.entityId === id) };
  const writes = [];
  w.addEventListener("message", (e) => {
    const d = e.data;
    if (d?.__yvh !== "req") return;
    let result;
    if (d.op === "list") result = txns.map((t) => ({ id: t.entityId, date: t.date, amountMilli: t.amount, memo: t.memo || "", memoEmpty: guard.isMemoEmpty(t.memo), payee: t.payeeName, account: t.account }));
    if (d.op === "apply") { writes.push(...d.args.updates); result = guard.applyMemoUpdates(em, d.args.updates, (t) => t.payeeName, 200, "venmo"); }
    w.postMessage({ __yvh: "res", id: d.id, ok: true, result }, "*");
  });

  for (const f of ["shared.js", "venmo-shared.js", "ynab-helper.js", "amazon-ynab.js", "venmo-ynab.js"]) w.eval(src(f));
  const $ = (id) => w.document.getElementById("yvh-host").shadowRoot.getElementById(id);
  const open = async () => {
    (await waitFor(() => w.document.querySelector(".yvh-sidebar-button"), "sidebar button")).click();
    await waitFor(() => $("bd").querySelector("table, .allset"), "table");
  };
  return { w, $, open, txns, writes, opened, data };
}

test("the Venmo button is directly under the Amazon button", async () => {
  const t = setup();
  const btn = await waitFor(() => t.w.document.querySelector(".yvh-sidebar-button"), "button");
  assert.equal(btn.textContent, "Venmo Helper");
  assert.ok(btn.previousElementSibling.classList.contains("yah-sidebar-button"));
  assert.ok(btn.previousElementSibling.previousElementSibling.classList.contains("nav-bank-connections"));
});

test("rows: a clear match is selected; a tie is not and names the other YNAB transaction", async () => {
  const t = setup();
  await t.open();
  const box = (id) => t.$("bd").querySelector(`input[data-id="${id}"]`);
  assert.equal(box("y1").checked, true);
  assert.match(t.$("bd").textContent, /Venmo to Alex Doe: Concert/);
  assert.equal(box("y2").checked, false);
  assert.match(t.$("bd").textContent, /Another YNAB transaction fits this Venmo transaction just as well: 2026-11-09, -\$50\.00, memo “Paid Kim”/);
  assert.equal(t.$("apply").textContent, "Write 1 memo");
});

test("the unmatched list opens and a checkbox click stays, although the page cancels clicks", async () => {
  const t = setup();
  await t.open();
  const details = t.$("bd").querySelector("details#unmatched");
  assert.match(details.querySelector("summary").textContent, /^1 YNAB Venmo transaction with an empty memo and no Venmo match$/);
  details.querySelector("summary").click();
  assert.equal(details.open, true);
  t.$("bd").querySelector('input[data-id="y2"]').click();
  await waitFor(() => t.$("apply").textContent === "Write 2 memos", "count update");
});

test("write shows the progress overlay, writes the selected memos, and reports the result", async () => {
  const t = setup();
  await t.open();
  t.$("apply").click();
  await waitFor(() => !t.$("overlay").hidden, "progress overlay");
  assert.match(t.$("ptext").textContent, /Writing 1 memo to YNAB/);
  await waitFor(() => t.$("msg").textContent, "result message", 5000);
  assert.equal(t.$("overlay").hidden, true);
  assert.deepEqual(t.writes.map((u) => [u.id, u.memo]), [["y1", "Venmo to Alex Doe: Concert"]]);
  assert.match(t.$("msg").textContent, /^Wrote 1 memo\./);
});

test("links in the dialog open in a new tab", async () => {
  const t = setup();
  await t.open();
  t.$("st").querySelector("a[href]").click();
  assert.equal(t.opened[0], "https://account.venmo.com/?feed=mine");
});

test("the Venmo dialog has the same Instructions section as the Amazon dialog", async () => {
  const t = setup();
  await t.open();
  const instr = await waitFor(() => t.$("st").querySelector("details.instr"), "instructions");
  assert.equal(instr.open, true, "open by default");
  assert.equal(instr.querySelector("summary").textContent, "Instructions:");
  const steps = [...instr.querySelectorAll("ol > li")].map((li) => li.textContent);
  assert.deepEqual(steps, [
    "Open Venmo in a new tab ↗",
    "Wait for it to say Ready. Click Load older transactions there to go further back.",
    "Come back here. Check the memos below, then click Write memos.",
  ]);
  // Same element and classes as the Amazon dialog, so the same styles apply.
  const amazon = t.w.document.getElementById("yah-host").shadowRoot;
  assert.equal(amazon.querySelector("style").textContent, t.w.document.getElementById("yvh-host").shadowRoot.querySelector("style").textContent);
  // Collapsing it is remembered for the Venmo helper only.
  instr.querySelector("summary").click();
  await waitFor(() => t.data.uiPrefs?.venmo?.instructionsCollapsed === true, "pref saved");
  assert.equal(t.data.uiPrefs.amazon, undefined);
});
