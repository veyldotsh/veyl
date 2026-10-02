import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { Kit } from '../src/kit.mjs';
import { Problem } from '../src/agent.mjs';

function setup(t, { mode = 'demo', queue = false, swarm = false, total = 5000000, daily = 3000000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'veyl-research-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'kit.json'), calls = [], fetches = [], entries = [];
  let at = new Date('2026-10-02T12:00:00Z'), source = 'Protocol release: version one.', failed = false;
  const provider = { mode, models: async () => [{ id: 'fixture/primary', oa_request_limit_micro_usd: 500000 }, { id: 'fixture/reviewer', oa_request_limit_micro_usd: 750000 }], complete: async body => {
    const disk = JSON.parse(readFileSync(file, 'utf8')), job = disk.jobs.at(-1);
    assert.equal(job.status, 'running'); assert.ok(job.reservation >= 500000);
    calls.push(body); if (failed) throw Error('private upstream failure');
    return { answer: 'A sourced report. https://ethereum.org/first', verification: 'fixture', demoCharge: 10000 };
  } };
  const researchReader = async url => { fetches.push(url); return { url, text: source, fetchedAt: at.toISOString(), responseBytes: source.length, possiblyTruncated: false }; };
  const store = new Store(file, mode), config = { store, provider, chain: {}, now: () => at, researchReader,
    ...(queue ? { queue: { assertCapacity() {}, enqueue(entry) { const disk = JSON.parse(readFileSync(file, 'utf8')); assert.equal(disk.jobs.at(-1).id, entry.jobId); entries.push(entry); } } } : {}) };
  const kit = new Kit(config), p = kit.create({ requestKey: randomUUID(), name: 'Source desk', symbol: 'DESK', purpose: 'Read public protocol changes.', template: 'research', swarm, model: 'fixture/primary', total, daily, request: Math.min(1000000, daily) });
  const watchInput = { requestKey: randomUUID(), name: 'Protocol changes', brief: 'Explain releases using source evidence.', sources: ['https://ethereum.org/first'], enabled: false, cadenceMinutes: 60, reviewerModel: null };
  const create = input => kit.research.create(p.id, { ...watchInput, requestKey: randomUUID(), ...input });
  const check = (watch, input = {}) => kit.research.check(p.id, watch.id, { requestKey: randomUUID(), ...input });
  return { kit, p, store, config, file, provider, calls, fetches, entries, create, check, setSource: value => { source = value; }, setFailure: value => { failed = value; }, setTime: value => { at = new Date(value); } };
}

test('old projects migrate without research data; watch input and reviewed URL limits fail before I/O', t => {
  const f = setup(t); assert.deepEqual(f.kit.research.snapshot(f.p.id).watchlists, []);
  for (const sources of [['http://ethereum.org'], ['https://localhost/a'], ['https://user:pass@ethereum.org/a'], ['https://ethereum.org/a', 'https://ethereum.org/a#same']]) assert.throws(() => f.create({ sources }), /HTTPS|distinct/);
  assert.throws(() => f.create({ enabled: undefined }), /schedule/);
  assert.throws(() => f.create({ cadenceMinutes: 15 }), /cadence/);
  assert.throws(() => f.create({ reviewerModel: f.p.model }), /different/);
  const input = { requestKey: randomUUID() }, first = f.create(input);
  assert.equal(f.create(input).id, first.id);
  assert.throws(() => f.create({ ...input, name: 'Changed terms' }), /already used/);
  assert.deepEqual(f.kit.research.update(f.p.id, first.id, { enabled: false }), first);
  assert.equal(f.fetches.length, 0); assert.equal(f.calls.length, 0);
  assert.equal(new Store(f.file, 'demo').data.projects[0].research.watchlists.length, 1);
});

test('baseline and unchanged checks are durable, deterministic and never acquire an LLM', async t => {
  const f = setup(t), watch = f.create(), key = randomUUID();
  f.provider.models = () => { throw Error('Catalog must not be requested'); };
  const first = await f.check(watch, { requestKey: key });
  assert.equal(first.status, 'baseline'); assert.equal(first.report.status, 'none');
  assert.equal(first.sources[0].beforeHash, null); assert.match(first.sources[0].afterHash, /^[0-9a-f]{64}$/);
  assert.equal(first.sources[0].afterExcerpt, 'Protocol release: version one.');
  assert.equal((await f.check(watch, { requestKey: key })).id, first.id);
  assert.equal(f.fetches.length, 1);
  const unchanged = await f.check(watch); assert.equal(unchanged.status, 'unchanged');
  assert.equal(unchanged.sources[0].beforeHash, unchanged.sources[0].afterHash);
  assert.equal(f.store.data.jobs.length, 0); assert.equal(f.p.committed, 0);
  const restored = new Store(f.file, 'demo'); assert.equal(restored.data.projects[0].research.checks.length, 2);
  const other = f.create({ name: 'Other watch' }); await assert.rejects(f.check(other, { requestKey: key }), /another watchlist/);
});

test('ordinary job callers cannot occupy or replay the internal research admission namespace', async t => {
  const f = setup(t);
  await assert.rejects(f.kit.submit(f.p.id, { requestKey: `research-${randomUUID()}-report`, prompt: 'Forged research admission' }), /reserved/);
  assert.equal(f.calls.length, 0); assert.equal(f.store.data.jobs.length, 0);
});

test('general workspace snapshots omit private research archives without mutating retained evidence', async t => {
  const f = setup(t), watch = f.create(); await f.check(watch);
  const sourceProject = f.kit.project(f.p.id), original = structuredClone(sourceProject.research);
  const projected = f.kit.snapshot().projects.find(project => project.id === f.p.id);
  assert.equal(Object.hasOwn(projected, 'research'), false);
  const { research, ...otherFields } = sourceProject; assert.deepEqual(projected, otherFields);
  assert.deepEqual(sourceProject.research, original);
  const dedicated = f.kit.research.snapshot(f.p.id);
  assert.equal(dedicated.watchlists.length, 1); assert.equal(dedicated.checks[0].status, 'baseline');
  assert.equal(Object.hasOwn(dedicated.watchlists[0], 'snapshots'), false);
  assert.equal(Object.hasOwn(dedicated, 'checkKeys'), false);
  assert.equal(new Store(f.file, 'demo').data.projects[0].research.watchlists[0].snapshots.length, 1);
});

test('changed source report uses ordinary durable budget admission and saved real evidence', async t => {
  const f = setup(t), watch = f.create(); await f.check(watch);
  f.setSource('Protocol release: version two, with the new fee policy.');
  const changed = await f.check(watch); await f.kit.execution;
  assert.equal(changed.status, 'changed'); assert.ok(changed.report.jobId);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].model, f.p.model);
  assert.match(f.calls[0].messages[1].content, /BEFORE: Protocol release: version one/);
  assert.match(f.calls[0].messages[1].content, /AFTER: Protocol release: version two/);
  const record = f.kit.research.snapshot(f.p.id).checks.at(-1);
  assert.equal(record.report.status, 'completed'); assert.equal(record.report.job.mode, 'demo');
  assert.equal(record.report.job.reservation, 10000); assert.equal(record.report.artifact.id, f.p.artifacts[0].id);
  assert.equal(record.report.job.steps[0].output, undefined);
  assert.equal(f.p.committed, 10000); assert.equal(new Store(f.file, 'demo').data.jobs.length, 1);
});

