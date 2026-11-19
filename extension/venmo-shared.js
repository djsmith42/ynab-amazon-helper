// Pure helpers: Venmo story -> bank-side transaction + memo, and YNAB matching.
// Loaded as a plain script in content scripts and as a CommonJS module in tests.
(function (root) {
  const MAX_MEMO = 200;

  /** "- $24.00" -> {sign:"-", cents:2400}; "$70.00" -> {sign:"", cents:7000} */
  function parseAmount(text) {
    const m = String(text || "").replace(/[\s,]/g, "").match(/^([+\-−]?)\$(\d+(?:\.\d{1,2})?)$/);
    if (!m) return null;
    return { sign: m[1] === "−" ? "-" : m[1], cents: Math.round(parseFloat(m[2]) * 100) };
  }

  /** "11/16/2026" -> "2026-11-16" */
  function usDate(text) {
    const m = String(text || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
  }

  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const cap = (s, max = MAX_MEMO) => (s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…");

  /**
   * One Venmo story (from /api/stories) -> the transaction as the bank sees it:
   * { key, date: "YYYY-MM-DD", amountCents (negative = money out of the bank), kind, party, note, memo }
   * myId: your Venmo account id (from /api/user/profile).
   * Returns null for stories with no readable amount or date.
   * - Payment you sent ("- $X"): bank charge of -X (when Venmo pulled it from the bank).
   * - Payment you received ("+ $X"): goes to the Venmo balance, so it rarely hits the bank.
   * - Transfer to bank ("$X"): bank deposit of +X, dated on the arrival date when Venmo gives one.
   */
  function parseStory(s, myId) {
    if (!s || !s.id) return null;
    const amt = parseAmount(s.amount);
    const date = typeof s.date === "string" ? s.date.slice(0, 10) : null;
    if (!amt || !date) return null;
    const note = s.note || {};
    if (s.type === "transfer") {
      const bank = [clean(note.name), note.lastFour ? `••${note.lastFour}` : ""].filter(Boolean).join(" ");
      return { key: s.id, date: usDate(note.date) || date, amountCents: amt.cents, kind: "transfer", party: bank, note: "", memo: cap(`Venmo transfer${bank ? ` to ${bank}` : ""}`), story: s, myId };
    }
    const t = s.title || {};
    const outgoing = amt.sign === "-";
    // The other person is the side that is not "you". In a charge (a request you
    // paid), Venmo lists the requester as sender and you as receiver, so the side
    // cannot come from the money direction alone.
    // "You" is your own account id when it is known, else Venmo's "you" label.
    const isYou = (u) => !u || (myId && u.id === myId) || /^you$/i.test(String(u.displayName || "").trim());
    const other = [outgoing ? t.receiver : t.sender, outgoing ? t.sender : t.receiver].find((u) => !isYou(u));
    const party = clean(other?.displayName);
    const text = clean(note.content);
    const verb = outgoing ? "to" : "from";
    const memo = cap(`Venmo ${verb} ${party || "?"}${text ? `: ${text}` : ""}`);
    return { key: s.id, date, amountCents: outgoing ? -amt.cents : amt.cents, kind: s.type || "payment", party, note: text, memo, story: s, myId };
  }

  function daysBetween(a, b) {
    return Math.round((Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86400000);
  }

  /**
   * One-to-one match of YNAB transactions to Venmo transactions: exact amount,
   * bank date from 2 days before to `windowDays` after the Venmo date, nearest first.
   * ynab: [{ id, date, amountMilli }], venmo: [{ key, date, amountCents }]
   * Returns [{ ynab, venmo, dayDiff, ambiguous, otherYnab, otherVenmo }].
   * A match is ambiguous when a rival fits just as well:
   * - otherYnab: other YNAB transactions that fit this Venmo transaction equally well;
   * - otherVenmo: other Venmo transactions that fit this YNAB transaction equally
   *   well, each as { venmo, ynab } with the YNAB transaction it was matched to, if any.
   */
  function matchTransactions(ynab, venmo, windowDays = 5) {
    const pairs = [];
    for (const y of ynab) for (const v of venmo) {
      if (v.amountCents * 10 !== y.amountMilli) continue;
      const diff = daysBetween(y.date, v.date);
      if (!(diff >= -2 && diff <= windowDays)) continue;
      pairs.push({ y, v, diff, cost: Math.abs(diff) + (diff < 0 ? 0.5 : 0) });
    }
    pairs.sort((p, q) => p.cost - q.cost);
    const usedY = new Set(), usedV = new Set(), chosen = [];
    for (const p of pairs) {
      if (usedY.has(p.y.id) || usedV.has(p.v.key)) continue;
      usedY.add(p.y.id);
      usedV.add(p.v.key);
      chosen.push(p);
    }
    const byV = new Map(chosen.map((p) => [p.v.key, p]));
    return chosen.map((p) => {
      const otherYnab = pairs.filter((q) => q.v.key === p.v.key && q.y.id !== p.y.id && q.cost === p.cost).map((q) => q.y);
      const otherVenmo = pairs.filter((q) => q.y.id === p.y.id && q.v.key !== p.v.key && q.cost === p.cost)
        .map((q) => ({ venmo: q.v, ynab: byV.get(q.v.key)?.y || null }));
      return { ynab: p.y, venmo: p.v, dayDiff: p.diff, ambiguous: otherYnab.length + otherVenmo.length > 0, otherYnab, otherVenmo };
    });
  }

  const api = { MAX_MEMO, parseAmount, usDate, parseStory, matchTransactions };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.YVH = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
