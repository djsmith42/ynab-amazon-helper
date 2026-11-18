// The Amazon side (amazon.js) in a simulated browser (jsdom): collecting rows,
// fetching order pages, the status panel, failures, sign-in, and the pause while
// Amazon shows its "Something went wrong" error. Order fetches start about 4 s
// after new rows appear (by design), so these tests take a few seconds each.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM, VirtualConsole } = require("jsdom");

const src = (f) => fs.readFileSync(path.join(__dirname, "../extension", f), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

const row = (date, amount, order, status = "Charged") => `
  <a data-testid="transaction-link">
    <span data-testid="text">${date}</span><span data-testid="text">·</span><span data-testid="text">AMAZON MARKETPLACE</span>
    <span data-testid="method-details-number">1234</span>
    <div data-testid="text">Order #${order}</div>
    <div data-testid="text">${amount}</div><div data-testid="text">${status}</div>
  </a>`;
const orderPage = (title) => `<html><head><title>Order Details</title></head><body>
  <div data-component="orderDate">November 10, 2026</div>
  <div data-component="shippingAddress"><h5>Ship to</h5><ul><li>Pat Doe</li><li>1 MAIN ST<br>SPRINGFIELD, IL 62701</li></ul></div>
  <div data-component="purchasedItems"><div data-component="itemTitle">${title}</div></div></body></html>`;

function setup({ rows, fetchImpl, extraHtml = "" }) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>
    <span id="nav-link-accountList-nav-line-1">Hello, Pat</span>
    <div id="list">${rows.join("")}</div>${extraHtml}</body></html>`, {
    runScripts: "outside-only", pretendToBeVisual: true, url: "https://www.amazon.com/cpe/yourpayments/transactions", virtualConsole: new VirtualConsole(),
  });
  const w = dom.window;
  // jsdom has no layout; treat every element in the page as visible.
  Object.defineProperty(w.HTMLElement.prototype, "offsetParent", { get() { return this.isConnected ? w.document.body : null; } });
  const data = {};
  w.chrome = {
    runtime: { id: "test" },
    storage: { local: {
      get: async (keys) => Object.fromEntries((typeof keys === "string" ? [keys] : keys).filter((k) => k in data).map((k) => [k, structuredClone(data[k])])),
      set: async (obj) => { for (const [k, v] of Object.entries(obj)) data[k] = structuredClone(v); },
      remove: async (keys) => { for (const k of keys) delete data[k]; },
    } },
  };
  const fetched = [];
  w.fetch = async (url) => { fetched.push(url); return fetchImpl(url); };
  w.eval(src("shared.js"));
  w.eval(src("amazon-parse.js"));
  w.eval(src("amazon.js"));
  const panel = () => w.document.getElementById("yah-panel-host").shadowRoot;
  const pill = () => panel().getElementById("pill").textContent.trim();
  return { w, data, fetched, panel, pill };
}

const ok = (title) => async (url) => ({ url, status: 200, text: async () => orderPage(title(url)) });

test("collects rows, reads each order, and shows Ready", async () => {
  const t = setup({
    rows: [
      row("Nov 10, 2026", "-$10.00", "111-0000001-0000001"),
      row("Nov 10, 2026", "-$10.00", "111-0000001-0000001"), // same charge twice on one page
      row("Nov 9, 2026", "+$5.00", "D01-0000002-0000002", "Refunded"),
    ],
    fetchImpl: ok((url) => `Item for ${url.slice(-19)}`),
  });
  await waitFor(() => /^✅ ?Ready: Open YNAB and click Amazon Helper$/.test(t.pill()), "Ready pill", 15000);
  assert.deepEqual(Object.keys(t.data.amazonTxns).sort(), [
    "2026-11-09|500|D01-0000002-0000002#1",
    "2026-11-10|-1000|111-0000001-0000001#1",
    "2026-11-10|-1000|111-0000001-0000001#2",
  ]);
  assert.equal(t.data.accountName, "Pat");
  const o = t.data.orders["111-0000001-0000001"];
  assert.deepEqual(o.items, [{ title: "Item for 111-0000001-0000001", qty: 1 }]);
  assert.equal(o.orderer, "Pat");
  assert.equal(o.ordererFromAccount, true);
  assert.equal(t.fetched.length, 2, "each order is fetched once");
  assert.match(t.fetched.find((u) => u.includes("D01-")), /your-orders\/order-details/);
  assert.equal(t.panel().getElementById("retry").hidden, true, "no failures: no retry button");
  assert.match(t.panel().getElementById("body").textContent, /Imported 2 orders/);
  assert.equal(t.panel().querySelectorAll(".bar").length, 0, "no progress bar when every order is read");
  assert.equal(t.data.amazonStatus.kind, "ok");
});

test("a robot check fails the order; Retry failed orders fixes it", async () => {
  let robot = true;
  const t = setup({
    rows: [row("Nov 10, 2026", "-$10.00", "111-0000001-0000001")],
    fetchImpl: async (url) => ({ url, status: 200, text: async () => (robot ? "<html><head><title>Robot Check</title></head><body>captcha</body></html>" : orderPage("Widget")) }),
  });
  await waitFor(() => /order failed|robot check/i.test(t.pill()), "failure pill", 15000);
  assert.match(t.data.orders["111-0000001-0000001"].error, /robot check/);
  assert.equal(t.panel().getElementById("retry").hidden, false, "retry button shows when something failed");
  robot = false;
  t.panel().getElementById("retry").click();
  await waitFor(() => /^✅ ?Ready/.test(t.pill()), "Ready after retry", 15000);
  assert.deepEqual(t.data.orders["111-0000001-0000001"].items, [{ title: "Widget", qty: 1 }]);
  assert.equal(t.panel().getElementById("retry").hidden, true);
});

test("a sign-in redirect stops fetching and says so", async () => {
  const t = setup({
    rows: [row("Nov 10, 2026", "-$10.00", "111-0000001-0000001"), row("Nov 9, 2026", "-$20.00", "111-0000002-0000002"), row("Nov 8, 2026", "-$30.00", "111-0000003-0000003")],
    fetchImpl: async () => ({ url: "https://www.amazon.com/ap/signin?x", status: 200, text: async () => "<html></html>" }),
  });
  await waitFor(() => /Sign in to Amazon/.test(t.pill()), "sign-in pill", 15000);
  await sleep(300);
  assert.ok(t.fetched.length <= 2, `stopped early (${t.fetched.length} fetches; 2 run at a time)`);
  assert.match(t.data.orders[Object.keys(t.data.orders)[0]].error, /sign in again/);
});

test("order fetches wait while Amazon shows its list error", async () => {
  const t = setup({
    rows: [row("Nov 10, 2026", "-$10.00", "111-0000001-0000001")],
    fetchImpl: ok(() => "Widget"),
    extraHtml: `<div id="err">Something went wrong. <button id="try">Try Again</button></div>`,
  });
  await sleep(5500); // past the normal 4 s quiet time
  assert.equal(t.fetched.length, 0, "no order fetches while the error shows");
  assert.match(t.pill(), /Amazon rate limit, retrying slowly/);
  assert.match(t.panel().getElementById("body").textContent, /Orders read\s*0 of 1/, "labeled bar with its count while orders are left");
  assert.match(t.panel().getElementById("body").textContent, /Amazon is limiting requests\..*Plan to wait up to an hour.*Leave this tab open/s, "instructions while limited");
  t.w.document.getElementById("err").remove(); // Amazon recovers
  await waitFor(() => /^✅ ?Ready/.test(t.pill()), "Ready after the error clears", 15000);
  assert.equal(t.fetched.length, 1);
  assert.equal(t.panel().querySelector(".limit"), null, "instructions go away");
  assert.equal(t.data.rateLimitLog?.length, 1, "the limit's duration is saved");
  assert.ok(t.data.rateLimitLog[0].end > t.data.rateLimitLog[0].start);
});
