// Content script for https://app.ynab.com. Adds an "Amazon memos" button.
// It matches YNAB Amazon transactions to the Amazon data saved by amazon.js,
// shows a preview, and writes the memos you approve.
(() => {
  const { YAH } = globalThis;
  const AMAZON_URL = "https://www.amazon.com/cpe/yourpayments/transactions";

  // ---------- bridge to ynab-main.js ----------
  let seq = 0;
  const waiting = new Map();
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.data?.__yah !== "res") return;
    const w = waiting.get(e.data.id);
    if (!w) return;
    waiting.delete(e.data.id);
    e.data.ok ? w.resolve(e.data.result) : w.reject(new Error(e.data.error));
  });
  const call = (op, args) =>
    new Promise((resolve, reject) => {
      const id = `yah-${Date.now()}-${++seq}`;
      waiting.set(id, { resolve, reject });
      window.postMessage({ __yah: "req", id, op, args }, "*");
      setTimeout(() => waiting.has(id) && (waiting.delete(id), reject(new Error("YNAB did not answer. Reload the page."))), 10000);
    });

  // ---------- UI ----------
  const host = document.createElement("div");
  host.id = "yah-host";
  const ui = host.attachShadow({ mode: "open" });
  ui.innerHTML = `
    <style>
      :host { all: initial; }
      [hidden] { display: none !important; }
      * { box-sizing: border-box; }
      .fab { position: fixed; left: 16px; bottom: 16px; z-index: 2147483646; font: 600 13px system-ui, -apple-system, sans-serif;
             background: #ff9900; color: #111; border: 0; border-radius: 20px; padding: 8px 14px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.25); }
      .back { position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 2147483647; display: flex; align-items: center; justify-content: center; }
      .modal { position: relative; background: #fff; color: #1c1c1c; width: min(1100px, 96vw); max-height: 90vh; display: flex; flex-direction: column; border-radius: 10px;
               font: 13px/1.4 system-ui, -apple-system, sans-serif; box-shadow: 0 10px 40px rgba(0,0,0,.3); }
      .hd { padding: 14px 16px; background: #ff9900; color: #111; border-radius: 10px 10px 0 0; display: flex; justify-content: space-between; align-items: center; }
      .hd h2 { font-size: 16px; margin: 0; }
      .hd a.hdlink { margin-left: auto; font-weight: 600; }
      .bd { padding: 12px 16px; overflow: auto; }
      .ft { padding: 12px 16px; border-top: 1px solid #e5e5e5; display: flex; gap: 8px; justify-content: flex-end; align-items: center; }
      .ft .msg { margin-right: auto; color: #555; }
      .overlay { position: absolute; left: 0; right: 0; bottom: 0; background: rgba(255,255,255,.92); border-radius: 0 0 10px 10px;
                 display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; z-index: 2; }
      .overlay .ptext { font-weight: 600; font-size: 14px; }
      .overlay .pbar { width: min(420px, 70%); height: 10px; background: #e7e9ec; border-radius: 5px; overflow: hidden; }
      .overlay .pfill { height: 100%; width: 0; background: #3b5eda; border-radius: 5px; transition: width .4s ease; }
      tr.flash td { animation: yah-flash 2s ease-out; }
      @keyframes yah-flash { from { background: #fff3c4; } to { background: transparent; } }
      table { width: 100%; border-collapse: collapse; }
      th, td { text-align: left; padding: 6px; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
      th { position: sticky; top: 0; background: #fafafa; font-weight: 600; }
      td.amt { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
      td.date { white-space: nowrap; }
      td.fit, th.fit { width: 1%; white-space: nowrap; }
      td.memo { width: auto; overflow-wrap: anywhere; }
      .memo-view { display: flex; gap: 6px; align-items: flex-start; }
      .memo-text { flex: 1; }
      button.pencil { border: 1px solid #ccc; background: #fff; border-radius: 6px; cursor: pointer; padding: 1px 8px; font: 600 12px system-ui, -apple-system, sans-serif;
                      white-space: nowrap; visibility: hidden; }
      td.memo:hover button.pencil, button.pencil:focus-visible { visibility: visible; }
      button.pencil:hover { background: #f2f4f7; }
      .memo-edit { display: grid; gap: 4px; }
      .memo-edit .acts { display: flex; gap: 6px; }
      .memo-edit .acts button { font-size: 12px; padding: 2px 10px; }
      textarea { width: 100%; font: inherit; min-height: 38px; resize: vertical; border: 1px solid #ccc; border-radius: 4px; padding: 4px; }
      .note { color: #a15c00; font-size: 12px; }
      .muted { color: #777; }
      .err { color: #b00020; }
      button.b { font: inherit; border: 1px solid #aaa; background: #fff; border-radius: 6px; padding: 6px 12px; cursor: pointer; }
      button.b.primary { background: #3b5eda; color: #fff; border-color: #3b5eda; }
      button.b:disabled { opacity: .5; cursor: default; }
      details { margin-top: 12px; }
      summary { cursor: pointer; user-select: none; padding: 4px 0; font-weight: 600; }
      a { color: #3b5eda; }
      .st { padding: 12px 16px; border-bottom: 1px solid #e5e5e5; background: #fafafa; display: grid; gap: 8px; }
      .st ol { margin: 6px 0 0; padding-left: 20px; }
      .st summary { font-weight: 700; }
      .st li { margin: 2px 0; }
      .row2 { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; }
      .pill { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; font-size: 12px; padding: 3px 10px; border-radius: 999px; }
      .pill.busy { background: #e6f0fb; color: #0b5394; }
      .pill.load { background: #fff3e0; color: #a35b00; }
      .pill.ok { background: #e3f4ee; color: #067d62; }
      .pill.warn { background: #fff8db; color: #8a6d00; }
      .pill.bad { background: #fde8e4; color: #b12704; }
      .pill.idle { background: #eef0f2; color: #565959; }
      .big { font-size: 15px; font-weight: 700; }
    </style>
    <button class="fab" id="fab" hidden>Amazon Helper</button>
    <div class="back" id="back" hidden>
      <div class="modal" role="dialog" aria-label="Amazon memos">
        <div class="hd"><h2>YNAB Amazon Helper</h2><a class="hdlink" href="${AMAZON_URL}" target="_blank" rel="noopener">Your Amazon Transactions ↗</a></div>
        <div class="st" id="st"></div>
        <div class="bd" id="bd"></div>
        <div class="overlay" id="overlay" hidden><div class="ptext" id="ptext"></div><div class="pbar"><div class="pfill" id="pfill"></div></div></div>
        <div class="ft"><button class="b" id="close">Close</button><span class="msg" id="msg"></span><button class="b primary" id="apply" disabled>Write memos</button></div>
      </div>
    </div>`;
  const $ = (id) => ui.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const money = (milli) => (milli < 0 ? "-" : "+") + "$" + (Math.abs(milli) / 1000).toFixed(2);

  let rows = [];
  // Per-transaction choices, kept across automatic updates: { checked, edited, memo }.
  const state = new Map();
  let editing = 0; // number of memo edit boxes open
  let pendingRefresh = false;
  // New rows are selected unless the user cleared the header checkbox ("select none").
  let newRowsChecked = true;

  const openDialog = () => {
    $("back").hidden = false;
    state.clear();
    editing = 0;
    pendingRefresh = false;
    newRowsChecked = true;
    renderStatus();
    load({ initial: true });
  };
  $("fab").onclick = openDialog;
  $("close").onclick = () => ($("back").hidden = true);
  $("back").onclick = (e) => e.target === $("back") && ($("back").hidden = true);

  // YNAB's page-wide handlers can cancel clicks and steal keys from inputs. Keep
  // events that start in the dialog away from YNAB.
  for (const type of ["click", "mousedown", "mouseup", "keydown", "keyup", "keypress", "input"])
    $("back").addEventListener(type, (e) => e.stopPropagation());

  // YNAB cancels normal link clicks on its page, so open the dialog's links in code.
  $("back").addEventListener("click", (e) => {
    const a = e.target.closest("a[href]");
    if (!a) return;
    e.preventDefault();
    window.open(a.href, "_blank", "noopener");
  });

  $("bd").addEventListener("click", (e) => {
    const pencil = e.target.closest("button[data-edit]");
    if (pencil) editMemo(+pencil.dataset.edit);
  });

  // YNAB also cancels checkbox clicks, which puts the box back. So read the new
  // state during the click and set it again after the click finishes.
  $("bd").addEventListener("click", (e) => {
    const box = e.target.closest('input[type="checkbox"]');
    if (!box) return;
    const want = box.checked; // already toggled by the browser at this point
    setTimeout(() => {
      box.checked = want;
      const boxes = [...$("bd").querySelectorAll('input[type="checkbox"][data-i]')];
      const all = $("bd").querySelector("#all");
      if (box === all) { boxes.forEach((b) => (b.checked = want)); newRowsChecked = want; }
      else if (all) all.checked = boxes.every((b) => b.checked);
      for (const b of boxes) {
        const r = rows[+b.dataset.i];
        state.set(r.ynab.id, { ...state.get(r.ynab.id), checked: b.checked });
      }
      updateApply();
    }, 0);
  });

  // Open and close <details> sections in code, so the dialog does not depend on the default action.
  $("back").addEventListener("click", (e) => {
    const summary = e.target.closest("summary");
    if (!summary) return;
    e.preventDefault();
    const details = summary.parentElement;
    details.open = !details.open;
    if (details.id === "instr") {
      chrome.storage.local.get("uiPrefs").then(({ uiPrefs = {} }) =>
        chrome.storage.local.set({ uiPrefs: { ...uiPrefs, instructionsCollapsed: !details.open } }));
    }
  });
  $("apply").onclick = () => apply();

  // ---------- status block (instructions + live Amazon status) ----------
  // Instructions: a collapsible section, open by default. The open/closed choice is
  // saved, so the dialog opens the same way next time.
  async function renderInstructions() {
    if ($("st").querySelector("#instr")) return;
    const { uiPrefs = {} } = await chrome.storage.local.get("uiPrefs");
    $("st").innerHTML = `
      <details id="instr"${uiPrefs.instructionsCollapsed ? "" : " open"}>
        <summary>Instructions:</summary>
        <ol>
          <li><a href="${AMAZON_URL}" target="_blank" rel="noopener">Open Amazon transactions in a new tab ↗</a></li>
          <li>Scroll down to the oldest order you want. Wait for it to say <span class="pill ok">Ready</span></li>
          <li>Come back here. New memos show below as orders load. Check them, then click <b>Write memos</b>.</li>
        </ol>
      </details>
      <div class="row2" id="live"></div>`;
  }

  // Live Amazon status. It shows only while the Amazon page is still working or has
  // a problem; nothing shows when it is ready.
  async function renderStatus() {
    await renderInstructions();
    const { amazonStatus: a } = await chrome.storage.local.get("amazonStatus");
    const live = a && Date.now() - a.at < 60000;
    let html = "";
    if (live && a.kind !== "ok") {
      const progress = a.remaining ? `<span class="muted">${a.ok + a.failed} of ${a.total} orders read</span>` : "";
      html = `<span class="pill ${esc(a.kind)}">${esc(a.emoji)} Amazon page: ${esc(a.text)}</span>${progress}`;
    }
    $("live").innerHTML = html;
    $("live").hidden = !html;
  }
  // Keep the status current while the dialog is open.
  // New Amazon data updates the table in place, about 1 s after the last change.
  let refreshTimer = null;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || $("back").hidden) return;
    if (changes.amazonStatus || changes.orders) renderStatus();
    if (changes.orders || changes.amazonTxns) {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => load(), 1000);
    }
  });
  setInterval(() => !$("back").hidden && chrome.runtime?.id && renderStatus(), 15000);

  async function load({ initial = false } = {}) {
    // Do not replace the table while a memo is being edited; update when it closes.
    if (editing) { pendingRefresh = true; return; }
    if (initial) {
      $("bd").innerHTML = `<p class="muted">Loading…</p>`;
      $("msg").textContent = "";
      $("apply").disabled = true;
    }
    try {
      const { amazonTxns = {}, orders = {}, settings = {} } = await chrome.storage.local.get(["amazonTxns", "orders", "settings"]);
      const amazon = Object.values(amazonTxns);
      if (!amazon.length) {
        $("bd").innerHTML = `<p>No Amazon data yet. Follow the steps above. Memos show here as orders load.</p>`;
        return;
      }
      const s = { ...YAH.SETTINGS_DEFAULTS, ...settings };
      const since = amazon.map((t) => t.date).sort()[0];
      const sinceMinus = new Date(Date.parse(since + "T00:00:00Z") - 3 * 86400000).toISOString().slice(0, 10);
      const ynabTxns = await call("list", { since: sinceMinus });

      // Match against every YNAB Amazon transaction, so ones you already gave a memo
      // still "use up" their Amazon transaction. Only blank memos are proposed.
      const matches = YAH.matchTransactions(ynabTxns, amazon, s.dateWindowDays);
      const matchedIds = new Set(matches.map((m) => m.ynab.id));
      rows = matches
        .filter((m) => !m.ynab.memo)
        .map((m) => {
          const built = YAH.buildMemo(m.amazon, orders, s);
          const st = state.get(m.ynab.id);
          const memo = st?.edited ? st.memo : built;
          // Flash rows that are new, or whose memo just became available.
          const flash = !initial && memo && (!st || !st.memo);
          const checked = st && st.memo ? st.checked !== false : newRowsChecked;
          state.set(m.ynab.id, { ...st, memo, checked });
          return { ...m, memo, checked, flash, missing: m.amazon.orderIds.filter((id) => !orders[id] || orders[id].error), errors: m.amazon.orderIds.map((id) => orders[id]?.error).filter(Boolean) };
        })
        .sort((a, b) => b.ynab.date.localeCompare(a.ynab.date));
      const unmatched = ynabTxns.filter((t) => !t.memo && !matchedIds.has(t.id) && t.date >= since).sort((a, b) => b.date.localeCompare(a.date));
      render(rows, unmatched, ynabTxns.length, since);
    } catch (e) {
      const msg = /context invalidated/i.test(e.message) ? "The extension was updated. Reload this page." : e.message;
      $("bd").innerHTML = `<p class="err">${esc(msg)}</p>`;
    }
  }

  function render(rows, unmatched, total, since) {
    const scroll = $("bd").scrollTop;
    const unmatchedOpen = !!$("bd").querySelector("details#unmatched[open]");
    $("bd").innerHTML = `
      ${rows.length ? `<table>
        <thead><tr><th class="fit"><input type="checkbox" id="all"${rows.filter((r) => r.memo).every((r) => r.checked) ? " checked" : ""}></th><th class="fit">Date</th><th class="fit">Account</th><th class="fit">Amount</th><th>Memo to write</th><th class="fit">Amazon Order</th></tr></thead>
        <tbody>${rows.map((r, i) => `
          <tr${r.flash ? ' class="flash"' : ""}>
            <td class="fit">${r.memo ? `<input type="checkbox" data-i="${i}"${r.checked ? " checked" : ""}>` : ""}</td>
            <td class="fit date">${esc(r.ynab.date)}</td>
            <td class="fit">${esc(r.ynab.account)}</td>
            <td class="fit amt">${money(r.ynab.amountMilli)}</td>
            <td class="memo" data-memo="${i}">${r.memo ? memoView(i) : (r.errors.length ? `<span class="err">Amazon order failed to load: ${esc(r.errors[0])} Click “Retry failed orders” on the Amazon page.</span>` : `<span class="note">Order details not loaded yet. Open the Amazon page and wait for it to finish.</span>`)}
              ${r.ambiguous ? `<div class="note">Another Amazon charge has the same amount and date. Check this one.</div>` : ""}</td>
            <td class="fit muted">${esc(r.amazon.date)}${r.dayDiff ? ` (${r.dayDiff > 0 ? "+" : ""}${r.dayDiff}d)` : ""}<br>${r.amazon.orderIds.map((id, k) => `<a href="${esc(YAH.orderUrl(id))}" target="_blank" rel="noopener" title="${esc(id)}">View Order on Amazon${r.amazon.orderIds.length > 1 ? ` ${k + 1}` : ""} ↗</a>`).join("<br>")}</td>
          </tr>`).join("")}
        </tbody></table>` : `<p>Nothing to fill.</p>`}
      ${unmatched.length ? `<details id="unmatched"${unmatchedOpen ? " open" : ""}><summary>${unmatched.length} YNAB Amazon transactions with no Amazon match</summary>
        <p class="muted">These may be older than the Amazon data, or not on the Amazon page yet. Scroll further back on the Amazon page to find them.</p>
        <table><tbody>${unmatched.map((t) => `<tr><td class="date">${esc(t.date)}</td><td>${esc(t.account)}</td><td class="amt">${money(t.amountMilli)}</td><td class="muted">${esc(t.original || t.payee)}</td></tr>`).join("")}</tbody></table></details>` : ""}`;
    $("bd").scrollTop = scroll;
    updateApply();
  }

  // A memo shows as text with a pencil. The pencil switches to a text box with Save
  // and Cancel (Enter saves, Esc cancels). The edited text is what gets written.
  const memoView = (i) =>
    `<div class="memo-view"><span class="memo-text">${esc(rows[i].memo)}</span><button class="pencil" data-edit="${i}" title="Edit memo" aria-label="Edit memo">✏️ Edit</button></div>`;

  function editMemo(i) {
    const cell = $("bd").querySelector(`td[data-memo="${i}"]`);
    const view = cell.querySelector(".memo-view");
    const box = document.createElement("div");
    box.className = "memo-edit";
    box.innerHTML = `<textarea maxlength="${YAH.SETTINGS_DEFAULTS.maxMemoLength}">${esc(rows[i].memo)}</textarea>
      <div class="acts"><button class="b primary" data-save>Save</button><button class="b" data-cancel>Cancel</button></div>`;
    view.replaceWith(box);
    editing++;
    const ta = box.querySelector("textarea");
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    const done = (save) => {
      if (save && ta.value.trim() && ta.value.trim() !== rows[i].memo) {
        rows[i].memo = ta.value.trim();
        state.set(rows[i].ynab.id, { ...state.get(rows[i].ynab.id), memo: rows[i].memo, edited: true });
      }
      box.outerHTML = memoView(i);
      editing--;
      updateApply();
      if (!editing && pendingRefresh) { pendingRefresh = false; load(); }
    };
    box.querySelector("[data-save]").onclick = () => done(true);
    box.querySelector("[data-cancel]").onclick = () => done(false);
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); done(true); }
      if (e.key === "Escape") { e.preventDefault(); done(false); }
    });
  }

  function selected() {
    return [...$("bd").querySelectorAll('input[type="checkbox"][data-i]:checked')]
      .map((b) => rows[+b.dataset.i])
      .filter((r) => r.memo)
      .map((r) => ({ id: r.ynab.id, memo: r.memo }));
  }

  function updateApply() {
    const n = selected().length;
    $("apply").disabled = n === 0;
    $("apply").textContent = n ? `Write ${n} memo${n > 1 ? "s" : ""}` : "Write memos";
  }

  // Progress overlay over the dialog content (below the header). The dialog keeps
  // its size because the overlay is positioned on top of it.
  function progress(text, pct) {
    const ov = $("overlay");
    ov.style.top = `${ui.querySelector(".hd").offsetHeight}px`;
    ov.hidden = false;
    $("ptext").textContent = text;
    $("pfill").style.width = `${pct}%`;
  }
  const hideProgress = () => { $("overlay").hidden = true; $("pfill").style.width = "0"; };

  async function apply() {
    const updates = selected();
    if (!updates.length) return;
    $("apply").disabled = true;
    $("msg").textContent = "";
    const n = updates.length;
    const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
      progress(`Writing ${n} memo${n === 1 ? "" : "s"} to YNAB…`, 15);
      await sleepMs(50); // let the overlay paint first
      progress(`Writing ${n} memo${n === 1 ? "" : "s"} to YNAB…`, 60);
      const r = await call("apply", { updates });
      progress("Checking the results…", 85);
      await sleepMs(400); // give YNAB a moment to update its data
      await load();
      progress("Done", 100);
      await sleepMs(400);
      $("msg").textContent = `Wrote ${r.confirmed} memo${r.confirmed === 1 ? "" : "s"}.${r.skipped.length ? ` Skipped ${r.skipped.length} (already had a memo).` : ""} Use YNAB's Undo if needed.`;
    } catch (e) {
      $("msg").innerHTML = `<span class="err">${esc(e.message)}</span>`;
      $("apply").disabled = false;
    } finally {
      hideProgress();
    }
  }

  // ---------- clickable order links in the register ----------
  // YNAB shows memos as plain text. For each memo with an Amazon order URL, add a
  // small "Amazon order" link after the memo text. Clicking it opens the order and
  // does not start editing the memo.
  const ORDER_URL = /https:\/\/www\.amazon\.com\/(?:gp\/css\/summary\/edit\.html|your-orders\/order-details)\?orderID=[A-Z0-9-]+/g;
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

  // ---------- sidebar button, under "Bank Connections" ----------
  // Uses YNAB's own sidebar button classes so it matches in size and shape. If the
  // sidebar is collapsed or not found, the floating button shows instead.
  const sideStyle = document.createElement("style");
  sideStyle.textContent = `
    .yah-sidebar-button.ynab-button { background: #ff9900 !important; color: #111 !important; border-color: #ff9900 !important; margin-top: 8px; }
    .yah-sidebar-button.ynab-button:hover { background: #ffad33 !important; }
    .yah-sidebar-button.ynab-button { justify-content: center; }`;
  (document.head || document.documentElement).appendChild(sideStyle);

  function placeSidebarButton() {
    const bank = document.querySelector(".nav-bank-connections");
    let btn = document.querySelector(".yah-sidebar-button");
    if (bank && (!btn || btn.previousElementSibling !== bank)) {
      btn?.remove();
      btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ynab-button contrast button-sidebar yah-sidebar-button";
      btn.textContent = "Amazon Helper";
      btn.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); openDialog(); });
      bank.insertAdjacentElement("afterend", btn);
    }
    // Match the width of "Bank Connections" exactly, also when the sidebar is resized.
    if (bank && btn) {
      const w = `${bank.getBoundingClientRect().width}px`;
      if (btn.style.width !== w) btn.style.width = w;
      if (!bank.__yahResize) {
        bank.__yahResize = new ResizeObserver(() => placeSidebarButton());
        bank.__yahResize.observe(bank);
      }
    }
    // The floating button is only a fallback for a collapsed sidebar. While YNAB is
    // still loading, show neither button. YNAB counts as loaded when its sidebar
    // or register has been on the page for 3 s.
    const sidebarShown = !!(bank && bank.offsetParent !== null);
    const appLoaded = !!document.querySelector(".sidebar-bottom, .ynab-grid, .nav-add-accounts");
    if (appLoaded && !appLoadedAt) appLoadedAt = Date.now();
    const settled = appLoadedAt && Date.now() - appLoadedAt > 3000;
    $("fab").hidden = sidebarShown || !settled;
    if (!sidebarShown && appLoadedAt && !settled) setTimeout(placeSidebarButton, 3100);
  }
  let appLoadedAt = 0;
  let sideFrame = 0;
  new MutationObserver(() => {
    if (sideFrame) return;
    sideFrame = requestAnimationFrame(() => { sideFrame = 0; placeSidebarButton(); });
  }).observe(document.documentElement, { childList: true, subtree: true });

  const attach = () => {
    if (!document.body) return requestAnimationFrame(attach);
    document.body.appendChild(host);
    placeSidebarButton();
  };
  attach();
})();
