import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FundedAcceptance, acceptancePlan } from '../src/acceptance.mjs';
import { Store } from '../src/store.mjs';
import { Kit } from '../src/kit.mjs';
import { AgentTools } from '../src/agent-tools.mjs';

function setup(t, { enabled = true, loseDeposit = false, loseCall = false, pendingWithdrawal = false, depositTooHigh = false, withdrawalTooHigh = false, repeatedTool = false } = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'veyl-acceptance-')); t.after(() => rmSync(folder, { recursive: true, force: true }));
  const config = { version: 1, runId: randomUUID(), daemonOrigin: 'http://127.0.0.1:19999', expectedFundingAddress: '0x1111111111111111111111111111111111111111', model: 'fixture/model', depositGwei: '1000000', maxDepositTotalWei: '1100000000000000', maxRequestMicroUsd: 1_000_000, maxCalls: 2, maxTotalMicroUsd: 2_000_000, withdrawalDestination: '0x2222222222222222222222222222222222222222', maxWithdrawalFeeWei: '100000000000000', exclusiveProfile: true };
  const file = join(folder, 'acceptance.json'), ledger = [], tx = '0x' + 'a'.repeat(64), deposit = { id: randomUUID(), address: config.expectedFundingAddress, amountGwei: config.depositGwei, status: 'quoted', quote: { id: 'deposit-quote', recommended_total_wei: depositTooHigh ? '1200000000000000' : '1050000000000000', balance_wei: '2000000000000000' }, approvalDigest: 'deposit-digest' };
  const withdrawal = { id: randomUUID(), address: config.expectedFundingAddress, status: 'quoted', request: { destination: config.withdrawalDestination }, quote: { id: 'withdrawal-quote', note_id: 7, amount: 500000, fee_reserve_wei: withdrawalTooHigh ? '150000000000000' : '50000000000000', recommended_total_wei: '50000000000000', balance_wei: '100000000000000' }, approvalDigest: 'withdrawal-digest' };
  const funding = { capabilities: () => ({ approvalEnabled: true, daemonOrigin: config.daemonOrigin }), snapshot: () => ({ intents: [deposit], operations: [withdrawal] }), inspect: async () => { ledger.push('funding-inspect'); return { funding: { address: config.expectedFundingAddress, phase: 'ready' } }; }, quote: async () => deposit, refresh: async () => deposit,
    approve: async input => { ledger.push('deposit-approve'); assert.equal(JSON.parse(readFileSync(file)).phase, 'deposit-submitting'); assert.equal(input.approvalDigest, deposit.approvalDigest); if (loseDeposit) { deposit.status = 'approval_unknown'; throw new Error('Lost approval'); } deposit.status = 'active'; return deposit; },
    recover: async () => deposit, inspectOperation: async () => ({ phase: 'ready', address: config.expectedFundingAddress, noteId: 7, privateBalanceGwei: '500000' }), quoteOperation: async () => withdrawal, refreshOperation: async () => withdrawal,
    approveOperation: async input => { ledger.push('withdrawal-approve'); assert.equal(JSON.parse(readFileSync(file)).phase, 'withdrawal-submitting'); assert.equal(input.approvalDigest, withdrawal.approvalDigest); withdrawal.status = pendingWithdrawal ? 'pending' : 'complete'; withdrawal.transactionHash = tx; return withdrawal; }, recoverOperation: async () => withdrawal,
    resumeOperation: async input => { ledger.push('withdrawal-resume'); assert.equal(input.transactionHash, tx); withdrawal.status = 'complete'; return withdrawal; } };
  let count = 0, acceptance;
  const provider = { mode: 'zkapi', diagnostics: async () => ({ configuration: 'daemon-reported match', configurationVerified: false, backend: 'zkapi', network: 'mainnet', requestBudgetPolicy: 'model' }), models: async () => [{ id: config.model, oa_request_limit_micro_usd: 1_000_000 }], complete: async () => {
    const saved = JSON.parse(readFileSync(file)); assert.equal(saved.calls.at(-1).status, 'dispatching'); ledger.push('paid-call'); count++;
    if (count === 2 && loseCall) throw new Error('Lost inference response');
    return count === 1 || repeatedTool ? { answer: '', verification: 'fixture', toolCalls: [{ id: 'note-check-' + count, type: 'function', function: { name: 'save_note', arguments: JSON.stringify({ content: 'Veyl acceptance ' + config.runId }) } }] } : { answer: 'Note saved.', verification: 'fixture' };
  } };
  const wrapped = { mode: 'zkapi', models: provider.models, complete: body => acceptance.dispatch(body) }, tools = new AgentTools();
  const kitFile = join(folder, 'kit.json'), kit = new Kit({ store: new Store(kitFile, 'zkapi'), provider: wrapped, chain: {}, agentTools: tools });
  const expiryGuard = { assertCanInfer: async () => ({ canInfer: true, status: 'healthy' }) };
  acceptance = new FundedAcceptance({ file, config, provider, funding, kit, expiryGuard, enabled });
  return { config, file, kitFile, kit, funding, provider, ledger, tx, acceptance, approval: acceptance.plan.approvalDigest, replace(value) { acceptance = value; } };
}

test('offline plan and read-only inspection do not touch funding, sign, call a model or create a journal', async t => {
  const f = setup(t, { enabled: false }), report = await f.acceptance.inspect();
  assert.equal(report.mode, 'read-only'); assert.equal(report.paidInferenceCalls, 0); assert.equal(report.signedTransactions, 0); assert.equal(existsSync(f.file), false); assert.deepEqual(f.ledger, []);
  await assert.rejects(f.acceptance.run(f.approval), /disabled/); assert.deepEqual(f.ledger, []);
});

