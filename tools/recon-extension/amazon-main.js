// Recon v4 (MAIN world, Amazon transactions page): records fetch/XHR calls made by
// the page (not by extensions) and sends them when "Something went wrong" shows.
// Read-only: it only observes.
(() => {
  const calls = [];
  const t0 = Date.now();
  const trunc = (s, n = 6000) => (typeof s === "string" && s.length > n ? s.slice(0, n) + `...[${s.length}]` : s);
  const post = (name, body) => window.postMessage({ __recon: true, name, body: typeof body === "string" ? body : JSON.stringify(body, null, 1) }, "*");
  const interesting = (u) => !/unagi|fls-na|images|\.js(\?|$)|\.css|csm|rufus|metrics|uedata|beacon/i.test(u);

  const of = window.fetch;
  window.fetch = async function (input, init = {}) {
    const url = typeof input === "string" ? input : input?.url || String(input);
    const e = { t: Date.now() - t0, kind: "fetch", url, method: init.method || input?.method || "GET", reqBody: trunc(typeof init.body === "string" ? init.body : init.body ? String(init.body) : "") };
    if (interesting(url)) calls.push(e);
    try {
      const r = await of.apply(this, arguments);
      e.status = r.status;
      if (interesting(url)) try { e.resBody = trunc(await r.clone().text()); } catch {}
      return r;
    } catch (err) { e.error = String(err); throw err; }
  };
  const oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__r = { t: Date.now() - t0, kind: "xhr", method: m, url: String(u) }; if (interesting(String(u))) calls.push(this.__r); return oo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) {
    if (this.__r) { this.__r.reqBody = trunc(b == null ? "" : String(b)); this.addEventListener("loadend", () => { this.__r.status = this.status; try { this.__r.resBody = trunc(this.responseText); } catch {} }); }
    return os.apply(this, arguments);
  };

  let sent = 0;
  const snapshot = (why) => {
    const errEl = [...document.querySelectorAll("*")].find((el) => el.children.length < 3 && /something went wrong/i.test(el.textContent || ""));
    post(`amazon-${why}-${++sent}.json`, {
      why, at: Date.now() - t0, rows: document.querySelectorAll('[data-testid="transaction-link"]').length,
      errorHtml: errEl ? trunc(errEl.closest("div")?.parentElement?.outerHTML || errEl.outerHTML, 8000) : null,
      calls,
    });
  };
  let lastErr = false;
  setInterval(() => {
    const err = /something went wrong/i.test(document.body?.innerText || "");
    if (err && !lastErr) snapshot("error");
    lastErr = err;
  }, 1000);
  setTimeout(() => snapshot("baseline"), 15000);
})();
