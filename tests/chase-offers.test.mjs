import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { expandOffersPage, offersPageScraper, addOffersToCard } from '../lib/inject/offers.js';

function page(html) {
    const { document, window } = parseHTML(`<html><body>${html}</body></html>`);
    const context = vm.createContext({ document, window, setTimeout: (fn) => { fn(); return 1; }, getComputedStyle: () => ({ overflowY: 'scroll' }) });
    return { document, run: (fn, arg) => vm.runInContext(`(${fn.toString()})(${JSON.stringify(arg) || ''})`, context) };
}
const tile = (id, merchant, status = 'Add Offer') => `<a id="${id}" data-testid="commerce-tile" aria-label="${merchant} 5% cash back ${status}"><div>${merchant}</div><div>5% cash back</div></a>`;

test('Chase expands all scrolling batches without opening a featured collection', async () => {
    const p = page(`<button>See more offers</button>${tile('one', 'Mint Indian Restaurant')}`);
    let navigated = false;
    p.document.querySelector('button').click = () => { navigated = true; };
    Object.defineProperty(p.document.documentElement, 'scrollTop', { set(y) {
        if (y > 0 && p.document.querySelectorAll('[data-testid="commerce-tile"]').length < 5) p.document.body.insertAdjacentHTML('beforeend', tile(`offer${Math.random()}`, 'Turo'));
    } });
    Object.defineProperty(p.document.documentElement, 'scrollHeight', { get: () => 5000 });
    await p.run(expandOffersPage);
    assert.equal(navigated, false);
    assert.equal(p.document.querySelectorAll('[data-testid="commerce-tile"]').length, 5);
});

test('Chase stores actual merchants and the accessible activation marker', () => {
    const p = page(`<h1>Chase Offers</h1><p>Get cash back</p>${tile('one', 'Mint Indian Restaurant', 'Success Added')}${tile('two', 'Turo')}`);
    const offers = p.run(offersPageScraper);
    assert.equal(offers.length, 2);
    assert.equal(offers[0].merchant, 'Mint Indian Restaurant');
    assert.equal(offers[0].activated, true);
    assert.equal(offers[1].merchant, 'Turo');
    assert.equal(offers[1].activated, false);
});

test('Chase activation verifies details and preserves spend and expiration before returning to hub', async () => {
    const p = page(`<p>Sapphire Preferred...0947</p>${tile('one', 'Turo')}`);
    p.document.getElementById('one').click = () => {
        p.document.body.innerHTML = '<main><h1>About this deal</h1><h2>Turo</h2><h2>Success</h2><h2>Added to card</h2><h3>Offer details</h3><p>Earn $30 cash back</p><h3>$30 cash back</h3><p>Spend $150 or more</p><p>Expires on November 30, 2026</p><p>Pay with Sapphire Preferred (...0947)</p><h3>Disclaimer</h3><button>Back</button></main>';
        p.document.querySelector('button').click = () => { p.document.body.innerHTML = `<p>Sapphire Preferred...0947</p>${tile('one', 'Turo', 'Success Added')}`; };
    };
    const result = await p.run(addOffersToCard, 300);
    assert.equal(result.added, 1);
    assert.equal(result.remaining, 0);
    assert.equal(result.offers[0].activated, true);
    assert.equal(result.offers[0].minSpendCents, 15000);
    assert.equal(result.offers[0].discountValue, 3000);
    assert.match(result.offers[0].expiresAt, /^2026-11-30/);
    assert.ok(p.document.querySelector('[data-testid="commerce-tile"]'));
});

test('Chase never activates a tile without a visible selected account', async () => {
    const p = page(tile('one', 'Turo'));
    let clicked = false;
    p.document.getElementById('one').click = () => { clicked = true; };
    const result = await p.run(addOffersToCard, 300);
    assert.equal(clicked, false);
    assert.equal(result.added, 0);
    assert.equal(result.remaining, 1);
});
