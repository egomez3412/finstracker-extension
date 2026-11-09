import test from "node:test";
import assert from "node:assert/strict";
import { activityKey, freshActivity, matchBenefits, titleWords } from "../lib/benefit-match.js";

const today = "2026-11-09";
const perks = [
    { id: "u-nov", title: "Uber Cash · Nov", deadline: "2026-11-30T23:59:59.999Z", used: false },
    { id: "u-dec", title: "Uber Cash · Dec", deadline: "2026-12-31T23:59:59.999Z", used: false },
    { id: "de", title: "Digital Entertainment Credit · Nov", deadline: "2026-11-30T23:59:59.999Z", used: false },
    { id: "saks", title: "Saks Fifth Avenue credit · H2", deadline: "2026-12-31T23:59:59.999Z", used: true },
    { id: "old", title: "Uber Cash · Oct", deadline: "2026-10-31T23:59:59.999Z", used: false },
];

test("benefit titles reduce to their distinctive words", () => {
    assert.deepEqual(titleWords("Uber Cash · Nov"), ["uber"]);
    assert.deepEqual(titleWords("$20 Digital Entertainment Credit"), ["digital", "entertainment"]);
});

test("fully used benefits mark the current period's credit", () => {
    const marks = matchBenefits(perks, [
        { title: "Uber Cash", fullyUsed: true },
        { title: "Digital Entertainment Credit", fullyUsed: false },
        { title: "Saks Fifth Avenue", fullyUsed: true },
        { title: "Walmart+ membership", fullyUsed: true },
    ], today);
    assert.deepEqual(marks.map((m) => m.perk.id), ["u-nov"]); // not December's, not October's (expired), Saks already used
});

test("activity: the first read is a baseline, later reads return only new lines", () => {
    const rows = [{ date: "Nov 3", description: "Uber Eats", amount: 1200 }, { date: "Nov 1", description: "Transfer to Delta", amount: -5000 }];
    const first = freshActivity(rows, undefined);
    assert.equal(first.baseline, true);
    assert.deepEqual(first.fresh, []);
    const next = freshActivity([{ date: "Nov 8", description: "Grocery bonus", amount: 400 }, ...rows], first.keys);
    assert.deepEqual(next.fresh.map((r) => r.description), ["Grocery bonus"]);
    assert.equal(next.keys.length, 3);
    assert.equal(activityKey({ date: "Nov  8", description: "Grocery  Bonus", amount: 400 }), "nov 8|grocery bonus|400");
});

test("benefit report says what happened to each benefit", async () => {
    const { benefitReport } = await import("../lib/benefit-match.js");
    const benefits = [
        { title: "Uber Cash", used: 15, total: 15, fullyUsed: true },
        { title: "Digital Entertainment Credit", used: 5, total: 20, fullyUsed: false },
        { title: "Saks Fifth Avenue Credit", used: 50, total: 50, fullyUsed: true },
        { title: "Walmart+ Credit", remaining: 0, fullyUsed: true },
    ];
    const marks = [{ benefit: benefits[0], perk: { id: "u", title: "Uber Cash · Nov" } }];
    const rows = benefitReport(benefits, marks, [{ title: "Saks Fifth Avenue credit · H2", used: true }]);
    assert.deepEqual(rows, [
        ["Uber Cash", "$15 of $15 · marked used in Finstracker"],
        ["Digital Entertainment Credit", "$5 of $20 · not fully used yet"],
        ["Saks Fifth Avenue Credit", "$50 of $50 · already marked used"],
        ["Walmart+ Credit", "$0 left · no matching credit in Finstracker"],
    ]);
});
