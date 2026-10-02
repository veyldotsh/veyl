import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { TenantRegistry } from '../src/production.mjs';

const owner = '0x0000000000000000000000000000000000000001';
function fixture(t) {
  const directory = mkdtempSync(resolve(tmpdir(), 'veyl-accounting-'));
  t.after(() => { assert.ok(directory.startsWith(resolve(tmpdir(), 'veyl-accounting-'))); rmSync(directory, { force: true, recursive: true }); });
  let clock = Date.now(), acquisitions = 0, releases = 0, completions = 0, expiryChecks = 0;
  const registry = new TenantRegistry({ directory, key: randomBytes(32), mainnet: {}, now: () => new Date(clock) });
  const kit = registry.get(owner);
  const createProject = () => kit.create({ requestKey: randomUUID(), name: 'Charge recovery', symbol: 'TEST', purpose: 'Bounded work.', template: 'research', swarm: false, model: 'test/model', total: 1000000, daily: 1000000, request: 500000 });
  const project = createProject();
  registry.configuration.data.projects.push({ owner, projectId: project.id });
  registry.provisioner.acquire = async () => { acquisitions++; return { release: () => releases++ }; };
  registry.provisioner.withRuntime = async (who, id, callback) => { const lease = await registry.provisioner.acquire(who, id); try { return await callback(); } finally { lease.release(); } };
  const identity = { version: 1, journal_id: 'fixture-journal' };
  const runtime = { rawProvider: { mode: 'zkapi', models: async () => [], accountingIdentity: async () => identity, callSettlement: async callId => ({ callId, status: 'pending' }), complete: async (body, context) => { completions++; return { body, context }; } }, noteExpiryGuard: { assertCanInfer: async () => { expiryChecks++; return { status: 'healthy', canInfer: true }; } } };
  registry.runtime = () => runtime;
  return { registry, kit, project, runtime, identity, createProject, advance: amount => clock += amount, stats: () => ({ acquisitions, releases, completions, expiryChecks }) };
}

test('leased production provider preserves call accounting context and exposes receipt reads', async t => {
  const f = fixture(t), provider = await f.registry.executionProvider(owner, f.project.id);
  const body = { model: 'test/model' }, context = { callId: randomUUID(), reservedMicroUsd: 123, journalId: 'fixture-journal' };
  const result = await provider.complete(body, context);
  assert.equal(result.body, body); assert.equal(result.context, context);
  assert.equal(await provider.accountingIdentity(), f.identity);
  assert.deepEqual(await provider.callSettlement(context.callId), { callId: context.callId, status: 'pending' });
  assert.deepEqual(f.stats(), { acquisitions: 1, releases: 0, completions: 1, expiryChecks: 1 });
  provider.release(); provider.release();
  assert.equal(f.stats().releases, 1); assert.equal(f.kit.operations.size, 0);
});

test('background receipt recovery handles paused projects under one lease and lock without model dispatch', async t => {
  const f = fixture(t); f.project.status = 'paused'; f.kit.store.save();
  let called = 0, finish, started;
  const entered = new Promise(resolve => started = resolve);
  f.kit.pendingAccounting = id => id === f.project.id ? 12 : 0;
  f.kit.reconcileCalls = async (id, provider, options) => {
    called++; assert.equal(id, f.project.id); assert.equal(provider, f.runtime.rawProvider); assert.equal(options.limit, 8);
    assert.equal(f.kit.operations.has(id), true); assert.equal(f.registry.financeContext.getStore().purpose, 'accounting-reconciliation');
    started(); await new Promise(resolve => finish = resolve);
    return { checked: 8, settled: 4, pending: 8 };
  };
  const work = f.registry.tickAccounting(owner, f.kit); await entered;
  await f.registry.tickAccounting(owner, f.kit);
  await assert.rejects(f.registry.executionProvider(owner, f.project.id), error => error.dispatchDeferred === true);
  await assert.rejects(f.registry.financialOperation(owner, f.project.id, async () => assert.fail('No funding during reconciliation')), /Wait for/);
  finish(); await work;
  assert.equal(called, 1); assert.equal(f.project.accountingMaintenance.status, 'pending');
  assert.equal(f.project.accountingMaintenance.checked, 8); assert.equal(f.project.accountingMaintenance.settled, 4);
  assert.deepEqual(f.stats(), { acquisitions: 1, releases: 1, completions: 0, expiryChecks: 0 });
  assert.equal(f.kit.operations.size, 0); assert.equal(f.registry.financeOwners.size, 0);
  await f.registry.tickAccounting(owner, f.kit); assert.equal(called, 1);
});

test('receipt recovery skips active work and no-pending profiles, throttles failures and releases locks', async t => {
  const f = fixture(t); let calls = 0;
  f.kit.pendingAccounting = () => 0;
  f.kit.reconcileCalls = async () => { calls++; throw new Error('private upstream details'); };
  await f.registry.tickAccounting(owner, f.kit); assert.equal(f.stats().acquisitions, 0);
  f.kit.pendingAccounting = () => 1;
  f.kit.operations.add(f.project.id); await f.registry.tickAccounting(owner, f.kit); f.kit.operations.delete(f.project.id);
  f.kit.running = true; await f.registry.tickAccounting(owner, f.kit); f.kit.running = false;
  assert.equal(f.stats().acquisitions, 0);
  await f.registry.tickAccounting(owner, f.kit);
  assert.equal(calls, 1); assert.equal(f.project.accountingMaintenance.status, 'blocked');
  assert.ok(!JSON.stringify(f.project.accountingMaintenance).includes('private upstream'));
  assert.equal(f.kit.operations.size, 0); assert.equal(f.stats().releases, 1);
  f.advance(59999); await f.registry.tickAccounting(owner, f.kit); assert.equal(calls, 1);
  f.advance(1); await f.registry.tickAccounting(owner, f.kit); assert.equal(calls, 2);
});

test('receipt recovery rotates pending projects and retains the per-project cadence across process restart', async t => {
  const f = fixture(t), second = f.createProject(), seen = [];
  f.registry.configuration.data.projects.push({ owner, projectId: second.id });
  f.kit.pendingAccounting = () => 1;
  f.kit.reconcileCalls = async id => { seen.push(id); return { checked: 1, settled: 0, pending: 1 }; };
  await f.registry.tickAccounting(owner, f.kit); f.advance(60000);
  await f.registry.tickAccounting(owner, f.kit);
  assert.deepEqual(new Set(seen), new Set([f.project.id, second.id]));
  f.registry.lastAccountingTick = 0;
  // With the previously checked project locked, a restarted cadence cannot immediately poll the other again.
  f.kit.operations.add(seen[0]);
  await f.registry.tickAccounting(owner, f.kit); assert.equal(seen.length, 2);
  f.kit.operations.delete(seen[0]);
});
