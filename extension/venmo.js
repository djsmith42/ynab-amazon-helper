// Content script for https://account.venmo.com. Reads your Venmo feed through
// the same API the page uses (/api/stories, your own cookies) and saves the
// transactions to chrome.storage.local for the YNAB side. Read-only on Venmo.
// The panel works like the Amazon helper's panel: status pill, progress bar,
// "Load older transactions", rate-limit help, and "More options".
(() => {
  const { YVH } = globalThis;
  const PAGE_DELAY_MS = 700; // between feed pages, so Venmo does not rate-limit us
  const DAYS_PER_LOAD = 120;
  const MAX_PAGES = 60; // per load, as a safety stop
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const store = {
    get: (keys) => chrome.storage.local.get(keys),
    set: (obj) => chrome.storage.local.set(obj),
  };

  let me = null;
  let cursor = null; // nextId of the last page read in this tab
  let oldest = null; // oldest date read in this tab
  let busy = false;
  let started = false;
  let loads = 0; // loads started in this tab; the first reads the newest transactions
  let atEnd = false; // the whole Venmo history is read
  let cleared = false; // saved data was just cleared; the next step is "Reload Venmo transactions"
  let lastResult = ""; // what the last load added, for the panel
  let progress = null; // { from, to, oldest } while a load runs (ISO dates)
  let lastError = "";
  let signInNeeded = false;
  // Rate limit (HTTP 429): wait 30 s, 60 s, 2 min, then every 5 min before the
  // next try. Like the Amazon panel, the last 10 limit durations are kept
  // (venmoRateLimitLog) to tell the user what to expect.
  let limitedSince = 0;
  let retryIn = 0; // ms until the next try, while limited
  const ui = makePanel();

  class HttpError extends Error {
    constructor(status, url) { super(`${url.split("?")[0]} returned HTTP ${status}`); this.status = status; }
  }
  const getJson = async (url) => {
    const r = await fetch(url, { credentials: "include", headers: { accept: "application/json" } });
    if (!r.ok) throw new HttpError(r.status, url);
    return r.json();
  };

  // Fetches one URL. On HTTP 429 it waits longer each time and tries again.
  async function getWithRetry(url) {
    for (let tries = 0; ; tries++) {
      try {
        const res = await getJson(url);
        if (limitedSince) endLimit();
        return res;
      } catch (e) {
        if (e.status !== 429) throw e;
        if (!limitedSince) limitedSince = Date.now();
        const wait = Math.min(300000, 30000 * 2 ** tries);
        for (let left = wait; left > 0; left -= 1000) { retryIn = left; render(); await sleep(1000); }
        retryIn = 0;
      }
    }
  }
  function endLimit() {
    const entry = { start: limitedSince, end: Date.now() };
    limitedSince = 0;
    store.get("venmoRateLimitLog").then(({ venmoRateLimitLog = [] }) => store.set({ venmoRateLimitLog: [...venmoRateLimitLog, entry].slice(-10) })).catch(() => {});
  }

  async function save(list) {
    const { venmoTxns = {} } = await store.get("venmoTxns");
    for (const t of list) venmoTxns[t.key] = t;
    await store.set({ venmoTxns });
  }

  const isoDaysBefore = (iso, days) => new Date(Date.parse(iso + "T00:00:00Z") - days * 86400000).toISOString().slice(0, 10);
  const today = () => new Date().toISOString().slice(0, 10);

  // Reads feed pages, newest first. There are two kinds of load:
  // - Catch-up: the first load in this tab when transactions are already saved.
  //   It reads only what is new: it stops at the first page whose transactions
  //   are all saved already. A visit with nothing new costs one or two requests.
  // - Full: with no saved data, or for "Load older transactions". It reads until
  //   it is DAYS_PER_LOAD days older than the oldest saved transaction.
  // A transaction saved by an older version (no raw story) counts as not saved,
  // so it is read again.
  async function load() {
    if (busy || atEnd) return;
    busy = true;
    cleared = false;
    loads++;
    lastError = "";
    signInNeeded = false;
    lastResult = "";
    const { venmoTxns: saved = {} } = await store.get("venmoTxns");
    const isSaved = (t) => !!saved[t.key]?.story;
    const savedDates = Object.values(saved).filter((t) => t.story).map((t) => t.date).filter(Boolean).sort();
    const catchUp = !cursor && savedDates.length > 0;
    const from = oldest || today();
    const to = catchUp ? savedDates[savedDates.length - 1] : isoDaysBefore([from, ...savedDates.slice(0, 1)].sort()[0], DAYS_PER_LOAD);
    progress = { from: today(), to, oldest: from, catchUp };
    let added = 0;
    render();
    try {
      me ||= await getWithRetry("/api/user/profile");
      for (let page = 0; page < MAX_PAGES; page++) {
        const url = `/api/stories?feedType=me&externalId=${encodeURIComponent(me.id)}${cursor ? `&nextId=${encodeURIComponent(cursor)}` : ""}`;
        const res = await getWithRetry(url);
        // The raw story is saved too, so the YNAB side can rebuild memos with the current parser.
        const txns = (res.stories || []).map((s) => YVH.parseStory(s, me.id)).filter(Boolean);
        for (const t of txns) if (!oldest || t.date < oldest) oldest = t.date;
        const fresh = txns.filter((t) => !isSaved(t));
        added += fresh.length;
        await save(txns);
        for (const t of txns) saved[t.key] = t;
        progress.oldest = oldest || from;
        render();
        if (!res.nextId || res.nextId === cursor || !res.stories?.length) { atEnd = true; break; }
        cursor = res.nextId; // "Load older transactions" continues from here
        if (catchUp ? txns.length && !fresh.length : oldest && oldest < progress.to) break;
        await sleep(PAGE_DELAY_MS);
      }
      lastResult = added ? `Added ${added} new transaction${added === 1 ? "" : "s"}.` : catchUp ? "No new transactions since your last visit." : "No new transactions found.";
    } catch (e) {
      if (e.status === 401 || e.status === 403) { signInNeeded = true; lastError = "Venmo asked you to sign in again. Reload this page after you sign in."; }
      else lastError = String(e.message || e);
    } finally {
      busy = false;
      progress = null;
      render();
    }
  }

  // ---------- panel ----------
  function makePanel() {
    const host = document.createElement("div");
    host.id = "yvh-panel-host";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        [hidden] { display: none !important; }
        .p { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; width: 360px; max-width: calc(100vw - 32px); font: 13px/1.4 system-ui, -apple-system, sans-serif;
             background: #fff; color: #1a1a1a; border: 1px solid #d5d9dd; border-radius: 10px; box-shadow: 0 4px 16px rgba(0,0,0,.18); padding: 12px; }
        .h { font-weight: 600; margin-bottom: 6px; display: flex; justify-content: space-between; }
        .x { cursor: pointer; border: 0; background: none; font-size: 16px; line-height: 1; }
        .row { margin: 2px 0; }
        .muted { color: #5f6368; }
        .err { color: #b12704; margin-top: 6px; }
        .btns { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
        button.b { border: 1px solid #888c8c; background: #fff; border-radius: 8px; padding: 4px 10px; cursor: pointer; font: inherit; }
        button.b.primary { background: #008cff; border-color: #008cff; color: #fff; }
        button.b:disabled { opacity: .5; cursor: default; }
        .pill { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; font-size: 12px; padding: 3px 10px; border-radius: 999px; margin-bottom: 8px; }
        .pill.busy { background: #e6f0fb; color: #0b5394; }
        .pill.load { background: #fff3e0; color: #a35b00; }
        .pill.ok { background: #e3f4ee; color: #067d62; }
        .pill.warn { background: #fff8db; color: #8a6d00; }
        .pill.bad { background: #fde8e4; color: #b12704; }
        .pill.idle { background: #eef0f2; color: #565959; }
        .pill.busy .dot, .pill.load .dot { animation: yvh-pulse 1s ease-in-out infinite; }
        @keyframes yvh-pulse { 50% { opacity: .35; } }
        .lbl { display: flex; justify-content: space-between; font-size: 12px; color: #5f6368; }
        .bar { position: relative; height: 16px; background: #e7e9ec; border-radius: 8px; overflow: hidden; display: flex; margin: 3px 0 8px; }
        .bar > .run { background: #008cff; transition: width .3s; }
        .bar > .txt { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; color: #1a1a1a;
                      font-variant-numeric: tabular-nums; text-shadow: 0 0 2px #fff, 0 0 2px #fff, 0 0 3px #fff; pointer-events: none; }
        .limit { margin-top: 8px; padding: 8px 10px; background: #fff8db; border: 1px solid #f0d77a; border-radius: 8px; color: #5c4a00; font-size: 12px; }
        .limit ul { margin: 6px 0 0; padding-left: 18px; }
        details.opts { margin-top: 8px; font-size: 12px; color: #5f6368; }
        details.opts > summary { cursor: pointer; user-select: none; }
        details.opts .btns { margin-top: 6px; }
        .mini { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; }
      </style>
      <div class="p" id="p">
        <div class="h"><span>YNAB Venmo Helper</span><button class="x" id="hide" title="Hide">×</button></div>
        <div id="pill" class="pill"></div>
        <div id="body"></div>
        <div class="btns">
          <button class="b primary" id="more">Load older transactions</button>
          <button class="b" id="retry" hidden>Try again</button>
        </div>
        <details class="opts" id="opts"><summary>More options</summary>
          <div class="btns"><button class="b" id="clear">Clear saved data</button></div>
        </details>
      </div>
      <button class="b mini" id="show" hidden>YNAB helper</button>`;
    document.documentElement.appendChild(host);
    const $ = (id) => shadow.getElementById(id);
    $("hide").onclick = () => { $("p").hidden = true; $("show").hidden = false; };
    $("show").onclick = () => { $("p").hidden = false; $("show").hidden = true; };
    $("more").onclick = () => load();
    $("retry").onclick = () => load();
    $("clear").onclick = async () => {
      if (busy) { lastError = "Wait until the panel says Ready, then try again."; render(); return; }
      if (!confirm("Delete all saved Venmo transactions? YNAB memos are not changed.")) return;
      await chrome.storage.local.remove(["venmoTxns", "venmoStatus"]);
      // Start again from the newest transaction on the next load.
      cursor = null;
      oldest = null;
      atEnd = false;
      lastError = "";
      cleared = true;
      $("opts").open = false;
      render();
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
    const showYear = first.getUTCFullYear() !== last.getUTCFullYear() || last.getUTCFullYear() !== now.getFullYear();
    const fmt = new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", ...(showYear ? { year: "numeric" } : {}), timeZone: "UTC" });
    const isRecent = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - last.getTime() <= 7 * 86400000;
    if (firstIso === lastIso) return `on ${fmt.format(first)}`;
    return isRecent ? `from ${fmt.format(first)} to present` : `between ${fmt.format(first)} and ${fmt.format(last)}`;
  }
  const shortDate = (iso) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(iso + "T00:00:00Z"));

  // Instructions while Venmo limits requests, with how long it has lasted and how
  // long earlier limits lasted on this computer.
  function limitHelp(log) {
    const min = (ms) => Math.max(1, Math.round(ms / 60000));
    const plural = (n) => `${n} minute${n === 1 ? "" : "s"}`;
    const past = log.map((e) => e.end - e.start).filter((d) => d > 0).sort((a, b) => a - b);
    let expect = "Venmo does not say how long the limit lasts.";
    if (past.length) {
      const lo = min(past[0]);
      const hi = min(past[past.length - 1]);
      expect = `On this computer, the last ${past.length === 1 ? "limit" : `${past.length} limits`} cleared after ${lo === hi ? plural(lo) : `${lo} to ${plural(hi)}`}.`;
    }
    return `<div class="limit">
      <b>Venmo is limiting requests (error 429).</b> It started ${plural(min(Date.now() - limitedSince))} ago. ${expect}
      <ul><li>Leave this tab open. It tries again by itself in ${Math.ceil(retryIn / 1000)} s, with longer waits each time.</li>
      <li>Do not reload this page. Each request can make the limit last longer.</li>
      <li>Saved transactions stay saved. YNAB can use them now.</li></ul></div>`;
  }

  async function render() {
    if (!chrome.runtime?.id) {
      // After the extension is reloaded or updated, this old copy can no longer use chrome.storage.
      ui.getElementById("pill").className = "pill bad";
      ui.getElementById("pill").innerHTML = `<span>🔄</span><span>Extension updated. Reload this page.</span>`;
      ui.getElementById("body").innerHTML = "";
      return;
    }
    const { venmoTxns = {}, venmoRateLimitLog = [] } = await store.get(["venmoTxns", "venmoRateLimitLog"]);
    const txns = Object.values(venmoTxns);
    const dates = txns.map((t) => t.date).filter(Boolean).sort();
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    let bar = "";
    if (progress) {
      const span = Date.parse(progress.from) - Date.parse(progress.to);
      const done = Math.min(1, Math.max(0, (Date.parse(progress.from) - Date.parse(progress.oldest)) / span));
      bar = `<div class="lbl"><span>${progress.catchUp ? "Checking for new transactions" : `Reading back to ${esc(shortDate(progress.to))}`}</span></div>
        <div class="bar"><div class="run" style="width:${(100 * done).toFixed(1)}%"></div><span class="txt">back to ${esc(shortDate(progress.oldest))}</span></div>`;
    }
    ui.getElementById("body").innerHTML = `
      ${dates.length ? `<div class="row muted" style="margin-bottom:6px">Imported ${txns.length} transaction${txns.length === 1 ? "" : "s"} ${esc(dateRange(dates[0], dates[dates.length - 1]))}</div>` : ""}
      ${bar}
      ${lastResult && !busy ? `<div class="row">${esc(lastResult)}</div>` : ""}
      ${atEnd && !busy ? `<div class="row">Reached the start of your Venmo history.</div>` : ""}
      ${lastError ? `<div class="err">${esc(lastError)}</div>` : ""}
      ${busy ? `<div class="row muted" style="margin-top:6px">Keep this tab open until it is done.</div>` : ""}
      ${limitedSince ? limitHelp(venmoRateLimitLog) : ""}`;
    // With no saved data, the primary button reads the newest transactions again.
    const more = ui.getElementById("more");
    more.textContent = cleared || !txns.length ? "Reload Venmo transactions" : "Load older transactions";
    more.disabled = busy || (atEnd && !cleared) || signInNeeded;
    ui.getElementById("retry").hidden = busy || !lastError || signInNeeded;

    let pill;
    if (signInNeeded) pill = ["bad", "🔐", "Sign in to Venmo, then reload"];
    else if (limitedSince) pill = ["warn", "🐢", "Venmo rate limit, retrying slowly…"];
    else if (busy && loads > 1) pill = ["load", "📜", "Loading older transactions…"];
    else if (busy) pill = ["busy", "💸", "Reading transactions…"];
    else if (!started) pill = ["idle", "⏳", "Starting…"];
    else if (lastError) pill = ["bad", "⚠️", "Could not read Venmo"];
    else if (cleared) pill = ["idle", "🧹", "Saved data cleared. Click Reload Venmo transactions"];
    else if (!txns.length) pill = ["idle", "🔍", "No transactions found yet"];
    else pill = ["ok", "✅", "Ready: Open YNAB and click Venmo Helper"];
    const el = ui.getElementById("pill");
    el.className = `pill ${pill[0]}`;
    el.innerHTML = `<span class="dot">${pill[1]}</span><span>${esc(pill[2])}</span>`;

    // Share the status with the YNAB dialog (also a heartbeat: "at").
    store.set({ venmoStatus: { kind: pill[0], emoji: pill[1], text: pill[0] === "ok" ? "Ready" : pill[2], count: txns.length, oldest: dates[0] || null, newest: dates[dates.length - 1] || null, at: Date.now() } }).catch(() => {});
  }

  // Heartbeat, so YNAB can tell that this tab is still open.
  setInterval(() => chrome.runtime?.id && render(), 20000);

  render();
  started = true;
  load();
})();
