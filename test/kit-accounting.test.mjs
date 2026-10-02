import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Kit } from '../src/kit.mjs';
import { Store } from '../src/store.mjs';
import { fixtureCharge } from './fixtures/charge-accounting.mjs';

function setup({ uncertain = false, receiptReady = true, tools = false } = {}) {
  const file = join(mkdtempSync(join(tmpdir(), 'veyl-charge-')), 'state.json'), reports = new Map(); let calls = 0, ready = receiptReady;
  const provider = { mode: 'zkapi', models: async () => [{ id: 'fixture', oa_request_limit_micro_usd: 500000, oa_accounting_margin_micro_usd: 1000 }], accountingIdentity: async () => ({ version: 1, journal_id: 'a'.repeat(32) }), callSettlement: async id => { if (!ready) throw new Error('unknown'); return reports.get(id); }, complete: async (body, context) => {
    calls++; const saved = JSON.parse(readFileSync(file)); const records = saved.jobs[0].steps.flatMap(s => [s, ...(s.additionalCalls || [])]);
    assert.ok(records.some(r => r.callAccounting?.callId === context.callId)); assert.equal(context.reservedMicroUsd, 501000);
    reports.set(context.callId, fixtureCharge({ callId: context.callId, session: String(calls).repeat(64), receipt: String(calls).repeat(64) }).report);
    if (uncertain) throw new Error('lost completion');
    return tools && calls === 1 ? { answer: '', toolCalls: [{ id: 'tool', function: { name: 'read_source', arguments: '{}' } }] } : { answer: 'Done' };
  } };
  const store = new Store(file, 'zkapi'), kit = new Kit({ store, provider, chain: {}, now: () => new Date(1800000000 * 1000), agentTools: tools ? { schemas: () => [], execute: async () => ({ text: 'test' }) } : null });
  const p = kit.create({ requestKey: randomUUID(), name: 'Accounting', symbol: 'ACC', purpose: 'Test', template: 'research', swarm: false, model: 'fixture', total: 4000000, daily: 4000000, request: 501000 });
  return { kit, p, file, provider, reports, calls: () => calls, ready: () => ready = true };
}
test('every tool round saves identity before dispatch and settles exact ETH separately', async () => {
  const f = setup({ tools: true }); const job = await f.kit.submit(f.p.id, { requestKey: randomUUID(), prompt: 'Read' }); await f.kit.execution;
  assert.equal(job.status, 'completed'); assert.equal(f.calls(), 2); assert.equal(f.p.committed, 60000); assert.equal(job.reservation, 60000);
  assert.equal(new Store(f.file, 'zkapi').data.projects[0].committed, 60000);
});
test('lost completion and restart keep cap until readonly authoritative receipt recovery, without re-execution', async () => {
  const f = setup({ uncertain: true, receiptReady: false }); const job = await f.kit.submit(f.p.id, { requestKey: randomUUID(), prompt: 'Run' }); await f.kit.execution;
  assert.equal(job.status, 'interrupted'); assert.equal(f.p.committed, 501000); assert.equal(f.kit.pendingAccounting(f.p.id), 1);
  const restored = new Kit({ store: new Store(f.file, 'zkapi'), provider: f.provider, chain: {} }); f.ready();
  assert.deepEqual(await restored.reconcileCalls(f.p.id, f.provider), { checked: 1, settled: 1, pending: 0 });
  assert.equal(restored.project(f.p.id).committed, 30000); assert.equal(f.calls(), 1);
  assert.deepEqual(await restored.reconcileCalls(f.p.id, f.provider), { checked: 0, settled: 0, pending: 0 });
});
test('journal replacement blocks dispatch, and forged stored valuation fails closed', async () => {
  const f = setup(); f.p.accountingJournalId = 'e'.repeat(32); f.kit.store.save();
  await f.kit.submit(f.p.id, { requestKey: randomUUID(), prompt: 'Run' }); await f.kit.execution; assert.equal(f.calls(), 0); assert.equal(f.p.committed, 501000);
  const valid = setup(); await valid.kit.submit(valid.p.id, { requestKey: randomUUID(), prompt: 'Run' }); await valid.kit.execution;
  const disk = JSON.parse(readFileSync(valid.file)); disk.jobs[0].steps[0].callAccounting.valuationMicroUsd = 0; writeFileSync(valid.file, JSON.stringify(disk));
  assert.throws(() => new Store(valid.file, 'zkapi'));
});
test('concurrent receipt reads apply once and cross-project receipt reuse leaves the ledger healthy', async () => {
  const f = setup({ receiptReady: false }); const job = await f.kit.submit(f.p.id, { requestKey: randomUUID(), prompt: 'Run' }); await f.kit.execution; f.ready();
  await Promise.all([f.kit.reconcileCall(f.p, job, job.steps[0], f.provider), f.kit.reconcileCall(f.p, job, job.steps[0], f.provider)]);
  assert.equal(f.p.committed, 30000); assert.equal(f.kit.store.healthy, true);
  const p2 = f.kit.create({ requestKey: randomUUID(), name: 'Second', symbol: 'TWO', purpose: 'Test', template: 'research', swarm: false, model: 'fixture', total: 4000000, daily: 4000000, request: 501000 });
  const original = f.provider.callSettlement; f.provider.callSettlement = async () => { throw new Error('not ready'); };
  const job2 = await f.kit.submit(p2.id, { requestKey: randomUUID(), prompt: 'Run' }); await f.kit.execution;
  f.provider.callSettlement = original; const call = job2.steps[0].callAccounting;
  const reused = structuredClone(job.steps[0].callAccounting.report); reused.call_id = call.callId; reused.binding.call_id = call.callId;
  f.reports.set(call.callId, reused);
  await assert.rejects(f.kit.reconcileCall(p2, job2, job2.steps[0], f.provider), /already bound/);
  assert.equal(p2.committed, 501000); assert.equal(f.kit.store.healthy, true); assert.equal(job2.steps[0].callAccounting.status, 'pending');
});
test('a failed settlement save blocks further calls and leaves the on-disk cap held', async () => {
  const f = setup({ receiptReady: false }); const job = await f.kit.submit(f.p.id, { requestKey: randomUUID(), prompt: 'Run' }); await f.kit.execution; f.ready();
  f.kit.store.codec.encode = () => { throw new Error('disk full'); };
  await assert.rejects(f.kit.reconcileCall(f.p, job, job.steps[0], f.provider), /Persistence failed/);
  assert.equal(f.kit.store.healthy, false); assert.equal(JSON.parse(readFileSync(f.file)).projects[0].committed, 501000);
  await assert.rejects(f.kit.submit(f.p.id, { requestKey: randomUUID(), prompt: 'Again' }), /Persistence failed/); assert.equal(f.calls(), 1);
});
