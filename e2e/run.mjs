// End-to-end: the real extension in Chromium, syncing points from a fake bank (sign-in, a dashboard
// without the balance, a rewards page listing two cards, strict Content-Security-Policy) into a
// fake Finstracker API. Scenarios: update (new tab, confirm, then a trusted second sync on the same
// tab), existing (Read this tab on an open tab), picker (pick the number by hand).
import { chromium } from "playwright-core";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./fake-sites.mjs";

// npm run e2e -- update | existing | picker
// Needs playwright-core (devDependency) and a Chromium: npx playwright install chromium, or CHROME=/path.
const EXT = fileURLToPath(new URL("..", import.meta.url));
const CHROME = process.env.CHROME || chromium.executablePath();
const SHOTS = process.env.SHOTS || tmpdir();
const scenario = process.argv[2];
const { server, state } = await startServer();
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "fins-")), { executablePath: CHROME, headless: true, viewport: { width: 1100, height: 760 }, args: ["--headless=new", `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
const log = (...a) => console.log(`[${scenario}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = false;
try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 10000 });
  sw.on("console", (m) => { if (m.type() !== "log" || (process.env.DEBUG && m.text().startsWith("[dbg]"))) log("sw", m.type(), m.text()); });
  const extId = new URL(sw.url()).host;
  await sw.evaluate(() => chrome.storage.local.set({ token: "test-token", apiBase: "http://localhost:3000", devServer: true, autoAddCards: false, user: { username: "e2e" }, rewardsPages: { c1: { url: "http://localhost:3000/bank/dashboard", source: "learned" } } }));
  const session = () => sw.evaluate(() => chrome.storage.local.get("captureSession").then((r) => r.captureSession || null));
  const waitFor = async (pred, label, ms = 40000) => {
    const end = Date.now() + ms; let last = "";
    while (Date.now() < end) {
      const s = await session();
      const line = s ? `${s.status} | ${s.statusLabel || ""} | ${s.lastError || ""}${process.env.DEBUG ? ` | ${s.cardId} ${JSON.stringify(s.switchResult || null)} ${s.currentUrl || ""}` : ""}` : "none";
      if (line !== last) { log("  session:", line); last = line; }
      if (await pred(s)) return s;
      await sleep(400);
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  const note = async (page) => page.evaluate(() => document.querySelector("#fins-status-root")?.innerText.replace(/\n+/g, " | ") || "(no note)");
  const signIn = async (page) => { await page.fill('input[name="user"]', "me"); await page.fill('input[name="pw"]', "pw"); await page.click("button"); };

  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${extId}/panel/panel.html`);
  await panel.waitForSelector('[data-act="toggle-card"][data-id="c1"]', { timeout: 10000 });
  await panel.click('[data-act="toggle-card"][data-id="c1"]');
  const pagesBefore = ctx.pages().length;
  let bank;

  if (scenario === "update" || scenario === "picker") {
    await panel.click('[data-act="update"][data-id="c1"]');
    bank = await ctx.waitForEvent("page", { timeout: 5000 });
    await bank.waitForLoadState();
    log("opened", bank.url());
    await waitFor((s) => s?.status === "awaiting-login", "sign-in state");
    await sleep(500); log("note on sign-in page:", await note(bank));
    await signIn(bank);
    if (scenario === "update") {
      const s = await waitFor((s) => s?.status === "confirm", "confirm");
      log("now on", bank.url(), "pending", s.pending.value, "highlight:", await bank.evaluate(() => Boolean(document.getElementById("fins-highlight"))));
      log("note:", await note(bank));
      await bank.screenshot({ path: `${SHOTS}/confirm.png` });
      await panel.setViewportSize({ width: 380, height: 700 });
      await panel.screenshot({ path: `${SHOTS}/panel-confirm.png` });
      log("panel status:", await panel.evaluate(() => document.querySelector(".status")?.innerText.replace(/\n+/g, " | ")));
      await bank.click('#fins-status-root [data-action="confirm"]');
      await waitFor(() => state.transactions.length > 0, "transaction");
      await sleep(600); log("note after:", await note(bank));
      log("transactions:", JSON.stringify(state.transactions), "points:", state.points);
      // Second sync: the tab is already on the bank, and the spot is now trusted.
      const before = ctx.pages().length;
      await sw.evaluate(() => chrome.storage.local.set({ captureSession: null }));
      await panel.bringToFront();
      await panel.click('[data-act="update"][data-id="c1"]');
      const s2 = await waitFor((s) => s?.status === "synced", "second sync", 20000);
      log("second sync reused tab:", ctx.pages().length === before, "value", s2.lastScrape?.value);
      ok = state.points === 98765 && ctx.pages().length === before;
    } else {
      await waitFor((s) => s?.status === "confirm", "confirm");
      await bank.click('#fins-status-root [data-action="pick"]');
      await waitFor((s) => s?.status === "picking", "picking");
      await sleep(400);
      const target = bank.locator("text=98,765");
      await target.click();
      await sleep(300);
      await bank.screenshot({ path: `${SHOTS}/picker.png` });
      await bank.evaluate(() => 0);
      // Use this value (inside the picker's closed shadow root): click its position.
      const box = await bank.evaluate(() => { const h = document.getElementById("fins-picker-host"); return h ? true : false; });
      log("picker HUD present:", box);
      // Click "Use this value" with the mouse (the HUD sits bottom-left in a closed shadow root).
      await bank.keyboard.press("Enter"); // step 2: use the outlined number
      await waitFor(() => state.transactions.length > 0, "picked transaction");
      log("transactions:", JSON.stringify(state.transactions), "picker gone:", await bank.evaluate(() => !document.getElementById("fins-picker-host")));
      const { portalOverrides } = await sw.evaluate(() => chrome.storage.local.get("portalOverrides"));
      log("saved spot:", JSON.stringify(portalOverrides.c1));
      ok = state.points === 98765 && portalOverrides.c1?.source === "user-picker";
    }
  } else if (scenario === "guided") {
    // Pick the balance while looking at a page that is not the bank: the extension goes there,
    // waits for sign-in, then opens the guided picker by itself.
    await panel.click('[data-act="pick"][data-id="c1"]');
    bank = await ctx.waitForEvent("page", { timeout: 5000 });
    await bank.waitForLoadState();
    await waitFor((s) => s?.status === "awaiting-login", "sign-in");
    await sleep(400); log("note:", await note(bank));
    await signIn(bank);
    await waitFor((s) => s?.status === "picking" && /dashboard/.test(s.currentUrl || ""), "picker on dashboard");
    await sleep(500);
    await bank.screenshot({ path: `${SHOTS}/guided-dashboard.png` });
    await bank.mouse.click(95, 713); // "Not on this page" in the picker
    await waitFor((s) => s?.status === "picking" && /rewards/.test(s.currentUrl || ""), "picker on rewards page");
    await sleep(600);
    await bank.mouse.move(40, 145); await sleep(200); // hover shows the number that would be picked
    await bank.screenshot({ path: `${SHOTS}/guided-rewards.png` });
    await bank.keyboard.press("1"); // first suggestion
    await sleep(300);
    await bank.screenshot({ path: `${SHOTS}/guided-step2.png` });
    await bank.mouse.click(80, 713); // "Use 98,765" in the picker (bottom-left, 1100×760 window)
    await waitFor(() => state.transactions.length > 0, "picked transaction");
    const { portalOverrides } = await sw.evaluate(() => chrome.storage.local.get("portalOverrides"));
    log("transactions:", JSON.stringify(state.transactions), "spot:", portalOverrides.c1?.selector, portalOverrides.c1?.source);
    ok = state.points === 98765 && portalOverrides.c1?.source === "user-picker";
  } else if (scenario === "amex") {
    // Signed in, browsing the bank: the sync prompt shows on the dashboard, again after a full page
    // load to /rewards?opaqueAccountId=…, and stays through in-app route changes.
    bank = await ctx.newPage();
    const prompt = () => bank.evaluate(() => document.querySelector("#fins-prompt-root")?.innerText.replace(/\n+/g, " | ") || null);
    await bank.goto("http://localhost:3000/bank/login"); await signIn(bank);
    await bank.waitForURL(/dashboard/); await sleep(2500);
    const onDashboard = await prompt(); log("prompt on dashboard:", onDashboard);
    await bank.click("text=Ultimate Rewards"); await bank.waitForURL(/rewards/); await sleep(2500);
    const onRewards = await prompt(); log("prompt after page load to", bank.url(), ":", onRewards);
    await bank.goto("http://localhost:3000/bank/dashboard"); await sleep(2500);
    await bank.click("#spa-link"); await sleep(2500);
    const afterSpa = await prompt(); log("prompt after in-app route change to", bank.url(), ":", afterSpa);
    // Sync from the prompt on the rewards page (Trusted Types page): status note, confirm, post.
    await bank.goto("http://localhost:3000/bank/rewards?opaqueAccountId=OQX90"); await sleep(2500);
    await bank.click('#fins-prompt-root [data-act="sync"]');
    const s = await waitFor((s) => s?.status === "confirm", "confirm on rewards page");
    log("note:", await note(bank));
    await bank.click('#fins-status-root [data-action="confirm"]');
    await waitFor(() => state.transactions.length > 0, "transaction");
    const { rewardsPages } = await sw.evaluate(() => chrome.storage.local.get("rewardsPages"));
    log("saved page:", rewardsPages.c1?.url);
    ok = Boolean(onDashboard && onRewards && afterSpa) && s.pending?.value === 98765 && state.points === 98765 && /opaqueAccountId=OQX90/.test(rewardsPages.c1?.url || "");
  } else if (scenario === "wander") {
    // "Is this your balance?" shows a wrong number on the dashboard; the user goes to the rewards
    // page instead, and the extension reads that page.
    bank = await ctx.newPage();
    await bank.goto("http://localhost:3000/bank/login"); await signIn(bank); await bank.waitForURL(/dashboard/);
    await bank.goto("http://localhost:3000/bank/dashboard?promo=1"); await sleep(1500);
    await panel.bringToFront(); await bank.bringToFront();
    await panel.click('[data-act="read-tab"][data-id="c1"]').catch(() => {});
    const first = await waitFor((s) => s?.status === "confirm" || s?.status === "error", "first read");
    log("first read:", first.status, first.pending?.value ?? first.lastError, first.currentUrl);
    await bank.click("#spa-link");
    const s = await waitFor((s) => s?.status === "confirm" && s.pending?.value === 98765, "read after moving to rewards", 30000);
    log("after moving:", s.status, s.pending?.value, s.currentUrl);
    ok = first.pending?.value === 2000 && s.pending?.value === 98765;
  } else if (scenario === "cashback") {
    // A cash back card: the dollar "Reward Dollars" balance next to a statement balance.
    await sw.evaluate(() => chrome.storage.local.set({ rewardsPages: { c2: { url: "http://localhost:3000/bank/rewards", source: "user" } } }));
    bank = await ctx.newPage();
    await bank.goto("http://localhost:3000/bank/login"); await signIn(bank); await bank.waitForURL(/dashboard/);
    await panel.bringToFront();
    await panel.click('[data-act="toggle-card"][data-id="c2"]');
    await panel.click('[data-act="update"][data-id="c2"]');
    const s = await waitFor((s) => s?.status === "confirm" || s?.status === "error", "cash back confirm");
    log("found:", s.status, s.pending?.value, "note:", await note(bank));
    await bank.click('#fins-status-root [data-action="confirm"]');
    await waitFor(() => state.transactions.length > 0, "transaction");
    log("transactions:", JSON.stringify(state.transactions), "cash back:", state.cards.c2.currentCashBack);
    ok = s.pending?.value === 123.45 && state.cards.c2.currentCashBack === 123.45 && state.transactions[0].unit === "cashback";
  } else if (scenario === "offers") {
    // On the offers page: add every offer to the card, never the page's own "Add card" button, then save them.
    bank = await ctx.newPage();
    await bank.goto("http://localhost:3000/bank/login"); await signIn(bank); await bank.waitForURL(/dashboard/);
    await bank.goto("http://localhost:3000/bank/offers"); await bank.bringToFront();
    await panel.click('[data-act="sync-offers"][data-id="c1"]').catch(() => {});
    const s = await waitFor((s) => s?.kind === "offers" && (s.status === "synced" || s.status === "error"), "offers synced", 60000);
    const buttons = await bank.evaluate(() => [...document.querySelectorAll(".tile button")].map((b) => b.textContent));
    const decoy = await bank.evaluate(() => document.body.dataset.decoy || "not clicked");
    log("status:", s.statusLabel || s.lastError, "| buttons now:", buttons.join(", "), "| page-level Add card:", decoy);
    log("saved:", JSON.stringify(state.offers.map((o) => [o.merchant, o.activated, o.cardId])));
    ok = s.status === "synced" && buttons.every((b) => b === "Added") && decoy === "not clicked" && state.offers.length === 3 && state.offers.every((o) => o.activated && o.cardId === "c1");
  } else if (scenario === "benefits") {
    // Sync benefits from the dashboard: follows the Benefits link, marks the fully used credit only.
    bank = await ctx.newPage();
    await bank.goto("http://localhost:3000/bank/login"); await signIn(bank); await bank.waitForURL(/dashboard/);
    await panel.click('[data-act="sync-benefits"][data-id="c1"]').catch(() => {});
    const s = await waitFor((s) => s?.kind === "benefits" && (s.status === "synced" || s.status === "error"), "benefits checked", 60000);
    log("status:", s.statusLabel || s.lastError, "| on", bank.url(), "| perks:", JSON.stringify(state.perks.map((x) => [x.id, x.used])));
    ok = s.status === "synced" && state.perks.find((x) => x.id === "p-uber").used && !state.perks.find((x) => x.id === "p-de").used;
  } else if (scenario === "activity") {
    // First sync: every activity line is saved as history (dated, never changing the balance). Next
    // sync: only the new line is sent. The balance moves with the balance sync alone.
    await sw.evaluate(() => chrome.storage.local.set({ portalOverrides: { c1: { matchUrl: "http://localhost:3000/*", selector: "#root > div.tile:nth-of-type(2) > div:nth-of-type(3)", source: "user-picker" } }, rewardsPages: { c1: { url: "http://localhost:3000/bank/rewards", source: "user" } } }));
    bank = await ctx.newPage();
    await bank.goto("http://localhost:3000/bank/login"); await signIn(bank); await bank.waitForURL(/dashboard/);
    await bank.goto("http://localhost:3000/bank/rewards"); await sleep(1500);
    await bank.bringToFront();
    await panel.click('[data-act="read-tab"][data-id="c1"]').catch(() => {});
    await waitFor((s) => s?.status === "synced", "first sync");
    log("after first sync:", JSON.stringify(state.transactions.map((t) => [t.type, t.amount, t.note])));
    await sw.evaluate(() => chrome.storage.local.set({ captureSession: null }));
    await bank.goto("http://localhost:3000/bank/rewards?more=1"); await sleep(1500);
    await bank.bringToFront();
    await panel.click('[data-act="read-tab"][data-id="c1"]').catch(() => {});
    await waitFor((s) => s?.status === "synced", "second sync");
    await sleep(500);
    log("after second sync:", JSON.stringify(state.transactions.map((t) => [t.type, t.amount, t.note])), "points:", state.points, "| note:", await note(bank));
    log("history:", JSON.stringify(state.history.map((h) => [h.date, h.description, h.points])));
    const year = new Date().getFullYear();
    ok = state.history.length === 4 && state.history.some((h) => h.description === "Dining" && h.points === 500 && /-11-08$/.test(h.date))
      && state.history.some((h) => /Transfer to Delta/.test(h.description) && h.points === -5000)
      && state.transactions.every((t) => /Synced with Finstracker Sync/.test(t.note)) && state.points === 99265 && year > 2000;
  } else if (scenario === "autopilot") {
    // One button: balance, then offers (added + saved), then benefits, in one tab.
    await sw.evaluate(() => chrome.storage.local.set({ portalOverrides: { c1: { matchUrl: "http://localhost:3000/*", selector: "#root > div.tile:nth-of-type(2) > div:nth-of-type(3)", source: "user-picker" } }, rewardsPages: { c1: { url: "http://localhost:3000/bank/rewards", source: "user" } } }));
    bank = await ctx.newPage();
    await bank.goto("http://localhost:3000/bank/login"); await signIn(bank); await bank.waitForURL(/dashboard/);
    await panel.bringToFront();
    await panel.click('[data-act="run-autopilot"][data-id="c1"]');
    await sleep(1500);
    await panel.screenshot({ path: `${SHOTS}/autopilot-panel.png` });
    let run;
    const end = Date.now() + 120000;
    while (Date.now() < end) {
      run = await sw.evaluate(() => chrome.storage.local.get(["autopilotRun", "autopilot"]));
      if (!run.autopilotRun && run.autopilot?.c1?.lastRun) break;
      await sleep(1000);
    }
    const results = run.autopilot?.c1?.results;
    log("results:", JSON.stringify(results));
    log("points:", state.points, "| offers saved:", state.offers.length, "| perks:", JSON.stringify(state.perks.map((x) => [x.id, x.used])), "| tabs:", ctx.pages().length);
    await panel.click('[data-act="toggle-card"][data-id="c1"]').catch(() => {});
    await sleep(300);
    await panel.screenshot({ path: `${SHOTS}/autopilot-card.png` });
    const { learnedPages } = await sw.evaluate(() => chrome.storage.local.get("learnedPages"));
    log("learned pages:", JSON.stringify(learnedPages?.c1 || null));
    ok = state.points === 98765 && state.offers.length === 3 && state.perks.find((x) => x.id === "p-uber").used && /Balance/.test(results?.balance || "") && /offers saved/.test(results?.offers || "")
      && /^http:\/\/localhost:3000\//.test(learnedPages?.c1?.offers || "") && /^http:\/\/localhost:3000\//.test(learnedPages?.c1?.benefits || "");
  } else if (scenario === "quicktab") {
    // Close the prompt → a Finstracker tab stays on the edge. Drag it, click it, sync from its menu.
    bank = await ctx.newPage();
    await bank.goto("http://localhost:3000/bank/login"); await signIn(bank); await bank.waitForURL(/dashboard/);
    await bank.goto("http://localhost:3000/bank/rewards"); await sleep(2500);
    await bank.click('#fins-prompt-root .fins-prompt-close');
    await sleep(800);
    const hasTab = await bank.evaluate(() => Boolean(document.getElementById("fins-launcher-root")));
    await bank.screenshot({ path: `${SHOTS}/quicktab-right.png` });
    // Drag from the right edge (default spot, 62% down) to the left edge.
    const startY = Math.round(760 * 0.62) + 23;
    await bank.mouse.move(1085, startY); await bank.mouse.down();
    for (let i = 1; i <= 10; i++) await bank.mouse.move(1085 - i * 100, startY - i * 25);
    await bank.mouse.move(30, 230); await bank.mouse.up();
    await sleep(400);
    const { launcherPos } = await sw.evaluate(() => chrome.storage.local.get("launcherPos"));
    log("tab after closing the prompt:", hasTab, "| dragged to:", JSON.stringify(launcherPos));
    // Click it (no drag) to open the menu, then the first item: Sync points.
    await bank.mouse.click(18, 230);
    await sleep(400);
    await bank.screenshot({ path: `${SHOTS}/quicktab-menu.png` });
    await bank.keyboard.press("Enter");
    const s = await waitFor((s) => s?.status === "confirm", "sync from the quick tab");
    log("sync from the quick tab:", s.status, s.pending?.value);
    // Another page on the site: the tab is back, on the left.
    await sw.evaluate(() => chrome.storage.local.set({ captureSession: null }));
    await bank.goto("http://localhost:3000/bank/dashboard"); await sleep(2500);
    const again = await bank.evaluate(() => Boolean(document.getElementById("fins-launcher-root")));
    const prompt = await bank.evaluate(() => Boolean(document.getElementById("fins-prompt-root")));
    await bank.screenshot({ path: `${SHOTS}/quicktab-left.png` });
    log("next page: quick tab", again, "| prompt", prompt);
    ok = hasTab && launcherPos?.side === "left" && s.pending?.value === 98765 && again && !prompt;
  } else if (scenario === "portal") {
    // Three cards on one site. The popup offers autopilot for all of them; it selects each card in
    // the site's switcher, reads its balance, adds and saves its offers, checks its benefits. Blue
    // Cash isn't in the switcher: its balance is read, its offers and benefits are skipped.
    await sw.evaluate(() => chrome.storage.local.set({
      portalOverrides: {
        c1: { matchUrl: "http://localhost:3000/*", selector: "#root > div.tile:nth-of-type(2) > div:nth-of-type(3)", source: "user-picker" },
        c3: { matchUrl: "http://localhost:3000/*", selector: "#root > div.tile:nth-of-type(2) > div:nth-of-type(3)", source: "user-picker" },
        c2: { matchUrl: "http://localhost:3000/*", selector: "#root > div.tile:nth-of-type(3) > div:nth-of-type(5)", source: "user-picker" },
      },
      rewardsPages: Object.fromEntries(["c1", "c2", "c3"].map((id) => [id, { url: "http://localhost:3000/bank/rewards", source: "user" }])),
    }));
    bank = await ctx.newPage();
    await bank.goto("http://localhost:3000/bank/login"); await signIn(bank); await bank.waitForURL(/dashboard/);
    await bank.goto("http://localhost:3000/bank/rewards"); await sleep(2500);
    const popup = await bank.evaluate(() => document.querySelector("#fins-prompt-root")?.innerText.replace(/\n+/g, " | "));
    log("popup:", popup);
    await bank.screenshot({ path: `${SHOTS}/portal-popup.png` });
    await bank.click('#fins-prompt-root [data-act="run"]');
    let run;
    const end = Date.now() + 240000;
    await sleep(2000);
    let lastLine = "", maxPages = ctx.pages().length, boardSeen = false;
    while (Date.now() < end) {
      maxPages = Math.max(maxPages, ctx.pages().length);
      if (!boardSeen) boardSeen = await bank.evaluate(() => Boolean(document.getElementById("fins-board-root"))).catch(() => false);
      run = await sw.evaluate(() => chrome.storage.local.get(["autopilotRun", "autopilot", "captureSession"]));
      if (process.env.DEBUG) { const c = run.captureSession; const line = c ? `${c.cardId} ${c.kind} ${c.status} ${JSON.stringify(c.switchResult || null)} ${c.currentUrl || ""}` : "none"; if (line !== lastLine) { log("  ", line); lastLine = line; } }
      if (!run.autopilotRun) { if (process.env.DEBUG) log("  ap ended; keys:", JSON.stringify(Object.keys(await sw.evaluate(() => chrome.storage.local.get(null))))); break; }
      await sleep(500);
    }
    await sleep(800);
    await bank.screenshot({ path: `${SHOTS}/portal-done.png` });
    for (const id of ["c1", "c2", "c3"]) log(id, JSON.stringify(run.autopilot?.[id]?.results));
    log("balances:", state.cards.c1.currentPoints, state.cards.c3.currentPoints, state.cards.c2.currentCashBack);
    log("offers:", JSON.stringify(state.offers.map((o) => [o.cardId, o.merchant, o.activated])));
    log("perks:", JSON.stringify(state.perks.map((x) => [x.id, x.used])), "| tabs:", ctx.pages().length, "| note:", await note(bank));
    const pagesAfter = ctx.pages().length;
    log("side windows: most pages open at once", maxPages, "| after", pagesAfter, "| board shown:", boardSeen, "| board at end:", await bank.evaluate(() => Boolean(document.getElementById("fins-board-root"))));
    await bank.screenshot({ path: `${SHOTS}/portal-board.png` });
    const offersOf = (id) => state.offers.filter((o) => o.cardId === id).map((o) => o.merchant).sort().join(",");
    ok = maxPages >= pagesAfter + 2 && boardSeen && /3 cards/.test(popup || "") && state.cards.c1.currentPoints === 98765 && state.cards.c3.currentPoints === 45000 && state.cards.c2.currentCashBack === 123.45
      && offersOf("c1") === "Best Buy,Chipotle,Delta" && offersOf("c3") === "Hilton,Saks" && offersOf("c2") === "" && state.offers.every((o) => o.activated)
      && state.perks.find((x) => x.id === "p-uber").used && state.perks.find((x) => x.id === "p-dining").used && !state.perks.find((x) => x.id === "p-de").used;
  } else if (scenario === "parallel") {
    // Like Amex: the address picks the card (?account_key=, on every link) and the switcher lists two
    // cards that aren't in Finstracker. Autopilot adds them and runs them too, and a card's offers
    // and benefits keep running in their own tabs while the next card is selected.
    state.urlKeyed = true; state.newCard = true;
    const path = "#root > div.tile:nth-of-type(2) > div:nth-of-type(3)";
    await sw.evaluate((path) => chrome.storage.local.set({
      autoAddCards: true,
      portalOverrides: Object.fromEntries(["c1", "c3", "c4"].map((id) => [id, { matchUrl: "http://localhost:3000/*", selector: path, source: "user-picker" }])),
      rewardsPages: Object.fromEntries(["c1", "c3", "c4"].map((id) => [id, { url: "http://localhost:3000/bank/rewards", source: "user" }])),
    }), path);
    bank = await ctx.newPage();
    await bank.goto("http://localhost:3000/bank/login"); await signIn(bank); await bank.waitForURL(/dashboard/);
    await bank.goto("http://localhost:3000/bank/rewards"); await sleep(2500); await bank.bringToFront();
    const started = Date.now();
    await bank.click('#fins-prompt-root [data-act="run"]');
    let run, maxPages = ctx.pages().length, notice = "", lastLine = "";
    const confirms = [];
    const end = Date.now() + 300000;
    await sleep(1500);
    while (Date.now() < end) {
      maxPages = Math.max(maxPages, ctx.pages().length);
      if (!notice) notice = await bank.evaluate(() => document.querySelector("#fins-board-root") ? "" : "").catch(() => "");
      run = await sw.evaluate(() => chrome.storage.local.get(["autopilotRun", "autopilot"]));
      if (run.autopilotRun?.board?.notice?.text) notice = run.autopilotRun.board.notice.text;
      // A new card's first balance asks "Is this your balance?": say yes, as you would.
      const asked = await bank.evaluate(() => document.querySelector("#fins-status-root") && document.querySelector('#fins-status-root [data-action="confirm"]') ? `${document.querySelector("#fins-status-root").innerText.replace(/\n+/g, " | ").slice(0, 160)} || url=${location.search} tile=${[...document.querySelectorAll(".tile")].map((t) => t.innerText.split("\n")[0]).join(";")}` : "").catch(() => "");
      if (asked) { confirms.push(asked); await bank.click('#fins-status-root [data-action="confirm"]', { timeout: 500 }).catch(() => {}); await sleep(800); }
      if (process.env.DEBUG) { const line = (run.autopilotRun?.board?.cards || []).map((c) => `${c.name.slice(0, 10)}[${c.steps.map((x) => `${x.state[0]}:${(x.text || "").slice(0, 40)}`).join(" / ")}]`).join("  "); if (line !== lastLine) { log("  ", line); lastLine = line; } }
      if (!run.autopilotRun) break;
      await sleep(500);
    }
    const took = Math.round((Date.now() - started) / 1000);
    await sleep(800);
    const made = Object.values(state.cards).filter((c) => c.id.startsWith("n"));
    const idOf = (name) => made.find((c) => c.displayName.includes(name))?.id;
    const offersOf = (id) => state.offers.filter((o) => o.cardId === id).map((o) => o.merchant).sort().join(",");
    const order = state.log.map((x) => `${x.kind}:${x.cardId}`);
    // Overlap: a card's offers were saved after a later card's balance.
    const overlapped = state.log.some((a, i) => a.kind === "balance" && state.log.slice(i + 1).some((b) => b.kind === "balance" && b.cardId !== a.cardId && state.log.slice(state.log.indexOf(b) + 1).some((c) => c.kind === "offers" && c.cardId === a.cardId)));
    log("took", took, "s | most pages open:", maxPages, "| notice:", notice);
    log("added:", made.map((c) => `${c.id} ${c.displayName}`).join(", "));
    for (const c of confirms) log("  asked:", c);
    log("order:", order.join(" "));
    for (const id of ["c1", "c3", "c4", ...made.map((c) => c.id)]) log(id, JSON.stringify(run.autopilot?.[id]?.results));
    log("offers:", ["c1", "c3", "c4", ...made.map((c) => c.id)].map((id) => `${id}=${offersOf(id)}`).join(" | "));
    await bank.screenshot({ path: `${SHOTS}/parallel-board.png` });
    ok = idOf("Delta") && idOf("Hilton") && /Added .*Delta.*Hilton|Added .*Hilton.*Delta/.test(notice)
      && offersOf("c1") === "Best Buy,Chipotle,Delta" && offersOf("c3") === "Hilton,Saks" && offersOf("c4") === "Resy"
      && offersOf(idOf("Delta")) === "Delta Stays" && offersOf(idOf("Hilton")) === "Hilton Resorts"
      && state.cards.c3.currentPoints === 45000 && state.cards.c4.currentPoints === 0 && /Shared Membership Rewards .*Gold/.test(run.autopilot?.c4?.results?.balance || "") // one Membership Rewards balance per login
      && state.cards[idOf("Delta")].currentPoints === 62000 && state.cards[idOf("Hilton")].currentPoints === 250000
      && confirms.filter((c) => /Delta|Hilton/.test(c.split("||")[0])).every((c) => (/Delta/.test(c.split("||")[0]) ? /DLT04/ : /HLT08/).test(c))
      && overlapped && maxPages >= 5;
  } else if (scenario === "alloffers") {
    // Like Amex: an added offer leaves the list of offers to add, and the ones already on the card
    // are listed on their own page. Every offer is saved: the ones just added (gone from the list
    // when it's read again) and the ones that were already on the card.
    await sw.evaluate(() => chrome.storage.local.set({ learnedPages: { c1: { offers: "http://localhost:3000/bank/amex-eligible" } } }));
    bank = await ctx.newPage();
    await bank.goto("http://localhost:3000/bank/login"); await signIn(bank); await bank.waitForURL(/dashboard/);
    await bank.bringToFront();
    await panel.click('[data-act="sync-offers"][data-id="c1"]').catch(() => {});
    const s = await waitFor((s) => s?.kind === "offers" && (s.status === "synced" || s.status === "error"), "offers synced", 120000);
    log("status:", s.statusLabel || s.lastError, "| on", bank.url());
    log("saved:", state.offers.length, JSON.stringify(state.offers.map((o) => [o.merchant, o.activated])));
    const names = state.offers.map((o) => o.merchant).sort().join(",");
    ok = s.status === "synced" && names === "Audible,Best Buy,Dell,Duolingo,Glasses.com,Lyft,Saks,Uber Eats,Walmart" && state.offers.every((o) => o.activated)
      && /Added 6 to your card · 9 offers saved · 9 on the card/.test(s.statusLabel || "");
  } else if (scenario === "fresh") {
    // A Finstracker account with no cards (new, or after Delete all) on Amex: the popup finds the cards
    // the site lists and offers "Add cards and run autopilot". The fake bank is served at Amex's
    // address inside this test browser only.
    await ctx.route("https://global.americanexpress.com/**", async (route) => {
      const u = new URL(route.request().url());
      // Amex's own pages, as the fake bank has them.
      const AMEX = { "/offers/eligible": "/bank/offers", "/offers/enrolled": "/bank/amex-enrolled", "/card-benefits/activity": "/bank/benefits", "/card-benefits/view-all": "/bank/benefits", "/dashboard": "/bank/dashboard", "/overview": "/bank/dashboard" };
      if (process.env.DEBUG) log("  route", route.request().method(), u.pathname + u.search);
      const r = await route.fetch({ url: `http://localhost:3000${u.pathname.startsWith("/bank/") || AMEX[u.pathname] ? u.pathname : "/bank/rewards"}${u.search}`, maxRedirects: 0 });
      await route.fulfill({ response: r });
    });
    state.urlKeyed = true; state.newCard = true;
    for (const id of Object.keys(state.cards)) delete state.cards[id];
    await sw.evaluate(() => chrome.storage.local.set({ cardsCache: [], cardsCachedAt: 0, rewardsPages: {}, portalOverrides: {} }));
    bank = await ctx.newPage();
    await bank.goto("https://global.americanexpress.com/bank/login"); await signIn(bank); await bank.waitForURL(/dashboard/);
    await bank.goto("https://global.americanexpress.com/bank/rewards"); await bank.bringToFront();
    let text = "";
    for (let i = 0; i < 40 && !/Finstracker found/.test(text); i++) { await sleep(500); text = await bank.evaluate(() => document.querySelector("#fins-prompt-root")?.innerText.replace(/\n+/g, " | ") || "").catch(() => ""); }
    log("popup:", text);
    await bank.screenshot({ path: `${SHOTS}/fresh-popup.png` });
    await bank.click('#fins-prompt-root [data-act="add-run"]').catch((e) => log("click failed", e.message));
    let run;
    const end = Date.now() + 240000;
    await sleep(2000);
    while (Date.now() < end) {
      run = await sw.evaluate(() => chrome.storage.local.get(["autopilotRun", "autopilot"]));
      await bank.click('#fins-status-root [data-action="confirm"]', { timeout: 200 }).catch(() => {});
      if (!run.autopilotRun) break;
      await sleep(500);
    }
    await sleep(800);
    const made = Object.values(state.cards);
    const idOf = (name) => made.find((c) => c.displayName.includes(name))?.id;
    const offersOf = (id) => state.offers.filter((o) => o.cardId === id).map((o) => o.merchant).sort().join(",");
    log("added:", made.map((c) => `${c.displayName} (${c.issuer}, ${c.rewardType})`).join(", "));
    for (const c of made) log(c.displayName, JSON.stringify(run.autopilot?.[c.id]?.results), "| offers:", offersOf(c.id));
    ok = /Finstracker found 7 cards on americanexpress\.com/.test(text) && made.length === 7 && made.every((c) => c.issuer === "American Express")
      && /Resy/.test(offersOf(idOf("Platinum"))) && /Hilton,.*Saks/.test(offersOf(made.find((c) => c.displayName === "Gold Card")?.id))
      && /Delta Stays/.test(offersOf(idOf("Delta"))) && /Hilton Resorts/.test(offersOf(idOf("Hilton")))
      && /Uber Eats/.test(offersOf(idOf("Platinum"))) // from the "Added to Card" page
      && made.filter((c) => run.autopilot?.[c.id]?.results).length === 7;
  } else if (scenario === "noclick") {
    // Nothing runs unless you click. 1. Cards on the site, and the old daily-autopilot switches left
    // on: loading pages starts no autopilot and no sync, and never opens the site's card switcher.
    const path = "#root > div.tile:nth-of-type(2) > div:nth-of-type(3)";
    await sw.evaluate((path) => chrome.storage.local.set({
      autopilotAuto: true, autopilot: { c1: { on: true, lastRun: 0 }, c3: { on: true, lastRun: 0 } }, autopilotStoppedAt: 0,
      portalOverrides: Object.fromEntries(["c1", "c3"].map((id) => [id, { matchUrl: "http://localhost:3000/*", selector: path, source: "user-picker" }])),
    }), path);
    bank = await ctx.newPage();
    await bank.goto("http://localhost:3000/bank/login"); await signIn(bank); await bank.waitForURL(/dashboard/);
    let started = false;
    for (const p of ["/bank/rewards", "/bank/offers", "/bank/benefits", "/bank/rewards"]) {
      await bank.goto(`http://localhost:3000${p}`); await bank.bringToFront();
      for (let i = 0; i < 12; i++) { await sleep(500); const s = await sw.evaluate(() => chrome.storage.local.get(["autopilotRun", "captureSession"])); if (s.autopilotRun || s.captureSession) started = true; }
    }
    const opens1 = await bank.evaluate(() => document.body.dataset.opens || "0");
    const popup1 = await bank.evaluate(() => document.querySelector("#fins-prompt-root")?.innerText.replace(/\n+/g, " | ") || "");
    const flags = await sw.evaluate(() => chrome.storage.local.get(["autopilotAuto"]));
    log("1. started by itself:", started, "| switcher opened:", opens1, "| popup:", popup1.slice(0, 90), "| autopilotAuto now:", flags.autopilotAuto);
    // 2. No cards in Finstracker, on an Amex-like Overview whose card list exists only when opened:
    // the popup offers "Find my cards" and opens the list only on that click; nothing runs.
    await ctx.route("https://global.americanexpress.com/**", async (route) => {
      const u = new URL(route.request().url());
      const r = await route.fetch({ url: `http://localhost:3000${u.pathname}${u.search}`, maxRedirects: 0 });
      await route.fulfill({ response: r });
    });
    for (const id of Object.keys(state.cards)) delete state.cards[id];
    await sw.evaluate(() => chrome.storage.local.set({ cardsCache: [], cardsCachedAt: 0, rewardsPages: {}, portalOverrides: {} }));
    await bank.goto("https://global.americanexpress.com/bank/login"); await signIn(bank); await bank.waitForURL(/dashboard/);
    await bank.goto("https://global.americanexpress.com/overview"); await bank.bringToFront();
    let text = "";
    for (let i = 0; i < 40 && !/Find my cards|Finstracker found|Sign in/.test(text); i++) { await sleep(500); text = await bank.evaluate(() => document.querySelector("#fins-prompt-root")?.innerText.replace(/\n+/g, " | ") || "").catch(() => ""); }
    const opensBefore = await bank.evaluate(() => document.body.dataset.opens || "0");
    log("2. popup:", text, "| switcher opened before the click:", opensBefore);
    await bank.click('#fins-prompt-root [data-act="find-cards"]').catch((e) => log("no Find my cards button", e.message.split("\n")[0]));
    let after = "";
    for (let i = 0; i < 20 && !/Finstracker found/.test(after); i++) { await sleep(500); after = await bank.evaluate(() => document.querySelector("#fins-prompt-root")?.innerText.replace(/\n+/g, " | ") || "").catch(() => ""); }
    const opensAfter = await bank.evaluate(() => document.body.dataset.opens || "0");
    const run2 = await sw.evaluate(() => chrome.storage.local.get(["autopilotRun"]));
    log("   after Find my cards:", after.slice(0, 160), "| switcher opened:", opensAfter, "| autopilot:", Boolean(run2.autopilotRun), "| cards added:", Object.keys(state.cards).length);
    ok = !started && opens1 === "0" && /Run autopilot/.test(popup1)
      && /Find my cards/.test(text) && opensBefore === "0" && /Finstracker found 3 cards/.test(after) && Number(opensAfter) >= 1 && !run2.autopilotRun && Object.keys(state.cards).length === 0;
  } else if (scenario === "history") {
    // Amex-style points activity: one table for every card on the Membership Rewards account, behind
    // "Show More". Autopilot saves each line to the card in its card column (not the card that isn't
    // in Finstracker); a second run only reads until it reaches lines already saved.
    const path = "#root > div.tile:nth-of-type(2) > div:nth-of-type(3)";
    await sw.evaluate((path) => chrome.storage.local.set({
      portalOverrides: Object.fromEntries(["c3", "c4"].map((id) => [id, { matchUrl: "http://localhost:3000/*", selector: path, source: "user-picker" }])),
      rewardsPages: Object.fromEntries(["c3", "c4"].map((id) => [id, { url: "http://localhost:3000/bank/rewards", source: "user" }])),
      cardLast4: { c3: "3001", c4: "1004" },
    }), path);
    bank = await ctx.newPage();
    await bank.goto("http://localhost:3000/bank/login"); await signIn(bank); await bank.waitForURL(/dashboard/);
    await bank.evaluate(() => { document.cookie = "acct=c3; path=/"; }); // the site shows Gold
    const runOnce = async (label) => {
      await bank.goto("http://localhost:3000/bank/rewards"); await bank.bringToFront();
      let popup = "";
      for (let i = 0; i < 30 && !/Run autopilot/.test(popup); i++) { await sleep(500); popup = await bank.evaluate(() => document.querySelector("#fins-prompt-root")?.innerText.replace(/\n+/g, " | ") || "").catch(() => ""); }
      await bank.click('#fins-prompt-root [data-act="run"]');
      let run; const end = Date.now() + 240000; await sleep(1500);
      let trace = "";
      while (Date.now() < end) {
        run = await sw.evaluate(() => chrome.storage.local.get(["autopilotRun", "autopilot", "captureSession"]));
        if (process.env.DEBUG) { const c = run.captureSession; const line = `${run.autopilotRun?.cardName} ${run.autopilotRun?.step} | ${c?.cardId} ${c?.status} ${c?.statusLabel || ""} ${c?.lastError || ""} ${c?.currentUrl || ""} sw=${JSON.stringify(c?.switchResult || null)} ver=${c?.verified}`; if (line !== trace) { log("  ap:", line.slice(0, 260)); trace = line; } }
        await bank.click('#fins-status-root [data-action="confirm"]', { timeout: 200 }).catch(() => {});
        if (!run.autopilotRun) break;
        await sleep(500);
      }
      log(label, "popup:", popup.replace(/Finstracker \| × \| /, "").slice(0, 200));
      return { ...run, popup };
    };
    const run1 = await runOnce("run 1");
    const first = { lines: state.history.length, clicks: state.moreClicks };
    const per = (id) => state.history.filter((h) => h.cardId === id).length;
    log("run 1: lines", first.lines, "| Show More presses", first.clicks, "| c4", per("c4"), "c3", per("c3"), "| results c4:", JSON.stringify(run1.autopilot?.c4?.results), "c3:", JSON.stringify(run1.autopilot?.c3?.results));
    log("sample:", JSON.stringify(state.history.slice(0, 3).map((h) => [h.date, h.description, h.points, h.spend, h.status, h.multiplier])));
    const run2 = await runOnce("run 2");
    log("run 2: lines", state.history.length, "| Show More presses", state.moreClicks - first.clicks, "| points c4/c3:", state.cards.c4.currentPoints, state.cards.c3.currentPoints);
    const redeem = state.history.find((h) => /POINTS FOR TRAVEL/.test(h.description));
    ok = per("c4") === 5 && per("c3") === 4 && first.lines === 9 && first.clicks >= 2 && state.history.length === 9 && state.moreClicks - first.clicks === 0
      && redeem?.points === -5000 && state.history.some((h) => h.status === "Pending" && h.spend > 0 && h.multiplier === "4X")
      && /Not pulled yet/.test(run1.popup) && /(Last|All) pulled.*(just now|minute)/.test(run2.popup);
  } else if (scenario === "nologin") {
    // Amex cards with nothing saved but the bank's own settings (login page first in them), run from
    // a signed-in Amex page. Like Amex, loading the login page signs you out: autopilot must never
    // open it. Served at both Amex hosts inside this test browser only.
    await ctx.route(/^https:\/\/(www|global)\.americanexpress\.com\//, async (route) => {
      const u = new URL(route.request().url());
      const path = /account\/login/i.test(u.pathname) ? "/bank/login" : u.pathname;
      const r = await route.fetch({ url: `http://localhost:3000${path}${u.search}`, maxRedirects: 0 });
      await route.fulfill({ response: r });
    });
    state.urlKeyed = true;
    await sw.evaluate(() => chrome.storage.local.set({ rewardsPages: {}, portalOverrides: {}, learnedPages: {} }));
    bank = await ctx.newPage();
    await bank.goto("https://global.americanexpress.com/bank/login"); await signIn(bank); await bank.waitForURL(/dashboard/);
    state.loginVisits = 0;
    await bank.goto("https://global.americanexpress.com/bank/rewards"); await bank.bringToFront();
    let popup = "";
    for (let i = 0; i < 30 && !/Run autopilot/.test(popup); i++) { await sleep(500); popup = await bank.evaluate(() => document.querySelector("#fins-prompt-root")?.innerText.replace(/\n+/g, " | ") || "").catch(() => ""); }
    log("popup:", popup.slice(0, 140));
    await bank.click('#fins-prompt-root [data-act="run"]');
    let run, signInAsked = false;
    const end = Date.now() + 240000;
    await sleep(1500);
    while (Date.now() < end) {
      run = await sw.evaluate(() => chrome.storage.local.get(["autopilotRun", "autopilot", "captureSession"]));
      await bank.click('#fins-status-root [data-action="confirm"]', { timeout: 200 }).catch(() => {});
      const steps = JSON.stringify(run.autopilotRun?.board?.cards || []) + (run.captureSession?.statusLabel || "");
      if (/Sign in/i.test(steps)) signInAsked = true;
      if (!run.autopilotRun) break;
      await sleep(500);
    }
    const ids = Object.keys(run.autopilot || {});
    log("login page opened:", state.loginVisits, "times | asked to sign in:", signInAsked, "| tab now:", bank.url());
    for (const id of ids) log(id, JSON.stringify(run.autopilot[id].results));
    ok = /Run autopilot/.test(popup) && state.loginVisits === 0 && !signInAsked && ids.length >= 2 && ids.every((id) => !/sign/i.test(JSON.stringify(run.autopilot[id].results || {})));
  } else if (scenario === "reset") {
    // Settings → Start over: every card, its offers and credits are deleted; learned pages forgotten.
    state.offers.push({ cardId: "c1", merchant: "Old offer" }, { cardId: "c3", merchant: "Older offer" });
    await sw.evaluate(() => chrome.storage.local.set({ learnedPages: { c1: { offers: "http://localhost:3000/bank/offers" } }, cardLast4: { c1: "9876" } }));
    await panel.reload(); await sleep(1500);
    await panel.click("#settings-toggle");
    await panel.click('[data-act="reset-ask"]');
    const ask = await panel.evaluate(() => document.querySelector(".row-confirm")?.innerText.replace(/\n+/g, " | "));
    log("confirm:", ask, "| cards before:", Object.keys(state.cards).length);
    await panel.click('[data-act="reset-confirm"]');
    await sleep(2500);
    const kept = await sw.evaluate(() => chrome.storage.local.get(["learnedPages", "cardLast4", "token", "autoAddCards"]));
    const toast = await panel.evaluate(() => document.querySelector(".toast")?.innerText || "");
    log("toast:", toast, "| cards:", Object.keys(state.cards).length, "| offers:", state.offers.length, "| perks:", state.perks.length, "| kept:", JSON.stringify(kept));
    ok = /Delete all 5 cards/.test(ask || "") && Object.keys(state.cards).length === 0 && state.offers.length === 0 && state.perks.length === 0
      && !kept.learnedPages && !kept.cardLast4 && kept.token === "test-token" && /Deleted 5 cards, 2 offers and 4 credits/.test(toast);
  } else if (scenario === "viewing") {
    // Amex Gold and Amex Platinum on one site; the page shows Platinum in its top bar.
    const path = "#root > div.tile:nth-of-type(2) > div:nth-of-type(3)";
    await sw.evaluate((path) => chrome.storage.local.set({
      portalOverrides: Object.fromEntries(["c1", "c3", "c4", "c5"].map((id) => [id, { matchUrl: "http://localhost:3000/*", selector: path, source: "user-picker" }])),
      rewardsPages: Object.fromEntries(["c1", "c3", "c4", "c5"].map((id) => [id, { url: "http://localhost:3000/bank/rewards", source: "user" }])),
    }), path);
    bank = await ctx.newPage();
    await bank.goto("http://localhost:3000/bank/login"); await signIn(bank); await bank.waitForURL(/dashboard/);
    await bank.evaluate(() => { document.cookie = "acct=c4; path=/"; });
    await bank.goto("http://localhost:3000/bank/rewards?opaqueAccountId=PLT04"); await sleep(3500);
    const popup = await bank.evaluate(() => document.querySelector("#fins-prompt-root")?.innerText.replace(/\n+/g, " | "));
    const chosen = await bank.evaluate(() => document.querySelector("#fins-prompt-root select")?.value);
    log("popup:", popup, "| selected:", chosen);
    await bank.screenshot({ path: `${SHOTS}/viewing-popup.png` });
    // 1. Sync this page with the popup's default card.
    await bank.click('#fins-prompt-root [data-act="sync"]');
    const s1 = await waitFor((s) => s?.status === "synced" || s?.status === "error", "sync this page");
    log("sync this page →", s1.cardId, s1.lastScrape?.value, "| points c3/c4:", state.cards.c3.currentPoints, state.cards.c4.currentPoints);
    // 2. Read this tab for Gold while Platinum is on screen: follows the page's card.
    await sw.evaluate(() => chrome.storage.local.set({ captureSession: null }));
    await bank.bringToFront();
    await panel.click('[data-act="toggle-card"][data-id="c3"]').catch(() => {});
    await panel.click('[data-act="read-tab"][data-id="c3"]').catch(() => {});
    const s2 = await waitFor((s) => s?.status === "synced" || s?.status === "error", "read this tab for Gold");
    log("read this tab for Gold →", s2.cardId, "followed from:", s2.followedFrom, "| c3 still", state.cards.c3.currentPoints);
    // 3. Autopilot for all three from the popup: starts with Platinum (on screen), selects the others.
    await sw.evaluate(() => chrome.storage.local.set({ captureSession: null }));
    await bank.reload(); await sleep(3500);
    log("popup after reload:", await bank.evaluate(() => document.querySelector("#fins-prompt-root")?.innerText.replace(/\n+/g, " | ").slice(0, 80)));
    await bank.click('#fins-prompt-root [data-act="run"]');
    for (let i = 0; i < 6; i++) { await sleep(500); log("  run state:", JSON.stringify((await sw.evaluate(() => chrome.storage.local.get(["autopilotRun", "captureSession"]))).autopilotRun), "| prompt status:", await bank.evaluate(() => document.querySelector("#fins-prompt-root .fins-prompt-status")?.innerText || "")); }
    const end = Date.now() + 240000;
    let run;
    let trace = "";
    while (Date.now() < end) {
      run = await sw.evaluate(() => chrome.storage.local.get(["autopilotRun", "autopilot", "captureSession"]));
      if (process.env.DEBUG) { const r = run.autopilotRun, c = run.captureSession; const line = `${r?.cardName} ${r?.step} | ${c?.cardId} ${c?.kind} ${c?.status} ${c?.lastError || ""} ${c?.currentUrl || ""} sw=${JSON.stringify(c?.switchResult || null)} other=${c?.shownOther || ""} ver=${c?.verified}`; if (line !== trace) { log("  ap:", line); trace = line; } }
      if (!run.autopilotRun) break;
      await sleep(500);
    }
    await sleep(800);
    log("final note:", await note(bank), "| error:", (await sw.evaluate(() => chrome.storage.local.get("autopilotError"))).autopilotError || "none");
    for (const id of ["c4", "c3", "c1", "c5"]) log(id, JSON.stringify(run.autopilot?.[id]?.results));
    log("points c1/c3/c4/c5:", state.cards.c1.currentPoints, state.cards.c3.currentPoints, state.cards.c4.currentPoints, state.cards.c5.currentPoints);
    const offersOf = (id) => state.offers.filter((o) => o.cardId === id).map((o) => o.merchant).sort().join(",");
    log("offers c3:", offersOf("c3"), "| c4:", offersOf("c4"), "| c1:", offersOf("c1"));
    ok = /viewing Amex Platinum Card/.test(popup || "") && /4 of your cards/.test(popup || "") && chosen === "c4" && s1.cardId === "c4" && s2.cardId === "c4" && s2.followedFrom === "Amex Gold Card"
      // Membership Rewards is one balance per login: read on Platinum (on screen), shared by Gold.
      && state.cards.c4.currentPoints === 150000 && state.cards.c3.currentPoints === 0 && /Shared Membership Rewards/.test(run.autopilot?.c3?.results?.balance || "") && state.cards.c1.currentPoints === 98765
      && offersOf("c3") === "Hilton,Saks" && offersOf("c4") === "Resy" && offersOf("c1") === "Best Buy,Chipotle,Delta"
      && state.cards.c5.currentPoints === 0 && offersOf("c5") === "" && /Skipped/.test(JSON.stringify((await sw.evaluate(() => chrome.storage.local.get("autopilotLastBoard"))).autopilotLastBoard)); // Green isn't in the switcher: nothing saved for it
  } else if (scenario === "addall") {
    // Amex-style offers page: every offer gets added (new formats, redrawn list, Load more, a lost click).
    bank = await ctx.newPage();
    await bank.goto("http://localhost:3000/bank/login"); await signIn(bank); await bank.waitForURL(/dashboard/);
    await bank.goto("http://localhost:3000/bank/amex-offers"); await bank.bringToFront();
    await panel.click('[data-act="sync-offers"][data-id="c1"]').catch(() => {});
    const s = await waitFor((s) => s?.kind === "offers" && (s.status === "synced" || s.status === "error"), "offers synced", 120000);
    const buttons = await bank.evaluate(() => [...document.querySelectorAll("#offer-list button")].map((b) => b.textContent));
    const decoy = await bank.evaluate(() => document.body.dataset.decoy || "not clicked");
    log("status:", s.statusLabel || s.lastError, "| buttons:", buttons.join(", "), "| decoy:", decoy);
    log("saved:", state.offers.length, JSON.stringify(state.offers.map((o) => [o.merchant, o.activated])));
    ok = s.status === "synced" && buttons.length === 10 && buttons.every((b) => /Added/.test(b)) && decoy === "not clicked" && state.offers.length === 10 && state.offers.every((o) => o.activated)
      && state.offers.some((o) => o.merchant === "Duolingo" && o.discountValue === 3000 && o.minSpendCents === 7500);
  } else if (scenario === "amexbenefits") {
    // Amex-style benefits: usage behind "View details"; reports each benefit and what happened to it.
    bank = await ctx.newPage();
    await bank.goto("http://localhost:3000/bank/login"); await signIn(bank); await bank.waitForURL(/dashboard/);
    await bank.goto("http://localhost:3000/bank/amex-benefits"); await bank.bringToFront();
    await panel.click('[data-act="sync-benefits"][data-id="c1"]').catch(() => {});
    const s = await waitFor((s) => s?.kind === "benefits" && (s.status === "synced" || s.status === "error"), "benefits read", 60000);
    await sleep(500);
    log("status:", s.statusLabel || s.lastError);
    log("rows:", JSON.stringify(s.rows));
    log("perks:", JSON.stringify(state.perks.filter((x) => x.cardId === "c1").map((x) => [x.id, x.used])));
    await bank.screenshot({ path: `${SHOTS}/amex-benefits.png` });
    const used = (id) => state.perks.find((x) => x.id === id).used;
    ok = s.status === "synced" && used("p-uber") && used("p-saks") && !used("p-de") && (s.rows || []).length === 4 && /no matching credit/.test(JSON.stringify(s.rows));
  } else if (scenario === "amextabs") {
    // Amex's layout: from the home page, click Rewards & Benefits, then the View Benefits Activity tab
    // (usage is only there, as "$15 Earned Nov · $0 To Go" under credits named "$200 Uber Cash").
    // The site's menus are left alone, and the activity page is remembered for next time.
    bank = await ctx.newPage();
    await bank.goto("http://localhost:3000/bank/login"); await signIn(bank); await bank.waitForURL(/dashboard/);
    await bank.goto("http://localhost:3000/bank/amex-home"); await sleep(1500); await bank.bringToFront();
    await panel.click('[data-act="sync-benefits"][data-id="c1"]').catch(() => {});
    const s = await waitFor((s) => s?.kind === "benefits" && (s.status === "synced" || s.status === "error"), "benefits read", 90000);
    await sleep(500);
    const menu = await bank.evaluate(() => document.body.dataset.menu || "closed");
    const learned = (await sw.evaluate(() => chrome.storage.local.get("learnedPages"))).learnedPages?.c1?.benefits;
    log("status:", s.statusLabel || s.lastError, "| on", bank.url(), "| menu:", menu, "| learned:", learned);
    log("rows:", JSON.stringify(s.rows));
    const used = (id) => state.perks.find((x) => x.id === id).used;
    const rows = JSON.stringify(s.rows || []);
    ok = s.status === "synced" && /\/bank\/amex-hub\/activity$/.test(bank.url()) && used("p-uber") && !used("p-de") && menu === "closed"
      && /"Uber Cash"/.test(rows) && /"Digital Entertainment Credit"/.test(rows) && /"CLEAR Plus Credit","\$209 used · \$0 left · no matching credit/.test(rows)
      && /amex-hub\/activity$/.test(learned || "");
  } else if (scenario === "noise") {
    // A page whose only numbers are a copyright year, a phone number, "Member since 2015" and a date:
    // none of them may be read as the balance, by the reader or by the picker.
    bank = await ctx.newPage();
    await bank.goto("http://localhost:3000/bank/login"); await signIn(bank); await bank.waitForURL(/dashboard/);
    await bank.goto("http://localhost:3000/bank/no-balance"); await sleep(2000); await bank.bringToFront();
    // 1. The picker refuses them. (The card row is already open.)
    await panel.click('[data-act="pick"][data-id="c1"]');
    await waitFor((s) => s?.status === "picking", "picker");
    await sleep(800);
    for (const text of ["© 2026 Mock Bank, N.A.", "Member since 2015", "Questions? Call 1-800-528-4800"]) { await bank.locator(`text=${text}`).first().click(); await sleep(300); await bank.keyboard.press("Enter"); await sleep(300); }
    await bank.screenshot({ path: `${SHOTS}/noise-picker.png` });
    const afterPick = await session();
    log("after picking copyright, a year and a phone number:", afterPick?.status, "| transactions:", state.transactions.length);
    await bank.keyboard.press("Escape"); await sleep(300); await bank.keyboard.press("Escape");
    await sw.evaluate(() => chrome.storage.local.set({ captureSession: null }));
    // 2. Read this tab: finds nothing here, goes on to the rewards page, offers the real balance.
    await bank.reload(); await sleep(2000); await bank.bringToFront();
    await panel.click('[data-act="read-tab"][data-id="c1"]');
    const s = await waitFor((s) => s?.status === "confirm" || s?.status === "error" || s?.status === "synced", "read", 60000);
    log("read this tab →", s.status, s.pending?.value ?? s.lastScrape?.value ?? s.lastError, "on", s.currentUrl);
    const bad = [2026, 2015, 1, 800, 528, 4800, 8, 1026];
    ok = afterPick?.status === "picking" && state.transactions.length === 0 && s.status === "confirm" && s.pending?.value === 98765 && !bad.includes(s.pending?.value);
  } else if (scenario === "pagebutton") {
    // No card is linked to the site yet. The panel offers "Link cards to this site"; after linking two
    // cards the page shows the popup, and "Run autopilot on this page" runs both on that tab.
    // "Run autopilot for all cards" and "Add cards" sit at the bottom.
    const path = "#root > div.tile:nth-of-type(2) > div:nth-of-type(3)";
    await sw.evaluate((path) => chrome.storage.local.set({
      // Spots picked on another host: the cards aren't linked to localhost until the user links them.
      portalOverrides: Object.fromEntries(["c1", "c3"].map((id) => [id, { matchUrl: "http://127.0.0.1:3000/*", selector: path, source: "user-picker" }])),
      rewardsPages: {},
    }), path);
    bank = await ctx.newPage();
    await bank.goto("http://localhost:3000/bank/login"); await signIn(bank); await bank.waitForURL(/dashboard/);
    await bank.goto("http://localhost:3000/bank/rewards"); await sleep(1500);
    const popupBefore = await bank.evaluate(() => Boolean(document.querySelector("#fins-prompt-root")));
    // The panel reads the active tab of its own window; here it is a tab itself, so point it at the bank.
    await panel.bringToFront();
    await panel.evaluate(async () => {
      const [t] = (await chrome.tabs.query({})).filter((x) => x.url.startsWith("http://localhost:3000/bank"));
      const query = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = async (q) => (q?.active ? [t] : query(q));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await panel.waitForSelector('[data-act="link-start"]', { timeout: 10000 });
    const blockBefore = await panel.evaluate(() => document.querySelector(".page-block")?.innerText.replace(/\n+/g, " | "));
    const foot = await panel.evaluate(() => document.querySelector(".panel-foot-actions")?.innerText.replace(/\n+/g, " | "));
    await panel.setViewportSize({ width: 380, height: 760 });
    await panel.screenshot({ path: `${SHOTS}/page-link.png` });
    await panel.click('[data-act="link-start"]');
    await panel.check('.link-list input[value="c1"]'); await panel.check('.link-list input[value="c3"]');
    await panel.screenshot({ path: `${SHOTS}/page-link-list.png` });
    await panel.click('[data-act="link-save"]:not([data-value])');
    await panel.waitForSelector('[data-act="run-autopilot-page"]', { timeout: 10000 });
    const blockAfter = await panel.evaluate(() => document.querySelector(".page-block")?.innerText.replace(/\n+/g, " | "));
    await panel.screenshot({ path: `${SHOTS}/page-run.png` });
    await sleep(1500);
    const popup = await bank.evaluate(() => document.querySelector("#fins-prompt-root")?.innerText.replace(/\n+/g, " | "));
    const pagesBefore2 = ctx.pages().length;
    await panel.click('[data-act="run-autopilot-page"]');
    let run;
    const end = Date.now() + 240000;
    await sleep(2000);
    while (Date.now() < end) {
      run = await sw.evaluate(() => chrome.storage.local.get(["autopilotRun", "autopilot", "autopilotError"]));
      if (process.env.DEBUG) log("  run:", JSON.stringify(run.autopilotRun || null).slice(0, 200), run.autopilotError || "");
      if (!run.autopilotRun) break;
      await sleep(500);
    }
    await sleep(800);
    log("popup before linking:", popupBefore, "| block:", blockBefore, "| foot:", foot);
    log("after linking:", blockAfter, "| popup:", popup);
    for (const id of ["c1", "c3"]) log(id, JSON.stringify(run.autopilot?.[id]?.results));
    log("balances:", state.cards.c1.currentPoints, state.cards.c3.currentPoints, "| tabs before/after:", pagesBefore2, ctx.pages().length);
    ok = !popupBefore && /Link cards to this site/.test(blockBefore || "") && /Run autopilot for all cards/.test(foot || "") && /Add cards/.test(foot || "")
      && /Run autopilot on this page/.test(blockAfter || "") && /Sapphire/.test(blockAfter || "") && /Gold/.test(blockAfter || "")
      && /2 cards/.test(popup || "") && state.cards.c1.currentPoints === 98765 && state.cards.c3.currentPoints === 45000 && ctx.pages().length === pagesBefore2;
  } else if (scenario === "stop") {
    // Stop in the middle of a three-card run: the background tabs close, the board says stopped,
    // nothing more is saved, and a new run starts. A run left over from a restart is cleared too.
    const path = "#root > div.tile:nth-of-type(2) > div:nth-of-type(3)";
    await sw.evaluate((path) => chrome.storage.local.set({
      portalOverrides: Object.fromEntries(["c1", "c3"].map((id) => [id, { matchUrl: "http://localhost:3000/*", selector: path, source: "user-picker" }])),
      rewardsPages: Object.fromEntries(["c1", "c3"].map((id) => [id, { url: "http://localhost:3000/bank/rewards", source: "user" }])),
    }), path);
    bank = await ctx.newPage();
    await bank.goto("http://localhost:3000/bank/login"); await signIn(bank); await bank.waitForURL(/dashboard/);
    await bank.goto("http://localhost:3000/bank/rewards"); await sleep(2000);
    const runState = () => sw.evaluate(() => chrome.storage.local.get(["autopilotRun", "autopilotLastBoard"]));
    const tabId = await panel.evaluate(async () => (await chrome.tabs.query({})).find((t) => t.url.includes("/bank/rewards")).id);
    const pagesBefore = ctx.pages().length;
    await panel.evaluate((tabId) => chrome.runtime.sendMessage({ type: "runAutopilot", cardIds: ["c1", "c3"], tabId }), tabId);
    // Wait until offers and benefits are under way in their background tabs.
    const until = Date.now() + 60000;
    while (Date.now() < until && ctx.pages().length < pagesBefore + 2) await sleep(300);
    const sideOpen = ctx.pages().length - pagesBefore;
    await sleep(800);
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: "stopAutopilot" }));
    const t0 = Date.now();
    let r = await runState();
    while (r.autopilotRun && Date.now() - t0 < 15000) { await sleep(300); r = await runState(); }
    const stoppedIn = Date.now() - t0;
    await sleep(6000); // nothing comes back after a stop
    const later = await runState();
    const boardText = await bank.evaluate(() => document.getElementById("fins-board-root")?.shadowRoot?.textContent || document.getElementById("fins-board-root")?.textContent || "");
    log("side tabs opened:", sideOpen, "| stopped in", stoppedIn, "ms | run after 6s:", JSON.stringify(later.autopilotRun), "| last board:", later.autopilotLastBoard?.title, "| tabs:", pagesBefore, ctx.pages().length, "| c3 points:", state.cards.c3.currentPoints);
    // A run left in storage by a restarted worker: Stop clears it, and a new run starts.
    await sw.evaluate(() => chrome.storage.local.set({ autopilotRun: { id: "old", running: true, board: { running: true, title: "Autopilot · 1 card", cards: [] }, boardTab: null } }));
    const again = await panel.evaluate((tabId) => chrome.runtime.sendMessage({ type: "runAutopilot", cardIds: ["c1"], tabId }), tabId);
    await sleep(1500);
    const second = await runState();
    log("new run after a stale one:", JSON.stringify(again), "| id:", second.autopilotRun?.id);
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: "stopAutopilot" }));
    let s3 = await runState(); const t1 = Date.now();
    while (s3.autopilotRun && Date.now() - t1 < 15000) { await sleep(300); s3 = await runState(); }
    log("second stop:", s3.autopilotRun ? "still running" : "stopped", "| board:", s3.autopilotLastBoard?.title);
    ok = sideOpen >= 2 && stoppedIn < 12000 && !later.autopilotRun && later.autopilotLastBoard?.title === "Autopilot stopped" && ctx.pages().length === pagesBefore
      && state.cards.c3.currentPoints === 0 && Boolean(second.autopilotRun?.id) && second.autopilotRun.id !== "old" && !s3.autopilotRun;
  } else if (scenario === "reload") {
    // The extension is reloaded (or updated) while its popup and board are on the page: the old
    // copies remove themselves, the new copy draws one of each, and nothing is logged as an error.
    const path = "#root > div.tile:nth-of-type(2) > div:nth-of-type(3)";
    await sw.evaluate((path) => chrome.storage.local.set({
      portalOverrides: { c1: { matchUrl: "http://localhost:3000/*", selector: path, source: "user-picker" } },
      rewardsPages: { c1: { url: "http://localhost:3000/bank/rewards", source: "user" } },
    }), path);
    bank = await ctx.newPage();
    const errors = [];
    bank.on("console", (m) => { if (m.type() === "error" && /fins|context invalidated|chrome-extension/i.test(m.text())) errors.push(m.text()); });
    bank.on("pageerror", (e) => errors.push(String(e)));
    await bank.goto("http://localhost:3000/bank/login"); await signIn(bank); await bank.waitForURL(/dashboard/);
    await bank.goto("http://localhost:3000/bank/rewards"); await sleep(2500);
    const count = () => bank.evaluate(() => ["fins-prompt-root", "fins-launcher-root", "fins-board-root", "fins-status-root"].map((id) => document.querySelectorAll(`#${id}`).length).join(","));
    // Put a board up too (as autopilot does), then reload the extension.
    await sw.evaluate(async () => {
      const [t] = (await chrome.tabs.query({})).filter((x) => x.url.includes("/bank/rewards"));
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["content/progress.js"] });
      await chrome.scripting.executeScript({ target: { tabId: t.id }, func: () => window.__finsBoard.show({ running: true, title: "Autopilot · 1 card", cards: [{ name: "Sapphire Preferred", current: true, steps: [{ name: "Balance", state: "busy", text: "" }] }] }) });
    });
    await sleep(500);
    const before = await count();
    const oldSw = sw;
    await sw.evaluate(() => chrome.runtime.reload()).catch(() => {});
    const swUntil = Date.now() + 15000;
    while (Date.now() < swUntil && (sw === oldSw || !sw)) {
      await sleep(300);
      sw = ctx.serviceWorkers().find((w) => w !== oldSw && w.url().includes(extId)) || sw;
    }
    log("new service worker:", sw !== oldSw, "| workers:", ctx.serviceWorkers().length);
    await sleep(1500);
    // The page redraws: the old copies notice they were replaced and go.
    await bank.evaluate(() => { const i = document.createElement("i"); document.documentElement.appendChild(i); i.remove(); });
    await sleep(500);
    const afterReload = await count();
    // Click Stop on anything left (nothing should be): no error either way.
    // The page loads again with the new copy: one popup.
    await bank.reload(); await sleep(3000);
    const fresh = await count();
    log("prompt,launcher,board,status before:", before, "| after the reload:", afterReload, "| after the page reloads:", fresh, "| errors:", JSON.stringify(errors));
    // Test Chromium doesn't load an unpacked extension back after chrome.runtime.reload(); when it
    // does, the page must show exactly one new popup.
    const back = sw !== oldSw;
    ok = before.startsWith("1,") && before.split(",")[2] === "1" && afterReload === "0,0,0,0" && errors.length === 0
      && (!back || (fresh.startsWith("1,") && fresh.split(",").slice(1).every((n) => Number(n) <= 1)));
  } else if (scenario === "newcards") {
    // Signed in, the bank's card switcher lists two cards that aren't in Finstracker. The popup
    // offers them; add one (it is created with the bank and its catalog card, linked to the site and
    // joins the popup's cards), say "Not mine" to the other, and neither comes back.
    state.newCard = true;
    const path = "#root > div.tile:nth-of-type(2) > div:nth-of-type(3)";
    await sw.evaluate((path) => chrome.storage.local.set({
      portalOverrides: Object.fromEntries(["c1", "c3", "c4"].map((id) => [id, { matchUrl: "http://localhost:3000/*", selector: path, source: "user-picker" }])),
      rewardsPages: Object.fromEntries(["c1", "c3", "c4"].map((id) => [id, { url: "http://localhost:3000/bank/rewards", source: "user" }])),
    }), path);
    bank = await ctx.newPage();
    await bank.goto("http://localhost:3000/bank/login"); await signIn(bank); await bank.waitForURL(/dashboard/);
    await bank.goto("http://localhost:3000/bank/rewards");
    await bank.waitForSelector("#fins-prompt-root .fins-prompt-new input[data-new]", { timeout: 20000 });
    const newText = () => bank.evaluate(() => document.querySelector("#fins-prompt-root .fins-prompt-new")?.innerText.replace(/\n+/g, " | ") || "");
    const offered = await newText();
    await bank.screenshot({ path: `${SHOTS}/newcards-popup.png` });
    // Add Delta only.
    await bank.uncheck('#fins-prompt-root input[data-new][value="2008"]');
    await bank.click('#fins-prompt-root [data-act="add-new"]');
    const until = Date.now() + 15000;
    while (Date.now() < until && !state.created.length) await sleep(300);
    await sleep(3500); // the popup is redrawn with the new card, then the site is looked at again
    const popupAfter = await bank.evaluate(() => document.querySelector("#fins-prompt-root .fins-prompt-body")?.innerText.replace(/\n+/g, " | ") || "");
    const offeredAfter = await newText();
    await bank.screenshot({ path: `${SHOTS}/newcards-added.png` });
    // Hilton isn't mine.
    if (await bank.$('#fins-prompt-root [data-act="ignore-new"]')) await bank.click('#fins-prompt-root [data-act="ignore-new"]');
    await sleep(800);
    await bank.reload(); await sleep(5000);
    const offeredOnReload = await newText();
    const st = await sw.evaluate(() => chrome.storage.local.get(["cardLast4", "ignoredSiteCards", "rewardsPages"]));
    log("offered:", offered);
    log("created:", JSON.stringify(state.created), "| popup after:", popupAfter, "| still offered:", offeredAfter);
    log("after reload:", offeredOnReload || "(nothing)", "| numbers:", JSON.stringify(st.cardLast4), "| ignored:", JSON.stringify(st.ignoredSiteCards), "| n1 page:", st.rewardsPages?.n1?.url);
    // The rewards page also lists Freedom Unlimited (...1234): a Chase cash back card, from the catalog.
    const freedom = state.created.find((c) => c.displayName === "Freedom Unlimited");
    ok = /Delta SkyMiles Gold Card/.test(offered) && /Hilton Honors Aspire/.test(offered) && /Freedom Unlimited/.test(offered) && !/Platinum|Sapphire|Blue Cash/.test(offered) && /Add cards/.test(offered)
      && state.created.length === 2 && state.created[0].displayName === "Delta SkyMiles Gold Card" && state.created[0].issuer === "American Express" && state.created[0].rewardType === "points" && !state.created[0].cardKey
      && freedom?.issuer === "Chase" && freedom?.rewardType === "cashback" && freedom?.cardKey === "chase-freedom-unlimited"
      && /Delta SkyMiles Gold Card/.test(popupAfter) && /5 of your cards/.test(popupAfter) && /Hilton/.test(offeredAfter) && !/Delta|Freedom/.test(offeredAfter)
      && !offeredOnReload && st.cardLast4?.n1 === "3004" && st.cardLast4?.c4 === "1004" && (st.ignoredSiteCards?.["http://localhost:3000"] || []).includes("2008")
      && st.rewardsPages?.n1?.url === "http://localhost:3000/bank/rewards";
  } else if (scenario === "existing") {
    bank = await ctx.newPage();
    await bank.goto("http://localhost:3000/bank/login"); await signIn(bank);
    await bank.goto("http://localhost:3000/bank/rewards");
    await bank.bringToFront();
    const before = ctx.pages().length;
    await panel.evaluate(() => 0);
    // The panel reads the active tab of its window; bring the bank tab forward, then click in the panel.
    await panel.click('[data-act="read-tab"][data-id="c1"]', { noWaitAfter: true }).catch(() => {});
    const s = await waitFor((s) => s?.status === "confirm" || s?.status === "error", "confirm on existing tab");
    log("read tab:", s.status, s.pending?.value, "new tabs opened:", ctx.pages().length - before, "on", s.currentUrl);
    ok = s.status === "confirm" && s.pending?.value === 98765 && ctx.pages().length === before;
  }
} catch (err) {
  log("FAILED:", err.message);
} finally {
  log(ok ? "PASS" : "FAIL");
  process.exitCode = ok ? 0 : 1;
  await ctx.close(); server.close();
}
