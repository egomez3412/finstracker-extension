// Merchant offers sync: read the issuer's offers page and save every offer to Finstracker.
import { Tracker } from "../api.js";
import { setState } from "../storage.js";
import { session } from "./account.js";
import { notify, readOffers, showsSignIn } from "./tabs.js";

// Issuers with one offers page we can open directly. Others use whatever offers page is on screen.
const OFFER_PAGES = {
    chase: "https://secure.chase.com/web/auth/dashboard#/dashboard/merchantOffers/offer-hub",
    "american express": "https://global.americanexpress.com/offers/eligible",
    amex: "https://global.americanexpress.com/offers/eligible",
    "bank of america": "https://secure.bankofamerica.com/customer-deals/redirect/customer-deals.go",
};
const WAIT_MS = 4 * 60 * 1000;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

export function offersPageFor(card) {
    const issuer = String(card.issuer || "").toLowerCase().trim();
    if (issuer === "chase" && card.chaseAccountId) return `${OFFER_PAGES.chase}?accountId=${encodeURIComponent(card.chaseAccountId)}`;
    return OFFER_PAGES[issuer] || null;
}

/** Save offers read for a card and show the result in the panel. */
export async function uploadOffers(card, offers) {
    const { apiBase, token } = await session();
    try {
        const resp = await Tracker.bulkUpsertOffers(apiBase, token, { cardId: card.id, source: "extension", offers });
        const received = resp?.received || offers.length;
        await setState({
            captureSession: {
                kind: "offers",
                cardId: card.id,
                cardName: card.displayName,
                issuer: card.issuer,
                status: "synced",
                statusLabel: `Saved ${received} ${card.issuer || ""} offers`.replace(/\s+/g, " "),
                lastScrape: { offers: offers.length, at: Date.now() },
                startedAt: Date.now(),
                expiresAt: Date.now() + 2 * 60 * 1000,
            },
        });
        notify("Finstracker", `${card.displayName}: ${received} offers saved (${resp?.created || 0} new)`);
        return { ok: true, kind: "offers", offers: offers.length, received, created: resp?.created || 0, updated: resp?.updated || 0 };
    } catch (err) {
        const message = err?.message || "Couldn't save offers";
        await setState({ captureSession: { kind: "offers", cardId: card.id, cardName: card.displayName, issuer: card.issuer, status: "error", lastError: message, startedAt: Date.now() } });
        return { ok: false, error: message };
    }
}

/** Offers on a tab the user already has open. Null when there are none. */
export async function readOffersFromTab(card, tabId) {
    const offers = await readOffers(tabId);
    return offers.length ? uploadOffers(card, offers) : null;
}

/** Open the card's offers page, wait for sign-in, then read and save the offers. */
export async function syncOffersForCard(card) {
    if (!card?.id) return { ok: false, error: "Missing card" };
    const { token } = await session();
    if (!token) return { ok: false, error: "Sign in to Finstracker first" };

    const url = offersPageFor(card);
    if (!url) {
        const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!active?.id) return { ok: false, error: `Open your ${card.issuer || "card"} offers page first, then try again.` };
        return (await readOffersFromTab(card, active.id)) || { ok: false, error: "No offers on this tab. Open your offers list and try again." };
    }

    const base = { kind: "offers", cardId: card.id, cardName: card.displayName, issuer: card.issuer, startedAt: Date.now(), expiresAt: Date.now() + 5 * 60 * 1000 };
    await setState({ captureSession: { ...base, status: "opening", statusLabel: `Opening ${card.issuer} offers…`, currentUrl: url } });
    let tab;
    try {
        tab = await chrome.tabs.create({ url, active: true });
    } catch (err) {
        await setState({ captureSession: { ...base, status: "error", lastError: err.message || "Couldn't open the offers page" } });
        return { ok: false, error: err.message || "Couldn't open the offers page" };
    }

    const deadline = Date.now() + WAIT_MS;
    let lastError = null;
    while (Date.now() < deadline) {
        await pause(3500);
        let info;
        try { info = await chrome.tabs.get(tab.id); } catch { lastError = "The offers tab was closed"; break; }
        if (info?.status !== "complete") continue;
        await setState({ captureSession: { ...base, status: "watching", statusLabel: `Reading ${card.issuer} offers…`, currentUrl: info.url } });
        let offers = [];
        try { offers = await readOffers(tab.id); } catch (err) { lastError = err?.message || String(err); continue; }
        if (offers.length) return uploadOffers(card, offers);
        if (await showsSignIn(tab.id)) {
            await setState({ captureSession: { ...base, status: "awaiting-login", statusLabel: `Sign in to ${card.issuer}`, currentUrl: info.url } });
        }
    }
    const message = lastError || "No offers found on that page. Open your offers list and try again.";
    await setState({ captureSession: { ...base, status: "error", lastError: message } });
    return { ok: false, error: message };
}
