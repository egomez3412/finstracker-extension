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