test('a second-model review is a linked independently reserved queued job, including UTC rollover', async t => {
  const f = setup(t, { mode: 'zkapi', queue: true, swarm: true }), watch = f.create({ reviewerModel: 'fixture/reviewer' });
  await f.check(watch); f.setSource('A new protocol release.'); const changed = await f.check(watch);
  assert.equal(f.entries.length, 1); assert.equal(f.calls.length, 0); assert.equal(f.p.committed, 1500000);
  const report = f.store.data.jobs[0]; await f.kit.runQueued(report.id);
  f.setTime('2026-10-03T00:00:01Z'); await f.kit.research.tick();
  const reviewer = f.store.data.jobs[1]; assert.equal(reviewer.research.parentJobId, report.id);
  assert.equal(reviewer.model, 'fixture/reviewer'); assert.equal(reviewer.steps.length, 1); assert.equal(reviewer.reservation, 750000);
  assert.equal(f.p.model, 'fixture/primary'); assert.equal(f.p.days['2026-10-03'], 750000);
  await f.kit.runQueued(reviewer.id); await f.kit.research.tick();
  assert.equal(f.calls.length, 4); assert.equal(f.calls.at(-1).model, 'fixture/reviewer');
  assert.match(f.calls.at(-1).messages[1].content, /Independent review/);
  assert.equal(f.kit.research.snapshot(f.p.id).checks.find(item => item.id === changed.id).review.status, 'completed');
  assert.equal(new Store(f.file, 'zkapi').data.projects[0].committed, 2250000);
});

