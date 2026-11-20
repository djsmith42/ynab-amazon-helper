// The Venmo page panel (venmo.js) in a simulated browser (jsdom), with a fake
// Venmo feed API. Each "visit" is a new page that shares the same storage.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM, VirtualConsole } = require("jsdom");

const src = (f) => fs.readFileSync(path.join(__dirname, "../extension", f), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

const DAY = 86400000;
const isoDaysAgo = (n) => new Date(Date.now() - n * DAY).toISOString().slice(0, 19);
// A feed of `count` payments, newest first, one every 2 days, 5 per page.
function makeFeed(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `s${count - i}`, amount: "- $5.00", date: isoDaysAgo(2 * i), type: "payment", note: { content: `n${i}` },
    title: { sender: { id: "1", displayName: "you" }, receiver: { id: "2", displayName: "Alex Doe" } },
  }));
}

function visit(data, feed) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "outside-only", url: "https://account.venmo.com/", virtualConsole: new VirtualConsole() });
  const w = dom.window;
  w.setTimeout = (f) => setImmediate(f); // no waits between pages
  w.chrome = { runtime: { id: "t" }, storage: { local: {
    get: async (k) => Object.fromEntries([].concat(k).filter((x) => x in data).map((x) => [x, structuredClone(data[x])])),
    set: async (o) => Object.assign(data, structuredClone(o)),
    remove: async (k) => k.forEach((x) => delete data[x]),
  } } };
  const requests = [];
  w.fetch = async (url) => {
    requests.push(url);
    if (url.includes("/api/user/profile")) return { ok: true, json: async () => ({ id: "1" }) };
    const start = Number(new URL(url, "https://x").searchParams.get("nextId") || 0);
    const page = feed.slice(start, start + 5);
    return { ok: true, json: async () => ({ stories: page, nextId: start + 5 < feed.length ? String(start + 5) : null }) };
  };
  for (const f of ["venmo-shared.js", "venmo.js"]) w.eval(src(f));
  const ui = w.document.getElementById("yvh-panel-host").shadowRoot;
  // A load is done when the panel no longer says "Keep this tab open" and shows its result.
  const done = () => waitFor(() => /Ready/.test(ui.getElementById("pill").textContent) && !/Keep this tab open/.test(ui.getElementById("body").textContent) && /new transaction/i.test(ui.getElementById("body").textContent), "load done");
  const stories = () => requests.filter((u) => u.includes("/api/stories"));
  return { ui, requests, stories, done, body: () => ui.getElementById("body").textContent };
}

test("first visit reads 120 days; a later visit reads only the new transactions", async () => {
  const data = {};
  let feed = makeFeed(200); // 400 days of history, 40 pages
  const v1 = visit(data, feed);
  await v1.done();
  const saved1 = Object.keys(data.venmoTxns).length;
  assert.ok(saved1 >= 60 && saved1 <= 70, `about 120 days saved (${saved1})`);

  // Nothing new: one page, then stop.
  const v2 = visit(data, feed);
  await v2.done();
  assert.equal(v2.stories().length, 1);
  assert.match(v2.body(), /No new transactions since your last visit/);

  // Three new payments on top: the first page has new ones, the second has none.
  feed = [...makeFeed(203).slice(0, 3), ...feed];
  const v3 = visit(data, feed);
  await v3.done();
  assert.equal(v3.stories().length, 2);
  assert.match(v3.body(), /Added 3 new transactions/);
  assert.equal(Object.keys(data.venmoTxns).length, saved1 + 3);
});

test("Load older after a short visit goes 120 days past the oldest saved transaction", async () => {
  const data = {};
  const feed = makeFeed(200);
  await visit(data, feed).done();
  const oldestBefore = Object.values(data.venmoTxns).map((t) => t.date).sort()[0];
  const v = visit(data, feed);
  await v.done();
  v.ui.getElementById("more").click();
  await waitFor(() => v.ui.getElementById("more").disabled, "load started");
  await v.done();
  const oldestAfter = Object.values(data.venmoTxns).map((t) => t.date).sort()[0];
  const days = (Date.parse(oldestBefore) - Date.parse(oldestAfter)) / DAY;
  assert.ok(days >= 120 && days <= 132, `went back about 120 more days (${days})`);
});

test("transactions saved by an older version are read again", async () => {
  const data = {};
  const feed = makeFeed(20);
  await visit(data, feed).done();
  for (const t of Object.values(data.venmoTxns)) delete t.story; // as an older version saved them
  const v = visit(data, feed);
  await v.done();
  assert.ok(Object.values(data.venmoTxns).every((t) => t.story));
});
