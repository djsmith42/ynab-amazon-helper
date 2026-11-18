// Recon v2: dumps order-detail pages (from __NEXT_DATA__) and what "Next Page" does.
const dump = (name, body) => chrome.runtime.sendMessage({ type: "dump", name, body });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise((r) => (document.readyState === "complete" ? r() : addEventListener("load", r)));
  await sleep(4000);
  let list = [];
  try {
    const nd = JSON.parse(document.getElementById("__NEXT_DATA__").textContent);
    list = nd.props.pageProps.state.transactionResponseState.visibleTransactionResponse.transactionList || [];
  } catch (e) { dump("amazon-nextdata-error.txt", String(e)); }

  // Pick distinct orders, including one "D01" (digital) and one refund if present.
  const seen = new Set();
  const picks = [];
  for (const t of list) for (const o of t.orderData || []) {
    if (seen.has(o.orderDetailsUrl)) continue;
    seen.add(o.orderDetailsUrl);
    picks.push(o.orderDetailsUrl);
  }
  const chosen = [...picks.filter((u) => !/D01-/.test(u)).slice(0, 4), ...picks.filter((u) => /D01-/.test(u)).slice(0, 1)];
  for (const [i, url] of chosen.entries()) {
    try {
      const res = await fetch(url, { credentials: "include" });
      dump(`amazon-order-${i}.html`, `<!-- ${res.status} ${res.url} -->\n${await res.text()}`);
    } catch (e) { dump(`amazon-order-${i}-error.txt`, `${url}\n${e}`); }
    await sleep(800);
  }

  // Click "Next Page" and dump the DOM afterwards; MAIN-world hook records the XHR.
  const next = [...document.querySelectorAll("button, a, [role=button]")].find((b) => /next page/i.test(b.innerText || b.getAttribute("aria-label") || ""));
  dump("amazon-next-button.txt", next ? next.outerHTML.slice(0, 3000) : "not found");
  if (next) {
    next.click();
    await sleep(5000);
    dump("amazon-page2.html", document.documentElement.outerHTML);
  }
  dump("amazon-done.txt", `done; ${chosen.length} order pages`);
})();
