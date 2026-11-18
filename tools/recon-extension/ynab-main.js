// Recon v3 (MAIN world): fixed, read-only probe of YNAB's entity manager.
// It reads property names and types and a few sample transaction fields. It
// calls only zero-argument "get…Transaction…" functions. It changes nothing.
(() => {
  const post = (name, body) => {
    let text;
    try { text = JSON.stringify(body, null, 1); } catch (e) { text = `stringify failed: ${e}`; }
    window.postMessage({ __recon: true, name, body: text }, "*");
  };
  post("ynab-loaded.txt", `loaded ${location.href} ${new Date().toISOString()}`);
  const names = (o) => {
    const out = new Set();
    for (let p = o, d = 0; p && p !== Object.prototype && d < 8; p = Object.getPrototypeOf(p), d++)
      for (const k of Object.getOwnPropertyNames(p)) out.add(k);
    return [...out];
  };
  const typeOf = (o, k) => { try { const v = o[k]; return Array.isArray(v) ? `array(${v.length})` : v === null ? "null" : typeof v; } catch (e) { return `throws: ${e}`; } };
  const short = (v) => { try { return typeof v === "object" && v !== null ? `[${v.constructor?.name}] ${String(JSON.stringify(v)).slice(0, 200)}` : String(v).slice(0, 200); } catch (e) { return `[${v?.constructor?.name}] (not serializable)`; } };
  const describe = (o) => o == null ? String(o) : { ctor: o.constructor?.name, names: names(o).filter((k) => k !== "constructor").map((k) => `${k}:${typeOf(o, k)}`).slice(0, 400) };

  function sampleTxn(t) {
    const out = { describe: describe(t) };
    for (const k of ["entityId", "id", "amount", "memo", "date", "payeeName", "payee", "importedPayee", "originalImportedPayee", "accountName", "account", "isTombstone", "isSplit"]) {
      try { out[k] = short(t[k]); } catch (e) { out[k] = `throws: ${e}`; }
    }
    try {
      const d = t.date;
      out.dateDescribe = describe(d);
      for (const f of ["toISOString", "getUTCTime", "toNativeDate"]) try { out[`date.${f}`] = typeof d?.[f] === "function" ? short(d[f]()) : "n/a"; } catch (e) { out[`date.${f}`] = `throws: ${e}`; }
      try { out["date.format(YYYY-MM-DD)"] = short(d?.format?.("YYYY-MM-DD")); } catch (e) { out["date.format"] = `throws: ${e}`; }
    } catch {}
    return out;
  }

  function asArray(v) {
    if (!v) return null;
    if (Array.isArray(v)) return v;
    for (const f of ["toArray", "getAll", "values"]) try { if (typeof v[f] === "function") { const a = v[f](); if (a) return Array.isArray(a) ? a : [...a]; } } catch {}
    for (const k of ["_internalDataArray", "_data", "items", "content"]) if (Array.isArray(v[k])) return v[k];
    if (typeof v.forEach === "function") { const a = []; try { v.forEach((x) => a.push(x)); return a; } catch {} }
    return null;
  }

  function probe() {
    const r = { href: location.href };
    try {
      const lib = window.ynab?.YNABSharedLib?.defaultInstance;
      r.lib = !!lib;
      const em = lib?.entityManager;
      r.em = describe(em);
      if (!em) return r;
      r.transactionish = {};
      for (const k of names(em).filter((k) => /transaction/i.test(k))) {
        const t = typeOf(em, k);
        const entry = { type: t };
        try {
          if (t === "object") {
            entry.describe = describe(em[k]);
            const a = asArray(em[k]);
            entry.arrayLen = a ? a.length : null;
          } else if (t === "function" && /^get/.test(k) && em[k].length === 0) {
            const v = em[k]();
            const a = asArray(v);
            entry.callResult = a ? `array-like(${a.length})` : short(v);
          } else if (t === "function") {
            entry.arity = em[k].length;
          }
        } catch (e) { entry.err = String(e); }
        r.transactionish[k] = entry;
      }
      // Find a working list of transactions and sample an Amazon one.
      const sources = [
        ["transactionsCollection", () => em.transactionsCollection],
        ["getAllTransactions()", () => em.getAllTransactions?.()],
        ["transactions", () => em.transactions],
      ];
      for (const k of names(em)) if (/transaction/i.test(k) && /collection/i.test(k)) sources.push([k, () => em[k]]);
      r.sources = {};
      for (const [label, get] of sources) {
        try {
          const a = asArray(get());
          r.sources[label] = a ? a.length : "not array-like";
          if (a && a.length && !r.sample) {
            const amz = a.filter((t) => /amazon/i.test(`${short(t.payeeName)} ${short(t.payee?.name)} ${short(t.importedPayee)}`));
            r.sampleSource = label;
            r.amazonCount = amz.length;
            r.sample = sampleTxn(amz[0] || a[0]);
            r.sample2 = amz[1] ? sampleTxn(amz[1]) : null;
          }
        } catch (e) { r.sources[label] = `throws: ${e}`; }
      }
      r.has = { getTransactionById: typeof em.getTransactionById, performAsSingleChangeSet: typeof em.performAsSingleChangeSet, batchChangeProperties: typeof em.batchChangeProperties };
    } catch (e) { r.error = String(e?.stack || e); }
    return r;
  }

  // Probe at 10s and 30s, so it works after the budget finishes loading.
  for (const ms of [10000, 30000]) setTimeout(() => {
    post(`ynab-start-${ms / 1000}s.txt`, "starting probe");
    let r;
    try { r = probe(); } catch (e) { r = { fatal: String(e?.stack || e) }; }
    post(`ynab-probe-${ms / 1000}s.json`, r);
  }, ms);
})();
