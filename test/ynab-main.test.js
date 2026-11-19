// ynab-bridge.js + amazon-ynab-main.js run in YNAB's page. These tests load them
// with the real guard.js into a sandbox with a fake YNAB entity manager, and talk
// to them through the same postMessage bridge the extension uses.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const src = (f) => fs.readFileSync(path.join(__dirname, "../extension", f), "utf8");

// A YNAB date object like the real one (DateWithoutTime with getUTCTime).
const ynabDate = (iso) => ({ getUTCTime: () => Date.parse(iso + "T00:00:00Z") });

function makePage(transactions, { withYnab = true } = {}) {
  const listeners = [];
  const replies = [];
  const txns = transactions.map((t) => ({ setMemo(v) { this.memo = v; }, ...t }));
  let inner; // the sandbox's own global, which the script sees as `window`
  const window = {
    addEventListener: (type, fn) => type === "message" && listeners.push(fn),
    postMessage: (data) => {
      if (data.__yah === "res") replies.push(data);
      else for (const fn of listeners) fn({ source: inner, data });
    },
  };
  if (withYnab) {
    window.ynab = { YNABSharedLib: { defaultInstance: { entityManager: {
      getAllTransactions: () => txns,
      getTransactionById: (id) => txns.find((t) => t.entityId === id),
      performAsSingleChangeSet: (fn) => fn(),
    } } } };
  }
  const ctx = vm.createContext(window);
  inner = vm.runInContext("globalThis.window = globalThis", ctx); // like a browser: window is the global
  vm.runInContext(src("guard.js"), ctx);
  vm.runInContext(src("ynab-bridge.js"), ctx);
  vm.runInContext(src("amazon-ynab-main.js"), ctx);
  const send = (op, args, id = `t${replies.length}`) => {
    window.postMessage({ __yah: "req", id, op, args });
    return replies.find((r) => r.id === id);
  };
  return { send, txns, inner, replies, listeners };
}

const amz = (id, extra = {}) => ({ entityId: id, payeeName: "Amazon", amount: -10000, memo: null, date: ynabDate("2026-11-10"), isTombstone: false, account: { accountName: "Slush" }, ...extra });

test("list returns only Amazon transactions on or after `since`, with memoEmpty", () => {
  const p = makePage([
    amz("a"),
    amz("b", { memo: "has text" }),
    amz("c", { payeeName: "Grocer" }),
    amz("d", { payeeName: "Transfer", originalImportedPayee: "PURCHASE AMAZON MARK* 123" }),
    amz("old", { date: ynabDate("2026-01-01") }),
    amz("gone", { isTombstone: true }),
    amz("nodate", { date: null }),
  ]);
  const r = p.send("list", { since: "2026-11-01" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.result.map((t) => [t.id, t.date, t.amountMilli, t.memoEmpty, t.account]), [
    ["a", "2026-11-10", -10000, true, "Slush"],
    ["b", "2026-11-10", -10000, false, "Slush"],
    ["d", "2026-11-10", -10000, true, "Slush"],
  ]);
});

test("list reads other YNAB date shapes", () => {
  const p = makePage([
    amz("s", { date: "2026-11-11T00:00:00Z" }),
    amz("iso", { date: { toISOString: () => "2026-11-12" } }),
    amz("fmt", { date: { format: () => "2026-11-13" } }),
  ]);
  assert.deepEqual(p.send("list", {}).result.map((t) => t.date), ["2026-11-11", "2026-11-12", "2026-11-13"]);
});

test("apply goes through the guard: only empty memos are written", () => {
  const p = makePage([amz("a"), amz("b", { memo: "keep" })]);
  const r = p.send("apply", { updates: [{ id: "a", memo: "new", amountMilli: -10000 }, { id: "b", memo: "new", amountMilli: -10000 }] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.result.written, ["a"]);
  assert.equal(p.txns[0].memo, "new");
  assert.equal(p.txns[1].memo, "keep");
});

test("unknown and prototype operations are rejected", () => {
  const p = makePage([amz("a")]);
  for (const op of ["constructor", "toString", "__proto__", "nope", 5]) {
    const r = p.send(op, {});
    assert.equal(r.ok, false, String(op));
    assert.match(r.error, /unknown op/);
  }
});

test("messages from other sources or of other kinds are ignored", () => {
  const p = makePage([amz("a")]);
  for (const fn of p.listeners) fn({ source: {}, data: { __yah: "req", id: "x", op: "list" } });
  for (const fn of p.listeners) fn({ source: p.inner, data: { __yah: "other", id: "y", op: "list" } });
  assert.equal(p.replies.length, 0);
});

test("a clear error while YNAB is still loading", () => {
  const p = makePage([], { withYnab: false });
  assert.match(p.send("list", {}).error, /not ready/);
  assert.match(p.send("apply", { updates: [] }).error, /not ready/);
});

test("list skips YNAB's hidden copy of a matched import", () => {
  const p = makePage([amz("hidden", { source: "matched_import", matchedTransactionId: "shown" }), amz("shown", { source: "Imported", memo: "typed by hand", matchedTransactionId: "hidden" })]);
  const r = p.send("list", {});
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.result.map((t) => t.id), ["shown"]);
});
