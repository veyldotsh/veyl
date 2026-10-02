import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { TenantRegistry, configuredFeeKeeper, configuredTreasuryOperator, configuredConversionKeeper, fundingActivation } from '../src/production.mjs';
import { Problem } from '../src/agent.mjs';

const owner = '0x0000000000000000000000000000000000000001';
function fixture(t, extra = {}) {
  const directory = mkdtempSync(resolve(tmpdir(), 'veyl-finance-')); t.after(() => { assert.ok(directory.startsWith(resolve(tmpdir(), 'veyl-finance-'))); rmSync(directory, { force: true, recursive: true }); });
  const registry = new TenantRegistry({ directory, key: randomBytes(32), mainnet: {}, ...extra }), kit = registry.get(owner);
  const project = kit.create({ requestKey: randomUUID(), name: 'Finance isolation', symbol: 'TEST', purpose: 'Bounded work.', template: 'research', swarm: false, model: 'test/model', total: 1000000, daily: 1000000, request: 500000 });
  registry.configuration.data.projects.push({ owner, projectId: project.id });
  let acquisitions = 0, released = 0, calls = 0, safe = true, inspections = 0;
  registry.provisioner.acquire = async () => { acquisitions++; return { release: () => released++ }; };
  const runtime = { rawProvider: { mode: 'zkapi', models: async () => [], complete: async () => { calls++; return { answer: 'Only when safe' }; } },
    noteExpiryGuard: { assertCanInfer: async () => { inspections++; if (!safe) { const error = new Problem('Expired note blocked.', 409); error.noteExpiry = { status: 'expired', canInfer: false }; throw error; } return { status: 'healthy', canInfer: true }; }, inspect: async () => { inspections++; return { status: 'healthy', canInfer: true }; } },
    funding: { snapshot: () => ({ intents: [], approvalEnabled: false }) } };
  registry.runtime = () => runtime; registry.ready = async () => runtime;
  return { registry, kit, project, runtime, directory, setSafe: value => safe = value, stats: () => ({ acquisitions, released, calls, inspections }) };
}

test('funding operation prevents queued model acquisition; a held model lease prevents withdrawal and always releases its lock', async t => {
  const f = fixture(t); let finish, entered;
  const started = new Promise(r => entered = r);
  const operation = f.registry.financialOperation(owner, f.project.id, async () => { entered(); await new Promise(r => finish = r); });
  await started;
  await assert.rejects(f.registry.executionProvider(owner, f.project.id), error => error.dispatchDeferred === true); assert.equal(f.stats().acquisitions, 0);
  finish(); await operation; assert.equal(f.kit.operations.size, 0);
  const provider = await f.registry.executionProvider(owner, f.project.id);
  await assert.rejects(f.registry.financialOperation(owner, f.project.id, async () => assert.fail('No withdrawal while executing')), /Wait for/);
  provider.release(); provider.release(); assert.equal(f.stats().released, 1); assert.equal(f.kit.operations.size, 0);
  await assert.rejects(f.registry.financialOperation(owner, f.project.id, async () => { throw new Error('fixture'); }), /fixture/); assert.equal(f.kit.operations.size, 0);
});

test('every paid complete checks note expiry again and a changed expiry prevents the next provider request', async t => {
  const f = fixture(t), provider = await f.registry.executionProvider(owner, f.project.id);
  await provider.complete({}); f.setSafe(false);
  await assert.rejects(provider.complete({}), /Expired note/);
  assert.equal(f.stats().calls, 1); assert.equal(f.stats().inspections, 2); assert.equal(f.runtime.noteExpiry.status, 'expired');
  const snapshot = await f.registry.fundingSnapshot(owner, f.project.id); assert.equal(snapshot.noteExpiry.status, 'expired'); assert.equal(f.stats().inspections, 2);
  provider.release();
});

