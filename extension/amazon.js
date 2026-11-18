// Content script for https://www.amazon.com/cpe/yourpayments/transactions
// Collects transactions shown on the page, fetches each order's details with
// the user's own session, and saves everything to chrome.storage.local for the
// YNAB side to use.
(() => {
  const { YAH, YAHAmazon } = globalThis;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const store = {
    get: (keys) => chrome.storage.local.get(keys),
    set: (obj) => chrome.storage.local.set(obj),
  };

  let busy = false;
  let paging = false;
  let status = "Starting…";
  let scroll = null; // { round, rounds } while "Load older orders" runs
  let lastError = "";
  const ui = makePanel();

  async function collectVisible() {
    const fromDom = YAHAmazon.transactionsFromDom(document);
    const fromData = fromDom.length ? [] : YAHAmazon.transactionsFromNextData(document);
    const found = fromDom.length ? fromDom : fromData;
    if (!found.length) return { found: 0, added: 0 };

    const { amazonTxns = {} } = await store.get("amazonTxns");
    const seenSig = {};
    let added = 0;
    for (const t of found) {
      const orderIds = t.orders.map((o) => o.id);
      const sig = `${t.date}|${t.amountCents}|${orderIds.join(",")}`;
      seenSig[sig] = (seenSig[sig] || 0) + 1;
      const key = `${sig}#${seenSig[sig]}`;
      if (!amazonTxns[key]) { added++; markListActivity(); }
      amazonTxns[key] = { key, date: t.date, amountCents: t.amountCents, status: t.status, descriptor: t.descriptor, card: t.card, orderIds, seenAt: Date.now() };
    }
    const name = YAHAmazon.accountName(document);
    await store.set({ amazonTxns, ...(name ? { accountName: name } : {}) });
    return { found: found.length, added };
  }

  // Fetches details for every order that has none. If more orders arrive while it
  // runs (for example from scrolling the list), it picks them up before it stops.
  let again = false;

  // Order-page requests at the same time as the list loads more rows can make Amazon
  // fail the list request ("Something went wrong"). So order fetches wait while the
  // list is busy: during scrolling, while more rows load, and while the error shows.
  let lastListActivity = 0;
  const markListActivity = () => { lastListActivity = Date.now(); };
  addEventListener("scroll", markListActivity, { capture: true, passive: true });
  addEventListener("wheel", markListActivity, { capture: true, passive: true });
  addEventListener("touchmove", markListActivity, { capture: true, passive: true });
  async function listQuiet() {
    let errorSince = 0;
    for (;;) {
      const errorShown = listError || !!findTryAgain();
      errorSince = errorShown ? errorSince || Date.now() : 0;
      // If the error stays for 90 s, stop waiting for it so order details still load.
      const errorBlocks = errorShown && Date.now() - errorSince < 90000;
      if (!paging && !errorBlocks && Date.now() - lastListActivity >= 4000) break;
      waitingForList = true;
      await sleep(500);
    }
    waitingForList = false;
  }
  let waitingForList = false;

  // Saves one order. Saves run one after another, so parallel fetches cannot
  // overwrite each other's results.
  let saveChain = Promise.resolve();
  const saveOrder = (id, order) =>
    (saveChain = saveChain.then(async () => {
      const latest = (await store.get("orders")).orders || {};
      await store.set({ orders: { ...latest, [id]: order } });
    }));

  async function fetchOrder(id, accountName) {
    try {
      const res = await fetch(YAHAmazon.orderUrl(id), { credentials: "include" });
      if (/\/ap\/signin/.test(res.url)) return { signInNeeded: true, order: { error: "Amazon asked you to sign in again. Reload this page after you sign in.", fetchedAt: Date.now() } };
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      const o = YAHAmazon.parseOrderPage(doc);
      if (!o.items.length && !o.shipTo) {
        const robot = /captcha|robot|api-services-support/i.test(doc.title + (doc.body?.textContent || "").slice(0, 2000));
        throw new Error(robot ? "Amazon showed a robot check. Open any order page, pass the check, then click Retry failed orders." : `Could not read order ${id} (HTTP ${res.status}, page "${doc.title.trim()}").`);
      }
      return { order: { ...o, orderer: o.orderer || accountName, ordererFromAccount: !o.orderer, fetchedAt: Date.now() } };
    } catch (e) {
      return { order: { error: String(e.message || e), fetchedAt: Date.now() } };
    }
  }
  async function fetchMissingOrders({ retryFailed = false } = {}) {
    if (busy) { again = true; return; }
    busy = true;
    const tried = new Set();
    try {
      for (;;) {
        again = false;
        const { amazonTxns = {}, orders = {}, accountName = "" } = await store.get(["amazonTxns", "orders", "accountName"]);
        const all = [...new Set(Object.values(amazonTxns).flatMap((t) => t.orderIds))];
        const ids = all.filter((id) => !tried.has(id) && (!orders[id] || (retryFailed && orders[id].error)));
        if (!ids.length) { if (again) continue; break; }
        // Two at a time, with no timer waits: Chrome throttles timers in background
        // tabs to about one per minute, but it does not throttle network awaits.
        let stop = false;
        const queue = [...ids];
        const worker = async () => {
          while (queue.length && !stop) {
            await listQuiet();
            const id = queue.shift();
            if (!id) break;
            tried.add(id);
            const result = await fetchOrder(id, accountName);
            if (result.signInNeeded) stop = true;
            if (result.order.error) lastError = result.order.error;
            await saveOrder(id, result.order);
            status = "Fetching order details…";
            render();
          }
        };
        await Promise.all([worker(), worker()]);
        if (stop) return;
      }
    } finally {
      busy = false;
      status = "Ready";
      render();
    }
  }

  // Amazon sometimes shows "Something went wrong" with a "Try Again" button at the
  // end of the list, usually when it gets too many requests. Find that button.
  function findTryAgain() {
    for (const el of document.querySelectorAll('button, a, [role="button"]')) {
      if (el.closest("#yah-panel-host")) continue;
      if (/^\s*try again\s*$/i.test(el.textContent || "") && el.offsetParent !== null) return el;
    }
    return null;
  }

  // Clicks "Try Again" with a growing wait (30 s, 60 s, 2 min, then every 5 min).
  let retryCount = 0;
  let retryTimer = null;
  let listError = false;
  function scheduleTryAgain() {
    if (retryTimer || !findTryAgain()) return;
    listError = true;
    // Amazon answers 429 "Rate limit exceeded" here. Retrying fast extends the limit,
    // so wait 30 s, 60 s, 2 min, then 5 min between tries.
    const wait = Math.min(300000, 30000 * 2 ** retryCount);
    render();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      const btn = findTryAgain();
      if (!btn) { listError = false; retryCount = 0; render(); return; }
      retryCount++;
      btn.click();
      setTimeout(() => { if (!findTryAgain()) { listError = false; retryCount = 0; } render(); }, 3000);
    }, wait);
  }

  const rowCount = () => document.querySelectorAll('[data-testid="transaction-link"]').length;

  // The list uses infinite scroll: scrolling the last row into view loads more.
  // Scrolls up to `rounds` times and stops when no new rows appear.
  async function loadMore(rounds) {
    if (paging) return;
    paging = true;
    lastError = "";
    try {
      for (let i = 0; i < rounds; i++) {
        scroll = { round: i + 1, rounds };
        const before = rowCount();
        const rows = document.querySelectorAll('[data-testid="transaction-link"]');
        rows[rows.length - 1]?.scrollIntoView({ block: "end" });
        window.scrollTo(0, document.documentElement.scrollHeight);
        status = `Loading older orders (${before} shown)…`;
        render();
        for (let w = 0; w < 40 && rowCount() === before; w++) await sleep(250);
        // Rate limited ("Something went wrong"): stop scrolling. The background retry
        // (scheduleTryAgain) clicks "Try Again" slowly.
        listError = !!findTryAgain();
        if (rowCount() === before) {
          status = listError ? "Amazon could not load more." : "Reached the end of the list.";
          break;
        }
        // Space out list requests so Amazon does not rate-limit them.
        await sleep(3000);
        await collectVisible();
      }
    } finally {
      paging = false;
      scroll = null;
      if (!/end of the list|could not load more/.test(status)) status = "Ready";
      await collectVisible();
      render();
      fetchMissingOrders();
    }
  }


  // ---------- panel ----------
  function makePanel() {
    const host = document.createElement("div");
    host.id = "yah-panel-host";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        [hidden] { display: none !important; }
        .p { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; width: 300px; font: 13px/1.4 system-ui, -apple-system, sans-serif;
             background: #fff; color: #0f1111; border: 1px solid #d5d9d9; border-radius: 10px; box-shadow: 0 4px 16px rgba(0,0,0,.18); padding: 12px; }
        .h { font-weight: 600; margin-bottom: 6px; display: flex; justify-content: space-between; }
        .x { cursor: pointer; border: 0; background: none; font-size: 16px; line-height: 1; }
        .row { margin: 2px 0; }
        .err { color: #b12704; margin-top: 6px; }
        .btns { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
        button.b { border: 1px solid #888c8c; background: #fff; border-radius: 8px; padding: 4px 10px; cursor: pointer; font: inherit; }
        button.b.primary { background: #ffd814; border-color: #fcd200; }
        .pill { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; font-size: 12px; padding: 3px 10px; border-radius: 999px; margin-bottom: 8px; }
        .pill.busy { background: #e6f0fb; color: #0b5394; }
        .pill.load { background: #fff3e0; color: #a35b00; }
        .pill.ok { background: #e3f4ee; color: #067d62; }
        .pill.warn { background: #fff8db; color: #8a6d00; }
        .pill.bad { background: #fde8e4; color: #b12704; }
        .pill.idle { background: #eef0f2; color: #565959; }
        .pill.busy .dot, .pill.load .dot { animation: yah-pulse 1s ease-in-out infinite; }
        @keyframes yah-pulse { 50% { opacity: .35; } }
        .bar { height: 8px; background: #e7e9ec; border-radius: 4px; overflow: hidden; display: flex; margin: 3px 0 8px; }
        .bar > .ok { background: #067d62; transition: width .3s; }
        .bar > .bad { background: #b12704; transition: width .3s; }
        .bar > .run { background: #ff9900; transition: width .3s; }
        .count { text-align: center; font-size: 12px; color: #565959; margin: -4px 0 8px; font-variant-numeric: tabular-nums; }
        .lbl { display: flex; justify-content: space-between; font-size: 12px; color: #565959; }
        .lbl b { color: #0f1111; font-weight: 600; }
        .mini { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; }
      </style>
      <div class="p" id="p">
        <div class="h"><span>YNAB Amazon Helper</span><button class="x" id="hide" title="Hide">×</button></div>
        <div id="pill" class="pill"></div>
        <div id="body"></div>
        <div class="btns">
          <button class="b primary" id="more">Load older orders</button>
          <button class="b" id="retry" hidden>Retry failed orders</button>
          <button class="b" id="clear">Clear saved data</button>
        </div>
      </div>
      <button class="b mini" id="show" hidden>YNAB helper</button>`;
    document.documentElement.appendChild(host);
    shadow.getElementById("hide").onclick = () => { shadow.getElementById("p").hidden = true; shadow.getElementById("show").hidden = false; };
    shadow.getElementById("show").onclick = () => { shadow.getElementById("p").hidden = false; shadow.getElementById("show").hidden = true; };
    shadow.getElementById("more").onclick = () => loadMore(10);
    shadow.getElementById("retry").onclick = () => { lastError = ""; fetchMissingOrders({ retryFailed: true }); };
    shadow.getElementById("clear").onclick = async () => {
      if (busy || paging) { lastError = "Wait until the panel says Ready, then try again."; render(); return; }
      if (!confirm("Delete all saved Amazon orders? The page reloads and collects them again. YNAB memos are not changed.")) return;
      await chrome.storage.local.remove(["amazonTxns", "orders", "accountName"]);
      location.reload();
    };
    return shadow;
  }

  // "from August 17 to present", "between August 17 and October 12", or with years
  // when the range spans years or is not in the current year. Uses the browser locale.
  function dateRange(firstIso, lastIso) {
    const toDate = (iso) => new Date(iso + "T00:00:00Z");
    const first = toDate(firstIso);
    const last = toDate(lastIso);
    const now = new Date();
    const thisYear = now.getFullYear();
    const showYear = first.getUTCFullYear() !== last.getUTCFullYear() || last.getUTCFullYear() !== thisYear;
    const fmt = new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", ...(showYear ? { year: "numeric" } : {}), timeZone: "UTC" });
    // The newest saved transaction counts as "present" when it is from the last 7 days.
    const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    const isRecent = today - last.getTime() <= 7 * 86400000;
    if (firstIso === lastIso) return `on ${fmt.format(first)}`;
    return isRecent ? `from ${fmt.format(first)} to present` : `between ${fmt.format(first)} and ${fmt.format(last)}`;
  }

  async function render() {
    const { amazonTxns = {}, orders = {} } = await store.get(["amazonTxns", "orders"]);
    const txns = Object.values(amazonTxns);
    const ids = new Set(txns.flatMap((t) => t.orderIds));
    const ok = [...ids].filter((id) => orders[id] && !orders[id].error).length;
    const failed = [...ids].filter((id) => orders[id]?.error).length;
    const dates = txns.map((t) => t.date).sort();
    const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
    const pct = (n) => (ids.size ? (100 * n) / ids.size : 0).toFixed(1);
    const remaining = ids.size - ok - failed;
    ui.getElementById("body").innerHTML = `
      ${dates.length ? `<div class="row" style="color:#565959;margin-bottom:6px">Imported ${ok} order${ok === 1 ? "" : "s"} ${esc(dateRange(dates[0], dates[dates.length - 1]))}</div>` : ""}
      ${scroll ? `
        <div class="lbl"><span>Loading older orders</span><b>${scroll.round} of ${scroll.rounds}</b></div>
        <div class="bar"><div class="run" style="width:${(100 * scroll.round) / scroll.rounds}%"></div></div>` : ""}
      <div class="bar" title="${ok} loaded, ${failed} failed, ${remaining} left">
        <div class="ok" style="width:${pct(ok)}%"></div><div class="bad" style="width:${pct(failed)}%"></div>
      </div>
      ${remaining ? `<div class="count">${ok + failed} of ${ids.size}</div>` : ""}
      ${failed ? `<div class="row" style="color:#b12704">${failed} failed. Click “Retry failed orders”.</div>` : ""}
      ${/end of the list/.test(status) && !paging ? `<div class="row">Reached the end of the order list.</div>` : ""}
      ${lastError ? `<div class="err">${esc(lastError)}</div>` : ""}
      ${remaining || busy || paging ? `<div class="row" style="margin-top:6px;color:#565959">Keep this tab in front until it is done.</div>` : ""}
      ${status === "Amazon could not load more." ? `<div class="row" style="color:#b12704">Amazon limited requests (“Something went wrong”). Leave this tab open; it retries slowly. Do not reload or scroll fast.</div>` : ""}`;
    ui.getElementById("more").disabled = paging || busy;
    ui.getElementById("retry").hidden = !failed || busy;

    let pill;
    if (/sign in/i.test(lastError)) pill = ["bad", "🔐", "Sign in to Amazon, then reload"];
    else if (/robot check/i.test(lastError)) pill = ["bad", "🤖", "Amazon robot check"];
    else if (listError) pill = ["warn", "🐢", "Amazon rate limit, retrying slowly…"];
    else if (paging) pill = ["load", "📜", "Loading older orders…"];
    else if (busy && waitingForList) pill = ["load", "⏸️", "Paused while the list loads…"];
    else if (busy) pill = ["busy", "📦", `Reading orders… ${remaining} left`];
    else if (status === "Starting…") pill = ["idle", "⏳", "Starting…"];
    else if (!txns.length) pill = ["idle", "🔍", "No orders found yet"];
    else if (failed) pill = ["warn", "⚠️", `Ready, ${failed} order${failed > 1 ? "s" : ""} failed`];
    else if (remaining) pill = ["warn", "⏸️", `${remaining} order${remaining > 1 ? "s" : ""} not read yet`];
    else pill = ["ok", "✅", "Ready: Open YNAB and click Amazon memos"];
    const el = ui.getElementById("pill");
    el.className = `pill ${pill[0]}`;
    el.innerHTML = `<span class="dot">${pill[1]}</span><span>${esc(pill[2])}</span>`;

    // Share the status with the YNAB dialog.
    const statusText = pill[0] === "ok" ? "Ready" : pill[2];
    store.set({ amazonStatus: { kind: pill[0], emoji: pill[1], text: statusText, ok, failed, remaining, total: ids.size, first: dates[0] || null, last: dates[dates.length - 1] || null, at: Date.now() } }).catch(() => {});
  }

  // Re-read the list whenever the page changes it (for example after "Next Page").
  let pending = null;
  const observer = new MutationObserver(() => {
    if (!paging) scheduleTryAgain();
    clearTimeout(pending);
    pending = setTimeout(async () => {
      // After the extension is reloaded or updated, this old copy can no longer use
      // chrome.storage. Stop quietly and ask for a page reload.
      if (!chrome.runtime?.id) {
        observer.disconnect();
        ui.getElementById("pill").className = "pill bad";
        ui.getElementById("pill").innerHTML = `<span>🔄</span><span>Extension updated. Reload this page.</span>`;
        ui.getElementById("body").innerHTML = "";
        return;
      }
      try {
        if ((await collectVisible()).added) {
          render();
          fetchMissingOrders();
        }
      } catch (e) {
        if (/context invalidated/i.test(String(e))) observer.disconnect();
        else throw e;
      }
    }, 800);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Heartbeat, so YNAB can tell that this tab is still open.
  setInterval(() => chrome.runtime?.id && render(), 20000);

  (async () => {
    for (let i = 0; i < 20 && !(await collectVisible()).found; i++) await sleep(500);
    status = "Ready";
    render();
    fetchMissingOrders();
  })();
})();
