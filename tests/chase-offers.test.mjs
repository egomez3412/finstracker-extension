import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { expandOffersPage, offersPageScraper, addOffersToCard } from '../lib/inject/offers.js';

function page(html) {
    const { document, window } = parseHTML(`<html><body>${html}</body></html>`);
    window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 300, height: 40 });
    const delays = [];
    const context = vm.createContext({ document, window, setTimeout: (fn, ms) => { delays.push(ms); fn(); return 1; }, getComputedStyle: () => ({ overflowY: 'scroll' }) });
    return { document, delays, run: (fn, ...args) => vm.runInContext(`(${fn.toString()})(${args.map((arg) => JSON.stringify(arg)).join(',')})`, context) };
}
const tile = (id, merchant, status = 'Add Offer') => `<a id="${id}" data-testid="commerce-tile" aria-label="${merchant} 5% cash back ${status}"><div>${merchant}</div><div>5% cash back</div></a>`;

test('Chase expands all scrolling batches without opening a featured collection', async () => {
    const p = page(`<button>See more offers</button>${tile('one', 'Mint Indian Restaurant')}`);
    let navigated = false;
    let sentinelReady = true;
    p.document.querySelector('button').click = () => { navigated = true; };
    Object.defineProperty(p.document.documentElement, 'scrollTop', { set(y) {
        if (y === 0) sentinelReady = true;
        if (y > 0 && sentinelReady && p.document.querySelectorAll('[data-testid="commerce-tile"]').length < 5) {
            p.document.body.insertAdjacentHTML('beforeend', tile(`offer${p.document.querySelectorAll('[data-testid="commerce-tile"]').length}`, 'Turo'));
            sentinelReady = false;
        }
    } });
    Object.defineProperty(p.document.documentElement, 'scrollHeight', { get: () => 5000 });
    await p.run(expandOffersPage);
    assert.equal(navigated, false);
    assert.equal(p.document.querySelectorAll('[data-testid="commerce-tile"]').length, 5);
});

test('Chase stores actual merchants and the accessible activation marker', async () => {
    const p = page(`<h1>Chase Offers</h1><p>Get cash back</p>${tile('one', 'Mint Indian Restaurant', 'Success Added')}${tile('two', 'Turo')}`);
    const offers = await p.run(offersPageScraper);
    assert.equal(offers.length, 2);
    assert.equal(offers[0].merchant, 'Mint Indian Restaurant');
    assert.equal(offers[0].activated, true);
    assert.equal(offers[1].merchant, 'Turo');
    assert.equal(offers[1].activated, false);
});

test('Chase activation verifies details and preserves spend and expiration before returning to hub', async () => {
    const p = page(`<p>Sapphire Preferred...0947</p>${tile('one', 'Turo')}`);
    p.document.getElementById('one').click = () => {
        p.document.body.innerHTML = '<mds-navigation-bar></mds-navigation-bar><main><h2>Success</h2><h2>Added to card</h2><mds-heading></mds-heading><h3>Offer details</h3><p>Earn $30 cash back</p><p>Spend $150 or more</p><p>Expires on November 30, 2026</p><p>Pay with Sapphire Preferred (...0947)</p><h3>Disclaimer</h3></main>';
        const nav = p.document.querySelector('mds-navigation-bar').attachShadow({ mode: 'open' });
        nav.innerHTML = '<span role="heading" aria-level="1">About this deal</span><button aria-label="Back"><span>Back</span></button>';
        const heading = p.document.querySelector('mds-heading').attachShadow({ mode: 'open' });
        heading.innerHTML = '<h2 data-testid="merchant-name">Turo</h2><div role="heading" aria-level="3">$30 cash back</div>';
        nav.querySelector('button').click = () => { p.document.body.innerHTML = `<p>Sapphire Preferred...0947</p>${tile('one', 'Turo', 'Success Added')}`; };
    };
    const result = await p.run(addOffersToCard, 300);
    assert.equal(result.added, 1);
    assert.equal(result.remaining, 0);
    assert.equal(result.offers[0].activated, true);
    assert.equal(result.offers[0].minSpendCents, 15000);
    assert.equal(result.offers[0].discountValue, 3000);
    assert.match(result.offers[0].expiresAt, /^2026-11-30/);
    assert.ok(p.document.querySelector('[data-testid="commerce-tile"]'));
    assert.equal(p.delays.filter(ms => ms === 100).length, 0, 'the actual accessible heading resolves readiness immediately');
});

test('distinct issuer IDs keep matching merchant and discount offers separate', async () => {
    const p = page(tile('first', 'Turo') + tile('second', 'Turo'));
    const offers = await p.run(offersPageScraper);
    assert.equal(offers.length, 2);
    assert.equal(offers[0].activationVerified, true);
});

test('Chase keeps the YouTube Premium offer whose title and badge both mention a discount', async () => {
    const merchant = 'YouTube Premium: 50% off your first two subscription payments';
    const p = page(`<a id="youtube" data-testid="commerce-tile" aria-label="${merchant} 50% cash back Add Offer"><span class="titleTagVariant2Container">${merchant}</span><span class="subtitleTagVariant2Container">50% cash back</span><button>New offer details</button><button>Add Offer</button></a>`);
    const offers = await p.run(offersPageScraper);
    assert.equal(offers.length, 1);
    assert.equal(offers[0].merchant, merchant);
    assert.equal(offers[0].discountType, 'pct_back');
    assert.equal(offers[0].discountValue, 50);
});

test('issuer terms preserve comma-separated minimum spend and numeric expiration dates', async () => {
    const p = page('<article><h2>Example Merchant</h2><p>Spend $1,000 or more, earn $50 back</p><p>Expires 11/30/2026</p></article>');
    const offers = await p.run(offersPageScraper);
    assert.equal(offers.length, 1);
    assert.equal(offers[0].minSpendCents, 100000);
    assert.equal(new Date(offers[0].expiresAt).getFullYear(), 2026);
    assert.equal(new Date(offers[0].expiresAt).getMonth(), 10);
    assert.equal(new Date(offers[0].expiresAt).getDate(), 30);
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

test('Chase retains every offer while equal-size virtualized windows replace earlier tiles', async () => {
    const p = page(tile('one', 'Mint Indian Restaurant'));
    let position = 0;
    const scroller = p.document.documentElement;
    Object.defineProperties(scroller, {
        clientHeight: { get: () => 1000 }, scrollHeight: { get: () => 5000 },
        scrollTop: { get: () => position, set(y) {
            position = Math.min(4000, Math.max(0, y));
            const batch = Math.floor(position / 1000);
            p.document.body.innerHTML = tile(`offer-${batch}`, `Merchant ${batch}`);
        } },
    });
    const offers = await p.run(offersPageScraper, true);
    assert.equal(offers.length, 5);
    assert.deepEqual(Array.from(offers, (o) => o.issuerOfferId).sort(), ['offer-0', 'offer-1', 'offer-2', 'offer-3', 'offer-4']);
    assert.equal(scroller.scrollTop, 0);
});
