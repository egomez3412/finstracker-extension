import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { balanceHints, normalizeIssuer, programFor } from "../lib/programs.js";
import { cardsForUrl, nextHop, pageToRemember, resolvePortal, urlMatches } from "../lib/portals.js";

const portals = JSON.parse(readFileSync(new URL("../portals.json", import.meta.url)));

test("issuer spellings", () => {
    assert.equal(normalizeIssuer("Amex"), "American Express");
    assert.equal(normalizeIssuer("Citibank"), "Citi");
    assert.equal(normalizeIssuer("BofA"), "Bank of America");
    assert.equal(normalizeIssuer("US Bank"), "U.S. Bank");
    assert.equal(normalizeIssuer("Barclaycard"), "Barclays");
    assert.equal(normalizeIssuer("Credit Union"), "Credit Union");
});

test("co-branded cards belong to their program; bank currencies stay at the bank", () => {
    assert.equal(programFor({ displayName: "Delta SkyMiles Gold", issuer: "American Express" }), "delta");
    assert.equal(programFor({ displayName: "United Explorer", issuer: "Chase" }), "united");
    assert.equal(programFor({ displayName: "Boundless", program: "Marriott Bonvoy" }), "marriott");
    assert.equal(programFor({ cardKey: "alaska-mileage-plan-visa", displayName: "Alaska Visa" }), "alaska");
    assert.equal(programFor({ displayName: "Sapphire Preferred", program: "Chase Ultimate Rewards" }), null);
    assert.equal(programFor({ displayName: "Venture X", program: "Capital One Miles" }), null);
    assert.equal(programFor({ displayName: "Gold Card", issuer: "Amex" }), null);
});

test("balance hints: program words and card name words, no generic words", () => {
    const h = balanceHints({ displayName: "Delta SkyMiles Gold", issuer: "Amex" });
    assert.ok(h.keywords.includes("skymiles"));
    assert.ok(!h.keywords.includes("points") && !h.keywords.includes("miles"));
    assert.ok(h.cardWords.includes("delta") && h.cardWords.includes("gold"));
    assert.ok(balanceHints({ displayName: "Sapphire Preferred", issuer: "Chase" }).keywords.includes("ultimate rewards"));
    assert.deepEqual(balanceHints({ displayName: "Sapphire Preferred", issuer: "Chase" }).cardWords, ["sapphire"]);
});

test("co-branded cards open the program site, not the bank", () => {
    const p = resolvePortal({ id: "d", displayName: "Delta SkyMiles Gold", issuer: "American Express" }, {}, portals);
    assert.equal(p.source, "program");
    assert.ok(p.loginUrl.startsWith("https://www.delta.com"));
    assert.ok(urlMatches(p.matchUrl, "https://www.delta.com/myprofile"));
    assert.ok(!urlMatches(p.matchUrl, "https://global.americanexpress.com/rewards"));
    assert.equal(p.selector, null);
});

test("issuer aliases reach the issuer preset", () => {
    const p = resolvePortal({ id: "a", displayName: "Gold", issuer: "Amex" }, {}, portals);
    assert.equal(p.source, "issuer");
    assert.ok(urlMatches(p.matchUrl, "https://global.americanexpress.com/rewards"));
});

test("a saved rewards page opens first and widens the match", () => {
    const pages = { c: { url: "https://rewards.example-bank.com/summary", source: "user" } };
    const p = resolvePortal({ id: "c", displayName: "Local Card", issuer: "Example Bank" }, {}, portals, pages);
    assert.equal(p.loginUrl, "https://rewards.example-bank.com/summary");
    assert.ok(urlMatches(p.matchUrl, "https://rewards.example-bank.com/other"));
    assert.equal(resolvePortal({ id: "x", displayName: "Local Card", issuer: "Example Bank" }, {}, portals), null);
});

test("pages to remember drop the query string but keep hash routes", () => {
    assert.equal(pageToRemember("https://secure.chase.com/web/auth/dashboard?token=abc#/dashboard/ultimateRewards"), "https://secure.chase.com/web/auth/dashboard#/dashboard/ultimateRewards");
    assert.equal(pageToRemember("chrome://extensions"), null);
});

test("hops: points page first, then links, then stop", () => {
    const hint = "https://global.americanexpress.com/rewards";
    assert.equal(nextHop({ pointsUrlHint: hint }, "https://global.americanexpress.com/dashboard"), hint);
    assert.equal(nextHop({ pointsUrlHint: hint, tried: [hint], hops: 1 }, "https://global.americanexpress.com/dashboard"), "links");
    assert.equal(nextHop({ pointsUrlHint: hint }, hint), "links");
    assert.equal(nextHop({ pointsUrlHint: hint, hops: 3 }, "https://x.com"), null);
});

test("cards for a page", () => {
    const cards = [
        { id: "1", displayName: "Delta SkyMiles Gold", issuer: "American Express" },
        { id: "2", displayName: "Gold", issuer: "American Express" },
        { id: "3", displayName: "Sapphire Preferred", issuer: "Chase" },
    ];
    assert.deepEqual(cardsForUrl(cards, "https://www.delta.com/myprofile/skymiles-overview", {}, portals).map((c) => c.id), ["1"]);
    assert.deepEqual(cardsForUrl(cards, "https://global.americanexpress.com/rewards", {}, portals).map((c) => c.id), ["2"]);
});
