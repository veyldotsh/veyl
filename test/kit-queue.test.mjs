import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Kit } from '../src/kit.mjs';
import { Store } from '../src/store.mjs';
import { Problem } from '../src/agent.mjs';

function setup(t, { swarm = false, queueMode = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'veyl-kit-queue-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'kit.json'), calls = [], entries = [];
  let liveCap = 500_000, capacityError, enqueueError, acquireError, completionError, releaseError, at = new Date('2026-10-01T12:00:00Z');
  const provider = { mode: 'zkapi', models: async () => { calls.push('live-catalog'); return [{ id: 'fixture/model', oa_request_limit_micro_usd: liveCap }]; },
    complete: async body => { calls.push({ complete: body.model }); if (completionError) throw completionError; assert.equal(JSON.parse(readFileSync(file, 'utf8')).jobs.at(-1).status, 'running'); return { answer: 'Reviewed result', verification: 'fixture' }; },
    release: async () => { calls.push('release'); if (releaseError) throw releaseError; } };
  const queue = { assertCapacity: () => { calls.push('capacity'); if (capacityError) throw capacityError; }, enqueue: entry => {
    calls.push('enqueue'); const saved = JSON.parse(readFileSync(file, 'utf8')), job = saved.jobs.find(j => j.id === entry.jobId);
    assert.equal(job.status, 'queued'); assert.equal(job.dispatch, 'scheduler'); assert.equal(job.reservation, entry.reservation); assert.equal(saved.projects[0].committed, entry.reservation);
    entries.push(entry); if (enqueueError) throw enqueueError; return entry;
  } };
  const store = new Store(file, 'zkapi');
  const config = { store, provider, chain: {}, now: () => at, queue: queueMode ? queue : null,
    providerCatalogForProject: async () => { calls.push('admission-catalog'); return [{ id: 'fixture/model', oa_request_limit_micro_usd: 500_000 }]; },
    providerForProject: async p => { calls.push({ acquire: p.id }); if (acquireError) throw acquireError; return provider; } };
  const kit = new Kit(config);
  const project = kit.create({ requestKey: randomUUID(), name: 'Queued test', symbol: 'QUEUE', purpose: 'Bounded work.', template: 'research', swarm, model: 'fixture/model', total: 5_000_000, daily: 3_000_000, request: 1_000_000 });
  return { kit, project, provider, store, file, calls, entries, config, setLiveCap: value => { liveCap = value; }, setCapacityError: value => { capacityError = value; }, setEnqueueError: value => { enqueueError = value; }, setAcquireError: value => { acquireError = value; }, setCompletionError: value => { completionError = value; }, setReleaseError: value => { releaseError = value; }, setDate: value => { at = new Date(value); } };
}
const submit = f => f.kit.submit(f.project.id, { requestKey: randomUUID(), prompt: 'A queued task' });
const completions = f => f.calls.filter(c => typeof c === 'object' && c.complete).length;

test('queue capacity rejects before any catalog, daemon acquisition or budget reservation', async t => {
  const f = setup(t); f.setCapacityError(new Problem('Queue full.', 429));
  await assert.rejects(submit(f), e => e.status === 429);
  assert.deepEqual(f.calls, ['capacity']); assert.equal(f.project.committed, 0); assert.equal(f.store.data.jobs.length, 0); assert.equal(f.kit.running, false);
});

test('admission durably reserves exact job before enqueue and returns queued without acquiring a daemon', async t => {
  const f = setup(t, { swarm: true }), input = { requestKey: randomUUID(), prompt: 'Exact admission' };
  const job = await f.kit.submit(f.project.id, input);
  assert.deepEqual(f.calls, ['capacity', 'admission-catalog', 'enqueue']); assert.equal(job.status, 'queued'); assert.equal(job.reservation, 1_500_000); assert.equal(job.model, 'fixture/model');
  assert.deepEqual(f.entries[0], { projectId: f.project.id, jobId: job.id, reservation: 1_500_000 }); assert.equal(completions(f), 0); assert.equal(f.kit.running, false);
  assert.equal((await f.kit.submit(f.project.id, input)).id, job.id); assert.equal(f.entries.length, 1);
  assert.throws(() => f.kit.settings(f.project.id, { model: 'changed', total: 5_000_000, daily: 3_000_000, request: 1_000_000 }), /queued/);
});

test('lost enqueue acknowledgment interrupts the saved job and retains all admitted caps', async t => {
  const f = setup(t); f.setEnqueueError(new Error('lost queue reply'));
  await assert.rejects(submit(f), /lost queue reply/);
  const job = f.store.data.jobs[0]; assert.equal(job.status, 'interrupted'); assert.equal(f.project.committed, 500_000);
  assert.equal((await f.kit.runQueued(job.id)).status, 'interrupted'); assert.equal(completions(f), 0); assert.equal(f.calls.some(c => c.acquire), false);
  const restored = new Store(f.file, 'zkapi', undefined, { preserveQueued: () => true }); assert.equal(restored.data.jobs[0].status, 'interrupted');
});

test('worker captures one project lease for the entire swarm and releases only after completion', async t => {
  const f = setup(t, { swarm: true }), job = await submit(f);
  const result = await f.kit.runQueued(job.id);
  assert.equal(result.status, 'completed'); assert.equal(completions(f), 3); assert.equal(f.calls.filter(c => c.acquire).length, 1); assert.equal(f.calls.at(-1), 'release');
  assert.equal(f.project.committed, 1_500_000); assert.equal(f.kit.running, false);
  await f.kit.runQueued(job.id); assert.equal(completions(f), 3); assert.equal(f.calls.filter(c => c === 'release').length, 1);
});

test('raised live model cap interrupts before inference and releases its acquired lease', async t => {
  const f = setup(t), job = await submit(f); f.setLiveCap(600_000);
  assert.equal((await f.kit.runQueued(job.id)).status, 'interrupted'); assert.match(job.error, /exceeds/); assert.equal(completions(f), 0); assert.equal(f.calls.at(-1), 'release'); assert.equal(f.project.committed, 500_000);
});

test('only explicit pre-dispatch capacity errors can safely defer a queued job', async t => {
  for (const flag of ['dispatchDeferred', 'retryableNoDispatch']) {
    const f = setup(t), job = await submit(f), error = new Error('Pool full'); error[flag] = true; f.setAcquireError(error);
    assert.deepEqual(await f.kit.runQueued(job.id), { deferred: true }); assert.equal(job.status, 'queued'); assert.equal(completions(f), 0); assert.equal(f.calls.includes('release'), false);
    f.setAcquireError(null); assert.equal((await f.kit.runQueued(job.id)).status, 'completed'); assert.equal(completions(f), 1);
  }
  const f = setup(t), job = await submit(f); f.setAcquireError(new Error('Unknown runtime outcome'));
  assert.equal((await f.kit.runQueued(job.id)).status, 'interrupted'); assert.equal(f.project.committed, 500_000);
});

test('a deferred-looking error after actual inference is uncertain and never requeued', async t => {
  const f = setup(t), job = await submit(f), error = new Error('lost model response'); error.dispatchDeferred = true; f.setCompletionError(error);
  assert.equal((await f.kit.runQueued(job.id)).status, 'interrupted'); assert.equal(job.steps[0].status, 'uncertain'); assert.equal(f.project.committed, 500_000);
  await f.kit.runQueued(job.id); assert.equal(completions(f), 1); assert.equal(f.calls.filter(c => c === 'release').length, 1);
});

test('only proven untouched scheduler-queued work survives process restart', async t => {
  const f = setup(t), job = await submit(f); let checked = 0;
  const restore = new Store(f.file, 'zkapi', undefined, { preserveQueued: candidate => { checked++; return candidate.id === f.entries[0].jobId && candidate.projectId === f.entries[0].projectId && candidate.reservation === f.entries[0].reservation; } });
  assert.equal(checked, 1); assert.equal(restore.data.jobs[0].status, 'queued');
  const next = new Kit({ ...f.config, store: restore }); assert.equal((await next.runQueued(job.id)).status, 'completed'); assert.equal(completions(f), 1);
  const g = setup(t), uncertain = await submit(g), saved = JSON.parse(readFileSync(g.file, 'utf8'));
  saved.jobs[0].status = 'running'; saved.jobs[0].steps[0].status = 'running'; writeFileSync(g.file, JSON.stringify(saved));
  const restarted = new Store(g.file, 'zkapi', undefined, { preserveQueued: () => { assert.fail('Running jobs must not consult queue restoration'); } });
  assert.equal(restarted.data.jobs[0].status, 'interrupted'); assert.equal(restarted.data.jobs[0].steps[0].status, 'uncertain'); assert.equal(restarted.data.projects[0].committed, uncertain.reservation);
});

test('missing or mismatched queue restoration proof retains reservations but interrupts admission', async t => {
  for (const preserveQueued of [() => false, () => { throw new Error('queue unavailable'); }, async () => true]) {
    const f = setup(t); await submit(f); const restored = new Store(f.file, 'zkapi', undefined, { preserveQueued });
    assert.equal(restored.data.jobs[0].status, 'interrupted'); assert.equal(restored.data.projects[0].committed, 500_000);
  }
});

test('paused queued projects never acquire a daemon, and delayed dispatch accounts on its actual UTC day', async t => {
  const f = setup(t), job = await submit(f); f.kit.pause(f.project.id);
  assert.equal((await f.kit.runQueued(job.id)).status, 'interrupted'); assert.equal(f.calls.some(c => c.acquire), false);
  const g = setup(t, { swarm: true }), delayed = await submit(g); g.setDate('2026-10-02T12:00:00Z'); await g.kit.runQueued(delayed.id);
  assert.deepEqual(g.project.days, { '2026-10-01': 0, '2026-10-02': 1_500_000 });
});

test('direct runtime mode also releases a captured provider on failed admission and after execution', async t => {
  const f = setup(t, { queueMode: false }); f.setLiveCap(2_000_000); await assert.rejects(submit(f), /Budget/);
  assert.equal(f.calls.at(-1), 'release'); assert.equal(completions(f), 0);
  f.setLiveCap(500_000); const job = await submit(f); await f.kit.execution;
  assert.equal(job.status, 'completed'); assert.equal(f.calls.filter(c => c === 'release').length, 2);
});
