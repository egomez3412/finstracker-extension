// Messages from the side panel and the on-page widgets. Every handler answers { ok, ... }.
import { Tracker, isAuthError } from "../api.js";
import { clearAuth, getState } from "../storage.js";
import { cards, session } from "./account.js";
import { applyPickerResult, cancelCapture, clearOverride, confirmReading, onStatusAction, openPickerOnCaptureTab, openPickerOnTab, retryCapture, setRewardsPage, startCapture } from "./capture.js";
import { readOffersFromTab, syncOffersForCard } from "./offers-sync.js";
import { dismissOrigin, dropOffers, shoppingAdvice } from "./site-hints.js";

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
    if (/offer|deals|merchantoffers|customer-deals/i.test(tab.url || "")) {
        const offers = await readOffersFromTab(card, tabId);
        if (offers) return offers;
    }
    return startCapture({ card, tabId, mode: "auto" });
}

const handlers = {
    ping: async () => ({ ok: true }),
    logout: async () => { await clearAuth(); return { ok: true }; },
    listCards: (msg) => withAccount(async () => ({ cards: await cards({ fresh: Boolean(msg.fresh) }) })),
    listCredits: () => withAccount(async (base, token) => ({ credits: (await Tracker.listCredits(base, token)) || [] })),
    listOffers: () => withAccount(async (base, token) => ({ offers: (await Tracker.listOffers(base, token)) || [] })),
    setCreditUsed: (msg) => withAccount(async (base, token) => ({ credit: await Tracker.setCreditUsed(base, token, msg.id, msg.used !== false) })),
    setOfferUsed: (msg) => withAccount(async (base, token) => { dropOffers(); return { offer: await Tracker.setOfferUsed(base, token, msg.id, msg.used !== false) }; }),
    siteAdvice: (msg) => withAccount(async () => ({ advice: msg.url ? await shoppingAdvice(msg.url) : null })),
    startCapture: (msg) => startCapture({ card: msg.card, mode: msg.mode || "auto" }),
    cancelCapture: () => cancelCapture(),
    syncOffers: (msg) => syncOffersForCard(msg.card),
    clearOverride: (msg) => clearOverride(msg.cardId),
    setRewardsPage: (msg) => setRewardsPage(msg.cardId, msg.url),
    syncFromActiveTab: async (msg, sender) => {
        const tabId = msg.tabId || sender?.tab?.id;
        if (!tabId) return { ok: false, error: "No tab to read" };
        if (!(await getState(["token"])).token) return { ok: false, error: "Not signed in", signedOut: true };
        return readTab(msg.card, tabId);
    },
    startPickerForCard: async (msg, sender) => {
        const tabId = msg.tabId || sender?.tab?.id;
        if (!tabId) return { ok: false, error: "No tab to pick on" };
        return openPickerOnTab(msg.card, tabId);
    },
    openPicker: () => openPickerOnCaptureTab(),
    confirmReading: () => confirmReading(),
    retryCapture: () => retryCapture(),
    statusAction: (msg) => onStatusAction(msg.action),
    pickerResult: (msg) => applyPickerResult(msg),
    dismissPromptForOrigin: async (msg) => { dismissOrigin(msg.origin); return { ok: true }; },
};

export function onMessage(msg, sender, sendResponse) {
    const handler = handlers[msg?.type];
    if (!handler) { sendResponse({ ok: false, error: "Unknown message" }); return false; }
    Promise.resolve()
        .then(() => handler(msg, sender))
        .then(sendResponse, (err) => {
            console.error("[finstracker] message failed", msg?.type, err);
            sendResponse({ ok: false, error: err?.message || String(err) });
        });
    return true;
}
