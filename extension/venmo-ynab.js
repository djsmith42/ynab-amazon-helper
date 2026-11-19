// Venmo helper, YNAB side (extension world). The dialog itself is shared (see
// ynab-helper.js); this file gives the Venmo parts: matching YNAB Venmo
// transactions to the Venmo data saved by venmo.js, and the memo for each.
(() => {
  const { YVH, YNABH } = globalThis;
  const { esc, money } = YNABH;
  const VENMO_URL = "https://account.venmo.com/?feed=mine";

  // Tie warning: names the side of the tie (YNAB or Venmo) and each rival's real
  // date, plus the amount and memo of the YNAB transactions involved.
  const ynabInfo = (o) => `${esc(o.date)}, ${money(o.amountMilli)}, ${o.memo ? `memo “${esc(o.memo)}”` : "no memo"}`;
  function tieWarning(m) {
    const lines = [];
    for (const o of m.otherYnab) lines.push(`Another YNAB transaction fits this Venmo transaction just as well: ${ynabInfo(o)}.`);
    for (const { venmo: v, ynab: y } of m.otherVenmo) lines.push(`Another Venmo transaction fits just as well: ${esc(v.date)}, “${esc(v.memo)}”${y ? `, now matched to YNAB ${ynabInfo(y)}` : ""}.`);
    return `<div class="note">${lines.join("<br>")}</div>`;
  }

  async function loadRows(call) {
    const { venmoTxns = {} } = await chrome.storage.local.get("venmoTxns");
    // Rebuild each memo from the saved raw story, so parser fixes apply to data
    // saved earlier. Data saved before raw stories were kept is skipped (see banner).
    const saved = Object.values(venmoTxns);
    const stale = saved.filter((v) => !v.story).length;
    // Payments you received go to the Venmo balance, not the bank, so they are
    // not matched (a cash-out shows in the bank as a transfer instead).
    const venmo = saved.map((v) => v.story && YVH.parseStory(v.story, v.myId)).filter(Boolean)
      .filter((v) => v.kind === "transfer" || v.amountCents < 0);
    if (!venmo.length) return { noData: `${stale ? "Your saved Venmo data is from an older version." : "No Venmo data yet."} Follow the steps above. Memos show here when the Venmo page is ready.` };
    const since = venmo.map((v) => v.date).sort()[0];
    const ynab = await call("list", { since });

    // Match against every YNAB Venmo transaction, so ones you already gave a memo
    // still "use up" their Venmo transaction. Only empty memos are proposed.
    const matches = YVH.matchTransactions(ynab, venmo);
    const matchedIds = new Set(matches.map((m) => m.ynab.id));
    const rows = matches.map((m) => ({
      ynab: m.ynab,
      matchKey: m.venmo.key,
      memo: m.venmo.memo,
      ambiguous: m.ambiguous,
      warningHtml: m.ambiguous ? tieWarning(m) : "",
      detailHtml: `${esc(m.venmo.date)}${m.dayDiff ? ` (${m.dayDiff > 0 ? "+" : ""}${m.dayDiff}d)` : ""}`,
    }));
    const unmatched = ynab.filter((y) => y.memoEmpty && !matchedIds.has(y.id)).sort((a, b) => b.date.localeCompare(a.date));
    return {
      rows,
      unmatched,
      emptyMessage: unmatched.length ? "No memos to write right now. Some YNAB Venmo transactions have no Venmo match (see below)." : "All your Venmo transactions have memos. Congrats!",
      bannerHtml: stale ? `<span class="note">${stale} saved Venmo transactions are from an older version and are not used. Reload the Venmo page to read them again.</span>` : "",
    };
  }

  YNABH.register({
    id: "venmo",
    prefix: "yvh",
    name: "Venmo",
    color: "#008cff",
    textColor: "#fff",
    hoverColor: "#33a3ff",
    primaryColor: "#008cff",
    tag: "__yvh",
    siteUrl: VENMO_URL,
    siteLinkText: "Your Venmo Transactions ↗",
    instructions: [
      `<a href="${VENMO_URL}" target="_blank" rel="noopener">Open Venmo in a new tab ↗</a>`,
      `Wait for it to say <span class="pill ok">Ready</span>. Click <b>Load older transactions</b> there to go further back.`,
      "Come back here. Check the memos below, then click <b>Write memos</b>.",
    ],
    statusKey: "venmoStatus",
    watchKeys: ["venmoTxns"],
    columnTitle: "Venmo Date",
    reasons: { "not a Venmo transaction": "payee is no longer Venmo" },
    loadRows,
  });
})();
