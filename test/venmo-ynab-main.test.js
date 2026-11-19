// ynab-bridge.js + venmo-ynab-main.js run in YNAB's page with the shared write guard (guard.js).
// These tests load both into a sandbox with a fake YNAB entity manager and talk
// to them through the Venmo bridge (__yvh messages).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const src = (f) => fs.readFileSync(path.join(__dirname, "../extension", f), "utf8");
const ynabDate = (iso) => ({ getUTCTime: () => Date.parse(iso + "T00:00:00Z") });

function makePage(transactions) {
  const listeners = [];
  const replies = [];
  const txns = transactions.map((t) => ({ setMemo(v) { this.memo = v; }, ...t }));
  let inner;
  const window = {
    addEventListener: (type, fn) => type === "message" && listeners.push(fn),
    postMessage: (data) => {
      if (data.__yvh === "res") replies.push(data);
      else for (const fn of listeners) fn({ source: inner, data });
    },
    ynab: { YNABSharedLib: { defaultInstance: { entityManager: {
      getAllTransactions: () => txns,
      getTransactionById: (id) => txns.find((t) => t.entityId === id),
      performAsSingleChangeSet: (fn) => fn(),
    } } } },
  };
  const ctx = vm.createContext(window);
  inner = vm.runInContext("globalThis.window = globalThis", ctx);
  vm.runInContext(src("guard.js"), ctx);
  vm.runInContext(src("ynab-bridge.js"), ctx);
  vm.runInContext(src("venmo-ynab-main.js"), ctx);
  const send = (op, args, id = `t${replies.length}`) => {
    window.postMessage({ __yvh: "req", id, op, args });
    return replies.find((r) => r.id === id);
  };
  return { send, txns };
}

const ven = (id, extra = {}) => ({ entityId: id, payeeName: "Venmo", amount: -24000, memo: null, date: ynabDate("2026-11-10"), isTombstone: false, account: { accountName: "Checking" }, cleared: "Cleared", ...extra });

test("list returns Venmo transactions only, without hidden matched imports", () => {
  const p = makePage([ven("a"), ven("b", { payeeName: "Amazon" }), ven("hidden", { source: "matched_import" }), ven("old", { date: ynabDate("2026-01-01") })]);
  const r = p.send("list", { since: "2026-11-01" });
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.result.map((t) => [t.id, t.date, t.memoEmpty, t.cleared]), [["a", "2026-11-10", true, "cleared"]]);
});

test("apply goes through the shared guard: empty memos of Venmo payees only", () => {
  const p = makePage([ven("a"), ven("typed", { memo: "keep" }), ven("amz", { payeeName: "Amazon" })]);
  const r = p.send("apply", { updates: ["a", "typed", "amz"].map((id) => ({ id, memo: "Venmo to Alex: Pizza", amountMilli: -24000 })) });
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.result.written, ["a"]);
  assert.deepEqual(r.result.skipped.map((s) => [s.id, s.reason]), [["typed", "already has a memo"], ["amz", "not a Venmo transaction"]]);
  assert.equal(p.txns.find((t) => t.entityId === "typed").memo, "keep");
});
