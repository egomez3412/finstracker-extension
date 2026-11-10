// New cards on a bank's site: once signed in, read the cards the site lists for this login (card
// switcher, account tiles) and offer to add the ones that aren't in Finstracker yet. Added cards
// are linked to the site, so the popup and autopilot include them from then on.
import { Tracker } from "../api.js";
import { issuerForUrl, loadPortals } from "../portals.js";
import { cardIssuer } from "../programs.js";
import { cleanSiteCardName, newSiteCards } from "../site-cards.js";
import { getState, setState } from "../storage.js";
import { cards as loadCards, session } from "./account.js";
import { rememberPage } from "./capture.js";
import { listSiteCardsOn, pageSettled, showsSignIn } from "./tabs.js";

const seen = new Map(); // tabId → { origin, fresh, matched, at } from the last look at that tab
const originOf = (url) => { try { return new URL(url).origin; } catch { return ""; } };
const siteOf = (url) => { try { return new URL(url).hostname.replace(/^(www|secure|online|global|connect)\./, ""); } catch { return "this site"; } };

/**
 * The bank behind a site: from the issuer list (sure), else the cards already linked to it, else
 * its name (a guess; each card's own catalog entry or name wins over it).
 */
async function issuerFor(url, linked) {
    const named = issuerForUrl(url, await loadPortals());
    if (named) return { issuer: named, issuerSure: true };
    const counts = new Map();
    for (const c of linked || []) { const i = cardIssuer(c); if (i) counts.set(i, (counts.get(i) || 0) + 1); }
    return { issuer: [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || siteOf(url), issuerSure: false };
}

/**
 * Look at the page for cards the user doesn't have in Finstracker yet. Only when signed in.
 * linked: the user's cards already linked to the site. Returns { fresh: [{ key, name, last4, issuer, … }],
 * matched: { [cardId]: last4 } } (the user's cards the site lists).
 */
export async function scanSiteCards(tabId, url, linked = []) {
    try {
        if (await showsSignIn(tabId)) return { fresh: [], matched: {} };
        await pageSettled(tabId);
        const site = (await listSiteCardsOn(tabId)).map((x) => cleanSiteCardName(x.text)).filter(Boolean);
        if (!site.length) { seen.set(tabId, { origin: originOf(url), fresh: [], matched: {}, at: Date.now() }); return { fresh: [], matched: {} }; }
        const all = await loadCards();
        const { cardLast4, ignoredSiteCards } = await getState(["cardLast4", "ignoredSiteCards"]);
        const { fresh, matched } = newSiteCards(site, all, { ...(await issuerFor(url, linked)), last4s: cardLast4 || {}, ignored: ignoredSiteCards?.[originOf(url)] || [] });
        // Remember each known card's number: the surest way to tell cards apart next time.
        const learned = Object.fromEntries(Object.entries(matched).filter(([id]) => !cardLast4?.[id]));
        if (Object.keys(learned).length) await setState({ cardLast4: { ...(cardLast4 || {}), ...learned } });
        seen.set(tabId, { origin: originOf(url), fresh, matched, at: Date.now() });
        return { fresh, matched };
    } catch (err) {
        console.warn("[finstracker] card scan skipped", err?.message);
        return { fresh: [], matched: {} };
    }
}

/** What the last look at this tab found (for the side panel), without touching the page. */
export function seenSiteCards(tabId, url) {
    const s = seen.get(tabId);
    return s && s.origin === originOf(url) ? s.fresh : [];
}
export const forgetSiteCards = (tabId) => seen.delete(tabId);

/** The short form the popup, board and panel show: [{ key, name, last4 }]. */
export const newCardsView = (fresh) => (fresh || []).map((c) => ({ key: c.key, name: c.name, last4: c.last4 }));

/** Add these cards (keys from scanSiteCards) to the user's Finstracker and link them to the site. */
export async function addSiteCards(tabId, url, keys) {
    const s = seen.get(tabId);
    const items = (s?.fresh || []).filter((c) => (keys || []).includes(c.key));
    if (!items.length) return { ok: false, error: "Those cards are no longer on the page. Reload it and try again." };
    const { apiBase, token } = await session();
    if (!token) return { ok: false, error: "Sign in to Finstracker first", signedOut: true };
    const { cardLast4 } = await getState(["cardLast4"]);
    const numbers = { ...(cardLast4 || {}) };
    const added = [];
    const failed = [];
    for (const c of items) {
        const body = { displayName: c.name.slice(0, 80), issuer: String(c.issuer || siteOf(url)).slice(0, 60), rewardType: c.rewardType };
        let card = null;
        try {
            card = await Tracker.createCard(apiBase, token, c.cardKey ? { ...body, cardKey: c.cardKey } : body);
        } catch (err) {
            // A catalog key the server doesn't know: add the card without it.
            if (c.cardKey && err?.status === 400) { try { card = await Tracker.createCard(apiBase, token, body); } catch { card = null; } }
        }
        if (!card?.id) { failed.push(c.name); continue; }
        await rememberPage(card.id, url, "user");
        if (c.last4) numbers[card.id] = c.last4;
        added.push(card);
    }
    await setState({ cardLast4: numbers });
    await loadCards({ fresh: true });
    if (s) s.fresh = s.fresh.filter((c) => !items.includes(c) || failed.includes(c.name)); // the added ones are no longer new
    return { ok: added.length > 0, added: added.map((c) => ({ id: c.id, displayName: c.displayName })), failed, error: added.length ? null : "Couldn't add the cards. Try again from the Finstracker dashboard." };
}

/** "Not mine": don't offer these cards on this site again. */
export async function ignoreSiteCards(tabId, url, keys) {
    const origin = originOf(url);
    const { ignoredSiteCards } = await getState(["ignoredSiteCards"]);
    const list = [...new Set([...(ignoredSiteCards?.[origin] || []), ...(keys || [])])];
    await setState({ ignoredSiteCards: { ...(ignoredSiteCards || {}), [origin]: list } });
    const s = seen.get(tabId);
    if (s) s.fresh = s.fresh.filter((c) => !list.includes(c.key));
    return { ok: true };
}
