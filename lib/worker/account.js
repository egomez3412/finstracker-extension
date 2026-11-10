// The signed-in account: its token, API base and a short-lived copy of its cards.
import { Tracker } from "../api.js";
import { getState, setState } from "../storage.js";

const CARDS_TTL_MS = 5 * 60 * 1000;

export async function session() {
    const { apiBase, token } = await getState(["apiBase", "token"]);
    return { apiBase, token };
}

/** The user's cards; reuses the copy from the last five minutes unless fresh is set. */
export async function cards({ fresh = false } = {}) {
    const { apiBase, token, cardsCache, cardsCachedAt } = await getState(["apiBase", "token", "cardsCache", "cardsCachedAt"]);
    if (!token) return [];
    if (!fresh && Array.isArray(cardsCache) && Date.now() - cardsCachedAt < CARDS_TTL_MS) return cardsCache;
    const list = (await Tracker.listCards(apiBase, token)) || [];
    await setState({ cardsCache: list, cardsCachedAt: Date.now() });
    return list;
}

/** Forget the cached cards (after a sync changes a balance). */
export const dropCards = () => setState({ cardsCachedAt: 0 });

// What the extension learned about the user's cards and sites, cleared with the account's data.
const LEARNED_KEYS = ["captureSession", "portalOverrides", "rewardsPages", "learnedPages", "cardLast4", "ignoredSiteCards", "autopilot", "autopilotLastBoard", "autopilotError", "activitySeen", "historySeen", "lastPull", "cardsCache", "cardsCachedAt"];

/**
 * Start over: delete every card on the signed-in Finstracker account, with its offers and credits
 * (the dashboard doesn't remove those with the card), and forget what the extension learned.
 * Settings and the sign-in stay. Returns { cards, offers, credits } deleted.
 */
export async function resetAccount() {
    const { apiBase, token } = await session();
    if (!token) return { ok: false, error: "Sign in first", signedOut: true };
    const list = (await Tracker.listCards(apiBase, token)) || [];
    const done = { cards: 0, offers: 0, credits: 0 };
    const failed = [];
    for (const card of list) {
        try {
            done.offers += (await Tracker.deleteCardOffers(apiBase, token, card.id))?.deletedCount || 0;
            done.credits += (await Tracker.deleteCardCredits(apiBase, token, card.id))?.deletedCount || 0;
            await Tracker.deleteCard(apiBase, token, card.id);
            done.cards += 1;
        } catch (err) {
            failed.push(`${card.displayName}: ${err?.message || "failed"}`);
        }
    }
    await chrome.storage.local.remove(LEARNED_KEYS);
    return { ok: !failed.length, ...done, failed, error: failed.length ? `Couldn't delete ${failed.length} of ${list.length} cards` : null };
}