test('blocked budgets, unavailable reviewers and uncertain reports never dispatch another attempt', async t => {
  const f = setup(t, { mode: 'zkapi', queue: true, total: 600000, daily: 600000 }), watch = f.create({ reviewerModel: 'fixture/reviewer' });
  await f.check(watch); f.setSource('Changed once'); await f.check(watch); await f.kit.runQueued(f.store.data.jobs[0].id);
  await f.kit.research.tick(); assert.equal(f.store.data.jobs.length, 1);
  assert.equal(f.kit.research.snapshot(f.p.id).checks.at(-1).review.status, 'blocked');
  f.setSource('Changed twice'); const blocked = await f.check(watch); assert.equal(blocked.report.status, 'blocked');
  await f.kit.research.tick(); assert.equal(f.calls.length, 1); assert.equal(f.p.committed, 500000);
  const g = setup(t, { mode: 'zkapi', queue: true }), gw = g.create({ reviewerModel: 'fixture/reviewer' });
  await g.check(gw); g.setSource('Fresh change'); await g.check(gw); g.setFailure(true); await g.kit.runQueued(g.store.data.jobs[0].id);
  await g.kit.research.tick(); await g.kit.research.tick();
  assert.equal(g.calls.length, 1); assert.equal(g.store.data.jobs.length, 1); assert.equal(g.store.data.jobs[0].status, 'interrupted');
  assert.equal(g.kit.research.snapshot(g.p.id).checks.at(-1).review.status, 'blocked'); assert.equal(g.p.committed, 500000);
});

test('source checks fetch at most three concurrently, checkpoint first, reject overlap and preserve baseline on errors', async t => {
  const f = setup(t), watch = f.create({ sources: ['https://ethereum.org/first', 'https://blog.ethereum.org/second', 'https://api.github.com/repos/ethereum/zkapi'] });
  await f.check(watch); const old = structuredClone(f.p.research.watchlists[0].snapshots), pending = [];
  f.kit.research.reader = url => {
    assert.equal(JSON.parse(readFileSync(f.file, 'utf8')).projects[0].research.checks.at(-1).status, 'checking');
    return new Promise((resolve, reject) => pending.push({ url, resolve, reject }));
  };
  const operation = f.check(watch); assert.equal(pending.length, 3);
  await assert.rejects(f.check(watch), /already running/);
  pending[0].resolve({ url: pending[0].url, text: 'Changed', fetchedAt: '2026-10-02T12:00:00Z' });
  pending[1].reject(new Error('secret internal endpoint'));
  pending[2].resolve({ url: pending[2].url, text: 'Changed', fetchedAt: '2026-10-02T12:00:00Z' });
  const checked = await operation; assert.equal(checked.status, 'error'); assert.equal(checked.sources[0].status, 'changed');
  assert.doesNotMatch(JSON.stringify(checked), /secret internal/); assert.deepEqual(f.p.research.watchlists[0].snapshots, old);
  assert.equal(f.store.data.jobs.length, 0); assert.equal(f.calls.length, 0);
});

test('pause or edit while sources or catalog are awaited prevents stale paid admission', async t => {
  for (const edit of ['pause', 'watch']) {
    const f = setup(t), watch = f.create(); await f.check(watch); let resolve;
    f.kit.research.reader = url => new Promise(done => { resolve = () => done({ url, text: 'A changed document.', fetchedAt: '2026-10-02T12:00:00Z' }); });
    const operation = f.check(watch);
    if (edit === 'pause') f.kit.pause(f.p.id); else f.kit.research.update(f.p.id, watch.id, { brief: 'New research question.' });
    resolve(); const check = await operation; assert.equal(check.status, 'interrupted'); assert.equal(f.calls.length, 0); assert.equal(f.p.committed, 0);
  }
  const f = setup(t, { queue: true }), watch = f.create(); await f.check(watch); f.setSource('Changed'); let release;
  f.kit.providerCatalogForProject = () => new Promise(resolve => { release = () => resolve([{ id: f.p.model, oa_request_limit_micro_usd: 500000 }]); });
  const operation = f.check(watch); while (!release) await new Promise(resolve => setImmediate(resolve));
  f.kit.research.update(f.p.id, watch.id, { enabled: true }); release();
  assert.equal((await operation).report.status, 'blocked'); assert.equal(f.store.data.jobs.length, 0);
});