test('unfunded or expired admission rejects before a job, native call or USD reservation exists', async t => {
  for (const status of ['no_note', 'expired', 'unknown']) {
    const f = fixture(t); let queued = 0, nativeCalls = 0;
    f.kit.providerCatalogForProject = async () => [{ id: 'test/model', oa_request_limit_micro_usd: 490000, oa_accounting_margin_micro_usd: 1000 }];
    f.kit.queue = { assertCapacity: async () => {}, enqueue: async () => { queued++; } };
    f.runtime.rawProvider.complete = async () => { nativeCalls++; };
    f.runtime.noteExpiryGuard.assertCanInfer = async () => {
      assert.equal(f.kit.operations.has(f.project.id), true);
      assert.equal(f.registry.financeContext.getStore().purpose, 'inference-admission');
      assert.equal(f.project.committed, 0); assert.equal(f.kit.store.data.jobs.length, 0);
      const error = new Problem('Fund and activate an unexpired note before submitting.', 409); error.noteExpiry = { status, canInfer: false }; throw error;
    };
    await assert.rejects(f.kit.submit(f.project.id, { requestKey: randomUUID(), prompt: 'First task' }), /Fund and activate/);
    assert.equal(f.project.committed, 0); assert.deepEqual(f.project.days, {}); assert.equal(f.kit.store.data.jobs.length, 0);
    assert.equal(f.project.accountingJournalId, undefined); assert.equal(queued, 0); assert.equal(nativeCalls, 0);
    assert.equal(f.runtime.noteExpiry.status, status); assert.equal(f.kit.running, false); assert.equal(f.kit.operations.size, 0); assert.equal(f.registry.financeOwners.size, 0);
    assert.equal(f.stats().acquisitions, 1); assert.equal(f.stats().released, 1);
    f.registry.kits.delete(owner); const restored = f.registry.get(owner).project(f.project.id);
    assert.equal(restored.committed, 0); assert.deepEqual(restored.days, {});
  }
});

test('healthy admission reserves once and still rechecks expiry before the actual model call', async t => {
  const f = fixture(t); let queued = 0;
  f.kit.providerCatalogForProject = async () => [{ id: 'test/model', oa_request_limit_micro_usd: 490000, oa_accounting_margin_micro_usd: 1000 }];
  f.kit.queue = { assertCapacity: async () => {}, enqueue: async () => { queued++; } };
  const input = { requestKey: randomUUID(), prompt: 'Funded task' }, job = await f.kit.submit(f.project.id, input);
  assert.equal(queued, 1); assert.equal(job.status, 'queued'); assert.equal(f.project.committed, 491000); assert.equal(f.stats().inspections, 1);
  assert.equal((await f.kit.submit(f.project.id, input)).id, job.id); assert.equal(f.stats().inspections, 1);
  const provider = await f.registry.executionProvider(owner, f.project.id); f.setSafe(false);
  await assert.rejects(provider.complete({}), /Expired note/); provider.release();
  assert.equal(f.stats().calls, 0); assert.equal(f.project.committed, 491000); assert.equal(f.stats().inspections, 2);
});

test('scheduled admission defers daemon capacity and pauses an unfunded schedule without reservations', async t => {
  const f = fixture(t);
  f.kit.providerCatalogForProject = async () => [{ id: 'test/model', oa_request_limit_micro_usd: 490000, oa_accounting_margin_micro_usd: 1000 }];
  f.kit.queue = { assertCapacity: async () => {}, enqueue: async () => assert.fail('No unfunded job enters the queue') };
  f.project.schedule = { minutes: 15, prompt: 'Scheduled first task', nextAt: new Date(0).toISOString() }; f.kit.store.save();
  f.registry.provisioner.acquire = async () => { const error = new Problem('All daemon slots are busy.', 503); error.dispatchDeferred = true; throw error; };
  await f.kit.tick(); assert.ok(f.project.schedule); assert.ok(new Date(f.project.schedule.nextAt) > new Date());
  assert.equal(f.project.committed, 0); assert.equal(f.kit.store.data.jobs.length, 0);
  f.project.schedule.nextAt = new Date(0).toISOString(); f.kit.store.save();
  f.registry.provisioner.acquire = async () => ({ release() {} });
  f.runtime.noteExpiryGuard.assertCanInfer = async () => { const error = new Problem('No active private note.', 409); error.noteExpiry = { status: 'no_note', canInfer: false }; throw error; };
  await f.kit.tick(); assert.equal(f.project.schedule, null); assert.equal(f.project.committed, 0); assert.equal(f.kit.store.data.jobs.length, 0); assert.equal(f.kit.operations.size, 0);
});

