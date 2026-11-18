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

test("confidence gate: no memo unless every order loaded with items", () => {
  const good = { items: [{ title: "Widget", qty: 1 }], shipTo: { name: "Pat", addressLines: [] }, orderer: "Pat" };
  assert.equal(Y.buildMemo({ amountCents: -1, orderIds: ["A"] }, { A: { error: "boom" } }), null, "failed order");
  assert.equal(Y.buildMemo({ amountCents: -1, orderIds: ["A", "B"] }, { A: good }), null, "second order still loading");
  assert.equal(Y.buildMemo({ amountCents: -1, orderIds: ["A"] }, { A: { ...good, items: [] } }), null, "no items");
  assert.equal(Y.buildMemo({ amountCents: -1, orderIds: [] }, { A: good }), null, "no orders");
  assert.match(Y.buildMemo({ amountCents: -1, orderIds: ["A", "B"] }, { A: good, B: good }), /^Widget; Widget \|/);
});

test("memo is never cut: links stay whole and the length stays within the limit", () => {
  const long = (n) => ({ items: [{ title: `Product number ${n} with a very long descriptive name and more words`, qty: 1 }], shipTo: { name: `Person Number ${n} Longname`, addressLines: ["1 A ST", "SPRINGFIELD, IL 62701"] }, orderer: `Orderer${n}` });
  const ids = ["111-0000001-0000001", "112-0000002-0000002"];
  const memo = Y.buildMemo({ amountCents: -1, orderIds: ids }, { [ids[0]]: long(1), [ids[1]]: long(2) });
  assert.ok(memo.length <= 200, `${memo.length}: ${memo}`);
  const links = memo.match(Y.ORDER_URL_RE) || [];
  assert.ok(links.length >= 1, memo);
  for (const l of links) assert.ok(ids.some((id) => l === Y.orderUrl(id)), `whole link: ${l}`);
  assert.ok(!/orderID=[^ |]*$/.test(memo) || links.length, memo);
  // Every link that starts in the memo is complete.
  const starts = memo.split("https://").length - 1;
  assert.equal(starts, links.length, memo);
});

test("matcher: rejects bad dates and amounts, keeps the window, flags ties", () => {
  const ynab = [{ id: "y", date: "2026-01-10", amountMilli: -10000 }];
  const az = (key, date, amountCents = -1000) => ({ key, date, amountCents, orderIds: ["X"] });
  assert.equal(Y.matchTransactions(ynab, [az("a", null)]).length, 0, "null date");
  assert.equal(Y.matchTransactions(ynab, [az("a", "not a date")]).length, 0, "bad date");
  assert.equal(Y.matchTransactions(ynab, [az("a", "2026-01-10", NaN)]).length, 0, "bad amount");
  assert.equal(Y.matchTransactions(ynab, [az("a", "2026-01-05")]).length, 1, "5 days before: in window");
  assert.equal(Y.matchTransactions(ynab, [az("a", "2026-01-04")]).length, 0, "6 days before: out");
  assert.equal(Y.matchTransactions(ynab, [az("a", "2026-01-12")]).length, 1, "2 days after: in window");
  assert.equal(Y.matchTransactions(ynab, [az("a", "2026-01-13")]).length, 0, "3 days after: out");
  const tie = Y.matchTransactions(ynab, [az("a", "2026-01-09"), az("b", "2026-01-09")]);
  assert.equal(tie.length, 1);
  assert.equal(tie[0].ambiguous, true);
});

test("amount sign pattern only accepts + - and the minus sign", () => {
  assert.equal(Y.parseAmountCents("−$5.00"), -500);
  assert.equal(Y.parseAmountCents("Z$1.00"), -100, "unknown prefix is ignored, amount is a charge");
});

test("fitItems: one long item is shortened to the room, with the count of the rest", () => {
  const out = Y.fitItems(["A".repeat(30) + " word word word word", "second"], 25);
  assert.ok(out.length <= 25, out);
  assert.match(out, /… \+1 more$/);
  assert.equal(Y.fitItems(["short", "items"], 50), "short; items");
});

test("shorten keeps short text and cuts long text at a word", () => {
  assert.equal(Y.shorten("  a   b  ", 10), "a b");
  assert.equal(Y.shorten("alpha beta gamma delta", 12), "alpha beta…");
});
