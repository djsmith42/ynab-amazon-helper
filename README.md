<img src="assets/icon.svg" width="64" height="64" alt="">

# ynab-helpers

Chrome extension that fills empty YNAB memos for:

- **Amazon** transactions: the product names, ship-to name and city, orderer,
  and a link to the order.
- **Venmo** transactions: who you paid and the Venmo note, or the bank of a
  transfer.

It uses your own logged-in sessions on amazon.com, venmo.com, and
app.ynab.com. No API keys, no servers; data stays in `chrome.storage.local`.

Both helpers share the same rules: only empty memos are written, never one
that has text; YNAB's hidden copies of matched imports are skipped; and writes
go through YNAB's own in-page data layer, so they sync like normal edits and
YNAB's Undo works.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select the `extension/` folder.

After you change the code or pull an update, click the reload icon on **YNAB
Helpers** in `chrome://extensions`, then reload the Amazon, Venmo, and YNAB tabs.

## Amazon

1. Open https://www.amazon.com/cpe/yourpayments/transactions. A panel in the
   lower right collects the orders on the page and reads each order's details.
   Scroll the list, or click **Load older orders**, to go further back. Wait
   until the panel says **Ready**.
2. Open YNAB and click **Amazon Helper** (in the sidebar, under Bank
   Connections). Review the proposed memos, edit any of them, and click
   **Write N memos**. The list updates by itself as orders load.

A memo is proposed only when every order of the charge loaded. Matching uses
the exact amount and the nearest date (bank date from 2 days before to 5 days after the
Amazon charge). When two charges have the same amount and date, the row is
shown but not selected.

Memo format (at most 200 characters):

```
2x Product…; Other product… | To: Name, City | By: Name | https://www.amazon.com/gp/css/summary/edit.html?orderID=…
```

Refunds start with `Refund: `. "By" is the Amazon Household buyer when Amazon
shows one, otherwise the account holder's first name. When the memo is too
long, the item list gets shorter first ("+N more"); links are never cut. In the
YNAB register, each memo with an order link gets an **Amazon order ↗** button.

## Venmo

1. Open https://account.venmo.com/?feed=mine. A panel in the lower right reads
   your Venmo feed (the page's own `/api/stories` API, last 120 days) and saves
   it. Click **Load older transactions** to go 120 days further back. Wait
   until the panel says **Ready**.
2. Open YNAB and click **Venmo Helper** (in the sidebar, under **Amazon
   Helper**). Review the proposed memos, select the rows you want, and click
   **Write N memos**.

It matches YNAB transactions whose payee contains "Venmo" by exact amount and
nearest date (bank date from 2 days before to 5 days after the Venmo date; a
transfer uses its arrival date). When another YNAB or Venmo transaction fits
just as well, the row is not selected and names the other transaction with its
date, amount, and memo. YNAB Venmo transactions that have an empty memo and no
Venmo match are listed at the bottom of the dialog.

Memo format (at most 200 characters). The other person is always named, also
for a payment request that you paid:

```
Venmo to Alex Doe: Concert tickets
Venmo transfer to BANK NAME ••1234
```

Payments you received are not matched: they go to the Venmo balance, and the
cash-out shows in the bank as a transfer.

The raw Venmo data is saved, and the YNAB dialog builds each memo from it when
it opens, so a fix to the memo text applies to data saved earlier.

## The page panels

The Amazon and Venmo panels work the same way:

- A status pill shows what the panel is doing (reading, paused, rate limited,
  sign-in needed, or **Ready**). The YNAB dialog shows the same status while
  the tab is open.
- A progress bar shows how far a load has got.
- When the site limits requests (HTTP 429), the panel waits longer between
  each try (30 s, 60 s, 2 min, then 5 min) and shows how long earlier limits
  lasted on this computer. Leave the tab open; saved data stays usable.
- **×** hides the panel; **YNAB helper** shows it again.
- **More options → Clear saved data** deletes that site's saved data. YNAB
  memos are not changed. On Venmo, then click **Reload Venmo transactions**.

## Develop

- `npm install` once, then `npm test` runs the tests (about 20 s).
- Tests cover the shared logic (`shared.js`, `guard.js`, `amazon-parse.js`,
  `venmo-shared.js`) directly, and run the browser scripts in a simulated
  browser (jsdom): the YNAB page bridge for each helper, the YNAB dialog for
  each helper, and the Amazon panel (`amazon.js`).
- `tools/venmo-recon/` + `tools/recon-server.py` is a dev-only recon extension
  that dumps a site's page data and API calls to a local server. Run
  `python3 tools/recon-server.py <out-dir>`, load the extension, and click
  **Recon dump** on the site's pages. Do not keep it installed.

### File layout

Shared by all helpers (YNAB side):

| File | Runs in | Does |
| --- | --- | --- |
| `ynab-helper.js` | YNAB, extension world | The dialog (instructions, live status, table, memo editor, write with progress bars, result message), the sidebar buttons, and the bridge client. |
| `ynab-bridge.js` | YNAB, page world | Lists a helper's YNAB transactions and writes memos through YNAB's own data layer. |
| `guard.js` | YNAB, page world | The one write guard: empty memos only, right payee, same amount, no hidden matched imports. |

Per helper (`<vendor>` is `amazon` or `venmo`):

| File | Runs in | Does |
| --- | --- | --- |
| `<vendor>.js` | the vendor site | The panel that reads your data there and saves it to `chrome.storage.local`. |
| `<vendor>-shared.js` (`shared.js` and `amazon-parse.js` for Amazon) | vendor site and YNAB | Parsing, memo text, and matching. No browser APIs, so Node tests load it directly. |
| `<vendor>-ynab.js` | YNAB, extension world | `YNABH.register({...})`: name, colors, instructions, and `loadRows()`. |
| `<vendor>-ynab-main.js` | YNAB, page world | One line: `YNABBridge.serve({ tag, payee })`. |

### Add a vendor

1. Find the vendor's data: load the recon extension (see above) on the vendor
   site and look at the API calls it dumps.
2. Add `<vendor>-shared.js` (parse, memo, match) with Node tests.
3. Add `<vendor>.js`, the panel on the vendor site. Save the data and a status
   (`{ kind, emoji, text, at }`) to `chrome.storage.local`.
4. Add a payee check to `PAYEES` in `guard.js`.
5. Add `<vendor>-ynab-main.js` (one line) and `<vendor>-ynab.js`
   (`YNABH.register`). `ynab-helper.js` has the full option list. The sidebar
   button goes under the buttons of the helpers before it.
6. Add the files to `manifest.json`, in the same order as the other helpers,
   and the vendor site to `host_permissions` if the panel needs it.

YNAB's page cancels the default action of clicks. The shared dialog opens
links, opens and closes `<details>` sections, and keeps checkbox states in its
own code. Do the same for any new control.
