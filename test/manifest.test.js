// Chrome injects a file only once per page. A file listed in two content-script
// entries for the same pages (for example the page world and the extension's
// world) runs in only one of them, and the other world breaks.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.join(__dirname, "../extension");
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));

test("no script is listed twice for the same pages", () => {
  const seen = new Map();
  for (const cs of manifest.content_scripts) {
    for (const match of cs.matches) {
      for (const js of cs.js) {
        const key = `${match} ${js}`;
        assert.ok(!seen.has(key), `${js} is listed twice for ${match}`);
        seen.set(key, true);
      }
    }
  }
});

test("every listed script exists and the description fits Chrome's limit", () => {
  for (const cs of manifest.content_scripts) for (const js of cs.js) assert.ok(fs.existsSync(path.join(dir, js)), js);
  assert.ok(manifest.description.length <= 132, `description is ${manifest.description.length} characters`);
});

test("guard and memo builder use the same memo length limit", () => {
  assert.equal(require("../extension/guard.js").MAX_MEMO_LENGTH, require("../extension/shared.js").SETTINGS_DEFAULTS.maxMemoLength);
});
