import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Kit } from '../src/kit.mjs';
import { Store } from '../src/store.mjs';
import { AgentTools } from '../src/agent-tools.mjs';
import { fixtureCharge } from './fixtures/charge-accounting.mjs';

function setup(t, { queued = false, tracked = false, total = 10000000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'veyl-autonomy-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json'), calls = [], fetches = [], entries = [], receipts = new Map();
  let at = new Date(1800000000 * 1000), question = 'What changed in the protocol release?', planner = null, handler = null, fail = false;
  const source = 'https://ethereum.org/updates';
  const provider = { mode: 'zkapi', models: async () => ['fixture/primary', 'fixture/reviewer'].map(id => ({ id, oa_request_limit_micro_usd: 500000, ...(tracked ? { oa_accounting_margin_micro_usd: 1000 } : {}) })),
    ...(tracked ? { accountingIdentity: async () => ({ version: 1, journal_id: 'a'.repeat(32) }), callSettlement: async callId => receipts.get(callId) } : {}),
    complete: async (body, accounting) => {
      const disk = JSON.parse(readFileSync(file, 'utf8')), job = disk.jobs.at(-1);
      assert.equal(job.status, 'running'); assert.ok(job.reservation >= 500000);
      calls.push({ body, accounting, phase: job.autonomy?.phase });
      if (tracked) { assert.equal(job.steps[0].callAccounting.callId, accounting.callId); const identity = calls.length.toString(16).padStart(64, '0'); receipts.set(accounting.callId, fixtureCharge({ callId: accounting.callId, session: identity, receipt: identity }).report); }
      if (fail) throw Error('private provider error');
      if (handler) return handler(body, job);
      return { answer: job.autonomy?.phase === 'planner' ? planner || JSON.stringify({ question, sourceUrls: [source] }) : `Findings from ${source}: release evidence.`, verification: 'fixture' };
    } };
  const agentTools = new AgentTools({ client: {}, sourceReader: async url => { fetches.push(url); return { url, text: 'Captured official release evidence.', fetchedAt: at.toISOString() }; } });
  const store = new Store(file, 'zkapi'), config = { store, provider, agentTools, chain: {}, now: () => at,
    ...(queued ? { queue: { assertCapacity() {}, enqueue(entry) { entries.push(entry); assert.equal(JSON.parse(readFileSync(file, 'utf8')).jobs.at(-1).id, entry.jobId); } } } : {}) };
  const kit = new Kit(config), p = kit.create({ requestKey: randomUUID(), name: 'Autonomous desk', symbol: 'AUTO', purpose: 'Research supported claims.', template: 'research', swarm: true, model: 'fixture/primary', total, daily: total, request: 1000000 });
  const policy = { enabled: true, objective: 'Track protocol improvements and their practical implications.', cadenceMinutes: 60, dailyRunCap: 2, allowedTools: ['read_source'], sourceUrls: [source], sourceHosts: [], reviewerModel: null };
  const enable = input => kit.autonomy.configure(p.id, { ...policy, ...input });
  const run = input => kit.autonomy.run(p.id, { requestKey: randomUUID(), ...input });
  const drain = async () => {
    for (let n = 0; n < 8; n++) {
      const queuedJob = store.data.jobs.find(job => job.status === 'queued');
      if (queuedJob) await kit.runQueued(queuedJob.id); else if (kit.execution) await kit.execution;
      const cycle = p.autonomy?.cycles.at(-1); if (!cycle || ['completed', 'blocked', 'interrupted'].includes(cycle.status)) return;
      await kit.autonomy.advance(p, cycle);
    }
    throw Error('Cycle did not reach a terminal result');
  };
  return { kit, p, store, file, config, provider, agentTools, calls, fetches, entries, policy, source, enable, run, drain,
    setPlanner: value => { planner = value; }, setQuestion: value => { question = value; }, setHandler: value => { handler = value; }, setFail: value => { fail = value; }, setTime: value => { at = new Date(value); } };
}

