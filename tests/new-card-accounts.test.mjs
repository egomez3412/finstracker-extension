import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Tracker } from '../lib/api.js';
import { addSiteCards, scanSiteCards } from '../lib/worker/new-cards.js';

test('adding a second account preserves the first and repeated Add clicks create only one card', async t => {
    const before = { chrome: globalThis.chrome, fetch: globalThis.fetch, listCards: Tracker.listCards, createCard: Tracker.createCard };
    t.after(() => { globalThis.chrome = before.chrome; globalThis.fetch = before.fetch; Tracker.listCards = before.listCards; Tracker.createCard = before.createCard; });
    const stored = { token: 'local-test', apiBase: 'http://localhost', cardLast4: {}, ignoredSiteCards: {} };
    globalThis.chrome = {
        runtime: { getURL: path => `http://extension.test/${path}` },
        storage: { local: { get: async () => structuredClone(stored), set: async patch => Object.assign(stored, structuredClone(patch)) } },
        scripting: { executeScript: async details => details.args?.[0] === 'listSiteCards' ? [{ result: [{ text: 'The Platinum Card •••• 1004' }, { text: 'The Platinum Card •••• 2004' }] }] : [{ result: false }] },
    };
    globalThis.fetch = async () => ({ json: async () => JSON.parse(readFileSync(new URL('../portals.json', import.meta.url))) });
    const first = { id: 'first', displayName: 'Amex Platinum', issuer: 'American Express', last4: '1004', currentPoints: 50000 };
    const cards = [first];
    Tracker.listCards = async () => structuredClone(cards);
    let creates = 0;
    Tracker.createCard = async (_base, _token, body) => {
        creates++;
        assert.equal(body.last4, '2004');
        assert.equal(body.rewardsAccount, '', 'a new account does not inherit the first rewards pool');
        assert.match(body.displayName, /2004/);
        const card = { id: 'second', ...body };
        cards.push(card);
        return card;
    };
    const url = 'https://global.americanexpress.com/dashboard';
    const discovery = await scanSiteCards(1, url, cards);
    assert.deepEqual(discovery.matched, { first: '1004' });
    assert.equal(discovery.fresh.length, 1);
    await Promise.all([addSiteCards(1, url, ['2004']), addSiteCards(1, url, ['2004'])]);
    assert.equal(creates, 1);
    assert.equal(first.currentPoints, 50000);
    assert.equal(stored.cardLast4.second, '2004');
    assert.deepEqual(await scanSiteCards(1, url, cards), { fresh: [], matched: { first: '1004', second: '2004' } });
});
