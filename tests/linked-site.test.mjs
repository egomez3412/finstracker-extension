import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePortal } from "../lib/portals.js";

const portals = { issuers: { Chase: { matchUrl: "https://*.chase.com/*", loginUrl: "https://secure.chase.com/", pointsUrlHint: "https://ultimaterewards.chase.com/", selector: ".ur-balance" } }, cards: {} };
const sapphire = { id: "c1", displayName: "Sapphire Preferred", issuer: "", program: "Chase Ultimate Rewards" };

test("a card's bank settings apply on the bank's own site", () => {
    const p = resolvePortal(sapphire, {}, portals, { c1: { url: "https://secure.chase.com/web/dashboard" } });
    assert.equal(p.selector, ".ur-balance");
    assert.equal(p.pointsUrlHint, "https://ultimaterewards.chase.com/");
});

test("a card linked to another site never goes to the bank's pages", () => {
    const p = resolvePortal(sapphire, {}, portals, { c1: { url: "http://localhost:3000/bank/dashboard" } });
    assert.equal(p.selector, null);
    assert.equal(p.pointsUrlHint, "http://localhost:3000/bank/dashboard");
    assert.ok(!p.matchUrl.some((m) => /chase/.test(m)));
});

test("a card with no saved page uses its bank (found from its program)", () => {
    const p = resolvePortal(sapphire, {}, portals, {});
    assert.equal(p.loginUrl, "https://secure.chase.com/");
});
