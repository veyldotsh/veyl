import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeAbiParameters, encodeEventTopics, decodeFunctionData } from 'viem';
import { TreasuryRunway, TREASURY_RUNWAY_ABI } from '../src/runway.mjs';
import { Problem } from '../src/agent.mjs';

const owner = '0x1111111111111111111111111111111111111111', treasury = '0x2222222222222222222222222222222222222222', daemon = '0x3333333333333333333333333333333333333333';
const TX = `0x${'a'.repeat(64)}`, BLOCK = `0x${'b'.repeat(64)}`, NOW = 1_800_000_000_000;
const policy = { projectId: 'project-1', owner, operator: owner, treasury, depositGwei: '1000000', lowWaterGwei: '1000', maxTopUpWei: '2000000000000000', dailyTopUpWei: '4000000000000000', automatic: true };
function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'veyl-runway-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'runway.json'); let intents = [], amount = '1120000000000000', allowed = false, paid = false, ownerResult = owner, chainId = 1, note = { phase: 'no_note', privateBalanceGwei: '0', address: daemon, noteId: 7 }, status = 'ready', sends = 0, lastRequest, receiptMutation, failSend = false, idle = true, expiryFee = false;
  const fundingCalls = [];
  const funding = {
    capabilities: () => ({ daemonOrigin: 'http://127.0.0.1:8787', approvalEnabled: true }),
    inspect: async () => ({ funding: { address: daemon, phase: status } }),
    snapshot: () => ({ persistence: 'healthy', intents, operations: [] }),
    quote: async ({ idempotencyKey, amountGwei }) => {
      const old = intents.find(i => i.idempotencyKey === idempotencyKey); if (old) return structuredClone(old);
      const item = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', idempotencyKey, address: daemon, amountGwei, approvalAttempted: false, status: 'quoted', quote: { id: 'q1', recommended_top_up_wei: amount, required_total_wei: '1012000000000000', balance_wei: '0' }, approvalDigest: 'reviewed' };
      intents.push(item); fundingCalls.push('quote'); return structuredClone(item);
    },
    refresh: async id => { fundingCalls.push('refresh'); const item = intents.find(i => i.id === id); item.quote.balance_wei = expiryFee ? '0' : '2000000000000000'; return structuredClone(item); },
    approve: async input => { fundingCalls.push('approve'); assert.equal(input.approvalDigest, 'reviewed'); const item = intents.find(i => i.id === input.intentId); item.status = 'pending'; item.approvalAttempted = true; item.transactionHash = TX; return structuredClone(item); },
    recover: async id => { fundingCalls.push('recover'); return structuredClone(intents.find(i => i.id === id)); },
    resume: async ({ intentId }) => { fundingCalls.push('resume'); const item = intents.find(i => i.id === intentId); item.status = 'active'; status = 'active'; return structuredClone(item); },
    inspectOperation: async () => note
  };
  funding.abandonUnsigned = async id => { const intent = intents.find(i => i.id === id); assert.equal(intent.approvalAttempted, false); assert.equal(intent.transactionHash, undefined); intent.status = 'abandoned'; return structuredClone(intent); };
  const client = {
    getChainId: async () => chainId,
    getBlock: async () => ({ number: 100n, hash: BLOCK, timestamp: BigInt(NOW / 1000) }),
    getBalance: async () => 10n ** 18n,
    getCode: async () => '0x6000',
    readContract: async ({ functionName }) => ({ owner: ownerResult, operator: owner, dailyLimit: 10n ** 18n, spentOnDay: 0n, allowedRecipient: allowed, paid })[functionName],
    call: async () => ({ data: '0x' }),
    getTransaction: async () => ({ from: owner, to: treasury, input: lastRequest.data, value: 0n }),
    getTransactionReceipt: async () => {
      const args = decodeFunctionData({ abi: TREASURY_RUNWAY_ABI, data: lastRequest.data }).args;
      const result = { transactionHash: TX, status: 'success', blockNumber: 99n, blockHash: BLOCK, logs: [{ address: treasury, topics: encodeEventTopics({ abi: TREASURY_RUNWAY_ABI, eventName: 'Expense', args: { id: args[0], recipient: args[1] } }), data: encodeAbiParameters([{ type: 'uint256' }], [args[2]]) }] };
      return receiptMutation ? receiptMutation(result) : result;
    }
  };
  const signer = { account: { address: owner }, sendTransaction: async request => {
    sends++; lastRequest = request;
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).refills[0].status, 'sending');
    if (failSend) throw new Error('lost signer response'); return TX;
  } };
  let expiry = { source: 'finalized-vault-with-authenticated-daemon-note', noteState: 'active', fundingAddress: daemon, checkedAt: NOW / 1000, expiresAt: NOW / 1000 + 30 * 86400, status: 'healthy' };
  const config = { file, funding, client, signer, enableAutomatic: true, isIdle: () => idle, inspectNote: async () => ({ noteId: note.noteId, ...expiry }), now: () => NOW, ...options };
  const runway = new TreasuryRunway(config);
  return { runway, funding, client, file, fundingCalls, config, restart: () => new TreasuryRunway(config), sends: () => sends,
    allow: () => { allowed = true; }, setChain: n => { chainId = n; }, setOwner: value => { ownerResult = value; }, setAmount: n => { amount = n; }, setPaid: value => { paid = value; },
    mutateReceipt: fn => { receiptMutation = fn; }, failSend: () => { failSend = true; }, setIdle: value => { idle = value; }, setNote: value => { note = { ...note, ...value }; }, setFeeMoved: () => { expiryFee = true; },
    setRequest: req => { lastRequest = req; }, setExpiry: value => { expiry = { ...expiry, ...value }; } };
}
const prepare = runway => runway.prepare({ projectId: policy.projectId, idempotencyKey: 'first-refill-fixture' });

