// Messages from the side panel and the on-page widgets. Every handler answers { ok, ... }.
import { Tracker, isAuthError } from "../api.js";
import { clearAuth, getState } from "../storage.js";
import { cards, resetAccount, session } from "./account.js";
import { applyPickerResult, cancelCapture, clearOverride, confirmReading, onStatusAction, openPickerOnCaptureTab, pickBalance, pickerNavigate, retryCapture, setRewardsPage, startCapture } from "./capture.js";
import { readOffersFromTab, syncOffersForCard } from "./offers-sync.js";
import { isRunning, runAutopilot, setAutopilot, stopAutopilot } from "./autopilot.js";
import { syncBenefits } from "./benefits-sync.js";
import { afterCardsAdded, collapsePrompt, dismissOrigin, dropOffers, linkCardsToSite, pageCards, pageNewCards, shoppingAdvice } from "./site-hints.js";
import { addSiteCards, ignoreSiteCards } from "./new-cards.js";
import { boardCardsAdded } from "./autopilot.js";

async function withAccount(fn) {
    const { apiBase, token } = await session();
    if (!token) return { ok: false, error: "Not signed in", signedOut: true };
    try {
        return { ok: true, ...(await fn(apiBase, token)) };
    } catch (err) {
        if (isAuthError(err)) {
            await clearAuth();
            return { ok: false, error: "Your session ended. Sign in again.", signedOut: true };
        }
        return { ok: false, error: err?.message || "Request failed" };
    }
}

/** Offers pages are read for offers; every other page starts a points sync on that tab. */
async function readTab(card, tabId) {
    const tab = await chrome.tabs.get(tabId);
    if (/offer|deals|merchantoffers|customer-deals/i.test(tab.url || "")) return readOffersFromTab(card, tabId);
    return startCapture({ card, tabId, mode: "auto" });
}

const handlers = {
    ping: async () => ({ ok: true }),
    logout: async () => { await clearAuth(); return { ok: true }; },
    resetAccount: async () => {
        if (await isRunning()) await stopAutopilot();
        return resetAccount();
    },
    listCards: (msg) => withAccount(async () => ({ cards: await cards({ fresh: Boolean(msg.fresh) }) })),
    listCredits: () => withAccount(async (base, token) => ({ credits: (await Tracker.listCredits(base, token)) || [] })),
    listOffers: () => withAccount(async (base, token) => ({ offers: (await Tracker.listOffers(base, token)) || [] })),
    setCreditUsed: (msg) => withAccount(async (base, token) => ({ credit: await Tracker.setCreditUsed(base, token, msg.id, msg.used !== false) })),
    setOfferUsed: (msg) => withAccount(async (base, token) => { dropOffers(); return { offer: await Tracker.setOfferUsed(base, token, msg.id, msg.used !== false) }; }),
    siteAdvice: (msg) => withAccount(async () => ({ advice: msg.url ? await shoppingAdvice(msg.url) : null })),
    startCapture: (msg) => startCapture({ card: msg.card, mode: msg.mode || "auto" }),
    cancelCapture: () => cancelCapture(),
    syncOffers: (msg) => syncOffersForCard(msg.card),
    syncBenefits: (msg) => syncBenefits(msg.card),
    runAutopilot: async (msg, sender) => {
        const tabId = msg.tabId || (msg.here ? sender?.tab?.id : null) || null;
        runAutopilot(msg.cardIds || [], { tabId, firstId: msg.current || null }).catch((err) => console.warn("[finstracker] autopilot", err));
        return { ok: true, started: true }; // progress shows in the panel's status area
    },
    stopAutopilot: () => stopAutopilot(),
    setAutopilot: (msg) => setAutopilot(msg.cardId, msg.on),
    clearOverride: (msg) => clearOverride(msg.cardId),
    setRewardsPage: (msg) => setRewardsPage(msg.cardId, msg.url),
    syncFromActiveTab: async (msg, sender) => {
        const tabId = msg.tabId || sender?.tab?.id;
        if (!tabId) return { ok: false, error: "No tab to read" };
        if (!(await getState(["token"])).token) return { ok: false, error: "Not signed in", signedOut: true };
        return readTab(msg.card, tabId);
    },
    startPickerForCard: (msg, sender) => pickBalance(msg.card, msg.tabId || sender?.tab?.id),
    pickBalance: (msg, sender) => pickBalance(msg.card, msg.tabId || sender?.tab?.id),
    pickerNavigate: () => pickerNavigate(),
    openPicker: () => openPickerOnCaptureTab(),
    confirmReading: () => confirmReading(),
    retryCapture: () => retryCapture(),
    statusAction: (msg) => onStatusAction(msg.action),
    pickerResult: (msg) => applyPickerResult(msg),
    dismissPromptForOrigin: async (msg) => { dismissOrigin(msg.origin); return { ok: true }; },
    pageCards: (msg) => pageCards(msg.url),
    pageNewCards: async (msg) => {
        const tab = await chrome.tabs.get(msg.tabId);
        return pageNewCards(tab.id, tab.url, { find: Boolean(msg.find) });
    },
    addSiteCards: async (msg, sender) => {
        const tabId = msg.tabId || sender?.tab?.id;
        if (!tabId) return { ok: false, error: "No tab" };
        const tab = await chrome.tabs.get(tabId);
        const r = await addSiteCards(tabId, tab.url, msg.keys || []);
        if (r.ok && msg.run) {
            // "Add cards and run autopilot": run the cards just added, in this tab.
            runAutopilot(r.added.map((c) => c.id), { tabId }).catch((err) => console.warn("[finstracker] autopilot", err));
        } else if (r.ok) { await boardCardsAdded(r.added); afterCardsAdded(tabId, tab.url).catch(() => {}); }
        return r;
    },
    ignoreSiteCards: async (msg, sender) => {
        const tabId = msg.tabId || sender?.tab?.id;
        if (!tabId) return { ok: false, error: "No tab" };
        const tab = await chrome.tabs.get(tabId);
        return ignoreSiteCards(tabId, tab.url, msg.keys || []);
    },
    linkCardsToSite: async (msg, sender) => {
        const tabId = msg.tabId || sender?.tab?.id;
        if (!tabId) return { ok: false, error: "No tab" };
        const tab = await chrome.tabs.get(tabId);
        return linkCardsToSite(tabId, tab.url, msg.cardIds || [], { run: Boolean(msg.run) });
    },
    collapsePrompt: (msg, sender) => (sender?.tab?.id ? collapsePrompt(sender.tab.id, sender.tab.url || sender.url) : { ok: false }),
    openSidePanel: async (msg, sender) => {
        // Called from a click on the page's quick tab, which counts as the user's action.
        try { await chrome.sidePanel.open({ tabId: sender.tab.id }); return { ok: true }; } catch (err) { return { ok: false, error: err?.message || "Open Finstracker from the toolbar" }; }
    },
};

