// Parsers for Amazon pages. Pure functions over a Document, so they can be
// tested against saved HTML.
(function (root) {
  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

  /** Transactions from the server-rendered __NEXT_DATA__ blob (first page only). */
  function transactionsFromNextData(doc) {
    const el = doc.getElementById("__NEXT_DATA__");
    if (!el) return [];
    try {
      const nd = JSON.parse(el.textContent);
      const list = nd.props.pageProps.state.transactionResponseState.visibleTransactionResponse.transactionList || [];
      return list.map((t) => ({
        date: root.YAH.parseAmazonDate(t.formattedDate),
        amountCents: root.YAH.parseAmountCents(t.formattedAmount),
        status: t.statusInfo?.label || "",
        descriptor: t.statementDescriptor || "",
        card: t.paymentMethodDisplayStringData?.paymentMethodNumber?.lastDigits || "",
        orders: (t.orderData || []).map((o) => ({ id: (o.orderDisplayString || "").replace(/^.*#\s*/, "").trim(), url: o.orderDetailsUrl })),
      }));
    } catch {
      return [];
    }
  }

  /** Transactions from the rendered rows (works for every page, including after "Next Page"). */
  function transactionsFromDom(doc) {
    const rows = doc.querySelectorAll('[data-testid="transaction-link"]');
    const out = [];
    for (const row of rows) {
      // Each piece of the row is its own [data-testid="text"] element:
      // date, "·", descriptor, "Order #...", amount, status.
      const parts = [...row.querySelectorAll('[data-testid="text"]')].map((e) => e.textContent.trim()).filter(Boolean);
      const date = root.YAH.parseAmazonDate(parts.find((p) => root.YAH.parseAmazonDate(p)));
      const amountIdx = parts.findIndex((p) => /^[+-−]?\$\d/.test(p));
      const ids = [...row.textContent.matchAll(/([A-Z0-9]{3}-\d{7}-\d{7})/g)].map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i);
      if (!date || amountIdx < 0 || !ids.length) continue;
      out.push({
        date,
        amountCents: root.YAH.parseAmountCents(parts[amountIdx]),
        status: parts[amountIdx + 1] || "",
        descriptor: parts[parts.indexOf("·") + 1] || "",
        card: (row.querySelector('[data-testid="method-details-number"]')?.textContent || "").trim(),
        orders: ids.map((id) => ({ id, url: orderUrl(id) })),
      });
    }
    return out;
  }

  const orderUrl = (id) => root.YAH.orderUrl(id);

  /** Account holder's first name from the nav bar ("Hello, David"). */
  function accountName(doc) {
    const t = clean(doc.getElementById("nav-link-accountList-nav-line-1")?.textContent);
    const m = t.match(/^Hello,\s*(.+)$/i);
    return m && !/sign in/i.test(m[1]) ? m[1] : "";
  }

  /** Text of an element with <br> turned into newlines (DOMParser documents have no layout, so innerText does not do this). */
  function textWithBreaks(el) {
    const c = el.cloneNode(true);
    for (const br of c.querySelectorAll("br")) br.replaceWith("\n");
    return c.textContent;
  }

  /** Order-details page -> { items, shipTo, orderer, placed } */
  function parseOrderPage(doc) {
    const comp = (name) => doc.querySelector(`[data-component="${name}"]`);

    const items = [];
    for (const titleEl of doc.querySelectorAll('[data-component="itemTitle"]')) {
      const title = clean(titleEl.textContent);
      if (!title) continue;
      // The quantity badge sits on the item image in the same purchasedItems block.
      const block = titleEl.closest('[data-component="purchasedItems"]');
      const qty = parseInt(clean(block?.querySelector(".od-item-view-qty")?.textContent), 10) || 1;
      const same = items.find((i) => i.title === title);
      if (same) same.qty += qty;
      else items.push({ title, qty });
    }

    let shipTo = null;
    const ship = comp("shippingAddress");
    if (ship) {
      const lis = [...ship.querySelectorAll("li")].map(textWithBreaks);
      if (lis.length) {
        const addressLines = lis.slice(1).flatMap((l) => l.split("\n")).map(clean).filter(Boolean);
        shipTo = { name: clean(lis[0]), addressLines };
      } else {
        // Digital orders show "Recipient <name>" with no list.
        const label = clean(ship.querySelector("h5, h4")?.textContent);
        const name = clean(ship.textContent.replace(label, ""));
        if (name) shipTo = { name, addressLines: [] };
      }
    }

    const orderer = clean(comp("sharedOrderBuyer")?.textContent).replace(/^(ordered|placed|purchased)\s+by:?\s*/i, "");
    const placed = root.YAH.parseAmazonDate(comp("orderDate")?.textContent);
    return { items, shipTo, orderer, placed };
  }

  const api = { transactionsFromNextData, transactionsFromDom, orderUrl, accountName, parseOrderPage };
  root.YAHAmazon = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
