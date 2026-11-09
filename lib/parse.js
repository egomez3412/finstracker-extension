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

// Text that is never a rewards balance: legal lines, phone numbers, years and dates.
const LEGAL = /©|\(c\)\s*\d{4}|copyright|all rights reserved|member fdic|equal housing|nmls|terms (and|&) conditions|privacy (policy|statement)/i;
const PHONE = /\b1[-.\s]?\d{3}[-.\s]\d{3}[-.\s]\d{4}\b|\(\d{3}\)\s*\d{3}[-.\s]\d{4}|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/;
const MONTH_DATE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+(19|20)\d{2}\b|\b\d{1,2}[/.-]\d{1,2}[/.-](19|20)?\d{2}\b|\b(19|20)\d{2}-\d{2}-\d{2}\b/i;
const SINCE = /\b(since|member since|established|est\.?|founded|as of|updated|in)\s+(19|20)\d{2}\b/i;

/**
 * Why a number read from a page can't be a balance, or null when it can. text: the text it came from.
 * A year on its own ("© 2026", "2026") is rejected; "2,026 points" is a balance.
 */
export function noiseReason(text, value) {
    const t = String(text || "").replace(SPACES, " ");
    if (LEGAL.test(t)) return "copyright or legal text";
    if (PHONE.test(t)) return "a phone number";
    if (MONTH_DATE.test(t) || SINCE.test(t)) return "a date";
    const raw = (t.match(/-?\d[\d,]*(?:\.\d+)?/) || [""])[0];
    const yearLike = /^(19[5-9]\d|20\d{2})$/.test(raw) && Number(value ?? raw) === Number(raw);
    if (yearLike && !/\b(pts?|points?|miles?|reward dollars|cash ?back)\b/i.test(t)) return "a year";
    return null;
}