// Things the browser or the page can do at any moment: the tab closed, the page moved on mid-step,
// the site isn't allowed yet. They're answered to the caller in plain words, not logged as errors.
const PAGE_GONE = /no tab with id|tab was closed|frame (with id \d+ )?was removed|frame was removed|document was unloaded|back\/forward cache|receiving end does not exist|message port closed|cannot access|cannot be scripted|missing host permission|extension manifest must request permission|chrome:\/\/|edge:\/\/|webstore|error page|no window with id/i;

/** A failed handler's error in words the panel and the page can show. */
export function friendlyError(err) {
    const text = err?.message || String(err || "");
    if (/no tab with id|tab was closed|no window with id/i.test(text)) return "That tab was closed";
    if (/frame|unloaded|back\/forward|receiving end|port closed/i.test(text)) return "The page changed before Finstracker finished. Try again.";
    if (/cannot access|cannot be scripted|host permission|must request permission/i.test(text)) return "Finstracker can't read this page. Allow access to the site, then try again.";
    if (/chrome:\/\/|edge:\/\/|webstore|error page/i.test(text)) return "Finstracker can't work on this page";
    return text || "Something went wrong";
}

export function onMessage(msg, sender, sendResponse) {
    const respond = (value) => { try { sendResponse(value); } catch { /* the page or panel closed */ } };
    const handler = handlers[msg?.type];
    if (!handler) { respond({ ok: false, error: "Unknown message" }); return false; }
    Promise.resolve()
        .then(() => handler(msg, sender))
        .then((value) => respond(value ?? { ok: true }), (err) => {
            const text = err?.message || String(err || "");
            // A warning, not an error: it's answered to the caller, which shows it.
            if (!PAGE_GONE.test(text)) console.warn("[finstracker] message failed", msg?.type, text, err?.stack || "");
            respond({ ok: false, error: friendlyError(err) });
        });
    return true;
}