test('runway prepares exact bounded recipient permission and payment without sending or approving', async t => {
  const f = fixture(t); await f.runway.configure(policy); const plan = await prepare(f.runway);
  assert.equal(plan.calls.length, 2); assert.equal(plan.amountWei, '1120000000000000');
  const permission = decodeFunctionData({ abi: TREASURY_RUNWAY_ABI, data: plan.calls[0].data }); assert.equal(permission.functionName, 'setRecipient'); assert.deepEqual(permission.args, [daemon, true]);
  const expense = decodeFunctionData({ abi: TREASURY_RUNWAY_ABI, data: plan.calls[1].data }); assert.equal(expense.functionName, 'pay'); assert.deepEqual(expense.args, [plan.expenseId, daemon, 1120000000000000n]);
  assert.deepEqual(await prepare(f.restart()), plan); assert.equal(f.sends(), 0); assert.deepEqual(f.fundingCalls, ['quote']);
  await assert.rejects(f.runway.execute({ projectId: policy.projectId, refillId: plan.id }), /explicitly allow/);
});

test('runway executes once, validates final canonical receipt and activates only a funded note', async t => {
  const f = fixture(t); f.allow(); await f.runway.configure(policy); const plan = await prepare(f.runway);
  const pending = await f.runway.execute({ projectId: policy.projectId, refillId: plan.id }); assert.equal(pending.status, 'pending');
  assert.equal((await f.runway.execute({ projectId: policy.projectId, refillId: plan.id })).status, 'funded'); assert.equal(f.sends(), 1);
  assert.equal((await f.runway.activate({ projectId: policy.projectId, refillId: plan.id })).status, 'deposit_pending');
  assert.equal((await f.runway.activate({ projectId: policy.projectId, refillId: plan.id })).status, 'active');
  assert.deepEqual(f.fundingCalls, ['quote', 'refresh', 'approve', 'recover', 'resume']);
  assert.equal(f.restart().snapshot().refills[0].status, 'active');
});

test('runway lost signer response remains unknown across restart and never resends', async t => {
  const f = fixture(t); f.allow(); f.failSend(); await f.runway.configure(policy); const plan = await prepare(f.runway);
  await assert.rejects(f.runway.execute({ projectId: policy.projectId, refillId: plan.id }), /uncertain/);
  const restart = f.restart(); assert.equal(restart.snapshot().refills[0].status, 'send_unknown');
  await assert.rejects(restart.execute({ projectId: policy.projectId, refillId: plan.id }), /cannot be replayed/);
  assert.equal(f.sends(), 1);
  assert.equal((await restart.confirm({ projectId: policy.projectId, refillId: plan.id, transactionHash: TX })).status, 'funded');
});

