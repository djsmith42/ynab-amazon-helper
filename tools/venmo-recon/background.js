chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "dump") return;
  fetch(`http://127.0.0.1:8765/${encodeURIComponent(msg.name)}`, {
    method: "POST",
    body: typeof msg.body === "string" ? msg.body : JSON.stringify(msg.body, null, 2),
  })
    .then((r) => sendResponse({ ok: r.ok }))
    .catch((e) => sendResponse({ ok: false, error: String(e) }));
  return true;
});
