// Where each card's points live. Resolution order:
//   1. the user's picked balance spot (selector) for the card
//   2. the card preset in portals.json (by cardKey)
//   3. the loyalty program site for co-branded cards (lib/programs.js)
//   4. the issuer preset in portals.json (issuer names normalised: "Amex" → "American Express")
// A page saved for the card (set by the user, or learned from the last successful sync) is opened first.
import { PROGRAM_PORTALS, balanceHints, normalizeIssuer, programFor } from "./programs.js";

const globToRegex = (pattern) => new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");

/** "https://*.example.com/*" glob match; also takes a list of globs. */
export function urlMatches(pattern, url) {
    if (!pattern || !url) return false;
    return [].concat(pattern).some((p) => p && globToRegex(p).test(url));
}

/** "https://www.delta.com/x" → "https://www.delta.com/*" */
export function originPattern(url) {
    try { return `${new URL(url).origin}/*`; } catch { return null; }
}

/** The portal settings for one card, or null when nothing is known about where its points live. */
export function resolvePortal(card, overrides, portals, pages = {}) {
    const issuers = portals?.issuers || {};
    const cards = portals?.cards || {};
    const issuerCfg = issuers[normalizeIssuer(card.issuer)] || issuers[card.issuer] || null;
    const cardCfg = card.cardKey ? cards[card.cardKey] || null : null;
    const programKey = programFor(card);
    const programCfg = programKey ? PROGRAM_PORTALS[programKey] : null;
    const base = programCfg || issuerCfg;
    const override = overrides?.[card.id];
    const saved = pages?.[card.id]?.url || null;
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

/** A page worth reopening next time: drops the query string (it can carry one-time tokens). */
export function pageToRemember(url) {
    try {
        const u = new URL(url);
        if (!/^https?:$/.test(u.protocol)) return null;
        return `${u.origin}${u.pathname}${u.hash}`;
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
