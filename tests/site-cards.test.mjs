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

test('Capital One repeated accessible endings and Unicode ellipses identify one account', () => {
    assert.deepEqual(cleanSiteCardName('Venture...4509ending in ...4509'), { name: 'Venture', last4: '4509' });
    assert.deepEqual(cleanSiteCardName('Venture …4509'), { name: 'Venture', last4: '4509' });
    assert.equal(cleanSiteCardName('Venture ...4509 ending in ...2469'), null, 'conflicting accounts never merge');
    assert.equal(cleanSiteCardName('ending in ...4509'), null);
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
    ], mine, { issuer: "American Express", last4s: { p: '1004' } });
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
test('a nicknamed corporate card uses a confirmed ending instead of guessing an account',()=>{
 const user=[{id:'corp',displayName:'Amex Corporate (Deloitte)'}];
 const site=[{name:'Corporate Card',last4:'1001'}];
 assert.equal(newSiteCards(site,user,{issuer:'American Express'}).fresh[0].requiresConfirmation,true);
 const found=newSiteCards(site,user,{issuer:'American Express',last4s:{corp:'1001'}});
 assert.deepEqual(found.matched,{corp:'1001'});assert.equal(found.fresh.length,0);
});


test("generic FNBO Signature labels require a known card ending and never create products", () => {
    const user = [{ id: "universal", displayName: "Universal Studios card" }];
    const site = ["3648", "9747", "3238"].map(last4 => ({ name: "Signature", last4 }));
    assert.deepEqual(newSiteCards(site, user, { issuer: "FNBO" }), { fresh: [], matched: {} });
    assert.deepEqual(newSiteCards(site, user, { issuer: "FNBO", last4s: { universal: "9747" } }), { fresh: [], matched: { universal: "9747" } });
});

test("duplicate product names wait for confirmed endings instead of choosing the first card", () => {
    const user = [{ id: "one", displayName: "Sapphire Preferred" }, { id: "two", displayName: "Chase Sapphire Preferred" }];
    const site = { name: "Sapphire Preferred", last4: "4087" };
    assert.equal(matchUserCard(site, user), null);
    const discovery = newSiteCards([site], user, { issuer: "Chase" });
    assert.deepEqual(discovery.matched, {});
    assert.equal(discovery.fresh[0].requiresConfirmation, true);
    assert.equal(matchUserCard(site, user, { one: "4087" })?.id, "one");
    assert.equal(matchUserCard(site, user, { one: "4087", two: "4087" }), null);
});

test('same product on different accounts stays separate and repeated scans match saved endings', () => {
    const site = [{ name: 'The Platinum Card', last4: '1004' }, { name: 'The Platinum Card', last4: '2004' }];
    const legacy = [{ id: 'one', displayName: 'Amex Platinum', issuer: 'American Express' }];
    const uncertain = newSiteCards(site, legacy, { issuer: 'American Express' });
    assert.deepEqual(uncertain.matched, {});
    assert.deepEqual(uncertain.fresh.map(c => [c.last4, c.requiresConfirmation]), [['1004', true], ['2004', true]]);
    const known = [{ ...legacy[0], last4: '1004' }];
    const first = newSiteCards(site, known, { issuer: 'American Express' });
    assert.deepEqual(first.matched, { one: '1004' });
    assert.deepEqual(first.fresh.map(c => [c.last4, c.requiresConfirmation]), [['2004', false]]);
    known.push({ id: 'two', displayName: 'Amex Platinum (•••• 2004)', issuer: 'American Express', last4: '2004' });
    assert.deepEqual(newSiteCards(site, known, { issuer: 'American Express' }), { fresh: [], matched: { one: '1004', two: '2004' } });
});

test('identical endings at different issuers never overwrite a known card', () => {
    const user = [{ id: 'chase', displayName: 'Sapphire Preferred', issuer: 'Chase', last4: '1004' }];
    assert.equal(matchUserCard({ name: 'The Platinum Card', issuer: 'American Express', last4: '1004' }, user), null);
    assert.equal(newSiteCards([{ name: 'The Platinum Card', last4: '1004' }], user, { issuer: 'American Express' }).fresh.length, 1);
});

test('Discover it Chrome discovered inside Capital One keeps cash-back units', () => {
    const { fresh } = newSiteCards([{ name: 'Discover it Chrome', last4: '9089' }], [], { issuer: 'Capital One' });
    assert.equal(fresh[0].rewardType, 'cashback');
    assert.equal(fresh[0].issuer, 'Discover');
});
