import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { WalletAuth } from '../src/auth.mjs';
import { ResourceBudget } from '../src/resource-budget.mjs';
import { TenantRegistry } from '../src/production.mjs';

const alice = '0x0000000000000000000000000000000000000001', bob = '0x0000000000000000000000000000000000000002';
function directory(t) { const path = mkdtempSync(resolve(tmpdir(), 'veyl-capacity-')); t.after(() => { assert.ok(path.startsWith(resolve(tmpdir(), 'veyl-capacity-'))); rmSync(path, { recursive: true, force: true }); }); return path; }
const input = () => ({ requestKey: randomUUID(), name: 'Saved agent', symbol: 'TEST', purpose: 'Run bounded work.', template: 'research', swarm: false, model: 'fixture/model', total: 5_000_000, daily: 3_000_000, request: 1_000_000 });
const models = [{ id: 'fixture/model', oa_request_limit_micro_usd: 500_000 }];
function registry(t, options = {}) { return new TenantRegistry({ directory: directory(t), key: randomBytes(32), mainnet: {}, maxLoadedTenants: 1, ...options }); }

test('global session cap rejects free additional wallets without consuming their valid challenges', async () => {
  const state = { version: 1, challenges: [], sessions: [] }, auth = new WalletAuth({ origin: 'https://veyl.sh', state, save() {}, verify: async () => true, maxChallenges: 2, maxSessions: 1 });
  const a = auth.challenge({ address: alice, chainId: 1 }), b = auth.challenge({ address: bob, chainId: 1 });
  assert.throws(() => auth.challenge({ address: bob, chainId: 1 }), /temporarily busy/);
  const signature = '0x' + '11'.repeat(65);
  await auth.authenticate({ id: a.id, signature });
  await assert.rejects(auth.authenticate({ id: b.id, signature }), /session capacity/);
  assert.equal(state.sessions.length, 1); assert.equal(state.challenges[0].id, b.id);
});

test('disk admission fails closed for exhaustion and inspection errors without removing state', t => {
  let time = 0, value = { bytes: 50, files: 1, available: 1000 }, reads = 0;
  const path = directory(t), file = resolve(path, 'recovery.json'); writeFileSync(file, 'keep');
  const budget = new ResourceBudget({ directory: path, maxBytes: 100, minFreeBytes: 100, now: () => time, inspect: () => { reads++; if (value instanceof Error) throw value; return value; } });
  budget.assertCapacity(); value.bytes = 101; budget.assertCapacity(); assert.equal(reads, 1);
  time = 10001; assert.throws(() => budget.assertCapacity(), /storage limit/);
  value = { bytes: 10, files: 1, available: 99 }; time += 10001; assert.throws(() => budget.assertCapacity(), /free space/);
  value = new Error('unsafe'); time += 10001; assert.throws(() => budget.assertCapacity(), /storage limit/);
  assert.equal(budget.snapshot().error, 'Storage cannot be inspected safely.');
});

test('tenant cache preserves encrypted state and cannot evict active request pins or unhealthy ledgers', t => {
  const r = registry(t), kit = r.get(alice), project = kit.create(input()); kit.note(project.id, 'Persist across eviction');
  const held = r.pin(alice); assert.throws(() => r.get(bob), /memory slots/); held.release(); held.release();
  r.get(bob); assert.equal(r.kits.size, 1); assert.equal(r.kits.has(alice), false);
  const restored = r.get(alice); assert.equal(restored.project(project.id).notes[0].content, 'Persist across eviction');
  restored.store.healthy = false; assert.throws(() => r.get(bob), /memory slots/);
});

test('unloaded queued owner executes once after scheduler makes its live dispatch durable', async t => {
  const r = registry(t), kit = r.get(alice), project = kit.create(input()); let executions = 0, releases = 0;
  r.catalog = async () => models;
  r.inferenceAdmission = async () => ({ status: 'healthy', canInfer: true }); // Explicit funded fixture.
  r.executionProvider = async () => ({ mode: 'zkapi', models: async () => models, complete: async () => { executions++; return { answer: 'Completed after cache eviction', verification: 'fixture' }; }, release: () => releases++ });
  const job = await kit.submit(project.id, { requestKey: randomUUID(), prompt: 'Run after eviction.' });
  r.get(bob); assert.equal(r.kits.has(alice), false);
  await r.scheduler.tick(); await r.scheduler.drain();
  assert.equal(executions, 1); assert.equal(releases, 1); assert.equal(r.scheduler.get(alice, job.id).status, 'completed');
  assert.equal(r.get(alice).store.data.jobs[0].status, 'completed');
  await r.scheduler.tick(); await r.scheduler.drain(); assert.equal(executions, 1);
});

test('queued work survives worker restart but a prior durable running dispatch never retries', async t => {
  const path = directory(t), key = randomBytes(32), options = { directory: path, key, mainnet: {}, maxLoadedTenants: 1 };
  const first = new TenantRegistry(options), kit = first.get(alice), project = kit.create(input()); first.catalog = async () => models;
  first.inferenceAdmission = async () => ({ status: 'healthy', canInfer: true });
  const job = await kit.submit(project.id, { requestKey: randomUUID(), prompt: 'Saved queue.' }); first.scheduler.stop();
  const second = new TenantRegistry(options); let executions = 0;
  second.executionProvider = async () => ({ mode: 'zkapi', models: async () => models, complete: async () => { executions++; return { answer: 'Restarted queue', verification: 'fixture' }; }, release() {} });
  await second.scheduler.tick(); await second.scheduler.drain(); assert.equal(executions, 1); assert.equal(second.get(alice).store.data.jobs[0].status, 'completed'); second.scheduler.stop();
  const k = second.get(alice); second.catalog = async () => models;
  second.inferenceAdmission = async () => ({ status: 'healthy', canInfer: true });
  // Simulate a crash after the queue's durable dispatch but before model output.
  second.scheduler.stopped = false;
  const uncertain = await k.submit(project.id, { requestKey: randomUUID(), prompt: 'Interrupted dispatch.' }); second.scheduler.stop();
  const entry = second.scheduler.get(alice, uncertain.id); entry.status = 'running'; entry.startedAt = Date.now(); second.scheduler.save();
  const third = new TenantRegistry(options); third.executionProvider = async () => { executions++; throw new Error('Must never acquire'); };
  await third.scheduler.tick(); await third.scheduler.drain(); assert.equal(executions, 1);
  assert.equal(third.scheduler.get(alice, uncertain.id).status, 'uncertain'); assert.equal(third.get(alice).store.data.jobs.find(j => j.id === uncertain.id).status, 'interrupted');
  assert.equal(third.get(alice).project(project.id).committed, 1_000_000); third.scheduler.stop();
});
