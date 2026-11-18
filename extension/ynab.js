// Content script for https://app.ynab.com. Adds an "Amazon Helper" button.
// It matches YNAB Amazon transactions to the Amazon data saved by amazon.js,
// shows a preview, and writes the memos you approve.
(() => {
  const { YAH } = globalThis;
  const AMAZON_URL = "https://www.amazon.com/cpe/yourpayments/transactions";

  // ---------- bridge to ynab-main.js ----------
  const waiting = new Map();
  const TIMEOUT = "YNAB did not answer.";
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.data?.__yah !== "res") return;
    const w = waiting.get(e.data.id);
    if (!w) return;
    waiting.delete(e.data.id);
    e.data.ok ? w.resolve(e.data.result) : w.reject(new Error(e.data.error));
  });
  const call = (op, args) =>
    new Promise((resolve, reject) => {
      const id = `yah-${crypto.randomUUID()}`;
      waiting.set(id, { resolve, reject });
      window.postMessage({ __yah: "req", id, op, args }, "*");
      setTimeout(() => waiting.has(id) && (waiting.delete(id), reject(Object.assign(new Error(`${TIMEOUT} Reload the page.`), { timeout: true }))), 10000);
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
      .allset { margin: 50px 0; display: flex; align-items: center; justify-content: center; text-align: center; font-size: 15px; font-weight: 600; }
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
                      white-space: nowrap; opacity: 0; }
      td.memo:hover button.pencil, button.pencil:focus-visible { opacity: 1; }
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
      .st details#instr { margin-top: 0; }
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
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="yah-title" tabindex="-1">
        <div class="hd"><h2 id="yah-title">YNAB Amazon Helper</h2><a class="hdlink" href="${AMAZON_URL}" target="_blank" rel="noopener">Your Amazon Transactions ↗</a></div>
        <div class="st" id="st"></div>
        <div class="bd" id="bd"></div>
        <div class="overlay" id="overlay" hidden><div class="ptext" id="ptext"></div><div class="pbar"><div class="pfill" id="pfill"></div></div></div>
        <div class="ft"><button class="b" id="close">Close</button><span class="msg" id="msg" role="status" aria-live="polite"></span><button class="b primary" id="apply" disabled>Write memos</button></div>
      </div>
    </div>`;
  const $ = (id) => ui.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const money = (milli) => (milli < 0 ? "-" : "+") + "$" + (Math.abs(milli) / 1000).toFixed(2);

  let rows = [];
  let settings = { ...YAH.SETTINGS_DEFAULTS };
  // Per-transaction choices, kept across automatic updates, keyed by YNAB id:
  // { checked, memo, edited, amazonKey } (amazonKey: the Amazon match an edit belongs to).
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
    ui.querySelector(".modal").focus();
  };
  const closeDialog = () => ($("back").hidden = true);
  $("fab").onclick = openDialog;
  $("close").onclick = closeDialog;
  $("back").onclick = (e) => e.target === $("back") && closeDialog();
  // Escape closes the dialog (an open memo editor handles Escape itself first).
  $("back").addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !editing) { e.preventDefault(); closeDialog(); }
  });

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

  // YNAB also cancels checkbox clicks, which puts the box back. So save the new
  // state during the click (keyed by YNAB id), and show it again after the click.
  $("bd").addEventListener("click", (e) => {
    const box = e.target.closest('input[type="checkbox"]');
    if (!box) return;
    const want = box.checked; // already toggled by the browser at this point
    if (box.id === "all") {
      newRowsChecked = want;
      for (const r of rows) if (r.memo) state.set(r.ynab.id, { ...state.get(r.ynab.id), checked: want });
    } else if (box.dataset.id) {
      state.set(box.dataset.id, { ...state.get(box.dataset.id), checked: want });
    }
    setTimeout(syncChecks, 0);
  });
  function syncChecks() {
    const boxes = [...$("bd").querySelectorAll('input[type="checkbox"][data-id]')];
    for (const b of boxes) b.checked = !!state.get(b.dataset.id)?.checked;
    const all = $("bd").querySelector("#all");
    if (all) all.checked = boxes.length > 0 && boxes.every((b) => b.checked);
    updateApply();
  }

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

  // One load at a time. A load asked for while one runs sets `again`, and the
  // running load starts one more pass when it ends. A load never replaces the
  // table while a memo editor is open; it runs when the editor closes.
  let loading = false;
  let again = false;
  async function load({ initial = false } = {}) {
    if (editing) { pendingRefresh = true; return; }
    if (loading) { again = true; return; }
    loading = true;
    try {
      do {
        again = false;
        await loadOnce(initial);
        initial = false;
      } while (again && !editing);
      if (again && editing) pendingRefresh = true;
    } finally {
      loading = false;
    }
  }

  async function loadOnce(initial) {
    if (initial) {
      $("bd").innerHTML = `<p class="muted">Loading…</p>`;
      $("msg").textContent = "";
      $("apply").disabled = true;
    }
    try {
      const { amazonTxns = {}, orders = {}, amazonStatus, settings: saved = {} } = await chrome.storage.local.get(["amazonTxns", "orders", "amazonStatus", "settings"]);
      const amazon = Object.values(amazonTxns);
      if (!amazon.length) {
        if (!editing) $("bd").innerHTML = `<p>No Amazon data yet. Follow the steps above. Memos show here as orders load.</p>`;
        return;
      }
      settings = { ...YAH.SETTINGS_DEFAULTS, ...saved };
      const since = amazon.map((t) => t.date).filter(Boolean).sort()[0];
      const sinceMinus = new Date(Date.parse(since + "T00:00:00Z") - 3 * 86400000).toISOString().slice(0, 10);
      const ynabTxns = await call("list", { since: sinceMinus });
      // An editor may have opened while we waited: do not destroy it.
      if (editing) { pendingRefresh = true; return; }

      // Match against every YNAB Amazon transaction, so ones you already gave a memo
      // still "use up" their Amazon transaction. Only empty memos are proposed.
      const matches = YAH.matchTransactions(ynabTxns, amazon, settings.dateWindowDays);
      const matchedIds = new Set(matches.map((m) => m.ynab.id));
      rows = matches
        .filter((m) => m.ynab.memoEmpty)
        .map((m) => {
          const built = YAH.buildMemo(m.amazon, orders, settings);
          let st = state.get(m.ynab.id);
          // An edit belongs to one Amazon match. Drop it if the match changed.
          if (st?.edited && st.amazonKey !== m.amazon.key) st = undefined;
          const memo = st?.edited ? st.memo : built;
          // Flash rows that are new, or whose memo just became available.
          const flash = !initial && memo && (!st || !st.memo);
          // A memo is selected at first, unless the match is ambiguous or the user chose otherwise.
          const checked = st && st.memo ? st.checked !== false : newRowsChecked && !m.ambiguous;
          state.set(m.ynab.id, { ...st, memo, checked: !!memo && checked, amazonKey: m.amazon.key });
          const errors = m.amazon.orderIds.map((id) => orders[id]?.error).filter(Boolean);
          const missing = m.amazon.orderIds.filter((id) => !orders[id]);
          return { ...m, memo, checked: !!memo && checked, flash, missing, errors };
        })
        .sort((a, b) => b.ynab.date.localeCompare(a.ynab.date));
      const unmatched = ynabTxns.filter((t) => t.memoEmpty && !matchedIds.has(t.id) && t.date >= since).sort((a, b) => b.date.localeCompare(a.date));
      const allOrderIds = new Set(amazon.flatMap((t) => t.orderIds));
      const ordersLoading = [...allOrderIds].filter((id) => !orders[id]).length;
      const amazonBusy = amazonStatus && Date.now() - amazonStatus.at < 60000 && amazonStatus.kind !== "ok";
      render(rows, unmatched, { ordersLoading, amazonBusy });
    } catch (e) {
      const msg = /context invalidated/i.test(e.message) ? "The extension was updated. Reload this page." : e.message;
      if (!editing) $("bd").innerHTML = `<p class="err">${esc(msg)}</p>`;
    }
  }

  function emptyMessage(unmatched, { ordersLoading, amazonBusy }) {
    if (ordersLoading || amazonBusy) return `Waiting for Amazon orders to load${ordersLoading ? ` (${ordersLoading} left)` : ""}. Memos show here as they load.`;
    if (unmatched.length) return "No memos to write right now. Some YNAB Amazon transactions have no Amazon match (see below).";
    return "All your Amazon orders have memos. Congrats!";
  }

  function rowNote(r) {
    if (r.errors.length) return `<span class="err">Amazon order failed to load: ${esc(r.errors[0])} Click “Retry failed orders” on the Amazon page.</span>`;
    if (r.missing.length) return `<span class="note">Order details not loaded yet. Open the Amazon page and wait for it to finish.</span>`;
    return `<span class="note">This Amazon order has no items that could be read, so no memo is proposed.</span>`;
  }

  function render(rows, unmatched, info) {
    const scroll = $("bd").scrollTop;
    const unmatchedOpen = !!$("bd").querySelector("details#unmatched[open]");
    $("bd").innerHTML = `
      ${rows.length ? `<table>
        <thead><tr><th class="fit"><input type="checkbox" id="all" aria-label="Select all"${rows.some((r) => r.memo) && rows.filter((r) => r.memo).every((r) => r.checked) ? " checked" : ""}></th><th class="fit">Date</th><th class="fit">Account</th><th class="fit">Amount</th><th>Memo to write</th><th class="fit">Amazon Order</th></tr></thead>
        <tbody>${rows.map((r, i) => `
          <tr${r.flash ? ' class="flash"' : ""}>
            <td class="fit">${r.memo ? `<input type="checkbox" data-i="${i}" data-id="${esc(r.ynab.id)}" aria-label="Write this memo"${r.checked ? " checked" : ""}>` : ""}</td>
            <td class="fit date">${esc(r.ynab.date)}</td>
            <td class="fit">${esc(r.ynab.account)}</td>
            <td class="fit amt">${money(r.ynab.amountMilli)}</td>
            <td class="memo" data-memo="${i}">${r.memo ? memoView(i) : rowNote(r)}
              ${r.ambiguous && r.memo ? `<div class="note">Another Amazon charge has the same amount and date, so this row is not selected. Check the order, then select it.</div>` : ""}</td>
            <td class="fit muted">${esc(r.amazon.date)}${r.dayDiff ? ` (${r.dayDiff > 0 ? "+" : ""}${r.dayDiff}d)` : ""}<br>${r.amazon.orderIds.map((id, k) => `<a href="${esc(YAH.orderUrl(id))}" target="_blank" rel="noopener" title="${esc(id)}">View Order on Amazon${r.amazon.orderIds.length > 1 ? ` ${k + 1}` : ""} ↗</a>`).join("<br>")}</td>
          </tr>`).join("")}
        </tbody></table>` : `<div class="allset">${esc(emptyMessage(unmatched, info))}</div>`}
      ${unmatched.length ? `<details id="unmatched"${unmatchedOpen ? " open" : ""}><summary>${unmatched.length} YNAB Amazon transactions with no Amazon match</summary>
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
    box.innerHTML = `<textarea maxlength="${settings.maxMemoLength}" aria-label="Memo">${esc(rows[i].memo)}</textarea>
      <div class="acts"><button class="b primary" data-save>Save</button><button class="b" data-cancel>Cancel</button></div>`;
    view.replaceWith(box);
    editing++;
    updateApply();
    const ta = box.querySelector("textarea");
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    const done = (save) => {
      if (save && ta.value.trim() && ta.value.trim() !== rows[i].memo) {
        rows[i].memo = ta.value.trim();
        state.set(rows[i].ynab.id, { ...state.get(rows[i].ynab.id), memo: rows[i].memo, edited: true, amazonKey: rows[i].amazon.key });
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
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); }
    });
  }

  // The rows to write come from the saved state, not the screen, so a render in
  // the middle of a click cannot change them.
  function selected() {
    return rows
      .filter((r) => r.memo && state.get(r.ynab.id)?.checked)
      .map((r) => ({ id: r.ynab.id, memo: r.memo, amountMilli: r.ynab.amountMilli }));
  }

  function updateApply() {
    if (editing) {
      $("apply").disabled = true;
      $("apply").textContent = "Save or cancel your edit first";
      return;
    }
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

  const REASONS = {
    "already has a memo": "already had a memo",
    "not found": "not found in YNAB",
    "amount changed": "amount changed in YNAB",
    "not an Amazon transaction": "payee is no longer Amazon",
    "unknown memo shape": "memo could not be read safely",
    "YNAB cannot set memos here": "YNAB did not allow the change",
    "bad memo": "memo was empty or too long",
    "bad request": "request was not valid",
  };

  function resultText(r) {
    const n = r.written.length;
    let text = `Wrote ${n} memo${n === 1 ? "" : "s"}.`;
    if (r.skipped.length) {
      const counts = {};
      for (const sk of r.skipped) counts[sk.reason] = (counts[sk.reason] || 0) + 1;
      text += ` Skipped ${r.skipped.length}: ` + Object.entries(counts).map(([k, c]) => `${c} ${REASONS[k] || k}`).join(", ") + ".";
    }
    if (r.confirmed < n) text += ` Warning: only ${r.confirmed} of ${n} could be confirmed. Check the register.`;
    return text + " Use YNAB's Undo if needed.";
  }

  async function apply() {
    const updates = selected();
    if (!updates.length || editing) return;
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
      $("msg").textContent = resultText(r);
    } catch (e) {
      if (e.timeout) {
        // The write may still have happened. Reload so the table shows the truth.
        $("msg").innerHTML = `<span class="err">YNAB did not answer in time. Some memos may have been written. The list was reloaded; check it before you write again.</span>`;
        await load();
      } else {
        $("msg").innerHTML = `<span class="err">${esc(e.message)}</span>`;
      }
      updateApply();
    } finally {
      hideProgress();
    }
  }

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
