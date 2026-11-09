// Where each card's points live. Resolution order: the user's own pick → the card preset →
// the issuer preset. portals.json holds the presets.

/** Simple "https://*.example.com/*" glob match. */
export function urlMatches(pattern, url) {
    if (!pattern || !url) return false;
    const rx = new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
    return rx.test(url);
}

/** The portal settings for one card, or null when nothing is known about its issuer. */
export function resolvePortal(card, overrides, portals) {
    const issuers = portals?.issuers || {};
    const cards = portals?.cards || {};
    const issuerCfg = issuers[card.issuer] || null;
    const cardCfg = card.cardKey ? cards[card.cardKey] || null : null;
    const override = overrides?.[card.id];

    if (override?.matchUrl && override?.selector) {
        return {
            matchUrl: override.matchUrl,
            selector: override.selector,
            regex: override.regex || null,
            capturedUrl: override.capturedUrl || null,
            // Always keep somewhere to go on the next sync, preferring the page we know works.
            loginUrl: override.capturedUrl || cardCfg?.loginUrl || issuerCfg?.loginUrl || cardCfg?.pointsUrlHint || issuerCfg?.pointsUrlHint || null,
            pointsUrlHint: cardCfg?.pointsUrlHint || issuerCfg?.pointsUrlHint || override.capturedUrl || null,
            source: override.source || "override",
        };
    }
    if (!issuerCfg && !cardCfg) return null;
    return {
        matchUrl: cardCfg?.matchUrl || issuerCfg?.matchUrl || null,
        loginUrl: cardCfg?.loginUrl || issuerCfg?.loginUrl || null,
        pointsUrlHint: cardCfg?.pointsUrlHint || issuerCfg?.pointsUrlHint || null,
        // Card selectors first, then the issuer-wide fallbacks.
        selector: [cardCfg?.selector, issuerCfg?.selector].filter(Boolean).join(", ") || null,
        regex: cardCfg?.regex || issuerCfg?.regex || null,
        source: cardCfg ? "card" : "issuer",
    };
}

/** The issuer whose portal this URL belongs to, if any. */
export function issuerForUrl(url, portals) {
    const issuers = portals?.issuers || {};
    const hit = Object.entries(issuers).find(([, p]) => urlMatches(p.matchUrl, url));
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
