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

## Quick tab

Close the sync prompt on a card's site and a small Finstracker tab stays on the edge of the page (and on the site's other pages). Drag it anywhere along the left or right edge; it remembers the spot. Click it for **Sync points/cash back**, **Pick the balance**, **Sync offers**, **Sync benefits**, **Run autopilot**, **Open Finstracker** (the side panel) or **Hide on this site**. Settings has a switch for it and brings it back on hidden sites.

## Autopilot

**Which card is on screen.** Finstracker reads the card name the site shows in its top bar or card switcher ("The Platinum Card® •••• 1004"), using only the words that tell your cards apart ("Amex Gold" and "Amex Platinum" → "gold", "platinum"). The popup says "You're viewing Platinum Card" and picks it by default; Sync this page and Read this tab sync the card on screen and say so if you chose another; autopilot starts with it. Before saving a balance, offers or benefits, it checks the page still shows the right card: autopilot selects the card again, and otherwise saves nothing for it (a balance printed right next to the card's own name, on pages that list several cards, still counts).

On a card site, the Finstracker popup names your cards that use the site ("3 of your cards use americanexpress.com: Gold, Platinum, Blue Cash") and offers **Run autopilot for 3 cards**. It runs in that tab. When several cards share a site, autopilot selects each card in the site's own card switcher before reading its balance, offers and benefits. If a card can't be selected on the offers or benefits page, that step is skipped for the card rather than saving another card's data. A short summary, one line per card, shows on the page at the end. The quick tab has the same **Run autopilot for all**.

**In the side panel.** The top of Your cards is about the tab you're on: **Run autopilot on this page** for the cards that use its site (it runs in that tab). If none of your cards is linked to the site yet, **Link cards to this site** lists your cards to tick, then **Save** or **Save and run autopilot**; the site is remembered for them. **Change cards** edits the list. **Run autopilot for all cards** and **Add cards** are at the bottom of the list.

**New cards on the site.** Once you're signed in, Finstracker reads the cards the site lists for your login (its card switcher and account tiles, "The Platinum Card® •••• 1004") and compares them with your Finstracker cards by number and name ("Gold Card" is your Amex Gold; "Delta SkyMiles Gold Card" is a different card). Cards that aren't in Finstracker yet show in the popup, checked: **Add cards** creates them in your account (with the dashboard's catalog card when it knows it, so fees and multipliers come along), links them to the site, and they join the popup and autopilot. **Not mine** hides them on that site for good. Autopilot shows them on its board with an Add button, and the side panel lists them too (**Find new cards on this site** looks right away). Card numbers are remembered to tell cards apart next time.

**A bank's site with none of your cards linked.** Cards are matched to a site by their issuer, their program (Membership Rewards → American Express, Ultimate Rewards → Chase) or well-known names (Platinum Card, Sapphire, Venture), so a card saved with an unusual issuer still finds its bank. If none matches, the popup asks "Which of your cards use americanexpress.com?" with the same Save / Save and run autopilot. When a card is linked to a site other than its issuer's, offers and benefits are found on that site rather than the issuer's usual pages.

**Background tabs and the progress board.** Start autopilot from any page of the site (the home page is fine): it follows the site's own links to the balance, offers and benefits pages, and remembers where it found each one so the next run goes straight there. Run by hand, it reads each card's balance in your tab, then opens two background tabs next to it (same window, so the site shows its full desktop pages) that add and save the card's offers and check its benefits at the same time; they close when done. **Stop autopilot** (on the board or in the panel) closes its tabs and ends the run within a couple of seconds. A run cut off by a browser or extension restart is marked stopped, so a new one can start. No step waits forever: looking for a balance or an OK on the page gives up after about 90 seconds once you're signed in, and offers or benefits after 3 minutes, so the other steps still run. Balances run one card at a time (see Several cards at once). A board in the top-right of the portal page shows every card with its Balance, Offers and Benefits as they happen (minimize it, or Stop autopilot); it stays with the results when autopilot is done.

**Run autopilot** (on a card, on this page, or for all cards at the bottom of Your cards) goes through the issuer's pages in one tab and updates everything for each card:

1. **Balance**: points, or cash back for cash back cards (Amex "Reward Dollars", Discover "Cashback Bonus", "cash back"), plus new **points activity** lines ("Nov 8 · Dining · +500 pts") recorded as their own entries. The first read of a card only notes what is already there, so nothing is counted twice.
2. **Offers**: clicks **Add to Card** on every offer tile (only inside offer tiles, never page buttons like "Add card"), then saves all offers to that card in Finstracker, marking the ones on the card. Banks without a known offers page are reached through their own "Offers" link.
3. **Benefits**: reads the benefits page ("Uber Cash · $10 of $10 used", "$0 remaining", "Completed", Amex's "$200 Uber Cash · $15 Earned Nov · $0 To Go") and marks the matching credits used in Finstracker.

**Every offer, saved and added.** Autopilot adds every offer it can to the card, then saves all of them: the ones it just added (Amex takes those off the list as they're added, so they're kept from the first read), the ones that couldn't be added, and the ones that were already on the card (Amex's "Added to Card" page, or the site's "Added offers" link). Hundreds of offers are saved in batches.

**New cards join the run.** When autopilot starts on a bank's site, cards the site lists that aren't in Finstracker are added (bank, reward type and catalog card) and run with the others. Bank accounts the switcher lists next to cards (checking, savings) are left out, and so are cards you marked "Not mine". Settings → **Autopilot adds new cards it finds** turns this off, and then they're offered on the board instead. A co-brand card found on Amex (Hilton Honors Aspire, Delta SkyMiles) is worked on at Amex with your other Amex cards.

**Several cards at once.** Balances are read one card at a time, since the site shows one selected card. Offers and benefits keep running in their own background tabs while the next card is selected, when that's safe: the card is the only one on its site, or the site keeps the selected card in the page address (Amex's `account_key`, also read from the page's links), so its tabs keep showing it. Up to three cards' offers and benefits run at once. Sites that remember the selected card only in your session run one card at a time.

**No cards yet.** On a bank's site with no cards in Finstracker (a new account, or after Start over), the popup looks for the cards the site lists ("Finstracker found 4 cards on americanexpress.com"), all ticked, with **Add cards and run autopilot**. Before you sign in it says to sign in, and looks again on the next page.

**Start over.** Settings → Account → **Delete all** deletes every card on the signed-in Finstracker account with its offers and credits, and clears what the extension learned (pages, card numbers, autopilot results). Your sign-in and settings stay. It asks first, and can't be undone.

**Clicking around the site.** When the page it opens doesn't show what it needs, autopilot clicks through the site the way you would, up to four links or tabs per step: for benefits, the Benefits link and then the tab with usage ("View Benefits Activity", "Track progress"); for offers, the Offers link and the list of offers you can still add ("Eligible offers"). If a page only lists offers already on the card, those are saved and it moves on to the ones it can still add. Tabs already selected and links already tried are skipped, and the site's menus and card switcher are never opened by accident. On Amex it goes straight to Benefits Activity, where usage lives, and reads every offer wording Amex uses ("Spend $75 or more, earn $30", "Earn +2 Membership Rewards® points per eligible dollar").

**Points history.** After each balance sync (the sync button and autopilot), Finstracker reads the site's points activity, such as Amex's "Your Points Activity" table (date, card, status, description, multiplier, amount, points), and saves each line to Finstracker as history. Lines go to the card in the table's card column (Amex lists every card on a Membership Rewards account together); lines for a card not in Finstracker are left out. Only new lines are read: "Show More" is pressed only until a line Finstracker already has shows up, so a second run reads nothing more. A pending line that later posts is updated, never saved twice. History never changes the balance (the balance sync does). If the balance page has no activity, the issuer's activity page (Amex: Rewards summary) or the site's "Points activity" link is opened in the same tab. Settings → Record points activity turns it off.

**Last pulled.** The popup says when each card was last pulled ("Last pulled 2 hours ago", "All pulled yesterday", "Not pulled yet"), and the card list shows it next to each card, so you can skip a run that isn't needed.

**Never the login page.** Each card starts from its saved rewards page or the bank's rewards page, never its sign-in page: loading Amex's login page signs you out. New background tabs share your signed-in session. If you aren't signed in, the bank sends you to its own sign-in.

**Shared points.** Amex Membership Rewards is one balance for every Amex points card on your login (Gold, Platinum, Green show the same number). Autopilot reads it once, on the first such card, and the others say "Shared Membership Rewards balance (saved on Platinum Card)"; their offers and benefits still run. Co-brand cards (Hilton, Delta) and cash back cards keep their own balances. A card the site's card list doesn't have is skipped.

**Only when you click.** Autopilot starts only from a button you press: Run autopilot (popup, quick tab, side panel) or Add cards and run autopilot. There is no daily run by itself. Opening a page only reads it: the popup appears and new cards are looked for without clicking anything on the site; the site's card list is opened only after you press Find my cards, Find new cards on this site or Run autopilot.

Each step also has its own button on the card: **Update points/cash back**, **Sync offers**, **Sync benefits**.

## How a points sync works

1. **Update points** uses a tab that is already on the card's site. Otherwise it opens the page where the balance was found last time, or the sign-in page of the site that holds the points. Co-branded cards go to the airline or hotel (Delta, United, Southwest, American, Alaska, JetBlue, Aeroplan, British Airways, Flying Blue, Marriott, Hilton, Hyatt, IHG, Wyndham, Choice, Amazon, Bilt); other cards go to their bank (Amex, Chase, Capital One, Citi, Discover, Wells Fargo, Bank of America, U.S. Bank, Barclays). **Read this tab** does the same on the tab you are looking at.
2. A small Finstracker note on the page says what is happening. On a sign-in or verification page it waits for you; passwords, passkeys and codes are yours to enter.
3. Once you are in, it reads the page. No balance there → it opens the card's rewards page, then follows the site's own rewards links ("Ultimate Rewards", "SkyMiles", "View rewards"), up to three steps, on the same site only.
4. It prefers numbers next to the card's name and program, so a page listing several cards gives each card its own number. Dollar amounts, statement balances and masked account numbers are skipped, and so is anything in the page footer or legal text (© 2026, "All rights reserved"), phone numbers, dates ("Nov 8, 2026", "Member since 2015") and bare years. "2,026 points" is still a balance. A final check runs before anything is saved, and the picker refuses these too.
5. The first time, the number is highlighted and the note asks **Is this your balance?** (also shown in the side panel). **Use it** posts the difference to Finstracker; **Pick another** lets you click the right number. That spot is then trusted, and later syncs post without asking.

**Pick the balance** walks you through it. From any tab, it takes you to the card's site and opens the picker once you have signed in. Step 1 lists the likeliest numbers (numbered on the page too); click one, press its number key, or click the balance itself. Hovering shows the number that would be picked. Step 2 asks "Use 98,765 for Sapphire Preferred?". **Not on this page** opens the card's rewards page and the picker comes back there.

**Use this tab** makes the open page a card's rewards page. Pages and spots are remembered per card; **Settings › Rewards pages › Reset** forgets them.

## Code layout

No build step: the folder is the extension.

```text
manifest.json
background.js              Service worker: connects Chrome events to lib/worker
panel/                     Side panel (panel.html, panel.css, panel.js)
content/                   Page scripts: reader (finds balances and rewards links), status note,
                           sync prompt, checkout note, element picker
lib/
  api.js                   Finstracker REST API client
  storage.js               chrome.storage.local keys and defaults
  parse.js                 Number parsing and the earn/redeem calculation
  portals.js               Which page and selector to use for each card, and where to go next
  programs.js              Airline and hotel programs, issuer name spellings, words next to a balance
  merchants.js             Website → spending category, checkout detection, offer matching
  best-card.js             Ranking cards by value per dollar
  benefits.js              Credits, offers and annual fee summaries
  inject/offers.js         Offer-tile reader run inside issuer offer pages
  worker/                  Service worker parts: capture, offers sync, site hints, messages, sign-in
portals.json               Issuer and card presets
fonts/                     Inter and Fraunces (SIL Open Font License)
tests/                     node --test suites for the lib/ logic
```

Run the tests with Node 20 or newer:

```bash
npm test
```

End-to-end tests load the extension in Chromium and sync from a fake bank (sign-in, a dashboard without the balance, a rewards page listing two cards, strict Content-Security-Policy):

```bash
npm install && npx playwright install chromium
npm run e2e -- update
npm run e2e -- existing
npm run e2e -- picker
npm run e2e -- guided
npm run e2e -- amex     # prompt across page loads and in-app routes, Trusted Types page
npm run e2e -- wander   # moving to another page while "Is this your balance?" is up
npm run e2e -- cashback  # Reward Dollars next to a statement balance
npm run e2e -- offers    # Add to Card on each offer, not the page's own buttons; saved per card
npm run e2e -- benefits  # follows the Benefits link, marks fully used credits
npm run e2e -- activity  # activity lines saved as dated history on the first sync, only the new line on the next; the balance moves with the sync alone
npm run e2e -- history   # Amex-style points activity table: Show More, lines to the card in their card column, second run reads nothing new; popup shows last pulled
npm run e2e -- autopilot # balance, offers and benefits from one button
npm run e2e -- quicktab  # close the prompt, drag the tab, sync from its menu
npm run e2e -- portal    # three cards on one site with a card switcher, autopilot from the popup
npm run e2e -- viewing   # the page shows Platinum: popup, Sync this page, Read this tab and autopilot follow it
npm run e2e -- addall    # Amex-style offers: new formats ("Spend $75 or more, earn $30", icon-only add buttons), redrawn list, Load more, a lost click; all 10 added
npm run e2e -- amexbenefits # benefits behind "View details"; each benefit reported with what happened
npm run e2e -- alloffers # Amex-style: added offers leave the list, "Added to Card" page; all 9 saved as on the card
npm run e2e -- parallel  # account_key in the address: two new cards added and run, cards overlap, each card's offers on its own card
npm run e2e -- fresh     # no cards in Finstracker, on Amex's address: popup finds 7 cards, adds and runs them all
npm run e2e -- nologin   # Amex cards with only the bank's settings, run from a signed-in Amex page: the login page is never opened
npm run e2e -- noclick   # pages load, nothing runs: no autopilot, no sync, the card switcher stays shut; Find my cards opens it
npm run e2e -- reset     # Settings → Delete all: cards, offers and credits deleted, learned pages forgotten, sign-in kept
npm run e2e -- amextabs  # Amex layout: home → Rewards & Benefits → View Benefits Activity tab; "$200 Uber Cash · $0 To Go"; menus left closed
npm run e2e -- noise     # © 2026, phone numbers, dates: never read or picked as a balance
npm run e2e -- stop      # Stop mid-run: tabs close, nothing more saved, a new run starts; a leftover run is cleared
npm run e2e -- reload    # extension reloaded with its popup and board on the page: the old ones go, no errors
npm run e2e -- newcards  # the site lists cards not in Finstracker: add one (bank and catalog card), "Not mine" for another
npm run e2e -- pagebutton # no card linked: link two from the panel, popup appears, Run autopilot on this page
```

## Security model

- The session token lives only in `chrome.storage.local` and is sent as `Authorization: Bearer …` to Finstracker. It is never put into any web page.
- Sign-in happens on finstracker.com in a normal tab, which hands the token to this extension by its ID. Only Finstracker's own origins can do that (`externally_connectable`).
- Page scripts run in the extension's isolated world (so bank pages' Content-Security-Policy cannot block them, and page scripts cannot see them) and return only the text of the balance or offer tiles. They do not read form fields, cookies or tokens.
- Host access is limited to Finstracker, the supported banks and the airline, hotel and shop programs above. Other sites are asked for one at a time, only when you use Read this tab, Pick the balance or Use this tab there. Checkout notes need broader site access, which is optional, asked for only when you turn the feature on, and given back when you turn it off.
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
