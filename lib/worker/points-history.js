// Points history: the activity lines on the issuer's site ("Your Points Activity" on Amex: date,
// card, status, description, multiplier, amount, points) saved to Finstracker as history. Only new
// lines are read and sent: older lines ("Show More") are opened only until a line already saved
// shows up. A line belongs to the card in its card column (Amex lists every card on a Membership
// Rewards account in one table). History never changes the balance; the balance sync does.
import { Tracker } from "../api.js";
import { cardIssuer } from "../programs.js";
import { getState, setState } from "../storage.js";
import { session } from "./account.js";
import { accountParam, withAccount } from "./sites.js";
import { findLinkOn, pageSettled, readPointsHistoryOn } from "./tabs.js";

// Pages that list points activity, by issuer (the card's account_key is kept on Amex).
const HISTORY_PAGES = {
    "American Express": "https://global.americanexpress.com/rewards/summary",
};
const LINK_WORDS = ["points activity", "rewards activity", "your points activity", "points summary", "rewards summary", "membership rewards summary"];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** Which of these cards a line belongs to: its card column's last digits, else the card synced. */
export function ownerOf(row, card, cards, last4s) {
    if (!row.card) return card;
    const byNumber = (cards || []).find((c) => last4s?.[c.id] === row.card);
    if (byNumber) return byNumber;
    // The only card here, and no number known for it yet: the lines are its own.
    if ((cards || []).length <= 1 && !last4s?.[card.id]) return card;
    return null; // a card that isn't in Finstracker
}

async function loadKnown(cards) {
    const { apiBase, token } = await session();
    const { historySeen } = await getState(["historySeen"]);
    const known = new Set();
    for (const c of cards) {
        for (const k of historySeen?.[c.id] || []) known.add(k);
        try { for (const k of (await Tracker.historyKeys(apiBase, token, c.id))?.keys || []) known.add(k); } catch { /* the dashboard's own copy only */ }
    }
    return known;
}

async function waitLoaded(tabId) {
    for (let i = 0; i < 30; i++) {
        await pause(500);
        const t = await chrome.tabs.get(tabId).catch(() => null);
        if (!t) return false;
        if (t.status === "complete") break;
    }
    await pageSettled(tabId);
    return true;
}

/**
 * Save the new points history for this card (and, on a shared account, the other cards in its card
 * column). cards: the user's cards on this site. navigate: may open the issuer's activity page in
 * this tab when this page has none. Returns { read, added, reachedKnown }.
 */
export async function syncPointsHistory(tabId, card, { cards = [], navigate = true } = {}) {
    const { recordActivity } = await getState(["recordActivity"]);
    if (recordActivity === false) return { read: 0, added: 0, off: true };
    const here = [card, ...cards.filter((c) => c.id !== card.id)];
    const known = await loadKnown(here);
    let result = await readPointsHistoryOn(tabId, [...known]);
    if (!result.rows.length && navigate) {
        // Not on this page: the issuer's activity page (or the site's own "Points activity" link),
        // in a background tab next to this one, so the page you're on stays where it is.
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab) return { read: 0, added: 0 };
        const site = (u) => { try { return new URL(u).hostname.split(".").slice(-2).join("."); } catch { return ""; } };
        const page = HISTORY_PAGES[cardIssuer(card)];
        let target = page && site(page) === site(tab.url) ? withAccount(page, accountParam(tab.url)) : null;
        if (!target) {
            const link = await findLinkOn(tabId, LINK_WORDS, [], { click: false });
            target = link?.href || null;
        }
        if (!target) return { read: 0, added: 0 };
        const side = await chrome.tabs.create({ url: target, active: false, windowId: tab.windowId, index: tab.index + 1, openerTabId: tab.id }).catch(() => null);
        if (!side) return { read: 0, added: 0 };
        try {
            if (!(await waitLoaded(side.id))) return { read: 0, added: 0 };
            for (let i = 0; i < 3 && !result.rows.length; i++) {
                if (i) await pause(1500);
                result = await readPointsHistoryOn(side.id, [...known]);
            }
        } finally {
            chrome.tabs.remove(side.id).catch(() => {});
        }
    }
    const { cardLast4 } = await getState(["cardLast4"]);
    const fresh = new Map(); // cardId → lines
    for (const row of result.rows) {
        if (known.has(row.key)) continue;
        const owner = ownerOf(row, card, here, cardLast4 || {});
        if (!owner) continue;
        if (!fresh.has(owner.id)) fresh.set(owner.id, []);
        fresh.get(owner.id).push(row);
    }
    const { apiBase, token } = await session();
    const { historySeen } = await getState(["historySeen"]);
    const seen = { ...(historySeen || {}) };
    let added = 0;
    for (const [cardId, lines] of fresh) {
        for (let i = 0; i < lines.length; i += 500) {
            const items = lines.slice(i, i + 500).map(({ key, date, description, points, spend, status, multiplier }) => ({ key, date, description, points, spend, status, multiplier }));
            try {
                const r = await Tracker.saveHistory(apiBase, token, { cardId, items });
                added += r?.created || 0;
                seen[cardId] = [...new Set([...items.map((x) => x.key), ...(seen[cardId] || [])])].slice(0, 2000);
            } catch (err) {
                console.warn("[finstracker] history not saved", err?.message);
            }
        }
    }
    await setState({ historySeen: seen });
    return { read: result.rows.length, added, reachedKnown: result.reachedKnown };
}
