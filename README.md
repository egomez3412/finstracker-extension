<p align="center">
  <img src="banner.svg" alt="finstracker-extension: one click and your credit card points balance is current" width="100%">
</p>

<h1 align="center">finstracker-extension</h1>

<p align="center">
  A Chrome (Manifest V3) extension that logs into your issuer portal alongside you, reads the live points balance off the page, and syncs the delta back to your <a href="https://finstracker.com">finstracker.com</a> wallet.
</p>

<p align="center">
  <a href="https://finstracker.com"><img alt="Live site" src="https://img.shields.io/badge/finstracker.com-live-1D6B4A?style=flat-square"></a>
  <a href="https://finstracker.com/docs-extension.html"><img alt="Docs" src="https://img.shields.io/badge/docs-Chrome%20extension-d4a64a?style=flat-square"></a>
  <a href="https://github.com/egomez3412/finstracker-claude-skill"><img alt="Claude Skill" src="https://img.shields.io/badge/also-Claude%20Skill-161a1f?style=flat-square"></a>
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square"></a>
</p>

---

## What this is

**[Finstracker](https://finstracker.com)** is a credit card rewards optimizer. It tracks your cards, recurring perks (monthly, quarterly, annual credits), merchant offers, and transactions so you actually use what you're paying annual fees for.

This repo is the **Chrome extension** that keeps your points balances current automatically. It works with Chase Ultimate Rewards, Amex Membership Rewards, Capital One Rewards, Citi ThankYou, Discover, and the major cashback portals. One click on a card and your tracker matches what the issuer actually shows.

It's not on the Chrome Web Store yet. While the listing is in review, you install it the developer way: clone this repo and load the folder as an unpacked extension. Updates are a `git pull` plus a reload click.

## Install

You need [git](https://git-scm.com/downloads) and a Chromium browser. Chrome, Edge, Brave, Arc, and Vivaldi all share the same extension format.

```bash
git clone https://github.com/egomez3412/finstracker-extension.git
```

Then in your browser:

1. Open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`).
2. Flip the **Developer mode** toggle in the top-right.
3. Click **Load unpacked** and pick the cloned `finstracker-extension/` folder. This is the folder that contains `manifest.json`.
4. Click the puzzle-piece icon in the toolbar and pin **Fins Sync** so it's one click away.

Click the pinned Fins icon. The side panel opens with a single button: **Sign in on finstracker.com**. Click it. A new tab opens at the real finstracker.com login page. Sign in with your existing account, either Google or username and password. Cloudflare Turnstile runs the same way it does on the website. The tab confirms you're signed in and the side panel auto-refreshes to your cards list.

For a screenshot walkthrough, see the [public docs page](https://finstracker.com/docs-extension.html).

## How a sync works

Each tile in the side panel has a **Sync** button. When you click it:

1. A new tab opens at the issuer's login URL.
2. You log in. Multi-factor, passkeys, and SMS codes are all on you. The extension never touches credentials, it just watches the tab.
3. When the points page renders, the extension scrapes the configured CSS selector, parses the first number, and posts a `POST /api/transactions` with the delta. `earn` if the new balance is higher than your tracker, `redeem` if lower, no-op if equal.
4. The card tile shows **"Synced 94,308"** with a green checkmark for a few seconds, then settles back to idle.

```text
delta = 94308 - 92466 = +1842
POST /api/transactions { cardId, type: "earn", unit: "points",
                         amount: 1842,
                         note: "Auto-sync from Chase portal" }
```

A negative delta posts a `redeem`. A zero delta is a no-op. Cashback cards run the same logic in dollars (rounded to cents). Every transaction goes through the server-side validators in [`routes/transactions.js`](https://github.com/egomez3412/cc-rewards-tracker/blob/main/routes/transactions.js) so nothing destructive sneaks through.

## When the default selector fails

Issuer DOMs change every few weeks. If the default selector misses the number, the card surfaces a **"Couldn't pull \<card\>"** banner with a **Pick element manually** button.

1. Click **Pick element manually**. The issuer tab reopens with a small Finstracker HUD floating in the top-left.
2. Hover the points value on the page. Elements outline as you move, and the HUD shows a live preview of what number it sees.
3. Click the value. The HUD locks on it. Hit **Use this value** (or press Enter) to confirm, **Pick another** to retry, or **Cancel** / Esc to abort.

The page URL pattern and a stable CSS selector are saved as a per-card override and reused for every future sync. You only have to do this once per card per portal redesign.

## Auto-detect mode

Open the extension settings (gear icon, top-right of the side panel) and toggle **Auto-detect on known portals** on. From then on, the next time you visit any issuer portal you already have a card for, the extension scrapes silently and shows a desktop notification with the result. No button click required.

If you own more than one card from the same issuer, auto-detect waits for you to click **Sync** on a specific card so it doesn't guess wrong.

## Updating

From the cloned repo:

```bash
cd finstracker-extension
git pull
```

Then go to `chrome://extensions` and click the circular **Reload** arrow on the Fins Sync card. Your saved settings, JWT, and portal overrides all survive the reload. They live in `chrome.storage.local`, which is per-extension-ID, not per-version.

## File layout

```text
finstracker-extension/
├── manifest.json          MV3 manifest
├── background.js          Service worker (auth, capture, sync, auto-detect)
├── popup.html             Side panel markup
├── popup.css              Design tokens lifted from finstracker.com
├── popup.js               UI controller (toast, tabs, settings, cards)
├── fins-logo.png          App icon source
├── portals.json           Default issuer to { loginUrl, pointsUrlHint, selector }
├── icons/                 16/32/48/128 PNG icons referenced by manifest.json
├── lib/
│   ├── api.js             Throwing fetch wrapper around the REST API
│   └── storage.js         chrome.storage.local helpers
└── content/
    ├── picker.css         Overlay styles for the element picker
    └── picker.js          Injected on demand: highlight + click-to-select
```

## Security model

- The JWT lives only in `chrome.storage.local` and is added as `Authorization: Bearer …` to backend requests. It is **never** injected into issuer pages.
- Your password is entered on `finstracker.com` in a normal browser tab, not inside the extension. The web tab posts the JWT back via `chrome.runtime.sendMessage`, scoped to your specific extension ID.
- The page extractor runs via `chrome.scripting.executeScript` in MAIN world and only returns the text content of the element you (or the default selector) picked. It has no access to your tokens, cookies, or form fields.
- Host permissions are scoped to known issuer domains plus the Finstracker backend. The extension cannot read pages on sites it isn't already permitted to.
- Every scraped number is re-validated server-side by the existing transaction validators (`redeem` cannot exceed balance, amounts must be finite and non-negative, etc.).
- The source is public. If anything above sounds wrong, read it.

## Limitations

- The default CSS selectors in `portals.json` are best-effort and **will go stale** as issuer sites change their DOM. Use **Pick element manually** to set a reliable selector for each card when that happens.
- Multi-factor and passkey logins must be completed by the user. The extension never automates credentials. It just watches the tab and scrapes once the points page renders.
- If an issuer renders points inside a cross-origin iframe, the current extractor will not see it. Use the picker on a page where the number is in the top frame.

## Related projects

- **[finstracker.com](https://finstracker.com)** — the web app
- **[finstracker-claude-skill](https://github.com/egomez3412/finstracker-claude-skill)** — talk to your wallet from Claude
- **REST API docs**: <https://finstracker.com/docs-api.html>
- **MCP server docs**: <https://finstracker.com/docs-mcp.html>

## License

MIT. See [LICENSE](LICENSE).
