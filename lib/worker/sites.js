// Finding a tab that is already on a card's bank (or program) site.
import { loadPortals, pageToRemember, resolvePortal, urlMatches } from "../portals.js";
import { distinctWords } from "../programs.js";
import { getState, setState } from "../storage.js";
import { cards } from "./account.js";
import { detectCardOn, switchAccountOn } from "./tabs.js";

export const siteName = (url) => { try { return new URL(url).hostname.replace(/^(www|secure|online|global|connect)\./, ""); } catch { return "the site"; } };

/** The card's portal; bank: true ignores its loyalty program (offers and benefits live at the bank). */
export async function portalForCard(card, { bank = false } = {}) {
    const { portalOverrides, rewardsPages } = await getState(["portalOverrides", "rewardsPages"]);
    return resolvePortal(bank ? { ...card, program: "", displayName: card.issuer || card.displayName } : card, portalOverrides, await loadPortals(), rewardsPages);
}

/** Where offers or benefits ("offers" | "benefits") were found for this card last time, or null. */
export async function learnedPage(card, kind) {
    const { learnedPages } = await getState(["learnedPages"]);
    return learnedPages?.[card.id]?.[kind] || null;
}

/** Remember where the card's offers or benefits were found, to go straight there next time. */
export async function learnPage(card, kind, url) {
    const page = pageToRemember(url);
    if (!page) return;
    const { learnedPages } = await getState(["learnedPages"]);
    await setState({ learnedPages: { ...(learnedPages || {}), [card.id]: { ...(learnedPages?.[card.id] || {}), [kind]: page } } });
}

/** The active tab if it is on the card's site, else the most recently used tab there, else null. */
export async function findSiteTab(portal) {
    if (!portal?.matchUrl) return null;
    const onSite = (t) => t?.id && /^https?:/.test(t.url || "") && urlMatches(portal.matchUrl, t.url);
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (onSite(active)) return active;
    return (await chrome.tabs.query({})).filter(onSite).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0] || null;
}

/**
 * The tab to work in: the given tab (navigated to url when asked), an open tab on the site, or a
 * new one. background: never focus it.
 */
export async function workTab({ tabId = null, portal = null, url = null, navigate = false, background = false }) {
    if (tabId) {
        const tab = await chrome.tabs.get(tabId);
        return navigate && url ? chrome.tabs.update(tabId, { url, ...(background ? {} : { active: true }) }) : tab;
    }
    const open = background ? null : await findSiteTab(portal);
    if (open) return url ? chrome.tabs.update(open.id, { url, active: true }) : chrome.tabs.update(open.id, { active: true });
    const target = url || portal?.loginUrl || portal?.pointsUrlHint;
    if (!target) return null;
    return chrome.tabs.create({ url: target, active: !background });
}

/**
 * The user's cards that share this card's site, each with the name words that tell it apart from
 * the others ("Amex Gold" / "Amex Platinum" → ["gold"] / ["platinum"]). [] when the card is alone.
 */
export async function siteCardsFor(card) {
    const all = await cards();
    const key = async (c) => [].concat((await portalForCard(c))?.matchUrl || [])[0] || `card:${c.id}`;
    const mine = await key(card);
    const same = [];
    for (const c of all) if ((await key(c)) === mine) same.push(c);
    if (!same.some((c) => c.id === card.id)) same.push(card);
    if (same.length < 2) return [];
    return same.map((c) => ({ id: c.id, name: c.displayName, words: distinctWords(c, same.filter((o) => o.id !== c.id)) }));
}

/**
 * Before saving a card's offers or benefits on a site shared with the user's other cards: make sure
 * the page is for this card. Selects it in the site's switcher when needed. Returns
 * { ok: true } to go on, { ok: true, clicked: true } after selecting (settle and look again), or
 * { ok: false, message } to skip. requireVerified: when the page names no card, only go on if the
 * card was confirmed a step earlier (autopilot).
 */
export async function ensureShownCard(tabId, card, { siteCards = null, requireVerified = false, attempt = 0 } = {}) {
    const site = siteCards || (await siteCardsFor(card));
    if (site.length < 2) return { ok: true };
    const me = site.find((c) => c.id === card.id) || { words: [] };
    const nameOf = (id) => site.find((c) => c.id === id)?.name || "another card";
    let seen = await detectCardOn(tabId, site);
    if (seen?.strong && seen.id === card.id) return { ok: true };
    if (attempt < 2) {
        const switched = await switchAccountOn(tabId, me.words, site.filter((c) => c.id !== card.id).map((c) => c.words));
        if (switched.clicked) return { ok: true, clicked: true };
        seen = await detectCardOn(tabId, site);
        if (seen?.strong && seen.id === card.id) return { ok: true };
    }
    if (seen?.strong) return { ok: false, message: `This page shows ${nameOf(seen.id)}, not ${card.displayName}, so it was skipped.` };
    if (requireVerified) return { ok: false, message: `Couldn't tell whether this page is for ${card.displayName}, so it was skipped.` };
    return { ok: true };
}
