<p align="center">
  <img src="banner.svg" alt="finstracker-extension" width="100%">
</p>

<h1 align="center">Finstracker Sync</h1>

<p align="center">
  A Chrome (Manifest V3) extension for <a href="https://finstracker.com">finstracker.com</a>: keep card points current, use your credits and offers before they lapse, and know which card to pay with.
</p>

<p align="center">
  <a href="https://finstracker.com"><img alt="Live site" src="https://img.shields.io/badge/finstracker.com-live-1D6B4A?style=flat-square"></a>
  <a href="https://finstracker.com/docs-extension.html"><img alt="Docs" src="https://img.shields.io/badge/docs-Chrome%20extension-d4a64a?style=flat-square"></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square"></a>
</p>

---

## What it does

The toolbar icon opens a side panel styled like the Finstracker dashboard:

- **Cards.** Every card with its balance. Open a card to update its points from the issuer's site, sync its merchant offers, read the tab you have open, or pick where the balance sits on the page.
- **Credits.** Unused statement credits, soonest first, with **Mark used** (and Undo).
- **Offers.** Active merchant offers, with **Mark used**.
- **Pay with.** On a known shop (Amazon, DoorDash, Delta, Netflix and about 150 others) the panel ranks your cards by what they earn there, using each card's earn rates and point value, and lists any saved offers for that merchant. The toolbar icon shows the best rate, for example `4×`.
- **Best card at checkout** (off by default). Turn it on in Settings and allow site access, and a small note on cart and checkout pages says which card to use.
- **Sync prompt.** On Chase, Amex, Capital One, Citi and other issuer sites, a prompt offers to sync the card's balance from the page you are on.

## Install

You need [git](https://git-scm.com/downloads) and a Chromium browser (Chrome, Edge, Brave, Arc, Vivaldi).

```bash
git clone https://github.com/egomez3412/finstracker-extension.git
```

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose the `finstracker-extension/` folder (the one with `manifest.json`).
3. Pin **Finstracker Sync** from the puzzle-piece menu.
4. Click the icon, then **Sign in on finstracker.com**. You sign in on the website (password, Google, Turnstile), and the panel fills in once you are done.

To update: `git pull`, then click **Reload** on the extension in `chrome://extensions`. Settings and saved balance spots are kept.

## How a points sync works

1. **Update points** opens the issuer's sign-in page in a new tab.
2. You sign in. Passwords, passkeys and codes are yours to enter; the extension never touches them.
3. Once the rewards page settles, the extension reads the balance and posts the difference to Finstracker: an `earn` when the portal shows more, a `redeem` when it shows less, nothing when they match.

If the balance cannot be found, choose **Pick the balance** and click the number on the page. That spot is saved for the card and used from then on. Spots that work automatically are remembered too.

## Code layout

No build step: the folder is the extension.

```text
manifest.json
background.js              Service worker: connects Chrome events to lib/worker
panel/                     Side panel (panel.html, panel.css, panel.js)
content/                   On-page widgets: sync prompt, checkout note, element picker
lib/
  api.js                   Finstracker REST API client
  storage.js               chrome.storage.local keys and defaults
  parse.js                 Number parsing and the earn/redeem calculation
  portals.js               Which page and selector to use for each card
  merchants.js             Website → spending category, checkout detection, offer matching
  best-card.js             Ranking cards by value per dollar
  benefits.js              Credits, offers and annual fee summaries
  inject/                  Functions run inside issuer pages (balance reader, watcher, offers reader)
  worker/                  Service worker parts: capture, offers sync, site hints, messages, sign-in
portals.json               Issuer and card presets
fonts/                     Inter and Fraunces (SIL Open Font License)
tests/                     node --test suites for the lib/ logic
```

Run the tests with Node 20 or newer:

```bash
npm test
```

## Security model

- The session token lives only in `chrome.storage.local` and is sent as `Authorization: Bearer …` to Finstracker. It is never put into any web page.
- Sign-in happens on finstracker.com in a normal tab, which hands the token to this extension by its ID. Only Finstracker's own origins can do that (`externally_connectable`).
- Page readers run with `chrome.scripting.executeScript` and return only the text of the balance or offer tiles. They do not read form fields, cookies or tokens.
- Host access is limited to Finstracker and the supported issuers. Checkout notes need broader site access, which is optional, asked for only when you turn the feature on, and given back when you turn it off.
- Finstracker re-checks every posted amount on the server (a redeem cannot exceed the balance, amounts must be valid numbers).

## Limitations

- Issuer pages change often, so the default selectors in `portals.json` go stale. **Pick the balance** fixes a card in one click.
- A balance inside a cross-origin frame may not be readable; pick it on a page where it is in the main frame.
- Best-card suggestions are only as good as the earn rates saved on each card in Finstracker.

## Related

- [finstracker.com](https://finstracker.com), the web app
- [finstracker-claude-skill](https://github.com/egomez3412/finstracker-claude-skill), your wallet from Claude
- [REST API docs](https://finstracker.com/docs-api.html)

## License

MIT. See [LICENSE](LICENSE). Fonts are under the SIL Open Font License; see `fonts/`.
