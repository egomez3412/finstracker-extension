import test from 'node:test';
import assert from 'node:assert/strict';
import { Tracker } from '../lib/api.js';
import { syncCardBalance } from '../lib/worker/capture.js';

test('confirmed snapshots save unchanged and zero balances without inventing earned activity', async t => {
  const originalChrome = globalThis.chrome;
  const originals = { getCard: Tracker.getCard, updateCard: Tracker.updateCard, postTransaction: Tracker.postTransaction };
  t.after(() => { Object.assign(Tracker, originals); globalThis.chrome = originalChrome; });
  globalThis.chrome = { storage: { local: { get: async () => ({ token: 'local-test-only', apiBase: 'http://localhost' }), set: async () => {} } } };
  let saved;
  Tracker.postTransaction = async () => assert.fail('a confirmed balance is not earned activity');
  Tracker.updateCard = async (_base, _token, id, body) => { saved = { id, body }; };
  for (const [rewardType, current, next, unknown, field] of [
    ['points', 0, 63684, true, 'currentPoints'],
    ['points', 0, 0, true, 'currentPoints'],
    ['points', 3811, 3811, false, 'currentPoints'],
    ['cashback', 14.42, 14.42, true, 'currentCashBack'],
    ['cashback', 14.42, 0, false, 'currentCashBack'],
  ]) {
    Tracker.getCard = async () => ({ id: 'card', rewardType, currentPoints: current, currentCashBack: current, balanceUnknown: unknown });
    const result = await syncCardBalance({ id: 'card' }, next);
    assert.equal(result.ok, true);
    assert.deepEqual(saved, { id: 'card', body: { [field]: next } });
    if (unknown) assert.equal(result.noop, false, 'an unknown balance is confirmed even if its number is unchanged');
  }
  Tracker.updateCard = async () => { throw Error('Saving failed'); };
  assert.equal((await syncCardBalance({ id: 'card' }, 1)).ok, false, 'failed saves never report success');
});
