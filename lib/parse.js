// Numbers read off issuer pages, and the transaction that brings Finstracker in line with them.

const SPACES = /[    ]/g;

/** First number in a piece of page text ("94,308 pts" → 94308, "$45.10" → 45.1). */
export function parseNumber(text) {
    if (text === null || text === undefined) return null;
    const match = String(text).replace(SPACES, " ").match(/-?\d[\d,]*(?:\.\d+)?/);
    if (!match) return null;
    const n = Number(match[0].replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
}

/**
 * What to post so the card's balance matches the portal.
 * Points are whole numbers; cash back is dollars rounded to cents.
 */
export function balanceChange(card, scraped) {
    const unit = card.rewardType === "cashback" ? "cashback" : "points";
    const current = unit === "points" ? Number(card.currentPoints) || 0 : Number(card.currentCashBack) || 0;
    const target = unit === "points" ? Math.round(scraped) : Math.round(scraped * 100) / 100;
    const delta = unit === "points" ? target - current : Math.round((target - current) * 100) / 100;
    if (delta === 0) return { unit, current, target, delta: 0, type: null };
    return { unit, current, target, delta, type: delta > 0 ? "earn" : "redeem", amount: Math.abs(delta) };
}
