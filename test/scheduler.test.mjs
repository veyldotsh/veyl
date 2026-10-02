import test from 'node:test';
import assert from 'node:assert/strict';
import { GlobalScheduler } from '../src/scheduler.mjs';

const owner = n => `0x${String(n).repeat(40)}`;
const entry = (n, job = `job-${n}`, projectId = `project-${n}`) => ({ owner: owner(n), projectId, jobId: job, reservation: 500000 });
const initial = () => ({ version: 1, sequence: 0, lastOwner: null, entries: [] });
function fixture(options = {}) {
  let now = 1000, disk = initial(), saves = 0;
  const calls = [], notifications = [], gates = new Map(), state = options.state || initial();
  const scheduler = new GlobalScheduler({ state, now: () => now, ...options,
    save() { saves++; if (options.failSave === saves) throw new Error('disk unavailable'); disk = structuredClone(state); },
    run: options.run || ((item, context) => { calls.push(item); return new Promise(resolve => gates.set(item.jobId, { resolve, context })); }),
    onUncertain: options.onUncertain || (async item => notifications.push(['uncertain', item.jobId])),
    onCancel: options.onCancel || (async item => notifications.push(['cancelled', item.jobId]))
  });
  async function finish(jobId, result = { status: 'completed' }) {
    const item = [...scheduler.active.values()].find(item => item.entry.jobId === jobId);
    gates.get(jobId).resolve(result); await item.promise;
  }
  return { scheduler, state, calls, notifications, gates, finish, disk: () => disk, saves: () => saves, setNow: value => { now = value; } };
}

test('global queue bounds active execution and serves wallets fairly with one active job per owner', async () => {
  const f = fixture();
  for (const item of [entry(1, 'a-1'), entry(1, 'a-2'), entry(2, 'b-1'), entry(3, 'c-1')]) f.scheduler.enqueue(item);
  await f.scheduler.tick(); assert.deepEqual(f.calls.map(c => c.jobId), ['a-1', 'b-1']); assert.equal(f.scheduler.active.size, 2);
  await f.finish('a-1'); await f.scheduler.tick(); assert.equal(f.calls.at(-1).jobId, 'c-1'); assert.equal(f.scheduler.active.size, 2);
  await f.finish('b-1'); await f.scheduler.tick(); assert.equal(f.calls.at(-1).jobId, 'a-2');
  await f.finish('c-1'); await f.finish('a-2'); await f.scheduler.tick();
  assert.equal(f.scheduler.snapshot().active, 0); assert.equal(f.scheduler.snapshot().queued, 0);
  assert.ok(f.state.entries.every(e => e.status === 'completed'));
});

test('durable running checkpoint precedes every callback and concurrent ticks cannot double-dispatch', async () => {
  const state = initial(), calls = []; let disk;
  const scheduler = new GlobalScheduler({ state, save: () => { disk = structuredClone(state); }, run: async item => {
    assert.equal(disk.entries.find(e => e.id === item.id).status, 'running'); calls.push(item.jobId); return { status: 'completed' };
  } });
  scheduler.enqueue(entry(1)); await Promise.all([scheduler.tick(), scheduler.tick(), scheduler.tick()]); await scheduler.drain();
  assert.deepEqual(calls, ['job-1']); assert.equal(scheduler.get(owner(1), 'job-1').status, 'completed');
});

test('queue and wallet capacity are checked before admitting another reserved job', async () => {
  const f = fixture({ maxQueued: 3, maxPerOwner: 2 });
  f.scheduler.enqueue(entry(1, 'a-1')); f.scheduler.enqueue(entry(1, 'a-2'));
  assert.throws(() => f.scheduler.assertCapacity(owner(1)), /wallet/);
  f.scheduler.enqueue(entry(2, 'b-1')); assert.throws(() => f.scheduler.enqueue(entry(3)), /full/);
  await f.scheduler.tick(); assert.throws(() => f.scheduler.assertCapacity(owner(3)), /full/); // Running retains its admission place.
  await f.finish('a-1'); assert.equal(f.scheduler.assertCapacity(owner(3)), true);
  await f.finish('b-1');
});

