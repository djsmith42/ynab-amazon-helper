// Venmo recon (MAIN world). Read-only: records the page's own fetch/XHR calls
// (URL, method, status, request body, response body; header NAMES only, never
// values) plus __NEXT_DATA__ and the DOM, and sends them to the local sink.
// Dumps: 8 s after load, 5 s after each in-app URL change, and on the
// "Recon dump" button (bottom left).
(() => {
  const t0 = Date.now();
  let calls = [];
  const trunc = (s, n = 400000) => (typeof s === "string" && s.length > n ? s.slice(0, n) + `...[${s.length}]` : s);
  const post = (name, body) => window.postMessage({ __recon: true, name, body: typeof body === "string" ? body : JSON.stringify(body, null, 1) }, "*");
  const boring = (u) => /\.(js|css|png|jpe?g|gif|svg|woff2?|ico|webp)(\?|$)|google|doubleclick|facebook|sentry|datadog|segment|amplitude|optimizely|braze|branch\.io|fullstory|newrelic|nr-data|recaptcha|hcaptcha|cdn\./i.test(u);
  const headerNames = (h) => { try { return h ? [...new Headers(h).keys()] : []; } catch { return Object.keys(h || {}); } };
  const bodyText = (b) => (b == null ? "" : typeof b === "string" ? b : b instanceof URLSearchParams ? b.toString() : `[${Object.prototype.toString.call(b)}]`);

  const of = window.fetch;
  window.fetch = async function (input, init = {}) {
    const url = typeof input === "string" ? input : input?.url || String(input);
    const keep = !boring(url);
    const e = { t: Date.now() - t0, kind: "fetch", page: location.href, url, method: init.method || input?.method || "GET", reqHeaders: headerNames(init.headers || input?.headers), reqBody: trunc(bodyText(init.body)) };
    if (keep) calls.push(e);
    try {
      const r = await of.apply(this, arguments);
      e.status = r.status;
      e.contentType = r.headers.get("content-type");
      if (keep) try { e.resBody = trunc(await r.clone().text()); } catch {}
      return r;
    } catch (err) { e.error = String(err); throw err; }
  };
  const oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send, osh = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (m, u) {
    this.__r = { t: Date.now() - t0, kind: "xhr", page: location.href, method: m, url: String(u), reqHeaders: [] };
    if (!boring(String(u))) calls.push(this.__r);
    return oo.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k) { this.__r?.reqHeaders.push(k); return osh.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) {
    if (this.__r) {
      this.__r.reqBody = trunc(bodyText(b));
      this.addEventListener("loadend", () => {
        this.__r.status = this.status;
        this.__r.contentType = this.getResponseHeader("content-type");
        try { this.__r.resBody = trunc(typeof this.response === "string" || this.responseType === "" ? this.responseText : `[${this.responseType}]`); } catch {}
      });
    }
    return os.apply(this, arguments);
  };

  let n = 0;
  const slug = () => location.pathname.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "") || "root";
  const dump = (why) => {
    const id = `${String(++n).padStart(2, "0")}-${why}-${slug()}`;
    let nextData = null;
    try { nextData = JSON.parse(document.getElementById("__NEXT_DATA__")?.textContent || "null"); } catch (e) { nextData = String(e); }
    post(`venmo-${id}.json`, { why, at: Date.now() - t0, url: location.href, title: document.title, nextData, calls });
    calls = [];
    post(`venmo-${id}.html`, trunc(document.documentElement.outerHTML, 3000000));
  };

  setTimeout(() => dump("load"), 8000);
  let last = location.href;
  setInterval(() => {
    if (location.href === last) return;
    last = location.href;
    setTimeout(() => dump("nav"), 5000);
  }, 500);

  const addButton = () => {
    const b = document.createElement("button");
    b.textContent = "Recon dump";
    b.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:2147483647;padding:8px 12px;background:#c00;color:#fff;border:0;border-radius:6px;font:600 13px system-ui;cursor:pointer";
    b.onclick = () => { dump("manual"); b.textContent = "Sent ✓"; setTimeout(() => (b.textContent = "Recon dump"), 1500); };
    document.body.appendChild(b);
  };
  if (document.body) addButton(); else addEventListener("DOMContentLoaded", addButton);
})();
