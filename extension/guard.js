// The write guard: the one place that decides whether a YNAB memo may be written.
// It runs in YNAB's page (MAIN world, loaded before ynab-main.js) and in Node
// tests. It is a separate file from shared.js because Chrome injects a file only
// once per page, so one file cannot serve both the page world and the
// extension's own world.
(function (root) {
  const MAX_MEMO_LENGTH = 200; // same as SETTINGS_DEFAULTS.maxMemoLength in shared.js

  /**
   * The one rule for "this memo is empty". Only null and "" count. Anything else
   * (a string with spaces, undefined, an object) is NOT empty, so an unknown memo
   * shape is never overwritten.
   */
  const isMemoEmpty = (memo) => memo === null || memo === "";

  /** True when payee text looks like Amazon. */
  const isAmazonText = (text) => /amazon|amzn/i.test(String(text || ""));

  const MAX_BATCH = 500;

  /**
   * The write guard. Runs in YNAB's page with YNAB's entity manager `m`. It writes
   * a memo only when ALL of these hold, and skips with a reason otherwise:
   * - the request is well formed (string id, non-empty string memo within the limit, number amount);
   * - the transaction exists, is not deleted, has an Amazon payee, and has the expected amount;
   * - its current memo is empty by isMemoEmpty (fails closed on any unknown shape);
   * - YNAB's own setMemo() is available (no direct property writes).
   * payeeText(t) returns the transaction's payee texts joined, for the Amazon check.
   * Returns { written: [ids], confirmed, skipped: [{id, reason}] }.
   */
  function applyMemoUpdates(m, updates, payeeText, maxMemoLength = MAX_MEMO_LENGTH) {
    if (!Array.isArray(updates)) throw new Error("updates must be a list");
    if (updates.length > MAX_BATCH) throw new Error(`Too many memos at once (max ${MAX_BATCH}).`);
    const written = [];
    const skipped = [];
    m.performAsSingleChangeSet(() => {
      for (const u of updates) {
        const id = u && u.id;
        const skip = (reason) => skipped.push({ id: typeof id === "string" ? id : String(id), reason });
        if (typeof id !== "string" || !id) { skip("bad request"); continue; }
        if (typeof u.memo !== "string" || !u.memo.trim() || u.memo.length > maxMemoLength) { skip("bad memo"); continue; }
        if (!Number.isFinite(u.amountMilli)) { skip("bad request"); continue; }
        const t = m.getTransactionById(id);
        if (!t || t.isTombstone) { skip("not found"); continue; }
        if (!isAmazonText(payeeText(t))) { skip("not an Amazon transaction"); continue; }
        if (t.amount !== u.amountMilli) { skip("amount changed"); continue; }
        if (!isMemoEmpty(t.memo)) { skip(t.memo === undefined || typeof t.memo !== "string" ? "unknown memo shape" : "already has a memo"); continue; }
        if (typeof t.setMemo !== "function") { skip("YNAB cannot set memos here"); continue; }
        t.setMemo(u.memo);
        written.push(id);
      }
    });
    const want = new Map(updates.filter((u) => u && typeof u.id === "string").map((u) => [u.id, u.memo]));
    const confirmed = written.filter((id) => m.getTransactionById(id)?.memo === want.get(id)).length;
    return { written, confirmed, skipped };
  }

  const api = { MAX_BATCH, MAX_MEMO_LENGTH, isMemoEmpty, isAmazonText, applyMemoUpdates };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.YAHGuard = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
