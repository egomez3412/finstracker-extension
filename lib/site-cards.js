// Cards a bank's site lists ("The Platinum Card® •••• 1004") compared with the user's Finstracker
// cards: which ones are already there, and which are new (to offer to add).
import { CARD_CATALOG } from "./card-catalog.js";
import { cardIssuer, normalizeIssuer } from "./programs.js";

// Masked card numbers: "(...1004)", "•••• 1004", "••••61007", "ending in 1004", "x1004" (not phone numbers or dates).
// Amex shows five digits ("••••61007"); the last four are kept either way.
const MASK = /\(?\s*(?:\.{2,}|[•*·∙●]+|(?<![a-z])x{1,4}|(?:account |card )?ending(?: in)?)\s*(\d{4,5})\b\s*\)?/i;
// Accounts a bank's switcher lists next to its cards ("Rewards Checking", "High Yield Savings Acct").
const NOT_A_CARD = /\b(checking|savings?|money market|certificate of deposit|cds?|loans?|mortgage|brokerage|investment|ira|401\s?k|hsa|line of credit|overview|personal loan|auto loan|merchant)\b|\bacct\b/i;
// Words that name the bank, the network or the product type, not the card.
const FILLER = new Set(["the", "card", "cards", "credit", "visa", "mastercard", "signature", "infinite", "world", "elite", "from", "by", "my",
    "amex", "american", "express", "chase", "citi", "citibank", "capital", "one", "bank", "of", "america", "u", "s", "us", "wells", "fargo", "barclays", "barclaycard", "account"]);
// Words that make a different card ("Business Platinum" is not "Platinum").
const TIER = new Set(["business", "reserve", "preferred", "everyday", "plus", "gold", "platinum", "green", "blue", "delta", "skymiles", "hilton", "honors",
    "marriott", "bonvoy", "ink", "unlimited", "flex", "x", "miles", "premier", "custom", "double", "aspire", "surpass", "brilliant", "bevy", "boundless",
    "venture", "savor", "quicksilver", "freedom", "sapphire", "active", "altitude", "go", "reserve", "rose", "corporate", "cash", "it", "travel", "customized"]);

/** "The Platinum Card® (...1004) ▾" → { name: "The Platinum Card", last4: "1004" }; null when it isn't a card. */
export function cleanSiteCardName(text) {
    const raw = String(text || "").replace(/\s+/g, " ").trim();
    if (!raw || raw.length > 90) return null;
    const m = raw.match(MASK);
    if (!m) return null;
    const name = raw.replace(MASK, " ").replace(/[®™℠▾▼⌄›»]/g, " ").replace(/\b(card )?ending in\b/i, " ").replace(/\s+/g, " ").replace(/^[\s,–—:-]+|[\s,–—:(-]+$/g, "").trim();
    if (name.length < 3 || !/[a-z]/i.test(name) || /\d{3,}|\$|%/.test(name)) return null; // a phone number, date or amount
    if (NOT_A_CARD.test(name)) return null; // a bank account the switcher lists with the cards
    return { name, last4: m[1].slice(-4) };
}

/** The words that tell a card apart: "Amex Gold Card" → ["gold"]. */
export function cardWords(name) {
    return [...new Set(String(name || "").replace(/\([^)]*\)/g, " ").toLowerCase().replace(/[®™℠]/g, " ").split(/[^a-z0-9]+/).filter((w) => w && !FILLER.has(w)))];
}

/** How well two card names agree: 0 = same card, 1 = one extra plain word, Infinity = different cards. */
function distance(a, b) {
    const A = new Set(a), B = new Set(b);
    if (!A.size || !B.size) return Infinity;
    const onlyA = a.filter((w) => !B.has(w)), onlyB = b.filter((w) => !A.has(w));
    if (onlyA.length && onlyB.length) return Infinity; // each has a word the other lacks
    const extra = [...onlyA, ...onlyB];
    if (extra.length > 1 || extra.some((w) => TIER.has(w) || /^\d+$/.test(w))) return Infinity;
    return extra.length;
}

/**
 * The user's card for a card on the site, or null. last4s: { [cardId]: "1004" } remembered from
 * earlier matches (a number is the surest sign).
 */
export function matchUserCard(siteCard, userCards, last4s = {}) {
    if (!siteCard) return null;
    const issuer = normalizeIssuer(siteCard.issuer || '');
    const eligible = (userCards || []).filter(c => !issuer || !cardIssuer(c) || cardIssuer(c) === issuer);
    const ending = c => c.last4 || last4s[c.id];
    const byNumber = eligible.filter((c) => siteCard.last4 && ending(c) === siteCard.last4);
    if (byNumber.length) return byNumber.length === 1 ? byNumber[0] : null;
    const words = cardWords(siteCard.name);
    let best = null, bestD = Infinity, tied = false;
    for (const c of eligible) {
        if (ending(c) && siteCard.last4 && ending(c) !== siteCard.last4) continue; // a known card with another number
        const d = distance(words, cardWords(c.displayName));
        if (d < bestD) { best = c; bestD = d; tied = false; }
        else if (Number.isFinite(d) && d === bestD) tied = true;
    }
    return tied ? null : best;
}

/** The dashboard catalog entry for a card on the site, or null. */
export function catalogFor(name, issuer = "") {
    const words = cardWords(name);
    const hits = CARD_CATALOG.filter((c) => (!issuer || c.issuer === issuer) && distance(words, cardWords(c.name)) === 0);
    return hits.length === 1 ? hits[0] : null;
}

/** Cash back or points, from the catalog or the name. */
export function rewardTypeFor(name, entry = null) {
    if (entry) return entry.rewardType;
    return /cash ?back|blue cash|\bcash\b|everyday|double cash|custom cash|active cash|quicksilver|savor|discover it/i.test(name || "") ? "cashback" : "points";
}

/**
 * Cards listed on the site that aren't in Finstracker yet, ready to add:
 * [{ name, last4, issuer, rewardType, cardKey }]. Also returns which user card each listed card is.
 * issuerSure: the site is a known bank's, so every card on it is that bank's; otherwise the bank is a
 * guess and the card's catalog entry or well-known name says better.
 */
export function newSiteCards(siteCards, userCards, { issuer = "", issuerSure = true, last4s = {}, ignored = [] } = {}) {
    const matched = {};
    const fresh = [];
    const seen = new Set();
    for (const sc of siteCards || []) {
        const key = sc.last4 || sc.name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const entry = catalogFor(sc.name, issuerSure ? issuer : "") || catalogFor(sc.name);
        const bank = entry?.issuer || cardIssuer({ displayName: sc.name }) || issuer;
        const scoped = { ...sc, issuer: bank };
        const mine = matchUserCard(scoped, userCards, last4s);
        if (mine && sc.last4 && (mine.last4 || last4s[mine.id]) === sc.last4) { matched[mine.id] = sc.last4; continue; }
        // A network-only label cannot identify a product. An ambiguous existing product
        // also needs a confirmed ending rather than creating a duplicate wallet card.
        if (!cardWords(sc.name).length) continue;
        // A product name is not an account identity. Offer an explicit separate-card
        // choice when an old entry has no ending, rather than learning two accounts onto it.
        const requiresConfirmation = (userCards || []).some(c => matchUserCard(scoped, [c], last4s));
        if (ignored.includes(key)) continue;
        fresh.push({ name: entry ? entry.name : sc.name, siteName: sc.name, last4: sc.last4 || "", issuer: bank, rewardType: rewardTypeFor(sc.name, entry), cardKey: entry?.key || null, key, requiresConfirmation });
    }
    return { fresh, matched };
}
