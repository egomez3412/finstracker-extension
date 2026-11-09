// Which card to pay with: earn rate × what a point is worth, from the rates saved on each card.

/** Points (or percent back) per dollar for a category; "other" is the fallback, then 1. */
export function earnRate(card, category) {
    const m = card?.multipliers || {};
    const rate = Number(m[category] ?? m.other);
    return Number.isFinite(rate) && rate > 0 ? rate : 1;
}

/** Cents earned per dollar spent. Cash back cards are worth 1¢ per percent. */
export function centsPerDollar(card, category) {
    const cpp = card?.rewardType === "cashback" ? 1 : Number(card?.pointValueCents) || 1;
    return Math.round(earnRate(card, category) * cpp * 100) / 100;
}

/** Cards ranked best first for this category. Ties go to the higher earn rate, then the name. */
export function rankCards(cards, category) {
    return (cards || [])
        .map((card) => ({ card, rate: earnRate(card, category), cents: centsPerDollar(card, category) }))
        .sort((a, b) => b.cents - a.cents || b.rate - a.rate || String(a.card.displayName).localeCompare(String(b.card.displayName)));
}

/** "4×" for points, "3%" for cash back. */
export function rateLabel(card, rate) {
    const n = Number.isInteger(rate) ? String(rate) : rate.toFixed(1).replace(/\.0$/, "");
    return card?.rewardType === "cashback" ? `${n}%` : `${n}×`;
}

/** The short text for the toolbar badge (four characters at most). */
export function badgeText(best) {
    if (!best) return "";
    const text = rateLabel(best.card, best.rate);
    return text.length <= 4 ? text : "";
}