test('replayed job identity is idempotent and changed project or reservation is rejected', async () => {
  const f = fixture({ run: async () => ({ status: 'completed' }) });
  const first = f.scheduler.enqueue(entry(1));
  assert.deepEqual(f.scheduler.enqueue(entry(1)), first); assert.equal(f.state.entries.length, 1);
  assert.throws(() => f.scheduler.enqueue({ ...entry(1), reservation: 1 }), /different/);
  assert.throws(() => f.scheduler.enqueue({ ...entry(1), projectId: 'other-project' }), /different/);
  await f.scheduler.tick(); await f.scheduler.drain(); assert.equal(f.scheduler.enqueue(entry(1)).status, 'completed');
  await f.scheduler.tick(); assert.equal(f.state.entries.length, 1);
});

test('restart preserves only proven queued records and never retries an in-flight dispatch', async () => {
  const f = fixture(); f.scheduler.enqueue(entry(1)); f.scheduler.enqueue(entry(2)); await f.scheduler.tick();
  // Snapshot one running dispatch plus one queued job, equivalent to a crash
  // just after the first dispatch marker was durably written.
  const saved = f.disk(); saved.entries[1].status = 'queued'; delete saved.entries[1].startedAt;
  const recovered = fixture({ state: saved, run: async item => { assert.equal(item.jobId, 'job-2'); return { status: 'completed' }; } });
  assert.equal(recovered.scheduler.get(owner(1), 'job-1').status, 'uncertain');
  assert.equal(recovered.scheduler.canRestore(owner(1), 'project-1', 'job-1', 500000), false);
  assert.equal(recovered.scheduler.canRestore(owner(2), 'project-2', 'job-2', 500000), true);
  assert.equal(recovered.scheduler.canRestore(owner(2), 'wrong-project', 'job-2', 500000), false);
  assert.equal(recovered.scheduler.canRestore(owner(2), 'project-2', 'job-2', 499999), false);
  await recovered.scheduler.tick(); await recovered.scheduler.drain();
  assert.deepEqual(recovered.notifications, [['uncertain', 'job-1']]);
  assert.equal(recovered.scheduler.get(owner(2), 'job-2').status, 'completed');
  await f.finish('job-1'); await f.finish('job-2');
});

test('unknown execution failure is terminal uncertain and never treated as capacity deferral', async () => {
  let calls = 0;
  const f = fixture({ run: async () => { calls++; throw new Error('unknown outcome'); } });
  f.scheduler.enqueue(entry(1)); await f.scheduler.tick(); await f.scheduler.drain(); await f.scheduler.tick();
  assert.equal(calls, 1); assert.equal(f.scheduler.get(owner(1), 'job-1').status, 'uncertain');
  assert.deepEqual(f.notifications, [['uncertain', 'job-1']]);
});

test('explicit no-dispatch capacity deferral preserves identity and backs off before retrying', async () => {
  let calls = 0;
  const f = fixture({ run: async () => (++calls === 1 ? { deferred: true } : { status: 'completed' }) });
  f.scheduler.enqueue(entry(1)); await f.scheduler.tick(); await f.scheduler.drain();
  const queued = f.scheduler.get(owner(1), 'job-1'); assert.equal(queued.status, 'queued'); assert.equal(queued.reservation, 500000); assert.equal(queued.nextAttemptAt, 2000);
  await f.scheduler.tick(); f.setNow(1999); await f.scheduler.tick(); assert.equal(calls, 1);
  f.setNow(2000); await f.scheduler.tick(); await f.scheduler.drain(); assert.equal(calls, 2);
  assert.equal(f.state.entries.length, 1); assert.equal(f.scheduler.get(owner(1), 'job-1').status, 'completed');
});

test('queued cancellation is wallet-scoped, durable before bookkeeping, and cannot reach execution', async () => {
  const f = fixture(); f.scheduler.enqueue(entry(1));
  await assert.rejects(f.scheduler.cancel(owner(2), 'job-1'), e => e.status === 404);
  const result = await f.scheduler.cancel(owner(1), 'job-1'); assert.equal(result.status, 'cancelled'); assert.equal(result.reservation, 500000);
  assert.equal(f.disk().entries[0].status, 'cancelled'); await f.scheduler.tick(); assert.equal(f.calls.length, 0);
  assert.deepEqual(f.notifications, [['cancelled', 'job-1']]); assert.equal(f.scheduler.enqueue(entry(1)).status, 'cancelled');
});

test('running cancellation is a signal only and makes no claim that an in-flight paid call was refunded', async () => {
  const f = fixture(); f.scheduler.enqueue(entry(1)); await f.scheduler.tick();
  const result = await f.scheduler.cancel(owner(1), 'job-1');
  assert.equal(result.status, 'running'); assert.equal(result.cancelRequested, true); assert.equal(result.reservation, 500000);
  assert.equal(f.gates.get('job-1').context.signal.aborted, true);
  await f.finish('job-1', { status: 'interrupted' }); assert.equal(f.scheduler.get(owner(1), 'job-1').status, 'uncertain');
});

