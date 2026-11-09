// Messages from the side panel and the on-page widgets. Every handler answers { ok, ... }.
import { Tracker, isAuthError } from "../api.js";
import { clearAuth, getState } from "../storage.js";
import { cards, session } from "./account.js";
import { applyPickerResult, cancelCapture, clearOverride, openPickerOnCaptureTab, openPickerOnTab, readPointsFromTab, startCapture } from "./capture.js";
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

/** Points or offers, whichever the tab shows. Offer-looking URLs try offers first. */
async function readTab(card, tabId) {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url || "";
    const steps = /offer|deals|merchantoffers|customer-deals/i.test(url)
        ? [() => readOffersFromTab(card, tabId), () => readPointsFromTab(card, tabId, url)]
        : [() => readPointsFromTab(card, tabId, url), () => readOffersFromTab(card, tabId)];
    let lastError = null;
    for (const step of steps) {
        try {
            const result = await step();
            if (result) return result;
        } catch (err) {
            lastError = err?.message || String(err);
        }
    }
    return { ok: false, error: lastError || "No balance or offers found on this tab. Open your rewards or offers page." };
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