test('watch edits before queued dispatch prevent the old report from running, without erasing its reservation', async t => {
  const f = setup(t, { mode: 'zkapi', queue: true }), watch = f.create(); await f.check(watch); f.setSource('Changed'); await f.check(watch);
  f.kit.research.update(f.p.id, watch.id, { brief: 'Updated brief' }); await f.kit.runQueued(f.store.data.jobs[0].id);
  assert.equal(f.calls.length, 0); assert.equal(f.store.data.jobs[0].status, 'interrupted'); assert.equal(f.p.committed, 500000);
});

test('research ticks without a regular schedule and checks only one due watch per tick', async t => {
  const f = setup(t); f.create({ enabled: true }); f.create({ enabled: true, name: 'Second' });
  f.setTime('2026-10-02T13:00:01Z'); await f.kit.tick(); assert.equal(f.fetches.length, 1);
  await f.kit.tick(); assert.equal(f.fetches.length, 2); await f.kit.tick(); assert.equal(f.fetches.length, 2);
  assert.equal(f.p.schedule, null); assert.equal(f.calls.length, 0);
});

test('restart interrupts collection and recovers saved job linkage without replay or lost charges', async t => {
  const f = setup(t, { mode: 'zkapi', queue: true }), watch = f.create({ reviewerModel: 'fixture/reviewer' });
  await f.check(watch); f.setSource('Changed'); await f.check(watch);
  const check = f.p.research.checks.at(-1), job = f.store.data.jobs[0];
  check.report.jobId = null; check.report.status = 'pending'; f.store.save();
  const store = new Store(f.file, 'zkapi'), kit = new Kit({ ...f.config, store });
  await kit.research.tick(); assert.equal(store.data.jobs.length, 1); assert.equal(store.data.jobs[0].id, job.id);
  assert.equal(store.data.projects[0].committed, 500000); assert.equal(kit.research.snapshot(f.p.id).checks.at(-1).review.status, 'blocked');
  const saved = JSON.parse(readFileSync(f.file, 'utf8')); saved.projects[0].research.checks[0].status = 'checking'; saved.projects[0].research.checks[0].finishedAt = null; writeFileSync(f.file, JSON.stringify(saved));
  const recovered = new Kit({ ...f.config, store: new Store(f.file, 'zkapi') });
  assert.equal(recovered.research.snapshot(f.p.id).checks[0].status, 'interrupted'); assert.equal(f.calls.length, 0);
});

test('history rotation retains key tombstones, snapshot bounds and old financial jobs', async t => {
  const f = setup(t), watch = f.create(), firstKey = randomUUID(); await f.check(watch, { requestKey: firstKey });
  f.setSource('Changed'); await f.check(watch); await f.kit.execution;
  for (let n = 0; n < 52; n++) await f.check(watch);
  assert.equal(f.p.research.checks.length, 50); assert.equal(f.store.data.jobs.length, 1); assert.equal(f.p.committed, 10000);
  await assert.rejects(f.check(watch, { requestKey: firstKey }), /expired history/);
  assert.ok(Buffer.byteLength(JSON.stringify(f.kit.research.snapshot(f.p.id))) <= 750000);
  assert.equal(new Store(f.file, 'demo').data.jobs.length, 1);
});

test('changing the project to its old reviewer still allows disabling or correcting the watch', t => {
  const f = setup(t), watch = f.create({ enabled: true, reviewerModel: 'fixture/reviewer' });
  f.kit.settings(f.p.id, { model: 'fixture/reviewer', total: 5000000, daily: 3000000, request: 1000000 });
  assert.equal(f.kit.research.update(f.p.id, watch.id, { enabled: false }).enabled, false);
  assert.equal(f.kit.research.update(f.p.id, watch.id, { reviewerModel: 'fixture/primary' }).reviewerModel, 'fixture/primary');
});

test('failed checkpoint prevents source I/O and malformed retained evidence fails closed on restart', async t => {
  const f = setup(t), watch = f.create(); mkdirSync(f.file + '.tmp');
  await assert.rejects(f.check(watch), /Persistence/); assert.equal(f.fetches.length, 0); assert.equal(f.calls.length, 0);
  const g = setup(t), other = g.create(); await g.check(other);
  const saved = JSON.parse(readFileSync(g.file, 'utf8')); saved.projects[0].research.watchlists[0].snapshots[0].text = 'Forged'; writeFileSync(g.file, JSON.stringify(saved));
  assert.throws(() => new Store(g.file, 'demo'), /mismatch/);
});
