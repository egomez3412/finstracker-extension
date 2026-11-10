// Finstracker Sync service worker. The work lives in lib/worker/*; this file only connects
// Chrome's events to it.
//   capture.js      points sync from issuer portals (and the element picker)
//   offers-sync.js  merchant offers from issuer offer pages
//   site-hints.js   sync prompt on portals, best card on shops and at checkout
//   router.js       messages from the side panel and on-page widgets
//   auth-bridge.js  sign-in hand-off from finstracker.com
import { cleanOverrides } from "./lib/portals.js";
import { PRODUCTION } from "./lib/storage.js";
import { onExternalMessage } from "./lib/worker/auth-bridge.js";
import { onTabClosed, processTab } from "./lib/worker/capture.js";
import { onMessage } from "./lib/worker/router.js";
import { forgetTabHints, onTabVisited } from "./lib/worker/site-hints.js";
import { clearStaleRun, redrawBoard } from "./lib/worker/autopilot.js";

async function onNavigated(tabId, url, finished) {
    if (!finished) return; // read pages once they have loaded, not while they unload
    try {
        processTab(tabId, url).catch((err) => console.warn("[finstracker] read failed", err));
        redrawBoard(tabId).catch(() => {}); // the autopilot board, after the portal page reloads
        await onTabVisited(tabId, url);
    } catch (err) {
        console.warn("[finstracker] navigation handler", err);
    }
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    const url = info.url || tab?.url;
    if (!url || (info.status !== "complete" && !info.url)) return;
    onNavigated(tabId, url, info.status === "complete");
});

// Single-page portals change routes without a page load; this catches those.
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    if (details?.frameId === 0) onNavigated(details.tabId, details.url, true);
});

// A new document in the tab: anything we drew on the old one is gone.
chrome.webNavigation.onCommitted.addListener((details) => {
    if (details?.frameId === 0) forgetTabHints(details.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
    onTabClosed(tabId);
    forgetTabHints(tabId);
});

chrome.runtime.onMessage.addListener(onMessage);
chrome.runtime.onMessageExternal.addListener(onExternalMessage);

chrome.runtime.onInstalled.addListener(async () => {
    const cur = await chrome.storage.local.get(["portalOverrides"]); // apiBase defaults to production (lib/storage.js)
    if (cur.portalOverrides) await chrome.storage.local.set({ portalOverrides: cleanOverrides(cur.portalOverrides) });
    await stayOnProduction();
});

// The toolbar icon opens the side panel, which stays open across navigation and sign-in.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
stayOnProduction();
// A run saved before this worker started can no longer finish: mark it stopped.
clearStaleRun().catch(() => {});
// Autopilot only runs when the user clicks Run: the old daily run's switches are turned off.
chrome.storage.local.set({ autopilotAuto: false }).catch(() => {});

/**
 * Finstracker always talks to finstracker.com. Early builds switched to any server answering on
 * localhost:3000 and stayed there (so sign-in opened a localhost page); move those back. A local
 * server is only used when devServer is set on purpose (the e2e tests do).
 */
async function stayOnProduction() {
    try {
        const { apiBase, devServer } = await chrome.storage.local.get(["apiBase", "devServer"]);
        if (devServer || !apiBase || apiBase === PRODUCTION) return;
        await chrome.storage.local.set({ apiBase: PRODUCTION });
    } catch { /* storage unavailable; try again next start */ }
}
