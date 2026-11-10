import { test } from "node:test";
import assert from "node:assert/strict";
import { catalogFor, cleanSiteCardName, matchUserCard, newSiteCards } from "../lib/site-cards.js";

test("card names and numbers as banks show them", () => {
    assert.deepEqual(cleanSiteCardName("The Platinum Card® (...1004) ▾"), { name: "The Platinum Card", last4: "1004" });
    assert.deepEqual(cleanSiteCardName("Blue Cash Everyday® •••• 2001"), { name: "Blue Cash Everyday", last4: "2001" });
    assert.deepEqual(cleanSiteCardName("Sapphire Preferred ending in 9876"), { name: "Sapphire Preferred", last4: "9876" });
    assert.equal(cleanSiteCardName("Pay $1,004.00 by Nov 12"), null);
    assert.equal(cleanSiteCardName("Statements"), null);
    assert.equal(cleanSiteCardName("Call us at 1-800-528-4800"), null);
    assert.equal(cleanSiteCardName("Box 1004, Phoenix AZ"), null);
    assert.deepEqual(cleanSiteCardName("Hilton Honors Aspire Card x2008"), { name: "Hilton Honors Aspire Card", last4: "2008" });
});

const mine = [
    { id: "g", displayName: "Amex Gold Card" },
    { id: "p", displayName: "Amex Platinum Card" },
    { id: "b", displayName: "Blue Cash Everyday" },
    { id: "s", displayName: "Sapphire Preferred" },
];

test("cards already in Finstracker are recognised", () => {
    assert.equal(matchUserCard({ name: "The Platinum Card", last4: "1004" }, mine)?.id, "p");
    assert.equal(matchUserCard({ name: "Gold Card", last4: "3001" }, mine)?.id, "g");
    assert.equal(matchUserCard({ name: "Chase Sapphire Preferred", last4: "9876" }, mine)?.id, "s");
});

test("a different card with a shared word is not one of yours", () => {
    assert.equal(matchUserCard({ name: "Delta SkyMiles Gold Card", last4: "3004" }, mine), null);
    assert.equal(matchUserCard({ name: "Business Platinum Card", last4: "2008" }, mine), null);
    assert.equal(matchUserCard({ name: "Blue Cash Preferred", last4: "1111" }, mine), null);
});

test("a remembered card number wins over the name", () => {
    assert.equal(matchUserCard({ name: "Gold Card", last4: "7777" }, mine, { g: "3001" }), null);
    assert.equal(matchUserCard({ name: "Platinum", last4: "1004" }, mine, { p: "1004" })?.id, "p");
});

test("new cards come with their catalog card when there is one", () => {
    assert.equal(catalogFor("The Platinum Card", "American Express")?.key, "amex-platinum");
    assert.equal(catalogFor("Hilton Honors Aspire Card", "American Express")?.key, "hilton-honors-aspire");
    const { fresh, matched } = newSiteCards([
        { name: "The Platinum Card", last4: "1004" },
        { name: "Blue Cash Preferred", last4: "1111" },
        { name: "Delta SkyMiles Gold Card", last4: "3004" },
        { name: "Delta SkyMiles Gold Card", last4: "3004" },
    ], mine, { issuer: "American Express" });
    assert.deepEqual(matched, { p: "1004" });
    assert.deepEqual(fresh.map((c) => [c.name, c.last4, c.rewardType, c.cardKey]), [
        ["Blue Cash Preferred", "1111", "cashback", "amex-blue-cash-preferred"],
        ["Delta SkyMiles Gold Card", "3004", "points", null],
    ]);
});

test("on a site whose bank is only a guess, the card's catalog entry decides", () => {
    const { fresh } = newSiteCards([{ name: "Freedom Unlimited", last4: "1234" }, { name: "Delta SkyMiles Gold Card", last4: "3004" }], mine, { issuer: "American Express", issuerSure: false });
    assert.deepEqual(fresh.map((c) => [c.name, c.issuer, c.rewardType, c.cardKey]), [
        ["Freedom Unlimited", "Chase", "cashback", "chase-freedom-unlimited"],
        ["Delta SkyMiles Gold Card", "American Express", "points", null],
    ]);
});

test("cards the user said aren't theirs stay hidden", () => {
    const { fresh } = newSiteCards([{ name: "Delta SkyMiles Gold Card", last4: "3004" }], mine, { ignored: ["3004"] });
    assert.equal(fresh.length, 0);
});

test("bank accounts in an Amex switcher are not cards", () => {
    assert.equal(cleanSiteCardName("American Express Rewards Checking ••••1234"), null);
    assert.equal(cleanSiteCardName("High Yield Savings Acct ••••5678"), null);
    assert.deepEqual(cleanSiteCardName("Corporate Card ••••91007"), { name: "Corporate Card", last4: "1007" });
    assert.deepEqual(cleanSiteCardName("American Express Gold Card ••••41002"), { name: "American Express Gold Card", last4: "1002" });
});
