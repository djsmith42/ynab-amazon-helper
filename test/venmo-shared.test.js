// extension/venmo-shared.js. Story shapes copied from Venmo's
// /api/stories response (names and ids made up).
const test = require("node:test");
const assert = require("node:assert");
const V = require("../extension/venmo-shared.js");

const me = { id: "1", displayName: "you", username: "me" };
const pay = (amount, other, outgoing, note = "Pizza") => ({
  id: `s-${amount}`, amount, date: "2026-11-18T19:40:10", type: "payment", note: { content: note },
  title: { titleType: "story", payload: { action: "pay", subType: "p2p" }, receiver: outgoing ? other : me, sender: outgoing ? me : other },
});
const alex = { id: "2", displayName: "Alex Doe", username: "Alex-Doe" };

test("sent payment is a bank charge with who and what", () => {
  const t = V.parseStory(pay("- $24.00", alex, true, "Concert  tickets"));
  assert.deepEqual([t.date, t.amountCents, t.memo], ["2026-11-18", -2400, "Venmo to Alex Doe: Concert tickets"]);
});

test("received payment is positive and names the sender", () => {
  const t = V.parseStory(pay("+ $1,070.50", alex, false));
  assert.deepEqual([t.amountCents, t.memo], [107050, "Venmo from Alex Doe: Pizza"]);
});

test("transfer to bank uses the arrival date", () => {
  const t = V.parseStory({ id: "x", amount: "$70.00", date: "2026-11-11T17:39:25", type: "transfer", note: { type: "standardTransferNote", date: "11/16/2026", name: "FIRST EXAMPLE BANK", lastFour: "1234" }, title: { payload: { subType: "standardTransfer" } } });
  assert.deepEqual([t.date, t.amountCents, t.memo], ["2026-11-16", 7000, "Venmo transfer to FIRST EXAMPLE BANK ••1234"]);
});

test("long notes are capped at 200 characters; bad stories are skipped", () => {
  assert.equal(V.parseStory(pay("- $1.00", alex, true, "x".repeat(300))).memo.length, 200);
  assert.equal(V.parseStory({ id: "y", amount: "", date: "2026-01-01" }), null);
  assert.equal(V.parseStory(null), null);
});

test("matches one-to-one by exact amount and nearest date", () => {
  const venmo = [{ key: "a", date: "2026-11-10", amountCents: -2400 }, { key: "b", date: "2026-11-12", amountCents: -2400 }];
  const ynab = [{ id: "y1", date: "2026-11-12", amountMilli: -24000 }, { id: "y2", date: "2026-11-20", amountMilli: -24000 }];
  const m = V.matchTransactions(ynab, venmo);
  assert.deepEqual(m.map((x) => [x.ynab.id, x.venmo.key, x.ambiguous]), [["y1", "b", false]]);
});

test("a paid charge names the requester, not you", () => {
  // Alex requested money and you paid it: Venmo lists Alex as sender, you as receiver.
  const s = { id: "c", amount: "- $15.00", date: "2026-11-18T10:00:00", type: "payment", note: { content: "Lunch" },
    title: { payload: { action: "charge", subType: "p2p" }, sender: alex, receiver: me } };
  assert.equal(V.parseStory(s).memo, "Venmo to Alex Doe: Lunch");
});

test("a tie on the YNAB side lists the other YNAB transaction, not a Venmo one", () => {
  // One Venmo transfer on 09-07, two YNAB +$250 deposits on 09-08.
  const venmo = [{ key: "t", date: "2026-09-07", amountCents: 25000 }];
  const ynab = [{ id: "y1", date: "2026-09-08", amountMilli: 250000 }, { id: "y2", date: "2026-09-08", amountMilli: 250000, memo: "Gift" }];
  const [m] = V.matchTransactions(ynab, venmo);
  assert.ok(m.ambiguous);
  assert.deepEqual(m.otherYnab.map((y) => y.id), [m.ynab.id === "y1" ? "y2" : "y1"]);
  assert.deepEqual(m.otherVenmo, []);
});

test("a tie on the Venmo side lists the other Venmo transaction", () => {
  const venmo = [{ key: "a", date: "2026-09-07", amountCents: 25000 }, { key: "b", date: "2026-09-07", amountCents: 25000 }];
  const ynab = [{ id: "y1", date: "2026-09-08", amountMilli: 250000 }];
  const [m] = V.matchTransactions(ynab, venmo);
  assert.ok(m.ambiguous);
  assert.deepEqual(m.otherVenmo.map((o) => [o.venmo.key, o.ynab]), [[m.venmo.key === "a" ? "b" : "a", null]]);
});

test("you are found by account id, also when Venmo shows your name", () => {
  // You paid Sam's request; Venmo shows your real name, not "you".
  const myself = { id: "1", displayName: "Pat Smith", username: "me" };
  const sam = { id: "3", displayName: "Sam Lee", username: "Sam" };
  for (const [sender, receiver] of [[sam, myself], [myself, sam]]) {
    const s = { id: "r", amount: "- $12.00", date: "2026-11-18T10:00:00", type: "payment", note: { content: "Uber" },
      title: { payload: { action: "charge", subType: "p2p" }, sender, receiver } };
    assert.equal(V.parseStory(s, "1").memo, "Venmo to Sam Lee: Uber");
  }
});

test("the raw story is kept so memos can be rebuilt", () => {
  const s = pay("- $5.00", alex, true);
  const t = V.parseStory(s, "1");
  assert.equal(V.parseStory(t.story, t.myId).memo, t.memo);
});