test('healthy admission followed by queue-time expiry releases every untouched swarm stage without a native call identity', async t => {
  const f = fixture(t), models = [{ id: 'test/model', oa_request_limit_micro_usd: 490000, oa_accounting_margin_micro_usd: 1000 }];
  f.project.swarm = true; f.project.policy.total = f.project.policy.daily = 2000000; f.kit.store.save();
  f.kit.providerCatalogForProject = f.runtime.rawProvider.models = async () => models;
  f.runtime.rawProvider.accountingIdentity = async () => ({ version: 1, journal_id: 'a'.repeat(32) });
  f.runtime.rawProvider.callSettlement = async () => assert.fail('No native call exists to settle');
  f.kit.queue = { assertCapacity: async () => {}, enqueue: async () => {} };
  const input = { requestKey: randomUUID(), prompt: 'Three queued stages' }, job = await f.kit.submit(f.project.id, input);
  assert.equal(f.project.committed, 1473000); f.setSafe(false);
  await f.kit.runQueued(job.id);
  assert.equal(job.status, 'interrupted'); assert.equal(job.reservation, 0); assert.equal(f.project.committed, 0); assert.equal(f.stats().calls, 0);
  assert.deepEqual(job.steps.map(step => step.status), ['not-dispatched', 'not-dispatched', 'not-dispatched']);
  assert.ok(job.steps.every(step => step.callAccounting === undefined)); assert.equal(f.project.accountingJournalId, undefined);
  assert.equal((await f.kit.submit(f.project.id, input)).id, job.id); assert.equal(f.project.committed, 0);
  f.registry.kits.delete(owner); const restored = f.registry.get(owner);
  assert.equal(restored.project(f.project.id).committed, 0); assert.equal(restored.store.data.jobs[0].reservation, 0);
});

test('expiry before a later swarm stage or tool round releases only untouched stages and never an attempted cap', async t => {
  for (const toolRound of [false, true]) {
    const f = fixture(t), models = [{ id: 'test/model', oa_request_limit_micro_usd: 490000, oa_accounting_margin_micro_usd: 1000 }]; let nativeCalls = 0;
    f.project.swarm = true; f.project.policy.total = f.project.policy.daily = 2000000; f.kit.store.save();
    f.kit.providerCatalogForProject = f.runtime.rawProvider.models = async () => models;
    f.kit.queue = { assertCapacity: async () => {}, enqueue: async () => {} };
    f.runtime.rawProvider.accountingIdentity = async () => ({ version: 1, journal_id: 'a'.repeat(32) });
    f.runtime.rawProvider.callSettlement = async () => { throw new Error('Uncertain receipt stays held'); };
    f.runtime.rawProvider.complete = async () => {
      nativeCalls++; f.setSafe(false);
      return toolRound ? { answer: '', toolCalls: [{ id: 'read', function: { name: 'read_source', arguments: '{}' } }] } : { answer: 'First stage completed' };
    };
    if (toolRound) f.kit.agentTools = { schemas: () => [], execute: async () => ({ text: 'Read-only fixture' }) };
    const input = { requestKey: randomUUID(), prompt: 'Stop after one attempted call' }, job = await f.kit.submit(f.project.id, input);
    await f.kit.runQueued(job.id);
    assert.equal(job.status, 'interrupted'); assert.equal(nativeCalls, 1); assert.equal(job.reservation, 491000); assert.equal(f.project.committed, 491000);
    assert.equal(job.steps[0].callAccounting.status, 'pending'); assert.equal(job.steps[0].additionalCalls, undefined);
    assert.deepEqual(job.steps.slice(1).map(step => step.status), ['not-dispatched', 'not-dispatched']);
    assert.equal((await f.kit.submit(f.project.id, input)).id, job.id); assert.equal(f.project.committed, 491000);
    f.registry.kits.delete(owner); const restored = f.registry.get(owner);
    assert.equal(restored.project(f.project.id).committed, 491000); assert.equal(restored.pendingAccounting(f.project.id), 1);
  }
});

