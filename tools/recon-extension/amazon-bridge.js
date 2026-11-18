window.addEventListener("message", (e) => {
  if (e.source !== window || !e.data?.__recon) return;
  chrome.runtime.sendMessage({ type: "dump", name: e.data.name, body: e.data.body });
});
