import test from "node:test";
import assert from "node:assert/strict";
import { isCheckoutUrl, offerMatchesSite, shoppingContext, siteFor } from "../lib/merchants.js";

test("known sites, including subdomains and the most specific entry", () => {
    assert.deepEqual(siteFor("https://www.amazon.com/dp/B01"), { name: "Amazon", category: "online", domain: "amazon.com" });
    assert.equal(siteFor("https://smile.amazon.com/").domain, "amazon.com");
    assert.equal(siteFor("https://tv.apple.com/show").category, "streaming");
    assert.equal(siteFor("https://www.apple.com/shop").category, "online");
    assert.equal(siteFor("https://www.doordash.com/store/1").category, "dining");
    assert.equal(siteFor("https://travel.chase.com/").category, "travel");
    assert.equal(siteFor("https://secure.chase.com/"), null);
    assert.equal(siteFor("chrome://extensions"), null);
});

test("checkout pages, and unknown shops only at checkout", () => {
    assert.ok(isCheckoutUrl("https://shop.example.com/checkout/payment"));
    assert.ok(isCheckoutUrl("https://www.target.com/cart"));
    assert.ok(!isCheckoutUrl("https://www.target.com/p/cartoon-mug"));
    assert.equal(shoppingContext("https://example.com/blog"), null);
    assert.deepEqual(shoppingContext("https://shop.example.com/checkout"), { name: "shop.example.com", category: "online", domain: "shop.example.com", checkout: true, guessed: true });
    assert.equal(shoppingContext("https://www.bestbuy.com/site/tv").checkout, false);
});

test("offers match the site by link or name", () => {
    const bestBuy = siteFor("https://www.bestbuy.com/");
    assert.ok(offerMatchesSite({ merchant: "Best Buy" }, bestBuy));
    assert.ok(offerMatchesSite({ merchant: "BestBuy.com" }, bestBuy));
    assert.ok(offerMatchesSite({ merchant: "Electronics", merchantUrl: "https://www.bestbuy.com/deals" }, bestBuy));
    assert.ok(!offerMatchesSite({ merchant: "Best Western" }, bestBuy));
    assert.ok(!offerMatchesSite({ merchant: "Go" }, bestBuy));
});
