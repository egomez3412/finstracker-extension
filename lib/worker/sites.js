// Finding a tab that is already on a card's bank (or program) site.
import { loadPortals, resolvePortal, urlMatches } from "../portals.js";
import { getState } from "../storage.js";

export const siteName = (url) => { try { return new URL(url).hostname.replace(/^(www|secure|online|global|connect)\./, ""); } catch { return "the site"; } };

/** The card's portal; bank: true ignores its loyalty program (offers and benefits live at the bank). */
export async function portalForCard(card, { bank = false } = {}) {
    const { portalOverrides, rewardsPages } = await getState(["portalOverrides", "rewardsPages"]);
    return resolvePortal(bank ? { ...card, program: "", displayName: card.issuer || card.displayName } : card, portalOverrides, await loadPortals(), rewardsPages);
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
