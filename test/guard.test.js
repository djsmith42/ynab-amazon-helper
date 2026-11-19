// The write guard (applyMemoUpdates) is the one place that protects the hard rule:
// never change a memo that is not empty. These tests use a fake YNAB entity manager.
const test = require("node:test");
const assert = require("node:assert");
const Y = require("../extension/guard.js");

function fakeYnab(txns) {
  const byId = new Map(txns.map((t) => [t.entityId, { ...t, setMemo(v) { this.memo = v; } }]));
  return {
    byId,
    changeSets: 0,
    performAsSingleChangeSet(fn) { this.changeSets++; fn(); },
    getTransactionById(id) { return byId.get(id); },
  };
}
const payee = (t) => `${t.payeeName || ""} ${t.originalImportedPayee || ""}`;
const amz = (id, extra = {}) => ({ entityId: id, payeeName: "Amazon", amount: -10000, memo: null, ...extra });

test("isMemoEmpty: only null and empty string are empty", () => {
  assert.equal(Y.isMemoEmpty(null), true);
  assert.equal(Y.isMemoEmpty(""), true);
  for (const v of [undefined, " ", "x", 0, {}, []]) assert.equal(Y.isMemoEmpty(v), false, JSON.stringify(v));
});

test("writes empty memos and never touches memos that have text", () => {
  const m = fakeYnab([amz("a"), amz("b", { memo: "" }), amz("c", { memo: "keep me" }), amz("d", { memo: " " })]);
  const r = Y.applyMemoUpdates(m, ["a", "b", "c", "d"].map((id) => ({ id, memo: `new ${id}`, amountMilli: -10000 })), payee);
  assert.deepEqual(r.written, ["a", "b"]);
  assert.equal(r.confirmed, 2);
  assert.equal(m.byId.get("c").memo, "keep me");
  assert.equal(m.byId.get("d").memo, " ");
  assert.deepEqual(r.skipped.map((s) => [s.id, s.reason]), [["c", "already has a memo"], ["d", "already has a memo"]]);
  assert.equal(m.changeSets, 1, "one change set, so one Undo reverts all");
});

test("fails closed on an unknown memo shape", () => {
  const t = amz("a");
  delete t.memo; // memo is undefined, as if YNAB renamed the property
  const m = fakeYnab([t]);
  const r = Y.applyMemoUpdates(m, [{ id: "a", memo: "x", amountMilli: -10000 }], payee);
  assert.deepEqual(r.written, []);
  assert.equal(r.skipped[0].reason, "unknown memo shape");
  assert.equal(m.byId.get("a").memo, undefined);
});

test("skips when setMemo is missing instead of writing the property", () => {
  const m = fakeYnab([amz("a")]);
  m.byId.get("a").setMemo = undefined;
  const r = Y.applyMemoUpdates(m, [{ id: "a", memo: "x", amountMilli: -10000 }], payee);
  assert.deepEqual(r.written, []);
  assert.equal(r.skipped[0].reason, "YNAB cannot set memos here");
  assert.equal(m.byId.get("a").memo, null);
});

test("re-checks payee, amount, deletion, and the request itself", () => {
  const m = fakeYnab([amz("gone", { isTombstone: true }), amz("shop", { payeeName: "Grocer" }), amz("amt", { amount: -20000 }), amz("ok")]);
  const r = Y.applyMemoUpdates(m, [
    { id: "missing", memo: "x", amountMilli: -10000 },
    { id: "gone", memo: "x", amountMilli: -10000 },
    { id: "shop", memo: "x", amountMilli: -10000 },
    { id: "amt", memo: "x", amountMilli: -10000 },
    { id: "ok", memo: "   ", amountMilli: -10000 },
    { id: "ok", memo: "y".repeat(201), amountMilli: -10000 },
    { id: "ok", memo: "x" },
    { id: 5, memo: "x", amountMilli: -10000 },
  ], payee);
  assert.deepEqual(r.written, []);
  assert.deepEqual(r.skipped.map((s) => s.reason), ["not found", "not found", "not an Amazon transaction", "amount changed", "bad memo", "bad memo", "bad request", "bad request"]);
});

test("refuses very large batches", () => {
  const m = fakeYnab([]);
  assert.throws(() => Y.applyMemoUpdates(m, new Array(Y.MAX_BATCH + 1).fill({ id: "a", memo: "x", amountMilli: 1 }), payee), /Too many/);
});

test("never writes YNAB's hidden copy of a matched import", () => {
  const m = fakeYnab([amz("hidden", { source: "matched_import", matchedTransactionId: "shown" }), amz("shown", { source: "Imported", matchedTransactionId: "hidden" })]);
  const r = Y.applyMemoUpdates(m, ["hidden", "shown"].map((id) => ({ id, memo: "x", amountMilli: -10000 })), payee);
  assert.deepEqual(r.written, ["shown"]);
  assert.equal(m.byId.get("hidden").memo, null);
  assert.deepEqual(r.skipped.map((s) => [s.id, s.reason]), [["hidden", "hidden matched import"]]);
});

test("the Venmo helper writes only Venmo payees", () => {
  const m = fakeYnab([amz("amazon"), amz("venmo", { payeeName: "Venmo" })]);
  const r = Y.applyMemoUpdates(m, ["amazon", "venmo"].map((id) => ({ id, memo: "x", amountMilli: -10000 })), payee, Y.MAX_MEMO_LENGTH, "venmo");
  assert.deepEqual(r.written, ["venmo"]);
  assert.deepEqual(r.skipped.map((s) => [s.id, s.reason]), [["amazon", "not a Venmo transaction"]]);
  assert.throws(() => Y.applyMemoUpdates(m, [], payee, Y.MAX_MEMO_LENGTH, "nope"), /unknown payee check/);
});
