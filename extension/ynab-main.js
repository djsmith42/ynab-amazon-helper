// Runs in YNAB's page (MAIN world) so it can use YNAB's own data layer, the same
// one the YNAB UI uses. Changes made here sync to YNAB like a normal edit and
// can be undone with YNAB's Undo.
//
// Protocol (window.postMessage):
//   request:  { __yah: "req", id, op: "list" | "apply", args }
//   response: { __yah: "res", id, ok, result | error }
(() => {
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

  function list({ since } = {}) {
    const m = em();
    if (!m) throw new Error("YNAB data is not ready yet. Wait for the budget to load.");
    const out = [];
    allTransactions(m).forEach((t) => {
      if (t.isTombstone) return;
      const date = isoDate(t.date);
      if (!date || (since && date < since)) return;
      const payee = str(t.payeeName || t.payee);
      const imported = str(t.importedPayee);
      const original = str(t.originalImportedPayee);
      if (!/amazon|amzn/i.test(`${payee} ${imported} ${original}`)) return;
      out.push({
        id: t.entityId,
        date,
        amountMilli: t.amount,
        memo: t.memo || "",
        payee,
        original,
        account: str(t.accountName || t.account?.accountName || t.account),
        isSplit: !!t.isSplit,
      });
    });
    return out;
  }

  // Writes memos ONLY on transactions whose memo is empty (null or ""). Any other
  // memo, even one with only spaces, is left alone. The check runs here, on YNAB's
  // live data at write time, so a memo typed after the preview is also safe.
  function apply({ updates }) {
    const m = em();
    if (!m) throw new Error("YNAB data is not ready yet.");
    let changed = 0;
    const skipped = [];
    m.performAsSingleChangeSet(() => {
      for (const u of updates) {
        const t = m.getTransactionById(u.id);
        if (!t) { skipped.push({ id: u.id, reason: "not found" }); continue; }
        if (t.memo != null && t.memo !== "") { skipped.push({ id: u.id, reason: "already has a memo" }); continue; }
        if (typeof t.setMemo === "function") t.setMemo(u.memo);
        else t.memo = u.memo;
        changed++;
      }
    });
    // Read back so the caller can confirm the values took.
    const confirmed = updates.filter((u) => m.getTransactionById(u.id)?.memo === u.memo).length;
    return { changed, confirmed, skipped };
  }

  const ops = { list, apply };
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.data?.__yah !== "req") return;
    const { id, op, args } = e.data;
    let reply;
    try {
      if (!ops[op]) throw new Error(`unknown op ${op}`);
      reply = { __yah: "res", id, ok: true, result: ops[op](args || {}) };
    } catch (err) {
      reply = { __yah: "res", id, ok: false, error: String(err?.message || err) };
    }
    window.postMessage(reply, "*");
  });
})();
