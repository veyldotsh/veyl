import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Kit } from '../src/kit.mjs';
import { Store, MODEL_OUTPUT_RESERVE_BYTES } from '../src/store.mjs';
import { Problem } from '../src/agent.mjs';

function setup(t, { maxBytes = 1024 * 1024, queue = false, tools = null, complete } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'veyl-storage-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'kit.json'), calls = [], entries = []; let now = new Date('2026-10-01T12:00:00Z'), capacityError;
  const provider = { mode: 'zkapi', models: async () => { calls.push('models'); return [{ id: 'fixture/model', oa_request_limit_micro_usd: 100_000 }]; }, complete: async body => { calls.push('complete'); return complete ? complete(body) : { answer: 'Result', verification: 'fixture' }; } };
  const store = new Store(file, 'zkapi', undefined, { maxBytes });
  const kit = new Kit({ store, provider, chain: {}, agentTools: tools, now: () => now, queue: queue ? { assertCapacity: () => { calls.push('capacity'); if (capacityError) throw capacityError; }, enqueue: entry => entries.push(entry) } : null });
  const p = kit.create({ requestKey: randomUUID(), name: 'Bounded storage', symbol: 'STORE', template: 'research', purpose: 'Keep recovery records.', swarm: false, model: 'fixture/model', total: 10_000_000, daily: 10_000_000, request: 100_000 });
  return { file, store, kit, p, calls, entries, setNow: v => { now = new Date(v); }, setCapacityError: v => { capacityError = v; } };
}
const submit = f => f.kit.submit(f.p.id, { requestKey: randomUUID(), prompt: 'A bounded task' });
function fillAdmissionSpace(f, leave = 0) {
  // The 64-byte margin covers the field name and JSON punctuation.
  f.p.padding = 'x'.repeat(Math.max(0, f.store.storage().availableBytes - leave - 64)); f.store.save();
}

test('storage exhaustion rejects admission before catalog I/O or financial reservation', async t => {
  const f = setup(t, { queue: true }); fillAdmissionSpace(f);
  const disk = readFileSync(f.file, 'utf8');
  await assert.rejects(submit(f), e => e.status === 507 && e.code === 'TENANT_STORAGE_FULL');
  assert.deepEqual(f.calls, ['capacity']); assert.equal(f.p.committed, 0); assert.equal(f.store.data.jobs.length, 0);
  assert.equal(readFileSync(f.file, 'utf8'), disk); assert.equal(f.store.healthy, true);
  assert.throws(() => f.kit.note(f.p.id, 'x'.repeat(1000)), /storage is full/); assert.equal(f.p.notes.length, 0);
});

test('queued output reservations survive proven restart and prevent over-admission', async t => {
  const f = setup(t, { queue: true }), job = await submit(f);
  assert.equal(job.storageReservationBytes, 2 * MODEL_OUTPUT_RESERVE_BYTES);
  const held = f.p.committed, restored = new Store(f.file, 'zkapi', undefined, { maxBytes: 1024 * 1024, preserveQueued: entry => entry.id === job.id });
  assert.equal(restored.data.jobs[0].status, 'queued'); assert.equal(restored.storage().reservedBytes, job.storageReservationBytes);
  await assert.rejects(submit(f), /storage is full/); assert.equal(f.p.committed, held); assert.equal(f.entries.length, 1);
  const interrupted = new Store(f.file, 'zkapi', undefined, { maxBytes: 1024 * 1024 });
  assert.equal(interrupted.data.jobs[0].status, 'interrupted'); assert.equal(interrupted.storage().reservedBytes, 0); assert.equal(interrupted.data.projects[0].committed, held);
});

test('concurrent edits cannot consume reserved output space; worst escaping fits and accounting persists', async t => {
  let finish, started; const dispatch = new Promise(resolve => { started = resolve; });
  const f = setup(t, { complete: () => new Promise(resolve => { finish = resolve; started(); }) });
  const job = await submit(f); await dispatch;
  const persisted = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.ok(persisted.jobs[0].storageReservationBytes >= 2 * MODEL_OUTPUT_RESERVE_BYTES);
  fillAdmissionSpace(f); const held = f.p.committed;
  finish({ answer: '\u0000'.repeat(32_000), verification: 'fixture' }); await f.kit.execution;
  assert.equal(job.status, 'completed'); assert.equal(job.storageReservationBytes, 0); assert.equal(job.steps[0].output.length, 32_000);
  assert.equal(f.p.artifacts[0].content.length, 32_000); assert.equal(f.p.committed, held); assert.equal(f.store.healthy, true);
  assert.ok(f.store.storage().usedBytes <= f.store.maxBytes); assert.equal(new Store(f.file, 'zkapi', undefined, { maxBytes: 1024 * 1024 }).data.jobs[0].status, 'completed');
});