test('runway rejects wrong chain, changed owner, project reassignment and excess refill', async t => {
  const f = fixture(t); f.setChain(8453); await assert.rejects(f.runway.configure(policy), /mainnet/);
  f.setChain(1); f.setOwner(daemon); await assert.rejects(f.runway.configure(policy), /owner/);
  f.setOwner(owner); await f.runway.configure(policy);
  await assert.rejects(f.runway.configure({ ...policy, projectId: 'another-project' }), /reassigned/);
  f.setAmount('3000000000000000'); await assert.rejects(prepare(f.runway), /ceiling/);
  assert.equal(f.sends(), 0); assert.equal(f.runway.snapshot().refills[0].status, 'prepare_unknown');
});

test('runway rejects a forged or unfinalized expense receipt', async t => {
  const f = fixture(t); f.allow(); await f.runway.configure(policy); const plan = await prepare(f.runway); await f.runway.execute({ projectId: policy.projectId, refillId: plan.id });
  f.mutateReceipt(r => ({ ...r, logs: [] })); await assert.rejects(f.runway.confirm({ projectId: policy.projectId, refillId: plan.id, transactionHash: TX }), /exact authorized/);
  f.mutateReceipt(r => ({ ...r, blockNumber: 101n })); await assert.rejects(f.runway.confirm({ projectId: policy.projectId, refillId: plan.id, transactionHash: TX }), /not finalized/);
  f.mutateReceipt(r => ({ ...r, blockHash: `0x${'c'.repeat(64)}` })); await assert.rejects(f.runway.confirm({ projectId: policy.projectId, refillId: plan.id, transactionHash: TX }), /not canonical/);
  assert.equal(f.runway.snapshot().refills[0].status, 'pending'); assert.equal(f.fundingCalls.includes('approve'), false);
});

test('automatic refill requires all enables, explicit recipient, idle runtime and settlement', async t => {
  const disabled = fixture(t, { enableAutomatic: false }); await disabled.runway.configure(policy); const p = await prepare(disabled.runway);
  await assert.rejects(disabled.runway.execute({ projectId: policy.projectId, refillId: p.id }), e => e.status === 403);
  const f = fixture(t); await f.runway.configure(policy); f.setIdle(false); assert.equal((await f.runway.tick(policy.projectId)).status, 'waiting_idle');
  f.setIdle(true); f.setNote({ phase: 'waiting_settlement' }); assert.equal((await f.runway.tick(policy.projectId)).status, 'waiting_settlement');
  f.setNote({ phase: 'ready', privateBalanceGwei: '9999' }); assert.equal((await f.runway.tick(policy.projectId)).status, 'adequate'); assert.equal(f.fundingCalls.length, 0);
});

test('deposit activation stops when refreshed network fee exceeds exact funded amount', async t => {
  const f = fixture(t); f.allow(); await f.runway.configure(policy); const plan = await prepare(f.runway); await f.runway.execute({ projectId: policy.projectId, refillId: plan.id }); await f.runway.execute({ projectId: policy.projectId, refillId: plan.id });
  f.setFeeMoved(); await assert.rejects(f.runway.activate({ projectId: policy.projectId, refillId: plan.id }), /fee moved/);
  assert.equal(f.fundingCalls.includes('approve'), false); assert.equal(f.runway.snapshot().refills[0].status, 'funded');
});

test('another process cannot overwrite a newer runway policy', async t => {
  const f = fixture(t), old = f.restart(); await f.runway.configure(policy);
  await assert.rejects(old.configure(policy), /another process/); assert.equal(old.snapshot().persistence, 'blocked');
});

test('owner can revise ceilings after unsigned preparation failed without changing its deposit identity', async t => {
  const f = fixture(t); await f.runway.configure(policy); f.setAmount('3000000000000000');
  await assert.rejects(prepare(f.runway), /ceiling/);
  const pending = f.runway.snapshot().refills[0];
  await assert.rejects(f.runway.configure({ ...policy, depositGwei: '2000000' }), /pending refill/);
  await f.runway.configure({ ...policy, maxTopUpWei: '3000000000000000' });
  const recovered = await f.runway.recover({ projectId: policy.projectId, refillId: pending.id });
  assert.equal(recovered.status, 'prepared'); assert.equal(recovered.amountWei, '3000000000000000'); assert.equal(f.sends(), 0);
});