test('explicitly enabled fixture acceptance covers durable deposit, real Kit tool loop and withdrawal exactly once', async t => {
  const f = setup(t), report = await f.acceptance.run(f.approval);
  assert.equal(report.phase, 'complete'); assert.equal(report.paidCallsAttempted, 2); assert.equal(report.actualBilledUsageVerified, false);
  assert.deepEqual(f.ledger, ['funding-inspect', 'deposit-approve', 'paid-call', 'paid-call', 'withdrawal-approve']);
  assert.equal(f.kit.store.data.jobs[0].status, 'completed'); assert.equal(f.kit.store.data.projects[0].committed, 2_000_000);
  await f.acceptance.run(f.approval); assert.equal(f.ledger.length, 5);
});

test('changed approval or deposit fee above its explicit ceiling blocks before signing or inference', async t => {
  const f = setup(t, { depositTooHigh: true }); await assert.rejects(f.acceptance.run('b'.repeat(64)), /reviewed plan digest/); assert.deepEqual(f.ledger, []);
  await assert.rejects(f.acceptance.run(f.approval), /exceeds/); assert.deepEqual(f.ledger, ['funding-inspect']); assert.equal(f.acceptance.report().phase, 'deposit-prepared');
});

test('lost deposit approval remains pending and never signs a replacement on rerun', async t => {
  const f = setup(t, { loseDeposit: true }); await assert.rejects(f.acceptance.run(f.approval));
  assert.equal(f.acceptance.report().phase, 'deposit-pending'); const report = await f.acceptance.run(f.approval); assert.match(report.nextAction, /unknown approval/);
  assert.equal(f.ledger.filter(item => item === 'deposit-approve').length, 1); assert.equal(f.ledger.includes('paid-call'), false);
});

test('lost model response retains conservative caps and restart cannot dispatch inference again', async t => {
  const f = setup(t, { loseCall: true }), report = await f.acceptance.run(f.approval);
  assert.equal(report.phase, 'job-submitting'); assert.match(report.nextAction, /never be dispatched again/); assert.equal(f.kit.store.data.projects[0].committed, 2_000_000);
  const kit = new Kit({ store: new Store(f.kitFile, 'zkapi'), provider: f.provider, chain: {} });
  const restarted = new FundedAcceptance({ file: f.file, config: f.config, provider: f.provider, funding: f.funding, kit, expiryGuard: f.acceptance.expiryGuard, enabled: true });
  await restarted.run(f.approval); assert.equal(f.ledger.filter(item => item === 'paid-call').length, 2); assert.equal(f.ledger.includes('withdrawal-approve'), false);
});

test('withdrawal recovery requires exact saved hash and never reruns the task', async t => {
  const f = setup(t, { pendingWithdrawal: true }), report = await f.acceptance.run(f.approval); assert.equal(report.phase, 'withdrawal-pending');
  await assert.rejects(f.acceptance.resume({ approvalDigest: f.approval, kind: 'withdrawal', transactionHash: '0x' + 'b'.repeat(64) }), /exact saved/);
  assert.equal((await f.acceptance.resume({ approvalDigest: f.approval, kind: 'withdrawal', transactionHash: f.tx })).phase, 'complete');
  assert.equal(f.ledger.filter(item => item === 'paid-call').length, 2); assert.equal(f.ledger.filter(item => item === 'withdrawal-resume').length, 1);
});

test('a continuing tool loop cannot purchase a third model round past the approved ceiling', async t => {
  const f = setup(t, { repeatedTool: true }), report = await f.acceptance.run(f.approval);
  assert.equal(report.phase, 'job-submitting'); assert.equal(report.paidCallsAttempted, 2);
  assert.equal(f.ledger.filter(item => item === 'paid-call').length, 2);
  assert.equal(f.ledger.includes('withdrawal-approve'), false);
  assert.equal(f.kit.store.data.projects[0].committed, 2_000_000);
  await assert.rejects(f.acceptance.dispatch({ model: f.config.model }), /call limit/);
});

test('withdrawal gas above its separate approved ceiling stops without authorizing or rerunning inference', async t => {
  const f = setup(t, { withdrawalTooHigh: true });
  await assert.rejects(f.acceptance.run(f.approval), /exceeds/);
  assert.equal(f.acceptance.report().phase, 'withdrawal-ready');
  await assert.rejects(f.acceptance.run(f.approval), /exceeds/);
  assert.equal(f.ledger.filter(item => item === 'paid-call').length, 2);
  assert.equal(f.ledger.includes('withdrawal-approve'), false);
});

test('public acceptance terms reject credentials, remote origins and implicit budgets', async t => {
  const f = setup(t);
  assert.throws(() => acceptancePlan({ ...f.config, privateKey: 'do-not-reflect' }), error => !error.message.includes('do-not-reflect'));
  assert.throws(() => acceptancePlan({ ...f.config, daemonOrigin: 'https://remote.example' }), /127/);
  assert.throws(() => acceptancePlan({ ...f.config, maxTotalMicroUsd: 1 }), /exact deposit/);
  assert.notEqual(acceptancePlan({ ...f.config, maxWithdrawalFeeWei: '200000000000000' }).approvalDigest, f.approval);
});

test('canonical expiry uncertainty stops acceptance before a paid model request', async t => {
  const f = setup(t); f.acceptance.expiryGuard = { assertCanInfer: async () => { throw new Error('Unknown note expiry'); } };
  const report = await f.acceptance.run(f.approval);
  assert.equal(report.phase, 'job-submitting'); assert.equal(report.paidCallsAttempted, 0);
  assert.equal(f.ledger.includes('paid-call'), false);
});
