import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { expandOffersPage, offersPageScraper, addOffersToCard } from '../lib/inject/offers.js';
import { mergeOffers } from '../lib/worker/offers-sync.js';

const selector = '<div role="combobox" aria-label="Open to manage your other accounts">Blue Cash Everyday® ••••21000</div>';
const row = (merchant, badge, added = false, date = '12/31/26') => `<article><div><h3>${merchant}</h3>\n<span>${badge}</span>\n<p>Expires ${date}</p>\n<button data-testid="merchantOfferTermsLink">Terms apply</button></div><div><button data-testid="merchantOfferDetailsLink">View Details</button>${added ? '<span data-testid="merchantOfferSuccessIcon"></span>' : '<button title="add to list card" data-testid="merchantOfferListAddButton"></button>'}</div></article>`;
function page(html) {
    const { document, window } = parseHTML(`<html><body>${html}</body></html>`);
    window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 300, height: 40 });
    window.HTMLElement.prototype.scrollIntoView = () => {};
    const context = vm.createContext({ document, window, setTimeout: (fn) => { fn(); return 1; }, getComputedStyle: () => ({ overflowY: 'visible', visibility: 'visible' }) });
    return { document, run: (fn, ...args) => vm.runInContext(`(${fn.toString()})(${args.map(JSON.stringify).join(',')})`, context) };
}

test('Amex reads multi-button merchant rows and excludes loan, APR and referral ads', async () => {
    const p = page(selector + row('Outback Steakhouse', 'Earn 15% back on a single purchase, up to a total of $15') + row('Uniqlo', 'Spend $50 or more, earn $10 back', true) + '<article><h3>Earn $25 Reward Dollars</h3><p>Add an Additional Card Member</p><a>View Offer</a></article>');
    const offers = await p.run(offersPageScraper);
    assert.equal(offers.length, 2);
    assert.equal(offers[0].merchant, 'Outback Steakhouse');
    assert.equal(offers[0].discountType, 'pct_back');
    assert.equal(offers[0].discountValue, 15);
    assert.equal(offers[0].activated, false);
    assert.equal(offers[0].activationVerified, true);
    assert.equal(offers[1].discountValue, 1000);
    assert.equal(offers[1].minSpendCents, 5000);
    assert.equal(offers[1].activated, true);
    assert.match(offers[1].expiresAt, /^2026-12-31/);
});

test('Amex zero-offer page never imports credit or loan promotions', async () => {
    const p = page(selector + '<h2>No available offers</h2><article><h3>Earn $25 Reward Dollars</h3><p>Add an Additional Card Member</p></article>');
    assert.equal((await p.run(offersPageScraper)).length, 0);
});

test('Amex retains all enrolled rows and same-value offers with distinct expirations', async () => {
    const p = page(selector + Array.from({ length: 295 }, (_, i) => row(`Merchant ${i}`, 'Spend $100 or more, earn $20 back', true)).join('') + row('Merchant 0', 'Spend $100 or more, earn $20 back', true, '1/31/27'));
    const offers = await p.run(offersPageScraper, true);
    assert.equal(offers.length, 296);
    assert.ok(offers.every(o => o.activated && o.activationVerified));
});

test('Amex expansion does not navigate to the enrolled View All Offers link', async () => {
    const p = page(selector + '<a href="/offers/enrolled?opaqueAccountId=card-one"><button>View All Offers</button></a>' + row('Uniqlo', 'Spend $50 or more, earn $10 back'));
    let navigated = false;
    p.document.querySelector('a button').click = () => { navigated = true; };
    await p.run(expandOffersPage);
    assert.equal(navigated, false);
});

test('Amex activation requires issuer success icon and never clicks enrollment marketing', async () => {
    const p = page(selector + row('Uniqlo', 'Spend $50 or more, earn $10 back') + '<button>Enroll now</button>');
    let marketing = false;
    p.document.querySelector('body > button').click = () => { marketing = true; };
    p.document.querySelector('[data-testid="merchantOfferListAddButton"]').click = function () { this.outerHTML = '<span data-testid="merchantOfferSuccessIcon"></span>'; };
    const result = await p.run(addOffersToCard, 300);
    assert.equal(result.added, 1);
    assert.equal(result.remaining, 0);
    assert.equal(marketing, false);
});

test('Amex detached row or changed account cannot confirm activation', async () => {
    const p = page(selector + row('Uniqlo', 'Spend $50 or more, earn $10 back'));
    p.document.querySelector('[data-testid="merchantOfferListAddButton"]').click = function () { this.closest('article').remove(); };
    assert.equal((await p.run(addOffersToCard, 300)).added, 0);
    const q = page(selector + row('Uniqlo', 'Spend $50 or more, earn $10 back'));
    q.document.querySelector('[data-testid="merchantOfferListAddButton"]').click = function () { q.document.querySelector('[role="combobox"]').textContent = 'Gold ••••93008'; this.outerHTML = '<span data-testid="merchantOfferSuccessIcon"></span>'; };
    assert.equal((await q.run(addOffersToCard, 300)).added, 0);
});

test('verified unactivated offers stay unactivated when they disappear from a later read', () => {
    const offer = { merchant: 'Uniqlo', discountType: 'statement_credit', discountValue: 1000, activationVerified: true, activated: false };
    assert.equal(mergeOffers([offer], [], true)[0].activated, false);
    assert.equal(mergeOffers([offer], [{ ...offer, activated: true }], false)[0].activated, true);
});