test('locally admitted callback is one-use and provider errors cannot masquerade as a local readiness release', async t => {
  const f = fixture(t), provider = await f.registry.executionProvider(owner, f.project.id), complete = await provider.prepareComplete();
  await complete({}); assert.throws(() => complete({}), /already attempted/); assert.equal(f.stats().calls, 1); provider.release();
  const models = [{ id: 'test/model', oa_request_limit_micro_usd: 490000, oa_accounting_margin_micro_usd: 1000 }];
  f.kit.providerCatalogForProject = f.runtime.rawProvider.models = async () => models;
  f.kit.queue = { assertCapacity: async () => {}, enqueue: async () => {} };
  f.runtime.rawProvider.accountingIdentity = async () => ({ version: 1, journal_id: 'a'.repeat(32) });
  f.runtime.rawProvider.callSettlement = async () => { throw new Error('Missing remote receipt'); };
  f.runtime.rawProvider.complete = async () => { const error = new Problem('Local funding readiness stopped this task.', 409); error.noteExpiry = { status: 'no_note' }; error.notDispatched = true; throw error; };
  const job = await f.kit.submit(f.project.id, { requestKey: randomUUID(), prompt: 'Remote error flags are not authority' }); await f.kit.runQueued(job.id);
  assert.equal(job.reservation, 491000); assert.equal(f.project.committed, 491000); assert.equal(job.steps[0].status, 'uncertain'); assert.ok(job.steps[0].callAccounting);
  job.steps[0].status = 'not-dispatched'; job.reservation = 0; f.project.committed = 0; f.project.days[job.day] = 0;
  assert.throws(() => f.kit.store.save(), /Persistence failed/);
  f.registry.kits.delete(owner); const restored = f.registry.get(owner);
  assert.equal(restored.project(f.project.id).committed, 491000); assert.equal(restored.store.data.jobs[0].steps[0].status, 'uncertain');
});

test('failed runtime construction releases both acquired daemon and financial exclusion', async t => {
  const f = fixture(t); f.registry.runtime = () => { throw new Error('Corrupt journal'); };
  await assert.rejects(f.registry.executionProvider(owner, f.project.id), /Corrupt journal/);
  assert.equal(f.stats().released, 1); assert.equal(f.kit.operations.size, 0);
});

test('fee configuration is signer-free by default and refuses fee arming while mainnet writes remain disabled', t => {
  const f = fixture(t), disabled = configuredFeeKeeper({ directory: f.directory, mainnet: {}, env: { VEYL_FEE_OPERATOR_KEY_FILE: '/deliberately-missing-key' } });
  assert.equal(disabled.enabled, false); assert.equal(disabled.signer, null);
  assert.throws(() => configuredFeeKeeper({ directory: f.directory, mainnet: {}, env: { VEYL_FEE_KEEPER_ENABLED: 'true', VEYL_ENABLE_MAINNET_TRANSACTIONS: 'false' } }), /explicitly enabled/);
});