test('next paid tool round needs new output room before reserving another financial cap', async t => {
  let finish, started; const dispatch = new Promise(resolve => { started = resolve; });
  const tools = { schemas: () => [], execute: async () => ({ source: 'x'.repeat(30_000) }) };
  const f = setup(t, { tools, complete: () => new Promise(resolve => { finish = resolve; started(); }) });
  const job = await submit(f); await dispatch; fillAdmissionSpace(f);
  finish({ answer: '', toolCalls: [{ id: 'fixture-call', type: 'function', function: { name: 'read_source', arguments: '{}' } }] });
  await f.kit.execution;
  assert.equal(f.calls.filter(x => x === 'complete').length, 1); assert.equal(job.status, 'interrupted'); assert.match(job.error, /storage is full/);
  assert.equal(f.p.committed, 100_000); assert.equal(job.steps[0].additionalCalls, undefined); assert.equal(job.storageReservationBytes, 0);
  const logged = job.steps[0].toolActivity[0].result;
  assert.equal(logged.truncated, true); assert.ok(logged.originalBytes > 8192); assert.match(logged.sha256, /^[a-f0-9]{64}$/); assert.ok(Buffer.byteLength(JSON.stringify(logged)) < 8192);
  assert.equal(f.store.healthy, true); assert.equal(new Store(f.file, 'zkapi', undefined, { maxBytes: 1024 * 1024 }).data.projects[0].committed, 100_000);
});

test('oversized provider output is refused without storing it or releasing the paid cap', async t => {
  const f = setup(t, { complete: () => ({ answer: 'x'.repeat(32_001), verification: 'fixture' }) }), job = await submit(f); await f.kit.execution;
  assert.equal(job.status, 'interrupted'); assert.equal(job.steps[0].output, undefined); assert.equal(f.p.committed, 100_000); assert.equal(f.p.artifacts.length, 0); assert.equal(f.store.healthy, true);
});

test('routine events rotate explicitly while transaction and idempotency history remain', async t => {
  const f = setup(t), input = { requestKey: randomUUID(), prompt: 'Replay protection' }, job = await f.kit.submit(f.p.id, input); await f.kit.execution;
  f.kit.event(f.p, 'trade', 'Exact transaction recovery identity');
  for (let i = 0; i < 500; i++) f.kit.event(f.p, 'status', `Status ${i}`);
  f.store.save();
  assert.equal(f.p.events.filter(e => e.type !== 'trade').length, 200); assert.equal(f.p.events.find(e => e.type === 'trade').message, 'Exact transaction recovery identity'); assert.ok(f.p.routineEventsOmitted >= 300);
  assert.equal((await f.kit.submit(f.p.id, input)).id, job.id); assert.equal(f.calls.filter(x => x === 'complete').length, 1); assert.equal(f.p.committed, 100_000);
});

test('an oversized tenant file is refused before decoding and preserved unchanged', t => {
  const dir = mkdtempSync(join(tmpdir(), 'veyl-storage-file-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'kit.json'), raw = 'x'.repeat(300_000); writeFileSync(file, raw); let decoded = false;
  assert.throws(() => new Store(file, 'zkapi', { decode: () => { decoded = true; }, encode: JSON.stringify }, { maxBytes: 128 * 1024 }), /storage limit/);
  assert.equal(decoded, false); assert.equal(readFileSync(file, 'utf8'), raw);
});

test('full admission queue retains schedule and backs off without busy-looping', async t => {
  const f = setup(t, { queue: true }); f.kit.schedule(f.p.id, { enabled: true, minutes: 15, prompt: 'Scheduled work' });
  f.setNow('2026-10-01T12:15:00Z'); f.setCapacityError(new Problem('Full queue', 429)); await f.kit.tick();
  assert.equal(f.p.schedule.nextAt, '2026-10-01T12:16:00.000Z'); assert.equal(f.store.data.jobs.length, 0); assert.equal(f.p.committed, 0);
  f.setNow('2026-10-01T12:15:59Z'); await f.kit.tick(); assert.deepEqual(f.calls, ['capacity']);
  f.setNow('2026-10-01T12:16:00Z'); f.setCapacityError(null); await f.kit.tick();
  assert.equal(f.entries.length, 1); assert.equal(f.store.data.jobs[0].status, 'queued'); assert.equal(f.p.schedule.nextAt, '2026-10-01T12:31:00.000Z');
});

test('budget failure still disables a due schedule instead of retrying indefinitely', async t => {
  const f = setup(t, { queue: true }); f.p.policy.request = 1;
  f.kit.schedule(f.p.id, { enabled: true, minutes: 15, prompt: 'Scheduled work' }); f.setNow('2026-10-01T12:15:00Z'); await f.kit.tick();
  assert.equal(f.p.schedule, null); assert.equal(f.store.data.jobs.length, 0); assert.equal(f.entries.length, 0);
});
