<img src="assets/icon.svg" width="64" height="64" alt="">

# ynab-amazon-helper

Chrome extension that fills YNAB memos for Amazon transactions with the product
names, ship-to name and address, and orderer. It uses your own logged-in
sessions on amazon.com and app.ynab.com. No API keys, no servers; data stays in
`chrome.storage.local`.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select the `extension/` folder.

## Use

1. Open https://www.amazon.com/cpe/yourpayments/transactions. A panel in the
   lower right collects the transactions on the page and reads each order's
   details. Scroll the list, or click **Load older orders**, to go further back.
2. Open YNAB and click **Amazon Helper** (in the sidebar, under Bank Connections). Review the proposed memos,
   edit any of them, and click **Write N memos**. The list updates by itself as orders load.

Only blank memos are filled. Matching uses the exact amount and the nearest
date (bank date up to 5 days after the Amazon charge). Memo writes go through
YNAB's own in-page data layer, so they sync like normal edits and YNAB's Undo
works.

Memo format: `2x Product…; Other product… | To: Name, Street, City ST | By: Name`
(refunds start with `Refund: `). "By" is the Amazon Household buyer when Amazon
shows one, otherwise the account holder's name.

## Develop

- `node --test test/*.test.js` runs the unit tests.
