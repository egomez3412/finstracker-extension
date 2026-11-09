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
  await sw.evaluate(() => chrome.storage.local.set({ token: "test-token", apiBase: "http://localhost:3000", user: { username: "e2e" }, rewardsPages: { c1: { url: "http://localhost:3000/bank/dashboard", source: "learned" } } }));
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
    // First sync: baseline (no activity entries). Next sync: the new line is recorded with its
    // description, and the balance change only covers the rest.
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
    ok = state.transactions.length === 2 && state.transactions[1].note === "Nov 8 · Dining" && state.transactions[1].amount === 500 && state.points === 99265;
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
    ok = state.points === 98765 && state.offers.length === 3 && state.perks.find((x) => x.id === "p-uber").used && /Balance/.test(results?.balance || "") && /offers saved/.test(results?.offers || "");
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
      && state.cards.c4.currentPoints === 150000 && state.cards.c3.currentPoints === 45000 && state.cards.c1.currentPoints === 98765
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
    ok = s.status === "synced" && buttons.length === 8 && buttons.every((b) => /Added/.test(b)) && decoy === "not clicked" && state.offers.length === 8 && state.offers.every((o) => o.activated);
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
