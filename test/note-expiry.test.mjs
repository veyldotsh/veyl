import test from 'node:test';
import assert from 'node:assert/strict';
import { NoteExpiryGuard, NOTE_EXPIRY_POLICY } from '../src/note-expiry.mjs';
import { ZKAPI_MAINNET } from '../src/funding.mjs';

const now = 1790895600, address = '0x1111111111111111111111111111111111111111', blockHash = '0x' + 'a'.repeat(64);
function fixture({ remaining = 30 * 86400, state = 1, phase = 'ready', stale = false, chain = 1, changed = false, reorg = false, missing = false } = {}) {
  let reads = 0; const calls = [];
  const funding = { inspectOperation: async kind => { calls.push(kind); return { kind: 'withdrawal', chainId: 1, phase, address, noteId: changed && ++reads > 1 ? 8 : 7 }; } };
  const client = { getChainId: async () => chain, getBlock: async args => ({ number: 26100547n, hash: reorg && args.blockNumber ? '0x' + 'b'.repeat(64) : blockHash, timestamp: BigInt(now - (stale ? 3601 : 800)) }),
    readContract: async args => { assert.equal(args.address, ZKAPI_MAINNET.vault); assert.equal(args.functionName, 'notes'); assert.equal(args.blockNumber, 26100547n); assert.deepEqual(args.args, [7]); if (missing) throw new Error('RPC unavailable'); return ['0x' + 'c'.repeat(64), 1_000_000n, BigInt(now + remaining), state]; } };
  return { guard: new NoteExpiryGuard({ funding, client, now: () => now * 1000 }), calls };
}

test('expiry guard binds authenticated note to pinned vault at canonical finalized block', async () => {
  const { guard, calls } = fixture(), report = await guard.assertCanInfer();
  assert.equal(report.status, 'healthy'); assert.equal(report.expiresAt, now + 30 * 86400); assert.equal(report.stopNewCallsAt, report.expiresAt - NOTE_EXPIRY_POLICY.stopSeconds);
  assert.equal(report.blockHash, blockHash); assert.deepEqual(calls, ['withdrawal', 'withdrawal']);
  assert.equal(report.noteState, 'active'); assert.equal(report.fundingAddress, address);
});
test('seven-day warning permits calls but three-day boundary and expired note block before model I/O', async () => {
  assert.equal((await fixture({ remaining: 7 * 86400 }).guard.assertCanInfer()).status, 'warning');
  for (const remaining of [3 * 86400, 1, 0, -1]) {
    let paidCalls = 0; const { guard } = fixture({ remaining });
    await assert.rejects(async () => { await guard.assertCanInfer(); paidCalls++; }, error => error.code === 'ZKAPI_NOTE_EXPIRY_BLOCKED'); assert.equal(paidCalls, 0);
  }
  assert.equal((await fixture({ remaining: 0 }).guard.inspect()).status, 'expired');
});
test('unknown, stale, foreign-chain, changed-note and reorg states fail closed without cached allowance', async () => {
  for (const options of [{ stale: true }, { chain: 8453 }, { changed: true }, { reorg: true }, { missing: true }]) {
    const { guard } = fixture(options); assert.equal((await guard.inspect()).status, 'unknown');
    await assert.rejects(guard.assertCanInfer(), error => error.code === 'ZKAPI_NOTE_EXPIRY_UNKNOWN');
  }
});
test('unfunded, withdrawing, pending-withdrawal and closed notes cannot be used for inference', async () => {
  assert.equal((await fixture({ phase: 'no_note' }).guard.inspect()).status, 'no_note');
  for (const options of [{ phase: 'withdrawal_pending' }, { state: 0 }, { state: 2 }, { state: 3 }]) await assert.rejects(fixture(options).guard.assertCanInfer());
  assert.equal((await fixture({ phase: 'waiting_settlement' }).guard.assertCanInfer()).canInfer, true);
});
test('each paid boundary checks again as time crosses the stop deadline', async () => {
  const { guard } = fixture({ remaining: 3 * 86400 + 1 });
  assert.equal((await guard.assertCanInfer()).canInfer, true); guard.now = () => (now + 1) * 1000;
  await assert.rejects(guard.assertCanInfer(), error => error.code === 'ZKAPI_NOTE_EXPIRY_BLOCKED');
});

test('withdrawal-only expiry inspection permits an unsigned quote but never enables inference from it', async () => {
  for (const phase of ['quoted', 'waiting_funds']) {
    const { guard } = fixture({ phase });
    assert.equal((await guard.inspect()).status, 'blocked');
    const report = await guard.inspect({ forWithdrawal: true }); assert.equal(report.noteState, 'active'); assert.equal(report.canInfer, false); assert.equal(report.status, 'healthy');
    await assert.rejects(guard.assertCanInfer());
  }
  assert.equal((await fixture({ state: 2 }).guard.inspect({ forWithdrawal: true })).noteState, 'inactive');
});