test('autonomy is absent/off by default and enabling requires a bounded explicit owner policy', async t => {
  const f = setup(t); assert.equal(f.kit.autonomy.snapshot(f.p.id).policy.enabled, false); assert.equal(f.p.autonomy, undefined);
  await assert.rejects(f.run(), /Enable/); await f.kit.tick(); assert.equal(f.calls.length, 0);
  for (const change of [{ objective: '' }, { allowedTools: [] }, { allowedTools: ['publish'] }, { sourceHosts: ['unreviewed.example'] }, { sourceUrls: ['http://ethereum.org/'] }, { dailyRunCap: 25 }, { reviewerModel: f.p.model }, { budget: 99999 }]) assert.throws(() => f.enable(change));
  const configured = f.enable(); assert.equal(configured.policy.revision, 1); assert.equal(f.enable().policy.revision, 1);
  assert.equal(f.kit.snapshot().projects[0].autonomy, undefined);
  assert.equal(new Store(f.file, 'zkapi').data.projects[0].autonomy.policy.enabled, true);
});

test('a real structured planner question drives sourced research and becomes the next cycle memory', async t => {
  const f = setup(t, { tracked: true }); f.enable(); const first = await f.run(); await f.drain();
  const cycle = f.kit.autonomy.snapshot(f.p.id).cycles[0]; assert.equal(cycle.id, first.id); assert.equal(cycle.status, 'completed');
  assert.equal(f.calls.length, 2); assert.equal(f.calls[0].phase, 'planner'); assert.equal(f.calls[0].body.tools, undefined);
  assert.equal(f.calls[1].phase, 'research'); assert.match(f.calls[1].body.messages[1].content, /Captured official release evidence/);
  assert.deepEqual(f.fetches, [f.source]); assert.equal(cycle.question, 'What changed in the protocol release?');
  assert.equal(f.p.autonomy.memory.lastQuestion, cycle.question); assert.match(f.p.autonomy.memory.lastSummary, /Findings/);
  assert.equal(cycle.planner.artifact, undefined); assert.ok(cycle.research.artifact.id);
  assert.equal(f.p.committed, 60000); assert.equal(new Store(f.file, 'zkapi').data.jobs.length, 2);
  f.setQuestion('Which compatibility implications follow from that release?'); await f.run(); await f.drain();
  assert.match(f.calls[2].body.messages[1].content, /Previously completed question: What changed/);
  assert.notEqual(f.p.autonomy.cycles[0].question, f.p.autonomy.cycles[1].question);
  assert.equal(f.p.autonomy.cycles[1].status, 'completed'); assert.equal(f.p.committed, 120000);
});

test('optional reviewer is separately queued and budgeted without altering the project model', async t => {
  const f = setup(t, { queued: true }); f.enable({ reviewerModel: 'fixture/reviewer' }); await f.run();
  assert.equal(f.entries.length, 1); assert.equal(f.calls.length, 0); assert.equal(f.p.committed, 500000);
  await f.drain(); assert.deepEqual(f.calls.map(call => call.phase), ['planner', 'research', 'review']);
  assert.equal(f.calls[2].body.model, 'fixture/reviewer'); assert.equal(f.p.model, 'fixture/primary'); assert.equal(f.p.committed, 1500000);
  const jobs = f.store.data.jobs; assert.equal(jobs[1].autonomy.parentJobId, jobs[0].id); assert.equal(jobs[2].autonomy.parentJobId, jobs[1].id);
  assert.ok(jobs.every(job => job.steps.length === 1)); assert.equal(f.kit.autonomy.snapshot(f.p.id).cycles[0].review.status, 'completed');
});

test('queued watch reports defer a due autonomous cycle without consuming its daily slot or request key', async t => {
  const f = setup(t, { queued: true }); f.enable({ dailyRunCap: 1 });
  let sourceText = 'Original documented release.';
  f.kit.research.reader = async url => ({ url, text: sourceText, fetchedAt: f.kit.now().toISOString() });
  const watch = f.kit.research.create(f.p.id, { requestKey: randomUUID(), name: 'Release watch', brief: 'Explain documented release changes.', sources: [f.source], enabled: true, cadenceMinutes: 60 });
  await f.kit.research.check(f.p.id, watch.id, { requestKey: randomUUID() });
  sourceText = 'Changed documented release with a new supported feature.';
  await f.kit.research.check(f.p.id, watch.id, { requestKey: randomUUID() });
  const report = f.store.data.jobs[0]; assert.equal(report.research.kind, 'report'); assert.equal(report.status, 'queued');
  const due = f.p.autonomy.policy.nextAt, requestKey = randomUUID(); f.setTime(due);
  await f.kit.tick(); await assert.rejects(f.run({ requestKey }), /queued and current/);
  assert.equal(f.p.autonomy.cycles.length, 0); assert.equal(f.p.autonomy.requestKeys.length, 0);
  assert.deepEqual(f.p.autonomy.runsByDay, {}); assert.equal(f.p.autonomy.policy.nextAt, due); assert.equal(f.calls.length, 0);
  await f.kit.runQueued(report.id); const cycle = await f.run({ requestKey });
  assert.equal(cycle.planner.status, 'queued'); assert.equal(f.p.autonomy.runsByDay[f.kit.now().toISOString().slice(0, 10)], 1);
});