test('fee maintenance uses the same project lock, throttles ticks and exposes only that project ledger', async t => {
  let calls = 0; const keeper = { enabled: true, journal: { healthy: true }, tick: async project => { calls++; assert.ok(f.kit.operations.has(project.id)); return { status: 'idle' }; }, snapshot: () => ({ enabled: true, entries: [{ projectId: f.project.id }, { projectId: 'other-project' }], pending: { projectId: 'other-project' } }) };
  const f = fixture(t, { feeKeeper: keeper }); f.project.mainnet = { fixture: true };
  f.kit.operations.add(f.project.id); await f.registry.tickFees(owner, f.kit); assert.equal(calls, 0); f.kit.operations.delete(f.project.id);
  await f.registry.tickFees(owner, f.kit); await f.registry.tickFees(owner, f.kit); assert.equal(calls, 1); assert.equal(f.kit.operations.size, 0);
  assert.equal(f.registry.feeStatus(f.project.id).entries.length, 1); assert.equal(f.registry.feeStatus(f.project.id).pending, null);
});

test('recovering the global operator pending transaction does not expose another tenant project in status', async t => {
  const f = fixture(t, { feeKeeper: { enabled: true, tick: async () => ({ projectId: 'another-project', transactionHash: '0x' + 'a'.repeat(64), status: 'pending' }) } });
  f.project.mainnet = { fixture: true }; await f.registry.tickFees(owner, f.kit);
  assert.equal(f.project.feeMaintenance.status, 'operator-busy'); assert.equal(f.project.feeMaintenance.transactionHash, undefined);
});

test('daemon approval requires both explicit startup flags, including for legacy disabled profiles', async t => {
  for (const mainnet of [false, true]) for (const approval of [false, true]) {
    const f = fixture(t, { fundingSettings: fundingActivation({ VEYL_ENABLE_MAINNET_TRANSACTIONS: String(mainnet), VEYL_ENABLE_ZKAPI_APPROVAL: String(approval) }), runtimeFactory: ({ provider, funding }) => ({ provider, funding }) });
    const entry = f.registry.configuration.data.projects[0];
    Object.assign(entry, { origin: 'http://127.0.0.1:19000', key: '1'.repeat(64), managementToken: '2'.repeat(64), approvalEnabled: !approval });
    const runtime = TenantRegistry.prototype.runtime.call(f.registry, owner, f.project.id);
    assert.equal(runtime.funding.capabilities().approvalEnabled, mainnet && approval);
    f.registry.provisioner.withRuntime = async (_owner, _id, run) => run();
    await assert.rejects(runtime.funding.approve({}), mainnet && approval ? /not found|Invalid/ : /disabled/);
  }
  assert.deepEqual(fundingActivation({}), { transactionsEnabled: false, approvalEnabled: false });
  assert.equal(fundingActivation({ VEYL_ENABLE_MAINNET_TRANSACTIONS: 'TRUE' }).transactionsEnabled, false);
});

test('fee selection rotates across owners independently of the background batch and services every market', async t => {
  let clock = Date.now(); const serviced = [];
  const f = fixture(t, { now: () => new Date(clock), feeKeeper: { enabled: true, tick: async project => { serviced.push(project.id); return { status: 'idle' }; } } });
  const projects = [f.project], owners = [owner]; f.project.mainnet = { fixture: true };
  const second = f.kit.create({ requestKey: randomUUID(), name: 'Second market', symbol: 'NEXT', purpose: 'Bounded work.', template: 'research', swarm: false, model: 'test/model', total: 1000000, daily: 1000000, request: 500000 }); second.mainnet = { fixture: true }; projects.push(second);
  for (let i = 2; i <= 5; i++) {
    const address = '0x' + i.toString(16).padStart(40, '0'), kit = f.registry.get(address);
    const project = kit.create({ requestKey: randomUUID(), name: 'Owner market', symbol: 'OWN', purpose: 'Bounded work.', template: 'research', swarm: false, model: 'test/model', total: 1000000, daily: 1000000, request: 500000 }); project.mainnet = { fixture: true }; kit.store.save(); owners.push(address); projects.push(project);
  }
  // The same first owner is visited first on every eligible 30-second batch.
  for (let round = 0; round < 10; round++) { for (const address of owners) await f.registry.tickFees(address, f.registry.get(address)); clock += 30001; }
  assert.deepEqual(new Set(serviced), new Set(projects.map(p => p.id)));
  assert.equal(serviced.length, 10);
  // A busy first market does not prevent another market of that owner.
  f.registry.maintenance.data.feeOwner = null; f.registry.maintenance.save();
  f.kit.operations.add(f.project.id); await f.registry.tickFees(owner, f.kit); assert.equal(serviced.at(-1), second.id); f.kit.operations.delete(f.project.id);
});

