import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cleanOverrides, issuerForUrl, resolvePortal, urlMatches } from "../lib/portals.js";

const portals = JSON.parse(readFileSync(new URL("../portals.json", import.meta.url)));

test("glob patterns", () => {
    assert.ok(urlMatches("https://*.chase.com/*", "https://secure.chase.com/web/auth/dashboard"));
    assert.ok(!urlMatches("https://*.chase.com/*", "https://evil.com/?q=chase.com/"));
    assert.ok(!urlMatches(null, "https://x.com"));
});

test("issuer presets, card presets first in the selector list", () => {
    const p = resolvePortal({ id: "c1", issuer: "Chase", cardKey: "chase-sapphire-preferred" }, {}, portals);
    assert.equal(p.source, "card");
    assert.ok(p.loginUrl.startsWith("https://secure.chase.com"));
    assert.ok(p.selector.startsWith(portals.cards["chase-sapphire-preferred"].selector));
    assert.ok(p.selector.endsWith(portals.issuers.Chase.selector));
    assert.equal(resolvePortal({ id: "c2", issuer: "Nobody Bank" }, {}, portals), null);
});

test("a saved pick wins and keeps a page to open", () => {
    const overrides = { c1: { matchUrl: "https://x.chase.com/*", selector: "#pts", source: "user-picker" } };
    const p = resolvePortal({ id: "c1", issuer: "Chase" }, overrides, portals);
    assert.equal(p.selector, "#pts");
    assert.equal(p.loginUrl, portals.issuers.Chase.loginUrl);
});

test("portal lookup and override clean-up", () => {
    assert.equal(issuerForUrl("https://global.americanexpress.com/rewards", portals), "American Express");
    assert.equal(issuerForUrl("https://example.com", portals), null);
    assert.deepEqual(Object.keys(cleanOverrides({ a: { selector: "#x" }, b: { source: "auto-learned", selector: "#y" }, c: null, d: {} })), ["a"]);
});
