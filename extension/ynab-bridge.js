// The YNAB page side of every helper (MAIN world). It uses YNAB's own data
// layer, the same one the YNAB UI uses, so changes sync to YNAB like a normal
// edit and can be undone with YNAB's Undo. guard.js is loaded before this file
// in the same world.
//
// A helper starts its bridge with one call, in its own <vendor>-ynab-main.js:
//   YNABBridge.serve({ tag: "__yah", payee: "amazon" })
// `payee` names a payee check in guard.js (PAYEES).
//
// Protocol (window.postMessage), with the helper's tag as the message key:
//   request:  { [tag]: "req", id, op: "list" | "apply", args }
//             list args:  { since: "YYYY-MM-DD" }
//             apply args: { updates: [{ id, memo, amountMilli }] }
//   response: { [tag]: "res", id, ok, result | error }
(() => {
  // Keep our own references, so later changes to the global do not affect them.
  const { isMemoEmpty, isHiddenMatch, applyMemoUpdates, MAX_MEMO_LENGTH, PAYEES } = globalThis.YAHGuard;
  const em = () => window.ynab?.YNABSharedLib?.defaultInstance?.entityManager;

  const str = (v) => {
    if (v == null) return "";
    if (typeof v === "string") return v;
    return String(v.name ?? v.getName?.() ?? "");
  };

  function isoDate(d) {
    if (!d) return null;
    if (typeof d === "string") return d.slice(0, 10);
    try {
      if (typeof d.getUTCTime === "function") return new Date(d.getUTCTime()).toISOString().slice(0, 10);
    } catch {}
    try {
      if (typeof d.toISOString === "function") return d.toISOString().slice(0, 10);
    } catch {}
    try {
      if (typeof d.format === "function") return d.format("YYYY-MM-DD");
    } catch {}
    return null;
  }

  function asArray(v) {
    if (!v) return null;
    if (Array.isArray(v)) return v;
    for (const f of ["toArray", "getAll"]) {
      try { if (typeof v[f] === "function") { const a = v[f](); if (a) return Array.isArray(a) ? a : [...a]; } } catch {}
    }
    if (Array.isArray(v._internalDataArray)) return v._internalDataArray;
    if (typeof v.forEach === "function") { const a = []; v.forEach((x) => a.push(x)); return a; }
    return null;
  }

  function allTransactions(m) {
    const tries = [() => m.getAllTransactions?.(), () => m.transactionsCollection];
    for (const t of tries) {
      try { const a = asArray(t()); if (a) return a; } catch {}
    }
    throw new Error("Could not find YNAB's transaction list. YNAB may have changed its internals.");
  }

  // YNAB's cleared flag -> "cleared" | "uncleared" | "reconciled" (unknown shapes are shown as is).
  function clearedState(c) {
    const s = str(c).toLowerCase();
    if (c === true || s === "cleared") return "cleared";
    if (s === "reconciled") return "reconciled";
    if (c === false || c == null || s === "uncleared" || s === "") return "uncleared";
    return s;
  }

  const payeeText = (t) => [str(t.payeeName || t.payee), str(t.importedPayee), str(t.originalImportedPayee)].join(" ");

  function serve({ tag, payee }) {
    const check = PAYEES[payee];
    if (!check) throw new Error(`unknown payee check ${payee}`);

    // The helper's transactions on or after `since`. Deleted transactions and
    // YNAB's hidden copies of matched imports are never listed.
    function list({ since } = {}) {
      const m = em();
      if (!m) throw new Error("YNAB data is not ready yet. Wait for the budget to load.");
      const out = [];
      allTransactions(m).forEach((t) => {
        if (t.isTombstone || isHiddenMatch(t)) return;
        const date = isoDate(t.date);
        if (!date || (since && date < since)) return;
        if (!check.test(payeeText(t))) return;
        out.push({
          id: t.entityId,
          date,
          amountMilli: t.amount,
          memo: typeof t.memo === "string" ? t.memo : "",
          memoEmpty: isMemoEmpty(t.memo),
          payee: str(t.payeeName || t.payee),
          original: str(t.originalImportedPayee),
          account: str(t.accountName || t.account?.accountName || t.account),
          cleared: clearedState(t.cleared),
          isSplit: !!t.isSplit,
        });
      });
      return out;
    }

    // Writes ONLY on empty memos, through the shared guard (applyMemoUpdates in
    // guard.js). The check runs on YNAB's live data at write time, so a memo typed
    // after the preview is also safe.
    function apply({ updates }) {
      const m = em();
      if (!m) throw new Error("YNAB data is not ready yet.");
      return applyMemoUpdates(m, updates, payeeText, MAX_MEMO_LENGTH, payee);
    }

    const ops = { list, apply };
    window.addEventListener("message", (e) => {
      if (e.source !== window || e.data?.[tag] !== "req") return;
      const { id, op, args } = e.data;
      let reply;
      try {
        if (typeof op !== "string" || !Object.hasOwn(ops, op)) throw new Error(`unknown op ${op}`);
        reply = { [tag]: "res", id, ok: true, result: ops[op](args || {}) };
      } catch (err) {
        reply = { [tag]: "res", id, ok: false, error: String(err?.message || err) };
      }
      window.postMessage(reply, "*");
    });
  }

  globalThis.YNABBridge = Object.freeze({ serve });
})();
