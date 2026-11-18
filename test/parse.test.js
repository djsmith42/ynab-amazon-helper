// Parser tests with small sample pages (no real account data).
const test = require("node:test");
const assert = require("node:assert");
const { JSDOM, VirtualConsole } = require("jsdom");
globalThis.YAH = require("../extension/shared.js");
const A = require("../extension/amazon-parse.js");

const doc = (html) => new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { virtualConsole: new VirtualConsole() }).window.document;

test("order page: items with quantities, ship-to name and address lines, date", () => {
  const d = doc(`
    <div data-component="orderDate">November 14, 2026</div>
    <div data-component="shippingAddress"><h5>Ship to</h5><ul>
      <li><span>Pat Doe</span></li><li><span>12 ELM ST<br>SALT LAKE CITY, UT 84101-1234</span></li><li><span>United States</span></li></ul></div>
    <div data-component="sharedOrderBuyer"></div>
    <div data-component="purchasedItems"><div class="od-item-view-qty"><span>2</span></div><div data-component="itemTitle">Widget</div></div>
    <div data-component="purchasedItems"><div class="od-item-view-qty"><span>3</span></div><div data-component="itemTitle">Widget</div></div>
    <div data-component="purchasedItems"><div data-component="itemTitle">Gadget</div></div>`);
  const o = A.parseOrderPage(d);
  assert.deepEqual(o.items, [{ title: "Widget", qty: 5 }, { title: "Gadget", qty: 1 }]);
  assert.deepEqual(o.shipTo, { name: "Pat Doe", addressLines: ["12 ELM ST", "SALT LAKE CITY, UT 84101-1234", "United States"] });
  assert.equal(o.orderer, "");
  assert.equal(o.placed, "2026-11-14");
});

test("order page: digital recipient and household buyer", () => {
  const d = doc(`
    <div data-component="shippingAddress"><h5>Recipient</h5> Pat J Doe</div>
    <div data-component="sharedOrderBuyer">Ordered by Sam</div>
    <div data-component="purchasedItems"><div data-component="itemTitle">Audiobook</div></div>`);
  const o = A.parseOrderPage(d);
  assert.deepEqual(o.shipTo, { name: "Pat J Doe", addressLines: [] });
  assert.equal(o.orderer, "Sam");
});

test("transaction rows: date, amount, status, order ids; bad rows dropped", () => {
  const row = (date, amount, order, status = "Charged") => `
    <a data-testid="transaction-link">
      <span data-testid="text">${date}</span><span data-testid="text">·</span><span data-testid="text">AMAZON MARKETPLACE</span>
      <span data-testid="method-details-number">1234</span>
      <div data-testid="text">Order #${order}</div>
      <div data-testid="text">${amount}</div><div data-testid="text">${status}</div>
    </a>`;
  const d = doc(row("Nov 17, 2026", "-$244.92", "112-0000001-0000001", "Pending") + row("Nov 15, 2026", "+$7.57", "D01-0000002-0000002", "Refunded") + row("Bad date", "-$1.00", "112-0000003-0000003") + row("Nov 14, 2026", "no amount", "112-0000004-0000004"));
  const t = A.transactionsFromDom(d);
  assert.equal(t.length, 2);
  assert.deepEqual(t.map((x) => [x.date, x.amountCents, x.status, x.card, x.orders[0].id]), [
    ["2026-11-17", -24492, "Pending", "1234", "112-0000001-0000001"],
    ["2026-11-15", 757, "Refunded", "1234", "D01-0000002-0000002"],
  ]);
  assert.equal(t[1].orders[0].url, "https://www.amazon.com/your-orders/order-details?orderID=D01-0000002-0000002");
});

test("next-data rows: invalid dates or amounts are dropped", () => {
  const list = [
    { formattedDate: "Nov 17, 2026", formattedAmount: "-$10.00", orderData: [{ orderDisplayString: "Order #112-0000001-0000001" }] },
    { formattedDate: "", formattedAmount: "-$10.00", orderData: [{ orderDisplayString: "Order #112-0000002-0000002" }] },
    { formattedDate: "Nov 16, 2026", formattedAmount: "n/a", orderData: [{ orderDisplayString: "Order #112-0000003-0000003" }] },
    { formattedDate: "Nov 15, 2026", formattedAmount: "-$1.00", orderData: [] },
  ];
  const json = JSON.stringify({ props: { pageProps: { state: { transactionResponseState: { visibleTransactionResponse: { transactionList: list } } } } } });
  const d = doc(`<script id="__NEXT_DATA__" type="application/json">${json}</script>`);
  const t = A.transactionsFromNextData(d);
  assert.deepEqual(t.map((x) => x.orders[0].id), ["112-0000001-0000001"]);
});

test("next-data: missing or broken data gives no rows", () => {
  assert.deepEqual(A.transactionsFromNextData(doc("")), []);
  assert.deepEqual(A.transactionsFromNextData(doc(`<script id="__NEXT_DATA__" type="application/json">{not json</script>`)), []);
  assert.deepEqual(A.transactionsFromNextData(doc(`<script id="__NEXT_DATA__" type="application/json">{"props":{}}</script>`)), []);
});

test("account name from the nav bar", () => {
  assert.equal(A.accountName(doc(`<span id="nav-link-accountList-nav-line-1">Hello, Pat</span>`)), "Pat");
  assert.equal(A.accountName(doc(`<span id="nav-link-accountList-nav-line-1">Hello, sign in</span>`)), "");
  assert.equal(A.accountName(doc("")), "");
});

test("order page with no items or ship-to gives empty results", () => {
  const o = A.parseOrderPage(doc("<p>Robot check</p>"));
  assert.deepEqual(o, { items: [], shipTo: null, orderer: "", placed: null });
});
