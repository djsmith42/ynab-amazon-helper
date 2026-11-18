// Run: node --test test/
const test = require("node:test");
const assert = require("node:assert");
const Y = require("../extension/shared.js");

test("parses Amazon dates and amounts", () => {
  assert.equal(Y.parseAmazonDate("Nov 09, 2026"), "2026-11-09");
  assert.equal(Y.parseAmazonDate("November 17, 2026 "), "2026-11-17");
  assert.equal(Y.parseAmountCents("-$244.92"), -24492);
  assert.equal(Y.parseAmountCents("+$7.57"), 757);
  assert.equal(Y.parseAmountCents("-$1,204.00"), -120400);
});

test("matches by exact amount and nearest date, one-to-one", () => {
  const ynab = [
    { id: "y1", date: "2026-11-10", amountMilli: -64450 },
    { id: "y2", date: "2026-11-12", amountMilli: -64450 },
    { id: "y3", date: "2026-11-11", amountMilli: 7570 },
    { id: "y4", date: "2026-10-01", amountMilli: -64450 }, // too far away
  ];
  const amazon = [
    { key: "a1", date: "2026-11-09", amountCents: -6445, orderIds: ["1"] },
    { key: "a2", date: "2026-11-12", amountCents: -6445, orderIds: ["2"] },
    { key: "a3", date: "2026-11-10", amountCents: 757, orderIds: ["3"] },
  ];
  const m = Object.fromEntries(Y.matchTransactions(ynab, amazon).map((x) => [x.ynab.id, x.amazon.key]));
  assert.deepEqual(m, { y1: "a1", y2: "a2", y3: "a3" });
});

test("builds a memo with items, ship-to, and orderer inside the length limit", () => {
  const orders = {
    A: { items: [{ title: "A very long product name that goes on and on about features and sizes", qty: 2 }, { title: "Second thing", qty: 1 }], shipTo: { name: "Pat Doe", addressLines: ["1 MAIN ST", "SPRINGFIELD, IL 62701-1234", "United States"] }, orderer: "Pat" },
  };
  const memo = Y.buildMemo({ amountCents: -1000, orderIds: ["A"] }, orders);
  assert.match(memo, /^2x A very long product name/);
  assert.match(memo, /Second thing/);
  assert.match(memo, /To: Pat Doe, Springfield \|/);
  assert.doesNotMatch(memo, /MAIN ST/);
  assert.match(memo, /By: Pat \| https:\/\/www\.amazon\.com\/gp\/css\/summary\/edit\.html\?orderID=A$/);
  assert.ok(memo.length <= Y.SETTINGS_DEFAULTS.maxMemoLength);
  assert.match(Y.buildMemo({ amountCents: 500, orderIds: ["A"] }, orders), /^Refund: /);
  assert.equal(Y.buildMemo({ amountCents: 500, orderIds: ["missing"] }, orders), null);

  const many = { B: { items: Array.from({ length: 12 }, (_, i) => ({ title: `Gadget number ${i} with a long descriptive name`, qty: 1 })), shipTo: { name: "Pat Doe", addressLines: [] }, orderer: "Pat" } };
  const m2 = Y.buildMemo({ amountCents: -1, orderIds: ["B"] }, many);
  assert.ok(m2.length <= 200, m2);
  assert.match(m2, /\+\d+ more \| To: Pat Doe \| By: Pat \| https:\/\/www\.amazon\.com\/gp\/css\/summary\/edit\.html\?orderID=B$/);
});

test("city from address", () => {
  assert.equal(Y.cityFromAddress(["12 ELM ST", "SALT LAKE CITY, UT 84101-1234", "United States"]), "Salt Lake City");
  assert.equal(Y.cityFromAddress(["1 Main St", "O'FALLON, MO 63366"]), "O'Fallon");
  assert.equal(Y.cityFromAddress([]), "");
});

test("digital orders link to the digital order page", () => {
  assert.equal(Y.orderUrl("D01-1238612-8966650"), "https://www.amazon.com/your-orders/order-details?orderID=D01-1238612-8966650");
});