test('notification persistence failures retry only bookkeeping, never the cancelled job', async () => {
  let notices = 0;
  const f = fixture({ onCancel: async () => { if (++notices === 1) throw new Error('tenant store temporarily blocked'); } });
  f.scheduler.enqueue(entry(1)); const result = await f.scheduler.cancel(owner(1), 'job-1'); assert.equal(result.notificationPending, 'cancelled');
  await f.scheduler.tick(); assert.equal(f.calls.length, 0); assert.equal(notices, 2); assert.equal(f.state.entries[0].notificationPending, undefined);
});

test('failed dispatch checkpoint blocks execution and all later admissions', async () => {
  const f = fixture({ failSave: 2 }); f.scheduler.enqueue(entry(1));
  await assert.rejects(f.scheduler.tick(), /persistence failed/); assert.equal(f.calls.length, 0); assert.equal(f.disk().entries[0].status, 'queued');
  assert.throws(() => f.scheduler.enqueue(entry(2)), /persistence is blocked/);
});

test('failed completion persistence blocks further dispatch and recovers the last durable dispatch as uncertain', async () => {
  const f = fixture({ failSave: 3, run: async () => ({ status: 'completed' }) }); f.scheduler.enqueue(entry(1));
  await f.scheduler.tick(); await f.scheduler.drain(); assert.equal(f.scheduler.healthy, false); assert.equal(f.disk().entries[0].status, 'running');
  await assert.rejects(f.scheduler.tick(), /persistence is blocked/);
  const recovered = fixture({ state: f.disk() }); assert.equal(recovered.scheduler.get(owner(1), 'job-1').status, 'uncertain');
});

test('graceful drain leaves queued work durable and does not start further jobs', async () => {
  const f = fixture({ activeSlots: 1 }); f.scheduler.enqueue(entry(1)); f.scheduler.enqueue(entry(2)); await f.scheduler.tick();
  f.scheduler.stop(); await f.finish('job-1'); await f.scheduler.drain(); await f.scheduler.tick();
  assert.equal(f.calls.length, 1); assert.equal(f.scheduler.get(owner(2), 'job-2').status, 'queued');
  assert.throws(() => f.scheduler.enqueue(entry(3)), /draining/);
});

test('tenant snapshots omit other wallet metadata and terminal IDs have an explicit retention bound', async () => {
  const f = fixture({ maxQueued: 2, maxPerOwner: 2, maxEntries: 2, run: async () => ({ status: 'completed' }) });
  f.scheduler.enqueue(entry(1)); f.scheduler.enqueue(entry(2)); await f.scheduler.tick(); await f.scheduler.drain();
  assert.deepEqual(f.scheduler.snapshot(owner(1)).entries.map(e => e.owner), [owner(1)]);
  assert.throws(() => f.scheduler.enqueue(entry(3)), /retention/); assert.equal(f.state.entries.length, 2);
  const corrupt = f.disk(); corrupt.entries[0].status = 'retry'; assert.throws(() => fixture({ state: corrupt }), /recovery entry/);
});

test('a 100-job cross-tenant burst drains through two slots without duplicate execution', async () => {
  let active = 0, peak = 0; const executed = new Set();
  const f = fixture({ run: async item => {
    assert.equal(executed.has(item.id), false); executed.add(item.id); peak = Math.max(peak, ++active);
    await new Promise(resolve => setImmediate(resolve)); active--; return { status: 'completed' };
  } });
  for (let tenant = 1; tenant <= 10; tenant++) for (let i = 0; i < 10; i++) f.scheduler.enqueue({ owner: '0x' + tenant.toString(16).repeat(40), projectId: `project-${tenant}`, jobId: `burst-${tenant}-${i}`, reservation: 500000 });
  assert.equal(f.scheduler.snapshot().queued, 100); assert.throws(() => f.scheduler.assertCapacity(owner(1)), /full/);
  while (f.scheduler.snapshot().queued) { await f.scheduler.tick(); await f.scheduler.drain(); }
  assert.equal(executed.size, 100); assert.equal(peak, 2); assert.equal(active, 0);
  assert.ok(f.state.entries.every(e => e.status === 'completed'));
});
