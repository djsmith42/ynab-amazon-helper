// The YNAB side of every helper (extension world, on https://app.ynab.com).
// It owns everything the helpers have in common:
// - the sidebar buttons ("<Name> Helper", in registration order, under "Bank
//   Connections") and the floating fallback buttons;
// - the dialog: instructions, live status of the vendor page, the table of
//   proposed memos (select, edit), the unmatched list, and "Write N memos" with
//   a progress overlay and a result message;
// - the bridge client that talks to the helper's <vendor>-ynab-main.js.
//
// A helper registers itself in its own <vendor>-ynab.js:
//
//   YNABH.register({
//     id: "amazon", prefix: "yah", name: "Amazon",
//     color: "#ff9900", textColor: "#111", hoverColor: "#ffad33", primaryColor: "#3b5eda",
//     tag: "__yah",                         // bridge message key (see ynab-bridge.js)
//     siteUrl, siteLinkText,                // header link to the vendor page
//     instructions: ["<li> html", ...],     // steps in the "Instructions" section
//     statusKey: "amazonStatus",            // chrome.storage key the vendor page writes its status to
//     watchKeys: ["amazonTxns", "orders"],  // storage keys whose change reloads the table
//     columnTitle: "Amazon Order",          // last table column
//     reasons: { "not an Amazon transaction": "payee is no longer Amazon" },
//     async loadRows(call) { ... },         // see below
//   });
//
// loadRows(call) reads the vendor data, asks YNAB with call("list", { since }),
// matches, and returns either { noData: "<html>" } or:
//   {
//     rows: [{ ynab, matchKey, memo, ambiguous, warningHtml, noteHtml, detailHtml }],
//       // ynab: a YNAB transaction from "list"; matchKey: the vendor match an edit belongs to;
//       // memo: the proposed memo, or null (then noteHtml says why);
//       // warningHtml: shown under a memo (for example a tie); detailHtml: the last column.
//       // Rows whose YNAB memo is not empty are dropped here.
//     unmatched: [ynab transactions with an empty memo and no vendor match],
//     emptyMessage: "text when there is no row",
//     bannerHtml: "<optional html above the table>",
//     maxMemoLength: 200,                   // optional
//   }
(() => {
  const helpers = []; // registration order is the sidebar order
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const money = (milli) => (milli < 0 ? "-" : "+") + "$" + (Math.abs(milli) / 1000).toFixed(2);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- bridge client ----------
  const TIMEOUT = "YNAB did not answer.";
  function bridge(tag) {
    const waiting = new Map();
    window.addEventListener("message", (e) => {
      if (e.source !== window || e.data?.[tag] !== "res") return;
      const w = waiting.get(e.data.id);
      if (!w) return;
      waiting.delete(e.data.id);
      e.data.ok ? w.resolve(e.data.result) : w.reject(new Error(e.data.error));
    });
    return (op, args) =>
      new Promise((resolve, reject) => {
        const id = `${tag}-${crypto.randomUUID()}`;
        waiting.set(id, { resolve, reject });
        window.postMessage({ [tag]: "req", id, op, args }, "*");
        setTimeout(() => waiting.has(id) && (waiting.delete(id), reject(Object.assign(new Error(`${TIMEOUT} Reload the page.`), { timeout: true }))), 10000);
      });
  }

  // Skip reasons from the write guard (guard.js), as the result message says them.
  const REASONS = {
    "already has a memo": "already had a memo",
    "not found": "not found in YNAB",
    "hidden matched import": "it is YNAB's hidden copy of a matched import",
    "amount changed": "amount changed in YNAB",
    "unknown memo shape": "memo could not be read safely",
    "YNAB cannot set memos here": "YNAB did not allow the change",
    "bad memo": "memo was empty or too long",
    "bad request": "request was not valid",
  };

  const STYLE = `
      :host { all: initial; }
      [hidden] { display: none !important; }
      * { box-sizing: border-box; }
      .fab { position: fixed; left: 16px; z-index: 2147483646; font: 600 13px system-ui, -apple-system, sans-serif;
             background: var(--accent); color: var(--accent-text); border: 0; border-radius: 20px; padding: 8px 14px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.25); }
      .back { position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 2147483647; display: flex; align-items: center; justify-content: center; }
      .modal { position: relative; background: #fff; color: #1c1c1c; width: min(1100px, 96vw); max-height: 90vh; display: flex; flex-direction: column; border-radius: 10px;
               font: 13px/1.4 system-ui, -apple-system, sans-serif; box-shadow: 0 10px 40px rgba(0,0,0,.3); }
      .hd { padding: 14px 16px; background: var(--accent); color: var(--accent-text); border-radius: 10px 10px 0 0; display: flex; justify-content: space-between; align-items: center; }
      .hd h2 { font-size: 16px; margin: 0; }
      .hd a.hdlink { margin-left: auto; font-weight: 600; color: var(--accent-text); }
      .bd { padding: 12px 16px; overflow: auto; }
      .ft { padding: 12px 16px; border-top: 1px solid #e5e5e5; display: flex; gap: 8px; justify-content: flex-end; align-items: center; }
      .ft .msg { margin-right: auto; color: #555; }
      .overlay { position: absolute; left: 0; right: 0; bottom: 0; background: rgba(255,255,255,.92); border-radius: 0 0 10px 10px;
                 display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; z-index: 2; }
      .overlay .ptext { font-weight: 600; font-size: 14px; }
      .overlay .pbar { width: min(420px, 70%); height: 10px; background: #e7e9ec; border-radius: 5px; overflow: hidden; }
      .overlay .pfill { height: 100%; width: 0; background: var(--primary); border-radius: 5px; transition: width .4s ease; }
      .allset { margin: 50px 0; display: flex; align-items: center; justify-content: center; text-align: center; font-size: 15px; font-weight: 600; }
      tr.flash td { animation: ynabh-flash 2s ease-out; }
      @keyframes ynabh-flash { from { background: #fff3c4; } to { background: transparent; } }
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
      button.b.primary { background: var(--primary); color: #fff; border-color: var(--primary); }
      button.b:disabled { opacity: .5; cursor: default; }
      details { margin-top: 12px; }
      summary { cursor: pointer; user-select: none; padding: 4px 0; font-weight: 600; }
      a { color: var(--primary); }
      .banner { margin: 0 0 8px; }
      .st { padding: 12px 16px; border-bottom: 1px solid #e5e5e5; background: #fafafa; display: grid; gap: 8px; }
      .st ol { margin: 6px 0 0; padding-left: 20px; }
      .st summary { font-weight: 700; }
      .st details.instr { margin-top: 0; }
      .st li { margin: 2px 0; }
      .row2 { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; }
      .pill { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; font-size: 12px; padding: 3px 10px; border-radius: 999px; }
      .pill.busy { background: #e6f0fb; color: #0b5394; }
      .pill.load { background: #fff3e0; color: #a35b00; }
      .pill.ok { background: #e3f4ee; color: #067d62; }
      .pill.warn { background: #fff8db; color: #8a6d00; }
      .pill.bad { background: #fde8e4; color: #b12704; }
      .pill.idle { background: #eef0f2; color: #565959; }`;

  // ---------- one helper ----------
  function createHelper(cfg, index) {
    const call = bridge(cfg.tag);
    const reasons = { ...REASONS, ...(cfg.reasons || {}) };
    const host = document.createElement("div");
    host.id = `${cfg.prefix}-host`;
    host.style.setProperty("--accent", cfg.color);
    host.style.setProperty("--accent-text", cfg.textColor);
    host.style.setProperty("--primary", cfg.primaryColor);
    const ui = host.attachShadow({ mode: "open" });
    ui.innerHTML = `
      <style>${STYLE}</style>
      <button class="fab" id="fab" hidden style="bottom:${16 + 44 * index}px">${esc(cfg.name)} Helper</button>
      <div class="back" id="back" hidden>
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="title" tabindex="-1">
          <div class="hd"><h2 id="title">YNAB ${esc(cfg.name)} Helper</h2><a class="hdlink" href="${esc(cfg.siteUrl)}" target="_blank" rel="noopener">${esc(cfg.siteLinkText)}</a></div>
          <div class="st" id="st"></div>
          <div class="bd" id="bd"></div>
          <div class="overlay" id="overlay" hidden><div class="ptext" id="ptext"></div><div class="pbar"><div class="pfill" id="pfill"></div></div></div>
          <div class="ft"><button class="b" id="close">Close</button><span class="msg" id="msg" role="status" aria-live="polite"></span><button class="b primary" id="apply" disabled>Write memos</button></div>
        </div>
      </div>`;
    const $ = (id) => ui.getElementById(id);

    let rows = [];
    let maxMemoLength = 200;
    // Per-transaction choices, kept across automatic updates, keyed by YNAB id:
    // { checked, memo, edited, matchKey } (matchKey: the vendor match an edit belongs to).
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
    // events that start in the dialog away from YNAB. YNAB also cancels the default
    // action of clicks, so links, <details>, and checkboxes are handled in code.
    for (const type of ["click", "mousedown", "mouseup", "keydown", "keyup", "keypress", "input"])
      $("back").addEventListener(type, (e) => e.stopPropagation());

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

    // A checkbox click puts the box back, so save the new state during the click
    // (keyed by YNAB id), and show it again after the click.
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

    $("back").addEventListener("click", (e) => {
      const summary = e.target.closest("summary");
      if (!summary) return;
      e.preventDefault();
      const details = summary.parentElement;
      details.open = !details.open;
      if (details.classList.contains("instr")) {
        chrome.storage.local.get("uiPrefs").then(({ uiPrefs = {} }) =>
          chrome.storage.local.set({ uiPrefs: { ...uiPrefs, [cfg.id]: { ...uiPrefs[cfg.id], instructionsCollapsed: !details.open } } }));
      }
    });
    $("apply").onclick = () => apply();

    // ---------- status block (instructions + live vendor page status) ----------
    // Instructions: a collapsible section, open by default. The open/closed choice is
    // saved per helper, so the dialog opens the same way next time.
    async function renderInstructions() {
      if ($("st").querySelector(".instr")) return;
      const { uiPrefs = {} } = await chrome.storage.local.get("uiPrefs");
      $("st").innerHTML = `
        <details class="instr" id="instr"${uiPrefs[cfg.id]?.instructionsCollapsed ? "" : " open"}>
          <summary>Instructions:</summary>
          <ol>${cfg.instructions.map((li) => `<li>${li}</li>`).join("")}</ol>
        </details>
        <div class="row2" id="live"></div>`;
    }

    // Live vendor page status. It shows only while that page is still working or has
    // a problem; nothing shows when it is ready.
    async function renderStatus() {
      await renderInstructions();
      const { [cfg.statusKey]: a } = await chrome.storage.local.get(cfg.statusKey);
      const live = a && Date.now() - a.at < 60000;
      const html = live && a.kind !== "ok" ? `<span class="pill ${esc(a.kind)}">${esc(a.emoji)} ${esc(cfg.name)} page: ${esc(a.text)}</span>` : "";
      $("live").innerHTML = html;
      $("live").hidden = !html;
    }
    // Keep the status current while the dialog is open. New vendor data updates
    // the table in place, about 1 s after the last change.
    let refreshTimer = null;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || $("back").hidden) return;
      const dataChanged = cfg.watchKeys.some((k) => changes[k]);
      if (changes[cfg.statusKey] || dataChanged) renderStatus();
      if (dataChanged) {
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
        const res = await cfg.loadRows(call);
        // An editor may have opened while we waited: do not destroy it.
        if (editing) { pendingRefresh = true; return; }
        if (res.noData) {
          rows = [];
          $("bd").innerHTML = `<p>${res.noData}</p>`;
          updateApply();
          return;
        }
        maxMemoLength = res.maxMemoLength || 200;
        rows = res.rows
          .filter((m) => m.ynab.memoEmpty)
          .map((m) => {
            let st = state.get(m.ynab.id);
            // An edit belongs to one vendor match. Drop it if the match changed.
            if (st?.edited && st.matchKey !== m.matchKey) st = undefined;
            const memo = st?.edited ? st.memo : m.memo;
            // Flash rows that are new, or whose memo just became available.
            const flash = !initial && memo && (!st || !st.memo);
            // A memo is selected at first, unless the match is ambiguous or the user chose otherwise.
            const checked = st && st.memo ? st.checked !== false : newRowsChecked && !m.ambiguous;
            state.set(m.ynab.id, { ...st, memo, checked: !!memo && checked, matchKey: m.matchKey });
            return { ...m, memo, checked: !!memo && checked, flash };
          })
          .sort((a, b) => b.ynab.date.localeCompare(a.ynab.date));
        render(res);
      } catch (e) {
        const msg = /context invalidated/i.test(e.message) ? "The extension was updated. Reload this page." : e.message;
        if (!editing) $("bd").innerHTML = `<p class="err">${esc(msg)}</p>`;
      }
    }

    function render({ unmatched = [], emptyMessage = "", bannerHtml = "" }) {
      const scroll = $("bd").scrollTop;
      const unmatchedOpen = !!$("bd").querySelector("details#unmatched[open]");
      const withMemo = rows.filter((r) => r.memo);
      $("bd").innerHTML = `
        ${bannerHtml ? `<div class="banner">${bannerHtml}</div>` : ""}
        ${rows.length ? `<table>
          <thead><tr><th class="fit"><input type="checkbox" id="all" aria-label="Select all"${withMemo.length && withMemo.every((r) => r.checked) ? " checked" : ""}></th><th class="fit">Date</th><th class="fit">Account</th><th class="fit">Amount</th><th>Memo to write</th><th class="fit">${esc(cfg.columnTitle)}</th></tr></thead>
          <tbody>${rows.map((r, i) => `
            <tr${r.flash ? ' class="flash"' : ""}>
              <td class="fit">${r.memo ? `<input type="checkbox" data-i="${i}" data-id="${esc(r.ynab.id)}" aria-label="Write this memo"${r.checked ? " checked" : ""}>` : ""}</td>
              <td class="fit date">${esc(r.ynab.date)}</td>
              <td class="fit">${esc(r.ynab.account)}</td>
              <td class="fit amt">${money(r.ynab.amountMilli)}</td>
              <td class="memo" data-memo="${i}">${r.memo ? memoView(i) : r.noteHtml || ""}
                ${r.memo && r.warningHtml ? r.warningHtml : ""}</td>
              <td class="fit muted">${r.detailHtml || ""}</td>
            </tr>`).join("")}
          </tbody></table>` : `<div class="allset">${esc(emptyMessage)}</div>`}
        ${unmatched.length ? `<details id="unmatched"${unmatchedOpen ? " open" : ""}><summary>${unmatched.length} YNAB ${esc(cfg.name)} transaction${unmatched.length === 1 ? "" : "s"} with an empty memo and no ${esc(cfg.name)} match</summary>
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
      box.innerHTML = `<textarea maxlength="${maxMemoLength}" aria-label="Memo">${esc(rows[i].memo)}</textarea>
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
          state.set(rows[i].ynab.id, { ...state.get(rows[i].ynab.id), memo: rows[i].memo, edited: true, matchKey: rows[i].matchKey });
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

    function resultText(r) {
      const n = r.written.length;
      let text = `Wrote ${n} memo${n === 1 ? "" : "s"}.`;
      if (r.skipped.length) {
        const counts = {};
        for (const sk of r.skipped) counts[sk.reason] = (counts[sk.reason] || 0) + 1;
        text += ` Skipped ${r.skipped.length}: ` + Object.entries(counts).map(([k, c]) => `${c} ${reasons[k] || k}`).join(", ") + ".";
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
      try {
        progress(`Writing ${n} memo${n === 1 ? "" : "s"} to YNAB…`, 15);
        await sleep(50); // let the overlay paint first
        progress(`Writing ${n} memo${n === 1 ? "" : "s"} to YNAB…`, 60);
        const r = await call("apply", { updates });
        progress("Checking the results…", 85);
        await sleep(400); // give YNAB a moment to update its data
        await load();
        progress("Done", 100);
        await sleep(400);
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

    // Sidebar button colors. YNAB's own sidebar button classes give the size and shape.
    const sideStyle = document.createElement("style");
    sideStyle.textContent = `
      .${cfg.prefix}-sidebar-button.ynab-button { background: ${cfg.color} !important; color: ${cfg.textColor} !important; border-color: ${cfg.color} !important; margin-top: 8px; justify-content: center; }
      .${cfg.prefix}-sidebar-button.ynab-button:hover { background: ${cfg.hoverColor} !important; }`;
    (document.head || document.documentElement).appendChild(sideStyle);

    return { cfg, host, $, openDialog, call };
  }

  // ---------- sidebar buttons, in registration order under "Bank Connections" ----------
  // Each button goes directly after the one before it, so the order never changes.
  // If the sidebar is collapsed or not found, the floating buttons show instead.
  // While YNAB is still loading, no button shows. YNAB counts as loaded when its
  // sidebar or register has been on the page for 3 s.
  let appLoadedAt = 0;
  let settleTimer = 0;
  function placeSidebarButtons() {
    const appLoaded = !!document.querySelector(".sidebar-bottom, .ynab-grid, .nav-add-accounts");
    if (appLoaded && !appLoadedAt) appLoadedAt = Date.now();
    const settled = appLoadedAt && Date.now() - appLoadedAt > 3000;

    const bank = document.querySelector(".nav-bank-connections");
    let anchor = bank;
    for (const h of helpers) {
      if (!anchor) break;
      let btn = document.querySelector(`.${h.cfg.prefix}-sidebar-button`);
      if (!btn || btn.previousElementSibling !== anchor) {
        btn?.remove();
        btn = document.createElement("button");
        btn.type = "button";
        btn.className = `ynab-button contrast button-sidebar ${h.cfg.prefix}-sidebar-button`;
        btn.textContent = `${h.cfg.name} Helper`;
        btn.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); h.openDialog(); });
        anchor.insertAdjacentElement("afterend", btn);
      }
      // Match the width of "Bank Connections" exactly, also when the sidebar is resized.
      const w = `${bank.getBoundingClientRect().width}px`;
      if (btn.style.width !== w) btn.style.width = w;
      anchor = btn;
    }
    if (bank && !bank.__ynabhResize) {
      bank.__ynabhResize = new ResizeObserver(() => placeSidebarButtons());
      bank.__ynabhResize.observe(bank);
    }
    const sidebarShown = !!(bank && bank.offsetParent !== null);
    for (const h of helpers) h.$("fab").hidden = sidebarShown || !settled;
    if (!sidebarShown && appLoadedAt && !settled && !settleTimer) settleTimer = setTimeout(placeSidebarButtons, 3100);
  }
  let sideFrame = 0;
  new MutationObserver(() => {
    if (sideFrame) return;
    sideFrame = requestAnimationFrame(() => { sideFrame = 0; placeSidebarButtons(); });
  }).observe(document.documentElement, { childList: true, subtree: true });

  function register(cfg) {
    const h = createHelper(cfg, helpers.length);
    helpers.push(h);
    const attach = () => {
      if (!document.body) return requestAnimationFrame(attach);
      document.body.appendChild(h.host);
      placeSidebarButtons();
    };
    attach();
    return h;
  }

  globalThis.YNABH = Object.freeze({ register, bridge, esc, money });
})();
