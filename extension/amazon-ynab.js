// Amazon helper, YNAB side (extension world). The dialog itself is shared (see
// ynab-helper.js); this file gives the Amazon parts: matching YNAB Amazon
// transactions to the Amazon data saved by amazon.js, the memo for each, and
// the "Amazon order ↗" links in the register.
(() => {
  const { YAH, YNABH } = globalThis;
  const { esc } = YNABH;
  const AMAZON_URL = "https://www.amazon.com/cpe/yourpayments/transactions";

  function emptyMessage(unmatched, { ordersLoading, amazonBusy }) {
    if (ordersLoading || amazonBusy) return `Waiting for Amazon orders to load${ordersLoading ? ` (${ordersLoading} left)` : ""}. Memos show here as they load.`;
    if (unmatched.length) return "No memos to write right now. Some YNAB Amazon transactions have no Amazon match (see below).";
    return "All your Amazon orders have memos. Congrats!";
  }

  // Why a matched row has no memo.
  function noteHtml(errors, missing) {
    if (errors.length) return `<span class="err">Amazon order failed to load: ${esc(errors[0])} Click “Retry failed orders” on the Amazon page.</span>`;
    if (missing.length) return `<span class="note">Order details not loaded yet. Open the Amazon page and wait for it to finish.</span>`;
    return `<span class="note">This Amazon order has no items that could be read, so no memo is proposed.</span>`;
  }

  async function loadRows(call) {
    const { amazonTxns = {}, orders = {}, amazonStatus, settings: saved = {} } = await chrome.storage.local.get(["amazonTxns", "orders", "amazonStatus", "settings"]);
    const amazon = Object.values(amazonTxns);
    if (!amazon.length) return { noData: "No Amazon data yet. Follow the steps above. Memos show here as orders load." };
    const settings = { ...YAH.SETTINGS_DEFAULTS, ...saved };
    const since = amazon.map((t) => t.date).filter(Boolean).sort()[0];
    const sinceMinus = new Date(Date.parse(since + "T00:00:00Z") - 3 * 86400000).toISOString().slice(0, 10);
    const ynabTxns = await call("list", { since: sinceMinus });

    // Match against every YNAB Amazon transaction, so ones you already gave a memo
    // still "use up" their Amazon transaction. Only empty memos are proposed.
    const matches = YAH.matchTransactions(ynabTxns, amazon, settings.dateWindowDays);
    const matchedIds = new Set(matches.map((m) => m.ynab.id));
    const rows = matches.map((m) => {
      const errors = m.amazon.orderIds.map((id) => orders[id]?.error).filter(Boolean);
      const missing = m.amazon.orderIds.filter((id) => !orders[id]);
      return {
        ynab: m.ynab,
        matchKey: m.amazon.key,
        memo: YAH.buildMemo(m.amazon, orders, settings),
        ambiguous: m.ambiguous,
        noteHtml: noteHtml(errors, missing),
        warningHtml: m.ambiguous ? `<div class="note">Another Amazon charge has the same amount and date, so this row is not selected. Check the order, then select it.</div>` : "",
        detailHtml: `${esc(m.amazon.date)}${m.dayDiff ? ` (${m.dayDiff > 0 ? "+" : ""}${m.dayDiff}d)` : ""}<br>${m.amazon.orderIds.map((id, k) => `<a href="${esc(YAH.orderUrl(id))}" target="_blank" rel="noopener" title="${esc(id)}">View Order on Amazon${m.amazon.orderIds.length > 1 ? ` ${k + 1}` : ""} ↗</a>`).join("<br>")}`,
      };
    });
    const unmatched = ynabTxns.filter((t) => t.memoEmpty && !matchedIds.has(t.id) && t.date >= since).sort((a, b) => b.date.localeCompare(a.date));
    const allOrderIds = new Set(amazon.flatMap((t) => t.orderIds));
    const ordersLoading = [...allOrderIds].filter((id) => !orders[id]).length;
    const amazonBusy = amazonStatus && Date.now() - amazonStatus.at < 60000 && amazonStatus.kind !== "ok";
    return { rows, unmatched, emptyMessage: emptyMessage(unmatched, { ordersLoading, amazonBusy }), maxMemoLength: settings.maxMemoLength };
  }

  YNABH.register({
    id: "amazon",
    prefix: "yah",
    name: "Amazon",
    color: "#ff9900",
    textColor: "#111",
    hoverColor: "#ffad33",
    primaryColor: "#3b5eda",
    tag: "__yah",
    siteUrl: AMAZON_URL,
    siteLinkText: "Your Amazon Transactions ↗",
    instructions: [
      `<a href="${AMAZON_URL}" target="_blank" rel="noopener">Open Amazon transactions in a new tab ↗</a>`,
      `Scroll down to the oldest order you want. Wait for it to say <span class="pill ok">Ready</span>`,
      "Come back here. New memos show below as orders load. Check them, then click <b>Write memos</b>.",
    ],
    statusKey: "amazonStatus",
    watchKeys: ["amazonTxns", "orders"],
    columnTitle: "Amazon Order",
    reasons: { "not an Amazon transaction": "payee is no longer Amazon" },
    loadRows,
  });

  // ---------- clickable order links in the register ----------
  // YNAB shows memos as plain text. For each memo with an Amazon order URL, add a
  // small "Amazon order" link after the memo text. Clicking it opens the order and
  // does not start editing the memo.
  const ORDER_URL = YAH.ORDER_URL_RE;
  const linkStyle = document.createElement("style");
  linkStyle.textContent = `
    .yah-order-link { margin-left: 6px; padding: 0 6px; border-radius: 8px; background: #ff9900; color: #111 !important;
      font-size: 11px; font-weight: 600; text-decoration: none !important; white-space: nowrap; cursor: pointer; }
    .yah-order-link:hover { background: #ffad33; }`;
  (document.head || document.documentElement).appendChild(linkStyle);

  function addOrderLinks() {
    for (const cell of document.querySelectorAll(".ynab-grid-cell-memo")) {
      const text = cell.querySelector("span")?.textContent || "";
      const urls = [...new Set(text.match(ORDER_URL) || [])];
      const existing = [...cell.querySelectorAll(".yah-order-link")];
      if (existing.map((a) => a.href).join() === urls.join()) continue;
      existing.forEach((a) => a.remove());
      urls.forEach((url, i) => {
        const a = document.createElement("a");
        a.className = "yah-order-link";
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = urls.length > 1 ? `Amazon order ${i + 1} ↗` : "Amazon order ↗";
        a.title = url;
        for (const type of ["mousedown", "mouseup", "click", "dblclick"])
          a.addEventListener(type, (e) => {
            e.stopPropagation();
            if (type === "click") { e.preventDefault(); window.open(url, "_blank", "noopener"); }
          });
        cell.appendChild(a);
      });
    }
  }
  let linkFrame = 0;
  new MutationObserver(() => {
    if (linkFrame) return;
    linkFrame = requestAnimationFrame(() => { linkFrame = 0; addOrderLinks(); });
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  addOrderLinks();
})();