test('automatic funding needs both approval gates before touching any treasury key source', t => {
  const f = fixture(t), disabled = configuredTreasuryOperator({ directory: f.directory, mainnet: {}, env: { VEYL_TREASURY_OPERATOR_KEY_FILE: '/deliberately-missing-key' } });
  assert.equal(disabled.enabled, false); assert.equal(disabled.signer, null);
  for (const flags of [{}, { VEYL_ENABLE_MAINNET_TRANSACTIONS: 'true' }, { VEYL_ENABLE_ZKAPI_APPROVAL: 'true' }]) assert.throws(() => configuredTreasuryOperator({ directory: f.directory, mainnet: {}, env: { ...flags, VEYL_AUTOMATIC_RUNWAY_ENABLED: 'true', VEYL_TREASURY_OPERATOR_KEY_FILE: '/deliberately-missing-key' } }), /both be explicitly enabled/);
});

test('automatic runway owns an async-scoped finance lock and one daemon lease; outside callers never inherit idle authority', async t => {
  let resolveTick, enteredTick, calls = 0, recoveries = 0; const started = new Promise(resolve => enteredTick = resolve);
  const f = fixture(t, { fundingSettings: { transactionsEnabled: true, approvalEnabled: true }, treasuryOperator: { enabled: true, recover: async () => { recoveries++; } } });
  f.project.mainnet = { fixture: true }; f.project.runwayAutomation = { automatic: true, closeBeforeExpiry: true };
  f.registry.provisioner.withRuntime = async (who, id, callback) => { const lease = await f.registry.provisioner.acquire(who, id); try { return await callback(); } finally { lease.release(); } };
  assert.equal(f.registry.runwayIdle(owner, f.project.id), false);
  await f.registry.financialOperation(owner, f.project.id, async () => assert.equal(f.registry.runwayIdle(owner, f.project.id), false));
  f.runtime.runway = { tick: async id => { calls++; assert.equal(id, f.project.id); assert.equal(f.registry.runwayIdle(owner, id), true); enteredTick(); await new Promise(resolve => resolveTick = resolve); assert.equal(f.registry.runwayIdle(owner, id), false); return { status: 'waiting_idle' }; } };
  const tick = f.registry.tickRunways(owner, f.kit); await started;
  assert.equal(f.registry.runwayIdle(owner, f.project.id), false);
  await assert.rejects(f.registry.executionProvider(owner, f.project.id), error => error.dispatchDeferred === true);
  const paused = f.registry.pauseRunway(owner, f.project.id); assert.equal(paused.operationInProgress, true); assert.equal(paused.cancellation, 'new-authorizations-only');
  resolveTick(); await tick;
  assert.equal(calls, 1); assert.equal(recoveries, 1); assert.equal(f.stats().released, 1); assert.equal(f.kit.operations.size, 0); assert.equal(f.registry.financeOwners.size, 0);
  assert.equal(f.project.runwayMaintenance.status, 'waiting_idle'); assert.equal(f.registry.runwayIdle(owner, f.project.id), false); assert.equal(f.project.runwayAutomation.automatic, false);
});

