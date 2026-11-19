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

  /**
   * True for YNAB's hidden copy of a matched bank import. When YNAB matches an
   * import to a transaction you entered, it keeps the import as a hidden copy
   * (source "matched_import", linked by matchedTransactionId). The copy does not
   * show in the register, so it is never listed or written.
   */
  const isHiddenMatch = (t) => !!t && t.source === "matched_import";

  /** True when payee text looks like Amazon. */
  const isAmazonText = (text) => /amazon|amzn/i.test(String(text || ""));

  /** True when payee text looks like Venmo. */
  const isVenmoText = (text) => /venmo/i.test(String(text || ""));

  /**
   * The payee checks the guard knows, with the skip reason for a wrong payee.
   * A new helper adds its payee check here.
   */
  const PAYEES = {
    amazon: { test: isAmazonText, reason: "not an Amazon transaction" },
    venmo: { test: isVenmoText, reason: "not a Venmo transaction" },
  };

  const MAX_BATCH = 500;

  /**
   * The write guard. Runs in YNAB's page with YNAB's entity manager `m`. It writes
   * a memo only when ALL of these hold, and skips with a reason otherwise:
   * - the request is well formed (string id, non-empty string memo within the limit, number amount);
   * - the transaction exists, is not deleted, is not a hidden matched import, has the
   *   helper's payee (`payee`: "amazon" or "venmo"), and has the expected amount;
   * - its current memo is empty by isMemoEmpty (fails closed on any unknown shape);
   * - YNAB's own setMemo() is available (no direct property writes).
   * payeeText(t) returns the transaction's payee texts joined, for the payee check.
   * Returns { written: [ids], confirmed, skipped: [{id, reason}] }.
   */
  function applyMemoUpdates(m, updates, payeeText, maxMemoLength = MAX_MEMO_LENGTH, payee = "amazon") {
    const check = PAYEES[payee];
    if (!check) throw new Error(`unknown payee check ${payee}`);
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
        if (isHiddenMatch(t)) { skip("hidden matched import"); continue; }
        if (!check.test(payeeText(t))) { skip(check.reason); continue; }
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

  const api = { MAX_BATCH, MAX_MEMO_LENGTH, PAYEES, isMemoEmpty, isHiddenMatch, isAmazonText, isVenmoText, applyMemoUpdates };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.YAHGuard = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
