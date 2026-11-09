import test from "node:test";
import assert from "node:assert/strict";
import { daysUntil, dueLabel, nextFeeDate, openCredits, openOffers, summary, upcomingFees } from "../lib/benefits.js";

const today = "2026-11-08";

test("fee dates roll to next year once the month has passed", () => {
    assert.equal(nextFeeDate({ annualFee: 95, feeAnniversaryMonth: 12 }, today), "2026-12-01");
    assert.equal(nextFeeDate({ annualFee: 95, feeAnniversaryMonth: 3 }, today), "2027-03-01");
    assert.equal(nextFeeDate({ annualFee: 95, feeAnniversaryMonth: 11, feeAnniversaryDay: 20 }, today), "2026-11-20");
    assert.equal(nextFeeDate({ annualFee: 0, feeAnniversaryMonth: 12 }, today), null);
    assert.equal(nextFeeDate({ annualFee: 95 }, today), null);
});

test("open credits and offers, soonest first", () => {
    const perks = [
        { id: "a", used: false, deadline: "2026-12-31T23:59:59.999Z", valueCents: 1000 },
        { id: "b", used: true, deadline: "2026-11-30T23:59:59.999Z", valueCents: 500 },
        { id: "c", used: false, deadline: "2026-11-30T23:59:59.999Z", valueCents: 1500 },
        { id: "d", used: false, deadline: "2026-11-01T23:59:59.999Z", valueCents: 700 },
        { id: "e", used: false, deadline: null, valueCents: 200 },
    ];
    assert.deepEqual(openCredits(perks, today).map((p) => p.id), ["c", "a", "e"]);
    assert.deepEqual(openOffers([{ id: "x", expiresAt: "2026-11-09T00:00:00Z" }, { id: "y", used: true }, { id: "z", expiresAt: "2026-10-01T00:00:00Z" }], today).map((o) => o.id), ["x"]);
});

test("summary tiles", () => {
    const s = summary({
        today,
        cards: [{ id: "1", displayName: "Gold", annualFee: 325, feeAnniversaryMonth: 12 }, { id: "2", annualFee: 95, feeAnniversaryMonth: 6 }],
        perks: [{ used: false, deadline: "2026-11-30", valueCents: 1000 }, { used: false, deadline: "2027-06-30", valueCents: 5000 }],
        offers: [{ used: false, expiresAt: "2026-12-01", valueCents: 2500 }],
    });
    assert.equal(s.creditsValue, 60);
    assert.equal(s.creditsCount, 2);
    assert.equal(s.expiringCredits, 1);
    assert.equal(s.offersCount, 1);
    assert.equal(s.feesDue, 325);
    assert.equal(s.nextFee.card.displayName, "Gold");
    assert.equal(upcomingFees([{ annualFee: 95, feeAnniversaryMonth: 6 }], today, 60).length, 0);
});

test("due labels", () => {
    assert.equal(daysUntil("2026-11-10T23:59:59Z", today), 2);
    assert.equal(dueLabel("2026-11-08", today), "Today");
    assert.equal(dueLabel("2026-11-09", today), "Tomorrow");
    assert.equal(dueLabel("2026-11-15", today), "in 7 days");
    assert.equal(dueLabel("2027-01-04", today), "Jan 4");
    assert.equal(dueLabel(null, today), "No end date");
    assert.equal(dueLabel("2026-11-01", today), "Expired");
});
