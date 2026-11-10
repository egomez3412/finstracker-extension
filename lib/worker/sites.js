// Finding a tab that is already on a card's bank (or program) site.
import { loadPortals, originPattern, pageToRemember, resolvePortal, urlMatches } from "../portals.js";
import { distinctWords } from "../programs.js";
import { getState, setState } from "../storage.js";
import { cards } from "./account.js";
import { detectCardOn, switchAccountOn } from "./tabs.js";

export const siteName = (url) => { try { return new URL(url).hostname.replace(/^(www|secure|online|global|connect)\./, ""); } catch { return "the site"; } };

/**
 * The card's portal; bank: true ignores its loyalty program (offers and benefits live at the bank),
 * also when only its catalog entry names one ("hilton-honors-aspire" is an Amex card).
 */
export async function portalForCard(card, { bank = false } = {}) {
    const { portalOverrides, rewardsPages } = await getState(["portalOverrides", "rewardsPages"]);
    return resolvePortal(bank ? { ...card, program: "", cardKey: null, displayName: card.issuer || card.displayName } : card, portalOverrides, await loadPortals(), rewardsPages);
}

/**
 * Which site a card is worked on, to know which cards share one (and its card switcher): the site
 * it was linked to (picked, or found on), else its portal. A co-brand card found on Amex ("Hilton
 * Honors Aspire") is worked on at Amex with the other Amex cards, not on hilton.com.
 */
export async function siteKeyFor(card) {
    const { portalOverrides, rewardsPages } = await getState(["portalOverrides", "rewardsPages"]);
    const linked = portalOverrides?.[card.id]?.matchUrl || originPattern(rewardsPages?.[card.id]?.url || portalOverrides?.[card.id]?.capturedUrl || "");
    const pattern = linked || [].concat((await portalForCard(card))?.matchUrl || [])[0];
    return pattern ? siteDomain(pattern) : `card:${card.id}`;
}

/** "https://*.americanexpress.com/*" and "https://global.americanexpress.com/*" → "americanexpress.com". */
export function siteDomain(pattern) {
    const host = String(pattern).replace(/^[a-z*]+:\/\//i, "").split("/")[0];
    const [name, port] = host.split(":");
    return name.split(".").filter((p) => p && p !== "*").slice(-2).join(".") + (port ? `:${port}` : "");
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
    const key = siteKeyFor;
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

// Sites that keep the selected card in the page address ("?account_key=…" on Amex) let each card
// have its own tabs, so several cards can be worked on at once.
// Only parameters known to pick the card on their own: an "accountId" may just be remembered by
// the site's session, and two cards' tabs would then fight over it.
const ACCOUNT_PARAM = /^(account_key|accountkey)$/i;

/** The card-selecting parameter in a URL ({ param, value }), or null. */
export function accountParam(url) {
    try {
        for (const [k, v] of new URL(url).searchParams) if (ACCOUNT_PARAM.test(k) && v && v.length <= 128) return { param: k, value: v };
    } catch { /* not a URL */ }
    return null;
}

/** The URL with the card's parameter set (same site only), or the URL as it is. */
export function withAccount(url, account) {
    if (!url || !account?.param) return url;
    try {
        const u = new URL(url);
        if (account.host && u.hostname.split(".").slice(-2).join(".") !== account.host) return url;
        u.searchParams.set(account.param, account.value);
        return u.href;
    } catch {
        return url;
    }
}

/** The card's key from the page's own links (Amex puts account_key on every link), or null. */
export async function accountOnPage(tabId) {
    try {
        const [r] = await chrome.scripting.executeScript({ target: { tabId }, args: [ACCOUNT_PARAM.source], func: (src) => {
            const rx = new RegExp(src, "i");
            const counts = new Map();
            for (const a of document.querySelectorAll("a[href]")) {
                try {
                    const u = new URL(a.href, location.href);
                    if (u.hostname.split(".").slice(-2).join(".") !== location.hostname.split(".").slice(-2).join(".")) continue;
                    for (const [k, v] of u.searchParams) if (rx.test(k) && v) { const key = `${k}=${v}`; counts.set(key, (counts.get(key) || 0) + 1); }
                } catch { /* bad link */ }
            }
            // One key on the page: the card it shows. Several (a list of cards): don't guess.
            return counts.size === 1 ? [...counts.keys()][0] : null;
        } });
        if (!r?.result) return null;
        const [param, ...rest] = r.result.split("=");
        return { param, value: rest.join("=") };
    } catch {
        return null;
    }
}