test('a pending autonomous follow-up waits for queued work without recording an uncertain admission', async t => {
  const f = setup(t, { queued: true }); f.enable(); await f.run();
  await f.kit.runQueued(f.store.data.jobs[0].id);
  const ordinary = await f.kit.submit(f.p.id, { requestKey: randomUUID(), prompt: 'Prepare a separate saved report.' });
  const cycle = f.p.autonomy.cycles[0]; await f.kit.autonomy.advance(f.p, cycle);
  assert.equal(cycle.status, 'researching'); assert.equal(cycle.research.status, 'pending'); assert.equal(cycle.research.attemptedAt, null);
  assert.equal(f.store.data.jobs.length, 2); assert.equal(f.calls.length, 1);
  await f.kit.runQueued(ordinary.id); await f.kit.autonomy.advance(f.p, cycle);
  assert.equal(cycle.research.status, 'queued'); assert.ok(cycle.research.attemptedAt); assert.equal(f.store.data.jobs.length, 3);
});

test('malformed, repeated or out-of-policy planner answers stop without a research call', async t => {
  for (const value of ['not json', JSON.stringify({ question: 'A useful question?', sourceUrls: ['https://blog.ethereum.org/outside'] }), JSON.stringify({ question: 'A useful question?', sourceUrls: [], privateThought: 'do not expose' })]) {
    const f = setup(t); f.enable(); f.setPlanner(value); await f.run(); await f.drain();
    assert.equal(f.calls.length, 1); assert.equal(f.fetches.length, 0); assert.equal(f.p.autonomy.cycles[0].status, 'blocked');
  }
  const f = setup(t); f.enable(); await f.run(); await f.drain(); await f.run(); await f.drain();
  assert.equal(f.calls.length, 3); assert.equal(f.p.autonomy.cycles[1].status, 'blocked');
});

test('daily cycle limits and ordinary monetary caps both stop admission, with UTC day rollover', async t => {
  const f = setup(t, { total: 1000000 }); f.enable({ dailyRunCap: 1 }); await f.run(); await f.drain();
  await assert.rejects(f.run(), /UTC day/); assert.equal(f.calls.length, 2);
  f.setTime('2027-01-16T00:00:01Z'); f.setQuestion('What evidence should be checked next?'); await f.run(); await f.drain();
  assert.equal(f.calls.length, 2); assert.equal(f.p.autonomy.cycles.at(-1).status, 'blocked'); assert.equal(f.p.committed, 1000000);
});

test('manual run keys are idempotent and unavailable internal job identities cannot be occupied', async t => {
  const f = setup(t); f.enable(); const requestKey = randomUUID(), first = await f.run({ requestKey }); await f.drain();
  assert.equal((await f.run({ requestKey })).id, first.id); assert.equal(f.calls.length, 2); assert.equal(f.fetches.length, 1);
  await assert.rejects(f.kit.submit(f.p.id, { requestKey: `autonomy-${randomUUID()}-planner`, prompt: 'Spoof plan' }), /reserved/);
});

test('disabling or editing policy before queued dispatch prevents all model calls and preserves held accounting', async t => {
  const f = setup(t, { queued: true }); f.enable(); await f.run(); f.kit.autonomy.configure(f.p.id, { enabled: false });
  await f.kit.runQueued(f.store.data.jobs[0].id); assert.equal(f.calls.length, 0); assert.equal(f.p.committed, 500000);
  assert.equal(f.p.autonomy.cycles[0].status, 'interrupted'); assert.equal(f.store.data.jobs[0].status, 'interrupted');
});

