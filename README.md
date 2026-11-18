<img src="assets/icon.svg" width="64" height="64" alt="">

# ynab-amazon-helper

Chrome extension that fills empty YNAB memos for Amazon transactions with the
product names, ship-to name and city, orderer, and a link to the order. It uses
your own logged-in sessions on amazon.com and app.ynab.com. No API keys, no
servers; data stays in `chrome.storage.local`.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select the `extension/` folder.

## Use

1. Open https://www.amazon.com/cpe/yourpayments/transactions. A panel in the
   lower right collects the orders on the page and reads each order's details.
   Scroll the list, or click **Load older orders**, to go further back. Wait
   until the panel says **Ready**.
2. Open YNAB and click **Amazon Helper** (in the sidebar, under Bank
   Connections). Review the proposed memos, edit any of them, and click
   **Write N memos**. The list updates by itself as orders load.

Only empty memos are filled; a memo that has any text is never changed. A memo
is proposed only when every order of the charge loaded. Matching uses the exact
amount and the nearest date (bank date from 2 days before to 5 days after the
Amazon charge). When two charges have the same amount and date, the row is
shown but not selected. Memo writes go through YNAB's own in-page data layer, so
they sync like normal edits and YNAB's Undo works.

Memo format (at most 200 characters):

```
2x Product…; Other product… | To: Name, City | By: Name | https://www.amazon.com/gp/css/summary/edit.html?orderID=…
```

Refunds start with `Refund: `. "By" is the Amazon Household buyer when Amazon
shows one, otherwise the account holder's first name. When the memo is too
long, the item list gets shorter first ("+N more"); links are never cut. In the
YNAB register, each memo with an order link gets an **Amazon order ↗** button.

## Develop

- `npm install` once, then `npm test` runs the tests (about 20 s).
- Tests cover the shared logic (`shared.js`, `guard.js`, `amazon-parse.js`)
  directly, and run the browser scripts in a simulated browser (jsdom): the
  YNAB page bridge (`ynab-main.js`), the YNAB dialog (`ynab.js`), and the Amazon
  panel (`amazon.js`).
