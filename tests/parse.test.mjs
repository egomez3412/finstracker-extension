import test from "node:test";
import assert from "node:assert/strict";
import { balanceChange, parseNumber } from "../lib/parse.js";

test("reads numbers the way portals print them", () => {
    assert.equal(parseNumber("94,308 pts"), 94308);
    assert.equal(parseNumber("$45.10 cash back"), 45.1);
    assert.equal(parseNumber("12 345 miles"), 12);
    assert.equal(parseNumber("no digits"), null);
    assert.equal(parseNumber(null), null);
});

test("earn when the portal shows more, redeem when less, nothing when equal", () => {
    assert.deepEqual(balanceChange({ rewardType: "points", currentPoints: 92466 }, 94308.4), { unit: "points", current: 92466, target: 94308, delta: 1842, type: "earn", amount: 1842 });
    assert.equal(balanceChange({ rewardType: "points", currentPoints: 1000 }, 400).type, "redeem");
    assert.equal(balanceChange({ rewardType: "points", currentPoints: 1000 }, 1000).type, null);
});

test("cash back is compared in cents without float drift", () => {
    const c = balanceChange({ rewardType: "cashback", currentCashBack: 10.1 }, 10.3);
    assert.equal(c.delta, 0.2);
    assert.equal(c.amount, 0.2);
    assert.equal(c.unit, "cashback");
});

test("copyright years, dates and phone numbers are never balances", async () => {
    const { noiseReason } = await import("../lib/parse.js");
    assert.equal(noiseReason("© 2026 American Express. All rights reserved.", 2026), "copyright or legal text");
    assert.equal(noiseReason("Copyright 2026", 2026), "copyright or legal text");
    assert.equal(noiseReason("2026", 2026), "a year");
    assert.equal(noiseReason("Member since 2015", 2015), "a date");
    assert.equal(noiseReason("Statement closes Nov 8, 2026", 8), "a date");
    assert.equal(noiseReason("11/08/2026", 11), "a date");
    assert.equal(noiseReason("Call 1-800-528-4800", 1), "a phone number");
    assert.equal(noiseReason("2,026 points", 2026), null);
    assert.equal(noiseReason("2026 points", 2026), null);
    assert.equal(noiseReason("98,765", 98765), null);
    assert.equal(noiseReason("$123.45", 123.45), null);
});
