// Shared helpers. Loaded as a plain script in content scripts and as a CommonJS
// module in Node tests (see test/).
(function (root) {
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

  const SETTINGS_DEFAULTS = {
    maxMemoLength: 200, // YNAB truncates long memos; keep them readable.
    maxTitleLength: 45, // each product name is shortened to this many characters
    dateWindowDays: 5, // bank posting date may lag the Amazon charge date
    includeOrderLink: true, // order-details URL at the end of the memo
  };

  /** "Nov 17, 2026" or "November 17, 2026" -> "2026-11-17" */
  function parseAmazonDate(text) {
    const m = String(text || "").match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})/);
    if (!m) return null;
    const mon = MONTHS[m[1].toLowerCase()];
    if (!mon) return null;
    return `${m[3]}-${String(mon).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`;
  }

  /** "-$244.92" -> -24492 (cents). "+$7.57" -> 757. */
  function parseAmountCents(text) {
    const m = String(text || "").replace(/[\s,]/g, "").match(/([+\-−]?)\$(\d+(?:\.\d{1,2})?)/);
    if (!m) return null;
    const cents = Math.round(parseFloat(m[2]) * 100);
    return m[1] === "+" ? cents : -cents;
  }

  /** Order-details URLs that orderUrl() makes. Global flag: use with String.match. */
  const ORDER_URL_RE = /https:\/\/www\.amazon\.com\/(?:gp\/css\/summary\/edit\.html|your-orders\/order-details)\?orderID=[A-Z0-9]{3}-\d{7}-\d{7}/g;

  /** Order-details page URL. Digital orders (D01-…) use a different page. */
  function orderUrl(id) {
    return /^D01-/.test(id)
      ? `https://www.amazon.com/your-orders/order-details?orderID=${id}`
      : `https://www.amazon.com/gp/css/summary/edit.html?orderID=${id}`;
  }

  function daysBetween(isoA, isoB) {
    return Math.round((Date.parse(isoA + "T00:00:00Z") - Date.parse(isoB + "T00:00:00Z")) / 86400000);
  }

  function shorten(text, max) {
    const s = String(text || "").replace(/\s+/g, " ").trim();
    if (s.length <= max) return s;
    const cut = s.slice(0, max - 1);
    const sp = cut.lastIndexOf(" ");
    return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:|\-–]+$/, "") + "…";
  }

  /**
   * City only, in title case: ["12 ELM ST", "SALT LAKE CITY, UT 84101-1234"] -> "Salt Lake City".
   * The city is the text before the comma on the line that ends with "ST 12345".
   */
  function cityFromAddress(lines) {
    const line = (lines || []).find((l) => /,\s*[A-Z]{2}\s+\d{5}(-\d{4})?\s*$/i.test(l.trim()));
    if (!line) return "";
    const city = line.split(",")[0].trim();
    return city.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (m, p, c) => p + c.toUpperCase());
  }

  /**
   * Builds the memo for one Amazon transaction, or returns null when the data is
   * not complete enough to write. A written memo is never replaced, so a memo is
   * only made when every order of the transaction loaded and has items.
   * txn: { amountCents, orderIds }
   * orders: map orderId -> { items: [{title, qty}], shipTo: {name, addressLines}, orderer } | { error }
   *
   * The memo is assembled from whole parts and never cut, so an order link is
   * always complete. When it is too long, it shortens the item list first, then
   * drops the second link, the orderer, and the ship-to part, in that order.
   */
  function buildMemo(txn, orders, settings = SETTINGS_DEFAULTS) {
    const s = { ...SETTINGS_DEFAULTS, ...settings };
    if (!txn || !Array.isArray(txn.orderIds) || !txn.orderIds.length) return null;
    const known = txn.orderIds.map((id) => orders[id]);
    if (known.some((o) => !o || o.error || !Array.isArray(o.items) || !o.items.length)) return null;

    const items = [];
    for (const o of known) for (const it of o.items) items.push((it.qty > 1 ? `${it.qty}x ` : "") + shorten(it.title, s.maxTitleLength));
    const shipTo = [...new Set(known.map((o) => [o.shipTo?.name, cityFromAddress(o.shipTo?.addressLines)].filter(Boolean).join(", ")).filter(Boolean))];
    const by = [...new Set(known.map((o) => o.orderer).filter(Boolean))];
    const prefix = txn.amountCents > 0 ? "Refund: " : "";

    // Tail parts, in the order they show. `drop` is the order they are removed in when space runs out.
    const links = s.includeOrderLink ? txn.orderIds.slice(0, 2).map(orderUrl) : [];
    const parts = [
      shipTo.length && { text: `To: ${shipTo.join("; ")}`, drop: 3 },
      by.length && { text: `By: ${by.join(", ")}`, drop: 2 },
      links[0] && { text: links[0], drop: 4 },
      links[1] && { text: links[1], drop: 1 },
    ].filter(Boolean);

    const MIN_ITEMS = 20; // keep at least this much room for the products
    const tailOf = (ps) => (ps.length ? " | " + ps.map((p) => p.text).join(" | ") : "");
    let kept = parts;
    while (kept.length && s.maxMemoLength - prefix.length - tailOf(kept).length < MIN_ITEMS) {
      const worst = kept.reduce((a, b) => (b.drop < a.drop ? b : a));
      kept = kept.filter((p) => p !== worst);
    }
    const tailText = tailOf(kept);
    const room = s.maxMemoLength - prefix.length - tailText.length;
    if (room < 1) return null;
    return prefix + fitItems(items, room) + tailText;
  }

  /** Joins item names with "; " in at most `room` characters, ending with "+N more" when some do not fit. */
  function fitItems(items, room) {
    const all = items.join("; ");
    if (all.length <= room) return all;
    const kept = [];
    for (let i = 0; i < items.length; i++) {
      const more = items.length - i - 1;
      const candidate = [...kept, items[i]].join("; ") + (more ? ` +${more} more` : "");
      if (candidate.length > room) break;
      kept.push(items[i]);
    }
    if (kept.length) {
      const more = items.length - kept.length;
      return kept.join("; ") + (more ? ` +${more} more` : "");
    }
    const suffix = items.length > 1 ? ` +${items.length - 1} more` : "";
    return shorten(items[0], Math.max(1, room - suffix.length)) + suffix;
  }

  /**
   * One-to-one match of YNAB transactions to Amazon transactions.
   * ynabTxns: [{ id, date: "YYYY-MM-DD", amountMilli }]
   * amazonTxns: [{ key, date, amountCents, orderIds, status }]
   * Returns [{ ynab, amazon, dayDiff, ambiguous }].
   */
  function matchTransactions(ynabTxns, amazonTxns, windowDays = SETTINGS_DEFAULTS.dateWindowDays) {
    const pairs = [];
    const validDate = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d + "T00:00:00Z"));
    for (const y of ynabTxns) {
      if (!validDate(y.date) || !Number.isFinite(y.amountMilli)) continue;
      for (const a of amazonTxns) {
        if (!validDate(a.date) || !Number.isFinite(a.amountCents)) continue;
        if (a.amountCents * 10 !== y.amountMilli) continue;
        const diff = daysBetween(y.date, a.date); // bank usually posts on or after the Amazon date
        if (!(diff >= -2 && diff <= windowDays)) continue;
        pairs.push({ y, a, cost: Math.abs(diff) + (diff < 0 ? 0.5 : 0), diff });
      }
    }
    pairs.sort((p, q) => p.cost - q.cost);
    const usedY = new Set();
    const usedA = new Set();
    const out = [];
    for (const p of pairs) {
      if (usedY.has(p.y.id) || usedA.has(p.a.key)) continue;
      usedY.add(p.y.id);
      usedA.add(p.a.key);
      const rivals = pairs.filter((q) => q !== p && (q.y.id === p.y.id || q.a.key === p.a.key) && q.cost === p.cost);
      out.push({ ynab: p.y, amazon: p.a, dayDiff: p.diff, ambiguous: rivals.length > 0 });
    }
    return out;
  }

  const api = { SETTINGS_DEFAULTS, ORDER_URL_RE, fitItems, orderUrl, parseAmazonDate, parseAmountCents, daysBetween, shorten, cityFromAddress, buildMemo, matchTransactions };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.YAH = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
