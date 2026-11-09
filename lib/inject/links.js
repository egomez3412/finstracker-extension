// Runs inside a signed-in issuer or loyalty page (see extractor.js). Finds the link that leads to
// the rewards balance ("Ultimate Rewards", "SkyMiles", "View rewards") when the balance is not on
// the current page. Follows links on the same site only. Returns { href } or { clicked: true } or null.
export function findRewardsLink(hintWords, avoid) {
    const HINTS = (hintWords || []).map((w) => String(w).toLowerCase()).filter((w) => w.length >= 3);
    const AVOID = new Set(avoid || []);
    const GOOD = [
        [/\b(ultimate rewards|membership rewards|thankyou|rapid rewards|skymiles|mileageplus|aadvantage|bonvoy|honors|trueblue|aeroplan|avios|mileage plan)\b/, 10],
        [/\b(rewards? (summary|balance|center|dashboard|home|activity|account)|my rewards|view (my )?rewards|see rewards|points (summary|balance|activity)|miles (summary|balance|activity)|my (points|miles)|account (summary|overview))\b/, 8],
        [/\brewards?\b/, 6],
        [/\b(points|miles|cash ?back)\b/, 4],
        [/\bredeem\b/, 2],
    ];
    const BAD = /\b(apply|learn more|terms|faq|help|support|sign ?out|log ?out|offers?|deals|shop|transfer partners|refer|earn more|credit score|privacy|careers|español)\b/;

    function visible(el) {
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return false;
        const cs = getComputedStyle(el);
        return cs.visibility !== "hidden" && cs.display !== "none";
    }
    let best = null;
    for (const el of document.querySelectorAll("a[href], [role='link'], [role='tab'], button, [role='menuitem']")) {
        if (!visible(el)) continue;
        const text = `${el.innerText || el.textContent || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}`.toLowerCase().replace(/\s+/g, " ").trim();
        if (!text || text.length > 80) continue;
        let score = 0;
        for (const [rx, points] of GOOD) if (rx.test(text)) { score += points; break; }
        if (HINTS.some((h) => text.includes(h))) score += 6;
        if (BAD.test(text)) score -= 10;
        let href = null;
        if (el.tagName === "A") {
            try {
                const u = new URL(el.getAttribute("href"), location.href);
                if (!/^https?:$/.test(u.protocol)) continue;
                // Stay on the same site (sub-domains allowed: secure.chase.com → chase.com).
                const site = (h) => h.split(".").slice(-2).join(".");
                if (site(u.hostname) !== site(location.hostname)) continue;
                href = u.href;
                if (/rewards?|points|miles|loyalty/i.test(u.pathname + u.hash)) score += 3;
            } catch { continue; }
            if (AVOID.has(href) || href === location.href) continue;
        }
        if (score > (best?.score || 0)) best = { el, href, score };
    }
    if (!best || best.score < 8) return null;
    if (best.href) return { href: best.href, score: best.score };
    try { best.el.click(); return { clicked: true, score: best.score }; } catch { return null; }
}
