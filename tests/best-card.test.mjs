import test from "node:test";
import assert from "node:assert/strict";
import { badgeText, centsPerDollar, earnRate, rankCards, rateLabel } from "../lib/best-card.js";

const gold = { id: "g", displayName: "Gold", rewardType: "points", pointValueCents: 1.6, multipliers: { dining: 4, groceries: 4, other: 1 } };
const csp = { id: "s", displayName: "Sapphire", rewardType: "points", pointValueCents: 1.25, multipliers: { dining: 3, travel: 2, online: 1 } };
const cash = { id: "c", displayName: "Double Cash", rewardType: "cashback", multipliers: { other: 2 } };
const bare = { id: "b", displayName: "Bare" };

test("earn rate falls back to other, then 1", () => {
    assert.equal(earnRate(gold, "dining"), 4);
    assert.equal(earnRate(gold, "travel"), 1);
    assert.equal(earnRate(csp, "gas"), 1);
    assert.equal(earnRate(bare, "dining"), 1);
});

test("value per dollar uses point value; cash back is 1¢ per percent", () => {
    assert.equal(centsPerDollar(gold, "dining"), 6.4);
    assert.equal(centsPerDollar(cash, "online"), 2);
});

test("ranking by value, then rate", () => {
    assert.deepEqual(rankCards([csp, cash, gold, bare], "dining").map((r) => r.card.id), ["g", "s", "c", "b"]);
    assert.deepEqual(rankCards([csp, cash, gold], "online").map((r) => r.card.id), ["c", "g", "s"]);
});

test("labels", () => {
    assert.equal(rateLabel(gold, 4), "4×");
    assert.equal(rateLabel(cash, 1.5), "1.5%");
    assert.equal(badgeText(rankCards([gold], "dining")[0]), "4×");
    assert.equal(badgeText(null), "");
});