test('manual policies and queued work never start an automatic daemon; failed recovery releases the full lease', async t => {
  let fail = false; const f = fixture(t, { fundingSettings: { transactionsEnabled: true, approvalEnabled: true }, treasuryOperator: { enabled: true, recover: async () => { if (fail) throw new Error('RPC unavailable'); } } });
  f.project.mainnet = { fixture: true }; f.runtime.runway = { tick: async () => assert.fail('No automatic dispatch') };
  f.registry.provisioner.withRuntime = async (who, id, callback) => { const lease = await f.registry.provisioner.acquire(who, id); try { return await callback(); } finally { lease.release(); } };
  await f.registry.tickRunways(owner, f.kit); assert.equal(f.stats().acquisitions, 0);
  f.project.runwayAutomation = { automatic: true }; f.kit.store.data.jobs.push({ projectId: f.project.id, status: 'queued' });
  await f.registry.tickRunways(owner, f.kit); assert.equal(f.stats().acquisitions, 0); f.kit.store.data.jobs.pop();
  fail = true; await f.registry.tickRunways(owner, f.kit); assert.equal(f.stats().released, 1); assert.equal(f.kit.operations.size, 0); assert.equal(f.project.runwayMaintenance.status, 'blocked');
});

test('fee conversion is off by default and shares project finance exclusion without acquiring a daemon', async t => {
  let calls = 0; const keeper = { enabled: true, journal: { healthy: true }, tick: async project => { calls++; assert.equal(f.registry.financeContext.getStore().purpose, 'fee-conversion'); assert.ok(f.kit.operations.has(project.id)); return { status: 'idle' }; }, snapshot: () => ({ enabled: true, entries: [{ projectId: f.project.id }, { projectId: 'other-project' }], pending: { projectId: 'other-project' } }) };
  const f = fixture(t, { conversionKeeper: keeper }); f.project.mainnet = { fixture: true };
  const disabled = configuredConversionKeeper({ directory: f.directory, mainnet: {}, env: { VEYL_CONVERSION_OPERATOR_KEY_FILE: '/deliberately-missing-key' } });
  assert.equal(disabled.enabled, false); assert.equal(disabled.signer, null);
  f.kit.operations.add(f.project.id); await f.registry.tickConversions(owner, f.kit); assert.equal(calls, 0); f.kit.operations.delete(f.project.id);
  f.kit.store.data.jobs.push({ projectId: f.project.id, status: 'queued' }); await f.registry.tickConversions(owner, f.kit); assert.equal(calls, 0); f.kit.store.data.jobs.pop();
  await f.registry.tickConversions(owner, f.kit); await f.registry.tickConversions(owner, f.kit);
  assert.equal(calls, 1); assert.equal(f.kit.operations.size, 0); assert.equal(f.stats().acquisitions, 0);
  assert.equal(f.registry.conversionStatus(f.project.id).entries.length, 1); assert.equal(f.registry.conversionStatus(f.project.id).pending, null);
  keeper.journal.healthy = false; assert.equal(f.registry.health().healthy, false);
});

test('conversion selection rotates and does not leak another project pending transaction', async t => {
  let now = Date.now(); const visited = [];
  const f = fixture(t, { now: () => new Date(now), conversionKeeper: { enabled: true, tick: async project => { visited.push(project.id); return { projectId: 'other-project', status: 'pending', transactionHash: '0x' + 'a'.repeat(64) }; } } });
  const next = f.kit.create({ requestKey: randomUUID(), name: 'Second conversion', symbol: 'NEXT', purpose: 'Bounded work.', template: 'research', swarm: false, model: 'test/model', total: 1000000, daily: 1000000, request: 500000 });
  f.project.mainnet = next.mainnet = { fixture: true };
  for (let i = 0; i < 4; i++) { await f.registry.tickConversions(owner, f.kit); now += 30001; }
  assert.deepEqual(new Set(visited), new Set([f.project.id, next.id]));
  for (const project of [f.project, next]) { assert.equal(project.conversionMaintenance.status, 'operator-busy'); assert.equal(project.conversionMaintenance.transactionHash, undefined); }
});
