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
  sw.on("console", (m) => { if (m.type() !== "log") log("sw", m.type(), m.text()); });
  const extId = new URL(sw.url()).host;
  await sw.evaluate(() => chrome.storage.local.set({ token: "test-token", apiBase: "http://localhost:3000", user: { username: "e2e" }, rewardsPages: { c1: { url: "http://localhost:3000/bank/dashboard", source: "learned" } } }));
  const session = () => sw.evaluate(() => chrome.storage.local.get("captureSession").then((r) => r.captureSession || null));
  const waitFor = async (pred, label, ms = 40000) => {
    const end = Date.now() + ms; let last = "";
    while (Date.now() < end) {
      const s = await session();
      const line = s ? `${s.status} | ${s.statusLabel || ""} | ${s.lastError || ""}` : "none";
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
