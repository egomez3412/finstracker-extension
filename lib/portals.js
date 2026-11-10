// Where each card's points live. Resolution order:
//   1. the user's picked balance spot (selector) for the card
//   2. the card preset in portals.json (by cardKey)
//   3. the loyalty program site for co-branded cards (lib/programs.js)
//   4. the issuer preset in portals.json (issuer names normalised: "Amex" → "American Express")
// A page saved for the card (set by the user, or learned from the last successful sync) is opened first.
import { PROGRAM_PORTALS, balanceHints, cardIssuer, programFor } from "./programs.js";

const globToRegex = (pattern) => new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");

/** "https://*.example.com/*" glob match; also takes a list of globs. */
export function urlMatches(pattern, url) {
    if (!pattern || !url) return false;
    return [].concat(pattern).some((p) => p && globToRegex(p).test(url));
}

/** "https://www.delta.com/x" → "https://www.delta.com/*" */
/**
 * A bank's sign-in page ("/en-us/account/login", "/signin", "/logon"). Opening one can end the
 * session you have (Amex signs you out when its login page loads), so it's only ever a last resort.
 */
export function isLoginPage(url) {
    try {
        const u = new URL(url);
        return /(^|[\/_.-])(log-?in|log-?on|sign-?in|signon|auth2?|sso)([\/_.-]|$)/i.test(u.pathname) || /log-?in|sign-?in/i.test(u.hash);
    } catch {
        return false;
    }
}

/** Where to open a card's site: its saved rewards page, the bank's rewards page, and only then its sign-in page. */
export function startPage(portal, saved = null) {
    const pages = [saved, portal?.pointsUrlHint, portal?.capturedUrl, portal?.loginUrl].filter(Boolean);
    return pages.find((u) => !isLoginPage(u)) || pages[0] || null;
}

export function originPattern(url) {
    try { return `${new URL(url).origin}/*`; } catch { return null; }
}

/** The portal settings for one card, or null when nothing is known about where its points live. */
export function resolvePortal(card, overrides, portals, pages = {}) {
    const issuers = portals?.issuers || {};
    const cards = portals?.cards || {};
    const override = overrides?.[card.id];
    const saved = pages?.[card.id]?.url || null;
    // The bank's settings, unless the card is linked to a page on another site (then that site's
    // own page and links are used, never the bank's).
    const linked = saved || override?.capturedUrl || null;
    const bankCfg = issuers[cardIssuer(card)] || issuers[card.issuer] || null;
    const issuerCfg = bankCfg && !(linked && !urlMatches(bankCfg.matchUrl, linked)) ? bankCfg : null;
    const cardCfg = card.cardKey ? cards[card.cardKey] || null : null;
    const programKey = programFor(card);
    const programCfg = programKey ? PROGRAM_PORTALS[programKey] : null;
    const base = programCfg || issuerCfg;
    const hints = balanceHints(card);

    const pointsUrlHint = cardCfg?.pointsUrlHint || base?.pointsUrlHint || null;
    const extraMatches = [saved, override?.capturedUrl].map(originPattern).filter(Boolean);

    if (override?.matchUrl && override?.selector) {
        return {
            matchUrl: [override.matchUrl, cardCfg?.matchUrl || base?.matchUrl, ...extraMatches].filter(Boolean),
            selector: override.selector,
            regex: override.regex || null,
            capturedUrl: override.capturedUrl || null,
            loginUrl: saved || override.capturedUrl || cardCfg?.loginUrl || base?.loginUrl || pointsUrlHint,
            pointsUrlHint: pointsUrlHint || override.capturedUrl || null,
            program: programKey,
            hints,
            source: override.source || "override",
        };
    }
    if (!cardCfg && !base && !saved) return null;
    return {
        matchUrl: [cardCfg?.matchUrl || base?.matchUrl, ...extraMatches].filter(Boolean),
        loginUrl: saved || cardCfg?.loginUrl || base?.loginUrl || pointsUrlHint,
        pointsUrlHint: pointsUrlHint || saved,
        // Card selectors first, then the issuer-wide fallbacks (programs rely on the scored scan).
        selector: [cardCfg?.selector, programCfg ? null : issuerCfg?.selector].filter(Boolean).join(", ") || null,
        regex: cardCfg?.regex || (programCfg ? null : issuerCfg?.regex) || null,
        program: programKey,
        hints,
        source: saved ? "saved-page" : cardCfg ? "card" : programCfg ? "program" : "issuer",
    };
}

const SECRET_PARAM = /token|code|session|sess|auth|sig|signature|state|nonce|key|ticket|saml|otp|password|pwd|jwt|csrf|xsrf/i;

/**
 * A page worth reopening next time. Keeps parameters that pick an account or view
 * (opaqueAccountId=…, accountId=…) and drops anything that could be a one-time token.
 */
export function pageToRemember(url) {
    try {
        const u = new URL(url);
        if (!/^https?:$/.test(u.protocol)) return null;
        const keep = new URLSearchParams();
        for (const [k, v] of u.searchParams) if (!SECRET_PARAM.test(k) && v.length <= 64) keep.append(k, v);
        const query = keep.toString();
        return `${u.origin}${u.pathname}${query ? `?${query}` : ""}${u.hash}`;
    } catch {
        return null;
    }
}

/**
 * Where to go when the balance is not on the page after sign-in: the card's points page first,
 * then links found on the page. Returns a URL to open, "links" to look for a link, or null.
 */
export function nextHop({ pointsUrlHint, tried = [], hops = 0 }, url, maxHops = 3) {
    if (hops >= maxHops) return null;
    const here = pageToRemember(url);
    if (pointsUrlHint && pageToRemember(pointsUrlHint) !== here && !tried.includes(pointsUrlHint)) return pointsUrlHint;
    return "links";
}

/** Cards whose points live on this URL's site. */
export function cardsForUrl(cards, url, overrides, portals, pages) {
    return (cards || []).filter((card) => {
        const portal = resolvePortal(card, overrides, portals, pages);
        return portal && urlMatches(portal.matchUrl, url);
    });
}

/** The issuer whose portal this URL belongs to, if any. */
export function issuerForUrl(url, portals) {
    const hit = Object.entries(portals?.issuers || {}).find(([, p]) => urlMatches(p.matchUrl, url));
    return hit ? hit[0] : null;
}

/** Drop saved picks that can no longer open a page (left by early builds). */
export function cleanOverrides(overrides) {
    const out = {};
    for (const [cardId, ov] of Object.entries(overrides || {})) {
        if (!ov || typeof ov !== "object" || !ov.selector) continue;
        if (ov.source === "auto-learned" && !ov.capturedUrl) continue;
        out[cardId] = ov;
    }
    return out;
}

let cache = null;
/** portals.json, read once per service-worker life. */
export async function loadPortals() {
    if (!cache) cache = await (await fetch(chrome.runtime.getURL("portals.json"))).json();
    return cache;
}