test('policy changes while a source is in flight prevent subsequent research inference', async t => {
  const f = setup(t, { queued: true }); f.enable(); await f.run(); await f.kit.runQueued(f.store.data.jobs[0].id); await f.kit.autonomy.advance(f.p, f.p.autonomy.cycles[0]);
  let release; f.agentTools.sourceReader = url => new Promise(resolve => { release = () => resolve({ url, text: 'Official evidence', fetchedAt: f.kit.now().toISOString() }); });
  const running = f.kit.runQueued(f.store.data.jobs[1].id); while (!release) await new Promise(resolve => setImmediate(resolve));
  f.kit.autonomy.configure(f.p.id, { enabled: false }); release(); await running;
  assert.equal(f.calls.length, 1); assert.equal(f.store.data.jobs[1].status, 'interrupted'); assert.equal(f.store.data.jobs[1].steps[0].toolActivity[0].status, 'failed');
  assert.equal(f.store.data.jobs[1].reservation, 0); assert.equal(f.p.committed, 500000);
});

test('source/tool policy is enforced at the server boundary, including same-host URLs and manual-job compatibility', async t => {
  const f = setup(t, { queued: true }); f.enable(); await f.run(); await f.kit.runQueued(f.store.data.jobs[0].id); await f.kit.autonomy.advance(f.p, f.p.autonomy.cycles[0]);
  const job = f.store.data.jobs[1], context = { kit: f.kit, projectId: f.p.id, jobId: job.id, callId: 'fixture-call' };
  assert.deepEqual(f.agentTools.schemas(context).map(tool => tool.function.name), ['read_source']);
  await assert.rejects(f.agentTools.execute({ name: 'read_source', arguments: { url: 'https://ethereum.org/other' } }, context), /outside/);
  await assert.rejects(f.agentTools.execute({ name: 'save_note', arguments: { content: 'Unauthorized note' } }, context), /outside/);
  assert.equal(f.p.notes.length, 0); assert.equal(f.fetches.length, 0);
  const result = await f.agentTools.execute({ name: 'read_source', arguments: { url: f.source + '#section' } }, context); assert.equal(result.source, f.source);
  await f.agentTools.execute({ name: 'save_note', arguments: { content: 'Manual tools remain available.' } }, { ...context, jobId: 'ordinary-manual-context' }); assert.equal(f.p.notes.length, 1);
});

test('host scope allows only exact reviewed host and unknown tool responses cannot invoke forbidden actions', async t => {
  const f = setup(t); f.enable({ sourceUrls: [], sourceHosts: ['ethereum.org'] });
  f.setHandler((body, job) => job.autonomy.phase === 'planner' ? { answer: JSON.stringify({ question: 'What should be learned from this release?', sourceUrls: [f.source] }) } : { answer: '', toolCalls: [{ id: 'forbidden', function: { name: 'save_note', arguments: '{"content":"Not permitted"}' } }] });
  await f.run(); await f.drain(); assert.equal(f.p.notes.length, 0);
  const job = f.store.data.jobs[1]; assert.ok(job.steps[0].toolActivity.some(action => action.name === 'save_note' && action.status === 'failed'));
  assert.equal(job.status, 'interrupted'); assert.ok(f.calls.length <= 5);
});

test('uncertain model dispatch and restarted queued work cannot be retried as new cycles', async t => {
  const f = setup(t, { queued: true }); f.enable({ dailyRunCap: 1 }); await f.run(); f.setFail(true); await f.kit.runQueued(f.store.data.jobs[0].id); await f.kit.autonomy.tick();
  assert.equal(f.p.autonomy.cycles[0].status, 'interrupted'); assert.equal(f.calls.length, 1);
  const restored = new Kit({ ...f.config, store: new Store(f.file, 'zkapi') }); await restored.autonomy.tick(); assert.equal(f.calls.length, 1);
  assert.equal(restored.project(f.p.id).committed, 500000);
  const g = setup(t, { queued: true }); g.enable(); await g.run(); const next = new Kit({ ...g.config, store: new Store(g.file, 'zkapi') }); await next.autonomy.tick(); assert.equal(next.project(g.p.id).autonomy.cycles[0].status, 'interrupted'); assert.equal(g.calls.length, 0);
});

test('failed durable admission cannot call the provider or source reader', async t => {
  const f = setup(t); f.enable(); mkdirSync(f.file + '.tmp'); await assert.rejects(f.run(), /Persistence/);
  assert.equal(f.calls.length, 0); assert.equal(f.fetches.length, 0);
});

