// Credits, offers and annual fees, summarised for the side panel.

const DAY = 864e5;
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dayOf = (iso) => (iso ? String(iso).slice(0, 10) : "");

/** Whole days from today to an ISO date (negative when past). Infinity when there is no date. */
export function daysUntil(iso, today) {
    const d = dayOf(iso);
    if (!d) return Infinity;
    return Math.round((new Date(`${d}T12:00:00`) - new Date(`${today}T12:00:00`)) / DAY);
}

/** Next annual fee date for a card (the first of its fee month), or null. */
export function nextFeeDate(card, today) {
    const month = Number(card?.feeAnniversaryMonth);
    if (!(Number(card?.annualFee) > 0) || !(month >= 1 && month <= 12)) return null;
    const [y, m, d] = today.split("-").map(Number);
    const day = Math.min(Math.max(Number(card.feeAnniversaryDay) || 1, 1), 28);
    const thisYear = month > m || (month === m && day >= d);
    return ymd(new Date(thisYear ? y : y + 1, month - 1, day));
}

/** Unused credits that have not expired, soonest first. */
export function openCredits(perks, today) {
    return (perks || [])
        .filter((p) => !p.used && (!p.deadline || dayOf(p.deadline) >= today))
        .sort((a, b) => (dayOf(a.deadline) || "9999").localeCompare(dayOf(b.deadline) || "9999"));
}

/** Offers still usable, soonest expiry first. */
export function openOffers(offers, today) {
    return (offers || [])
        .filter((o) => !o.used && (!o.expiresAt || dayOf(o.expiresAt) >= today))
        .sort((a, b) => (dayOf(a.expiresAt) || "9999").localeCompare(dayOf(b.expiresAt) || "9999"));
}

/** Annual fees coming up, soonest first: [{ card, date, days, amount }]. */
export function upcomingFees(cards, today, withinDays = 365) {
    return (cards || [])
        .map((card) => {
            const date = nextFeeDate(card, today);
            return date ? { card, date, days: daysUntil(date, today), amount: Number(card.annualFee) } : null;
        })
        .filter((f) => f && f.days <= withinDays)
        .sort((a, b) => a.days - b.days);
}

/** Headline numbers for the panel's summary tiles. */
export function summary({ cards = [], perks = [], offers = [], today }) {
    const credits = openCredits(perks, today);
    const usable = openOffers(offers, today);
    const fees = upcomingFees(cards, today, 60);
    return {
        creditsValue: credits.reduce((s, p) => s + (Number(p.valueCents) || 0), 0) / 100,
        creditsCount: credits.length,
        expiringCredits: credits.filter((p) => daysUntil(p.deadline, today) <= 30).length,
        offersCount: usable.length,
        offersValue: usable.reduce((s, o) => s + (Number(o.valueCents) || 0), 0) / 100,
        feesDue: fees.reduce((s, f) => s + f.amount, 0),
        nextFee: fees[0] || null,
    };
}

/** "Today", "Tomorrow", "in 5 days", "Mar 4". */
export function dueLabel(iso, today) {
    const days = daysUntil(iso, today);
    if (days === Infinity) return "No end date";
    if (days < 0) return "Expired";
    if (days === 0) return "Today";
    if (days === 1) return "Tomorrow";
    if (days <= 14) return `in ${days} days`;
    return new Date(`${dayOf(iso)}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export const localToday = (now = new Date()) => ymd(now);
