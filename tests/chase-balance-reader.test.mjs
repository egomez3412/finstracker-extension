import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';

function chaseReader(balance) {
    const { window } = parseHTML('<html><body><section><h2>Sapphire Preferred (...0947)</h2><p>Current balance $68.98</p></section><mds-tile id="rewards-multi-navigation-tile-TileId"></mds-tile><section><span data-pt-name="rewardsPromo">Earn up to 100K</span><p>Refer friends to either Chase Sapphire card and earn up to 100,000 bonus points per year.</p></section></body></html>');
    const tile = window.document.querySelector('mds-tile').attachShadow({ mode: 'open' });
    tile.innerHTML = '<mds-list id="rewards-multi-navigation-tile-TileListId"></mds-list>';
    const list = tile.querySelector('mds-list').attachShadow({ mode: 'open' });
    list.innerHTML = `<ul><li><div class="list-item__text--primary"><label class="list-item__label list-item__label--titleMediumHeavier">${balance}</label><label>Ultimate Rewards® points</label></div></li></ul>`;
    delete window.__finsReader;
    window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 300, height: 40, top: 20 });
    const context = vm.createContext({ window, Element: window.Element, document: window.document, getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', fontSize: '24px', fontWeight: '600' }) });
    vm.runInContext(readFileSync(new URL('../content/reader.js', import.meta.url), 'utf8'), context);
    return window.__finsReader;
}

test('Chase reads the selected rewards widget through nested shadow roots, including confirmed zero', () => {
    const portals = JSON.parse(readFileSync(new URL('../portals.json', import.meta.url)));
    for (const balance of ['40,000', '0']) {
        const reader = chaseReader(balance);
        for (const key of ['chase-sapphire-preferred', 'chase-sapphire-reserve']) {
            const result = reader.extract(portals.cards[key].selector, null, 'points', { keywords: ['ultimate rewards'], cardWords: ['sapphire'] });
            assert.equal(result.text, balance);
            assert.equal(result.via, 'selector');
        }
    }
});

test('Chase referral and welcome advertisements never become a rewards balance', () => {
    const reader = chaseReader('40,000');
    for (const selector of [null, '[data-pt-name*="reward"]']) {
        const result = reader.extract(selector, null, 'points', { keywords: ['ultimate rewards'], cardWords: ['sapphire'] });
        assert.ok(result, 'the actual rewards balance remains available');
        assert.match(result.text, /40,000/);
        assert.doesNotMatch(result.text, /100K/);
    }
});

test('a Chase read-only selected account remains a strong card match below the navigation', () => {
    const { window, document } = parseHTML('<html><body><div data-testid="account-selector-readonly"><span>Sapphire Preferred...0947</span></div><p>Sapphire Preferred</p></body></html>');
    window.scrollY = 0;
    delete window.__finsReader;
    window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 300, height: 40, top: 380 });
    const context = vm.createContext({ window, Element: window.Element, document, scrollY: 0, getComputedStyle: () => ({ visibility: 'visible' }) });
    vm.runInContext(readFileSync(new URL('../content/reader.js', import.meta.url), 'utf8'), context);
    const result = window.__finsReader.detectCard([{ id: 'actual', words: ['0947'] }, { id: 'other', words: ['4087'] }, { id: 'duplicate', words: ['sapphire', 'preferred'] }]);
    assert.equal(result.id, 'actual');
    assert.equal(result.strong, true);
});

test('Chase benefits identify the ending in the shadow navigation and ignore extension widgets', () => {
    const { window, document } = parseHTML('<html><body><mds-navigation-bar></mds-navigation-bar><div id="fins-launcher-root"></div></body></html>');
    document.querySelector('mds-navigation-bar').attachShadow({ mode: 'open' }).innerHTML = '<span role="heading" aria-level="1">Benefits (...0947)</span>';
    document.querySelector('#fins-launcher-root').attachShadow({ mode: 'open' }).innerHTML = '<span role="heading" aria-level="1">Sapphire Preferred (...4087)</span>';
    delete window.__finsReader;
    window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 300, height: 40, top: 350 });
    const ctx = vm.createContext({ window, document, scrollY: 0 });
    vm.runInContext(readFileSync(new URL('../content/reader.js', import.meta.url), 'utf8'), ctx);
    const result = window.__finsReader.detectCard([{ id: 'current', words: ['0947'] }, { id: 'other', words: ['4087'] }]);
    assert.equal(result.id, 'current');
    assert.equal(result.strong, true);
});
