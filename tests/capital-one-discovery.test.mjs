import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { cleanSiteCardName } from '../lib/site-cards.js';

function reader(markup, setup = () => {}) {
    const { window } = parseHTML(`<html><body>${markup}</body></html>`);
    setup(window.document);
    delete window.__finsReader;
    window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 300, height: 40, top: 20 });
    const context = vm.createContext({ window, document: window.document, Element: window.Element, getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) });
    vm.runInContext(readFileSync(new URL('../content/reader.js', import.meta.url), 'utf8'), context);
    return window.__finsReader;
}

test('Capital One account tiles retain the product name instead of a shorter bare ending', async () => {
    const page = reader('<a role="link"><h2>Venture</h2><span>...4509</span><span>ending in ...4509</span></a>');
    const rows = await page.listSiteCards();
    assert.equal(rows.length, 1);
    assert.deepEqual(cleanSiteCardName(rows[0].text), { name: 'Venture', last4: '4509' });
});

test('Capital One headers use the card image name and support nested open components', async () => {
    const page = reader('<c1-header></c1-header>', document => {
        const root = document.querySelector('c1-header').attachShadow({ mode: 'open' });
        root.innerHTML = '<div class="account-header"><img alt="Venture"><div><span>…4509</span></div></div><button>Get Your Virtual Card ...4509</button><p>You still have account setup tasks left to do for your Venture...4509.</p><table><tr><td>Daisy M. ...4509</td></tr><tr><td>Someone Else ...3333</td></tr></table>';
    });
    const rows = await page.listSiteCards();
    assert.equal(rows.length, 1, 'virtual cards, setup messages and transaction cardholders are excluded');
    assert.deepEqual(cleanSiteCardName(rows[0].text), { name: 'Venture', last4: '4509' });
});

test('transaction names and extension widgets never become discovered cards', async () => {
    const page = reader('<section id="transaction-history"><span>Fake Venture ...2222</span></section><div id="fins-status-root"><div>Another Venture ...3333</div></div>');
    assert.equal((await page.listSiteCards()).length, 0);
});
