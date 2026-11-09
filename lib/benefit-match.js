// Matching what an issuer's benefits page says ("Uber Cash · $10 of $10 used") to the card's
// credits in Finstracker, and the activity lines on a rewards page to entries already recorded.

const STOP = new Set(["credit", "credits", "card", "cards", "benefit", "benefits", "statement", "annual", "annually", "monthly", "quarterly", "semi", "year", "yearly", "month", "the", "and", "for", "your", "with", "back", "membership", "plus", "per", "each", "up", "to", "of", "in", "on", "cash"]);
const baseTitle = (t) => String(t || "").split(" · ")[0];

/** Significant words of a benefit or credit title ("Uber Cash · Nov" → ["uber"]). */
export function titleWords(title) {
    return baseTitle(title).toLowerCase().replace(/[^a-z0-9+ ]/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w));
}

const day = (iso) => (iso ? String(iso).slice(0, 10) : "");

/**
 * Credits to mark used: for each fully used benefit, the card's open credit with the most words in
 * common (the current period's, i.e. the soonest deadline). Each credit is matched at most once.
 * perks: classic /api/perks rows for the card. Returns [{ perk, benefit }].
 */
export function matchBenefits(perks, benefits, today) {
    const open = (perks || []).filter((p) => !p.used && (!p.deadline || day(p.deadline) >= today))
        .sort((a, b) => (day(a.deadline) || "9999").localeCompare(day(b.deadline) || "9999"));
    const taken = new Set();
    const out = [];
    for (const benefit of benefits || []) {
        if (!benefit.fullyUsed) continue;
        const words = titleWords(benefit.title);
        if (!words.length) continue;
        let best = null, bestScore = 0;
        for (const perk of open) {
            if (taken.has(perk.id)) continue;
            const pw = titleWords(perk.title);
            const score = pw.filter((w) => words.includes(w)).length;
            if (score > bestScore) { best = perk; bestScore = score; }
        }
        if (best) { taken.add(best.id); out.push({ perk: best, benefit }); }
    }
    return out;
}

/** A stable key for one activity line. */
export const activityKey = (row) => `${String(row.date).toLowerCase().replace(/\s+/g, " ")}|${String(row.description).toLowerCase().replace(/\s+/g, " ").slice(0, 60)}|${row.amount}`;

/**
 * New activity since the last read. The first read of a card (seen === undefined) only records
 * what is there, so entries already in the balance are not counted twice.
 * Returns { fresh: rows to record, keys: every key to remember }.
 */
export function freshActivity(rows, seen) {
    const keys = (rows || []).map(activityKey);
    if (!Array.isArray(seen)) return { fresh: [], keys, baseline: true };
    const known = new Set(seen);
    const fresh = (rows || []).filter((row, i) => !known.has(keys[i]));
    return { fresh, keys: [...new Set([...seen, ...keys])].slice(-500), baseline: false };
}