test('failed source-only collection releases only untouched research cap and preserves real actions and planner settlement', async t => {
  const f = setup(t, { tracked: true, queued: true }); f.enable(); await f.run(); await f.kit.runQueued(f.store.data.jobs[0].id);
  assert.equal(f.p.committed, 30000); await f.kit.autonomy.advance(f.p, f.p.autonomy.cycles[0]);
  f.agentTools.sourceReader = async () => { throw Error('private network credential'); };
  await f.kit.runQueued(f.store.data.jobs[1].id); await f.kit.autonomy.advance(f.p, f.p.autonomy.cycles[0]);
  const job = f.store.data.jobs[1], step = job.steps[0];
  assert.equal(f.calls.length, 1); assert.equal(job.reservation, 0); assert.equal(f.p.committed, 30000);
  assert.equal(step.status, 'not-dispatched'); assert.equal(step.sourceEvidenceOnly, true); assert.equal(step.toolActivity[0].status, 'failed');
  assert.equal(step.callAccounting, undefined); assert.match(job.error, /unused research reservation was released/);
  assert.equal(new Store(f.file, 'zkapi').data.projects[0].committed, 30000);
  const disk = JSON.parse(readFileSync(f.file, 'utf8')); disk.jobs[1].steps[0].callAccounting = { status: 'pending' }; writeFileSync(f.file, JSON.stringify(disk));
  assert.throws(() => new Store(f.file, 'zkapi'), /mismatch/);
});

test('an actual research inference failure never uses the source-only refund path', async t => {
  const f = setup(t); f.enable(); f.setHandler((body, job) => {
    if (job.autonomy.phase === 'planner') return { answer: JSON.stringify({ question: 'Which changes affect this release?', sourceUrls: [f.source] }) };
    throw Error('lost inference response');
  });
  await f.run(); await f.drain();
  const research = f.store.data.jobs[1]; assert.equal(f.calls.length, 2); assert.equal(research.status, 'interrupted');
  assert.equal(research.reservation, 500000); assert.equal(research.steps[0].sourceEvidenceOnly, undefined); assert.equal(f.p.committed, 1000000);
});

test('independent reviewers can read evidence but cannot create notes or socially eligible drafts', async t => {
  const f = setup(t, { queued: true }); f.enable({ reviewerModel: 'fixture/reviewer', allowedTools: ['read_source', 'chain_read', 'save_note', 'prepare_social_draft'] });
  await f.run(); await f.kit.runQueued(f.store.data.jobs[0].id); await f.kit.autonomy.advance(f.p, f.p.autonomy.cycles[0]);
  await f.kit.runQueued(f.store.data.jobs[1].id); await f.kit.autonomy.advance(f.p, f.p.autonomy.cycles[0]);
  const job = f.store.data.jobs[2], context = { projectId: f.p.id, kit: f.kit, jobId: job.id, callId: 'reviewer-call', prepareSocialDraft: () => { throw Error('must not run'); } };
  assert.deepEqual(f.agentTools.schemas(context).map(tool => tool.function.name), ['read_source', 'chain_read']);
  await assert.rejects(f.agentTools.execute({ name: 'save_note', arguments: { content: 'Reviewer note' } }, context), /outside/);
  await assert.rejects(f.agentTools.execute({ name: 'prepare_social_draft', arguments: { channel: 'x', text: 'Reviewer social post' } }, context), /outside/);
  assert.equal(f.p.notes.length, 0);
});

test('bounded maximum-length policies and questions do not corrupt durable prompt storage', async t => {
  const f = setup(t); const urls = Array.from({ length: 8 }, (_, i) => `https://ethereum.org/${i}/` + 'a'.repeat(990));
  f.enable({ objective: 'x'.repeat(1200), sourceUrls: urls });
  f.setPlanner(JSON.stringify({ question: 'q'.repeat(1000), sourceUrls: urls.slice(0, 3) }));
  await f.run(); await f.drain(); assert.equal(f.store.healthy, true);
  assert.ok(f.store.data.jobs.every(job => job.prompt.length <= 8000)); assert.equal(f.p.autonomy.cycles[0].status, 'completed');
});

test('malformed or forged autonomous linkage fails closed while legacy jobs continue loading', async t => {
  const f = setup(t); f.enable({ reviewerModel: 'fixture/reviewer' }); await f.run(); await f.drain();
  const saved = JSON.parse(readFileSync(f.file, 'utf8')); saved.jobs[2].autonomy.parentJobId = saved.jobs[0].id; writeFileSync(f.file, JSON.stringify(saved));
  assert.throws(() => new Store(f.file, 'zkapi'), /mismatch/);
});