test('low-water refill closes the exact private note and funds only a bounded withdrawal gas shortfall', async t => {
  const f = fixture(t); f.allow(); await f.runway.configure(policy); f.setNote({ phase: 'ready', privateBalanceGwei: '500' });
  const operations = [];
  f.funding.snapshot = () => ({ intents: [], operations });
  f.funding.quoteOperation = async input => {
    assert.equal(input.kind, 'withdrawal'); assert.equal(input.destination, treasury); assert.equal(input.noteId, 7);
    const op = { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', request: input, address: daemon, status: 'quoted', approvalAttempted: false, quote: { id: 'q-withdrawal', expires_at: NOW + 30_000, recommended_top_up_wei: '120000000000000' }, approvalDigest: 'withdrawal-review' };
    operations.push(op); return structuredClone(op);
  };
  f.funding.refreshOperation = async () => structuredClone(operations[0]);
  const plan = await f.runway.tick(policy.projectId);
  assert.equal(plan.kind, 'recovery-fee'); assert.equal(plan.amountWei, '120000000000000');
  assert.equal(plan.calls.length, 1); assert.equal(decodeFunctionData({ abi: TREASURY_RUNWAY_ABI, data: plan.calls[0].data }).args[2], 120000000000000n);
  assert.equal(f.sends(), 0); assert.equal(f.runway.snapshot().closeIntentId, operations[0].id);
  assert.equal((await f.runway.tick(policy.projectId)).status, 'pending');
  assert.equal((await f.runway.tick(policy.projectId)).status, 'funded');
  assert.equal((await f.runway.tick(policy.projectId)).status, 'active');
  assert.equal(f.sends(), 1); assert.equal(f.fundingCalls.length, 0);
});

function withdrawal(f, { failApproval = false, changeAtRefresh = false } = {}) {
  const operations = []; let approvals = 0, recoveries = 0;
  f.funding.snapshot = () => ({ intents: [], operations });
  f.funding.quoteOperation = async input => {
    const op = { id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', request: input, address: daemon, status: 'quoted', approvalAttempted: false, quote: { id: 'expiry-quote', recommended_top_up_wei: '0' }, approvalDigest: 'exact-expiry-review' };
    operations.push(op); f.setNote({ phase: 'quoted' }); return structuredClone(op);
  };
  f.funding.refreshOperation = async () => { if (changeAtRefresh) f.setExpiry({ noteId: 99 }); return structuredClone(operations[0]); };
  f.funding.approveOperation = async input => {
    approvals++; assert.equal(input.approvalDigest, 'exact-expiry-review'); operations[0].approvalAttempted = true;
    operations[0].status = failApproval ? 'approval_unknown' : 'pending';
    if (failApproval) throw new Error('Lost approval response'); return structuredClone(operations[0]);
  };
  f.funding.recoverOperation = async () => { recoveries++; return structuredClone(operations[0]); };
  f.funding.resumeOperation = async () => assert.fail('Automatic expiry maintenance must not resubmit a withdrawal');
  return { operations, counts: () => ({ approvals, recoveries }) };
}

test('an adequately funded expiring note closes only after the owner explicitly opts in', async t => {
  const f = fixture(t), w = withdrawal(f); await f.runway.configure(policy); f.setNote({ phase: 'ready', privateBalanceGwei: '9999' }); f.setExpiry({ status: 'warning', expiresAt: NOW / 1000 + 6 * 86400 });
  assert.equal((await f.runway.tick(policy.projectId)).status, 'expiry_action_required'); assert.equal(w.operations.length, 0);
  await f.runway.configure({ ...policy, closeBeforeExpiry: true });
  assert.equal((await f.runway.tick(policy.projectId)).status, 'closing_note'); assert.equal(w.operations[0].request.destination, treasury); assert.equal(w.operations[0].request.noteId, 7); assert.equal(w.counts().approvals, 1);
  assert.equal(f.restart().snapshot().policy.closeBeforeExpiry, true);
  assert.equal((await f.restart().tick(policy.projectId)).status, 'closing_note'); assert.deepEqual(w.counts(), { approvals: 1, recoveries: 1 });
});

test('unknown, inactive, expired, stale or mismatched expiry cannot authorize even low-water closure', async t => {
  for (const report of [{ status: 'unknown' }, { noteState: 'inactive' }, { expiresAt: NOW / 1000 }, { checkedAt: NOW / 1000 - 31 }, { noteId: 8 }, { fundingAddress: treasury }]) {
    const f = fixture(t), w = withdrawal(f); await f.runway.configure({ ...policy, closeBeforeExpiry: true }); f.setNote({ phase: 'ready', privateBalanceGwei: '500' }); f.setExpiry(report);
    assert.equal((await f.runway.tick(policy.projectId)).status, 'expiry_unverified'); assert.equal(w.operations.length, 0); assert.equal(f.sends(), 0);
  }
});

test('expiry is rechecked after quote refresh; an ambiguous approval is recovered without retry', async t => {
  const changed = fixture(t), c = withdrawal(changed, { changeAtRefresh: true }); await changed.runway.configure({ ...policy, closeBeforeExpiry: true }); changed.setNote({ phase: 'ready', privateBalanceGwei: '500' });
  assert.equal((await changed.runway.tick(policy.projectId)).status, 'expiry_unverified'); assert.equal(c.counts().approvals, 0);
  const uncertain = fixture(t), u = withdrawal(uncertain, { failApproval: true }); await uncertain.runway.configure({ ...policy, closeBeforeExpiry: true }); uncertain.setNote({ phase: 'ready', privateBalanceGwei: '500' });
  await assert.rejects(uncertain.runway.tick(policy.projectId), /Lost approval/);
  assert.equal((await uncertain.restart().tick(policy.projectId)).status, 'recovery_required'); assert.deepEqual(u.counts(), { approvals: 1, recoveries: 1 });
});

test('only a trusted pre-signing refusal restores a prepared refill for a later bounded attempt', async t => {
  const f = fixture(t); f.allow(); await f.runway.configure(policy); const plan = await prepare(f.runway);
  f.config.signer.sendTransaction = async () => { const error = new Problem('Gas ceiling exceeded before nonce reservation', 409); error.treasuryNoSigningAttempted = true; throw error; };
  await assert.rejects(f.runway.execute({ projectId: policy.projectId, refillId: plan.id }), /Gas ceiling/);
  assert.equal(f.restart().snapshot().refills[0].status, 'prepared');
  f.config.signer.sendTransaction = async () => { throw new Error('Ambiguous signing outcome'); };
  await assert.rejects(f.restart().execute({ projectId: policy.projectId, refillId: plan.id }), /uncertain/);
  assert.equal(f.restart().snapshot().refills[0].status, 'send_unknown');
});

test('provably unsigned failed preparation is retired before changing principal, while all history is retained', async t => {
  const f = fixture(t); await f.runway.configure(policy); f.setAmount('3000000000000000'); await assert.rejects(prepare(f.runway), /ceiling/);
  const item = f.runway.snapshot().refills[0]; assert.equal(item.calls, undefined); assert.equal(item.transactionHash, undefined);
  const abandoned = await f.runway.abandonUnsigned({ projectId: policy.projectId, refillId: item.id }); assert.equal(abandoned.status, 'abandoned'); assert.equal(f.funding.snapshot().intents[0].status, 'abandoned');
  const restarted = f.restart(); assert.deepEqual(await restarted.abandonUnsigned({ projectId: policy.projectId, refillId: item.id }), abandoned);
  await restarted.configure({ ...policy, depositGwei: '2000000' }); f.setAmount('1000000000000000');
  const replacement = await restarted.prepare({ projectId: policy.projectId, idempotencyKey: 'replacement-refill-key' }); assert.equal(replacement.status, 'prepared');
  assert.equal(restarted.snapshot().refills.length, 2); assert.equal(restarted.snapshot().refills[0].status, 'abandoned'); assert.equal(f.sends(), 0);
});

test('unsigned abandonment refuses an exposed plan, submitted payment or ambiguous daemon approval', async t => {
  const planned = fixture(t); planned.allow(); await planned.runway.configure(policy); const plan = await prepare(planned.runway);
  await assert.rejects(planned.runway.abandonUnsigned({ projectId: policy.projectId, refillId: plan.id }), /without a payment plan/);
  await planned.runway.execute({ projectId: policy.projectId, refillId: plan.id }); await assert.rejects(planned.runway.abandonUnsigned({ projectId: policy.projectId, refillId: plan.id }), /without a payment plan/);
  const uncertain = fixture(t); await uncertain.runway.configure(policy); uncertain.setAmount('3000000000000000'); await assert.rejects(prepare(uncertain.runway));
  const item = uncertain.runway.snapshot().refills[0], snapshot = uncertain.funding.snapshot;
  uncertain.funding.snapshot = () => { const result = structuredClone(snapshot()); result.intents[0].approvalAttempted = true; result.intents[0].status = 'approval_unknown'; return result; };
  await assert.rejects(uncertain.runway.abandonUnsigned({ projectId: policy.projectId, refillId: item.id }), /unknown approval/);
  assert.equal(uncertain.runway.snapshot().refills[0].status, 'prepare_unknown');
});
