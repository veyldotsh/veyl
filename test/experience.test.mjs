import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ExperienceNotifications, ShowcaseDirectory } from '../src/experience.mjs';
import { Problem } from '../src/agent.mjs';
import { SealedState } from '../src/encrypted-state.mjs';

const owner = '0x1111111111111111111111111111111111111111', other = '0x2222222222222222222222222222222222222222', at = '2026-10-02T12:00:00.000Z';
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'veyl-experience-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const project = { id: randomUUID(), purpose: 'PRIVATE PURPOSE', notes: [{ content: 'PRIVATE NOTE' }], artifacts: [{ id: randomUUID(), title: 'PRIVATE PROMPT', content: 'Selected result content', at, mode: 'zkapi', privateField: 'MUST NOT LEAK' }] };
  const otherProject = { id: randomUUID(), artifacts: [{ id: randomUUID(), title: 'Another secret', content: 'Foreign output', at, mode: 'zkapi' }] };
  const key = Buffer.alloc(32, 23), config = { file: join(dir, 'showcase.sealed.json'), key, now: () => at, projectForOwner: (who, id) => { const p = who === owner ? project : who === other ? otherProject : null; if (!p || p.id !== id) throw new Problem('Project not found.', 404); return p; } };
  const notificationsConfig = { file: join(dir, 'notifications.sealed.json'), key, owner, now: () => at };
  return { dir, project, otherProject, config, notificationsConfig, showcase: new ShowcaseDirectory(config), notifications: new ExperienceNotifications(notificationsConfig) };
}

function historyFixture(t) {
  const f = fixture(t), artifact = f.project.artifacts[0], jobId = randomUUID(), finishedAt = '2026-10-02T12:01:00.000Z';
  artifact.jobId = jobId;
  const job = { id: jobId, projectId: f.project.id, artifactId: artifact.id, status: 'completed', mode: 'zkapi', at, finishedAt, reservation: 1000100, prompt: 'PRIVATE JOB PROMPT', account: owner,
    steps: [{ role: 'Researcher', status: 'completed', at, finishedAt, output: artifact.content, reasoning: 'PRIVATE THOUGHTS', callAccounting: { status: 'settled', chargeWei: '1234567890', valuationMicroUsd: 100 }, additionalCalls: [{ callAccounting: { status: 'pending' } }], toolActivity: [
      { name: 'read_source', status: 'completed', at, finishedAt, evidence: { source: 'https://eips.ethereum.org/EIPS/eip-7702' }, arguments: { secret: 'PRIVATE ARGUMENT' }, result: { raw: 'PRIVATE RAW OUTPUT' } },
      { name: 'read_source', status: 'failed', at, finishedAt, evidence: { source: 'https://ethereum.org/?token=SECRETQUERY' }, error: 'PRIVATE ERROR' },
      { name: 'chain_read', status: 'completed', at, finishedAt, result: { address: owner } }
    ] }] };
  const jobs = [job]; f.config.jobsForOwnerProject = (who, id) => who === owner && id === f.project.id ? jobs : [];
  f.showcase = new ShowcaseDirectory(f.config);
  return { ...f, job, jobs, input: { projectId: f.project.id, title: 'Public work', description: 'Chosen result and run.', artifactIds: [artifact.id], includeRunHistory: true } };
}

test('run sharing is default-off, explicitly previewed, allowlisted, bounded and persists as a non-live snapshot', t => {
  const f = historyFixture(t), legacy = f.showcase.publish(owner, { ...f.input, includeRunHistory: false }).showcase;
  assert.equal(f.showcase.public(legacy.slug).page.artifacts[0].run, undefined);
  assert.throws(() => f.showcase.publish(owner, f.input), error => error.status === 409);
  const reviewed = f.showcase.preview(owner, f.input), run = reviewed.preview.artifacts[0].run;
  assert.equal(f.showcase.public(legacy.slug).page.artifacts[0].run, undefined, 'preview never publishes');
  assert.equal(run.events.length, 4); assert.equal(run.events[1].source, 'https://eips.ethereum.org/EIPS/eip-7702'); assert.equal(run.events[2].source, undefined);
  assert.deepEqual(run.charge, { settledWei: '1234567890', settledMicroUsd: 100, pendingMicroUsd: 1000000, settledCalls: 1, totalCalls: 2 });
  const saved = f.showcase.publish(owner, { ...f.input, previewDigest: reviewed.previewDigest }).showcase;
  const publicText = JSON.stringify(f.showcase.public(saved.slug));
  for (const secret of ['PRIVATE', 'SECRETQUERY', owner, f.project.id, f.job.id, 'requestHash', 'journalId']) assert.equal(publicText.includes(secret), false, secret);
  f.job.reservation = 100; f.job.steps[0].additionalCalls = [];
  assert.equal(new ShowcaseDirectory(f.config).public(saved.slug).page.artifacts[0].run.charge.pendingMicroUsd, 1000000, 'later settlement is not auto-published');
  assert.equal(readFileSync(f.config.file, 'utf8').includes('1234567890'), false);
  assert.equal(saved.includeRunHistory, true);
  f.showcase.revoke(owner, { projectId: f.project.id }); assert.throws(() => f.showcase.public(saved.slug), error => error.status === 404);
});

test('history review digest binds exact selected content, costs and owner without weakening access isolation', t => {
  const f = historyFixture(t), reviewed = f.showcase.preview(owner, f.input);
  assert.throws(() => f.showcase.preview(other, f.input), error => error.status === 404);
  assert.throws(() => f.showcase.publish(other, { ...f.input, previewDigest: reviewed.previewDigest }), error => error.status === 404);
  assert.throws(() => f.showcase.publish(owner, { ...f.input, title: 'Changed', previewDigest: reviewed.previewDigest }), error => error.status === 409);
  f.job.reservation++;
  assert.throws(() => f.showcase.publish(owner, { ...f.input, previewDigest: reviewed.previewDigest }), error => error.status === 409);
  const next = f.showcase.preview(owner, f.input); f.project.artifacts[0].content += ' Later edit';
  assert.throws(() => f.showcase.publish(owner, { ...f.input, previewDigest: next.previewDigest }), error => error.status === 409);
  assert.equal(f.showcase.owned(owner, f.project.id).showcase, null);
  assert.throws(() => f.showcase.preview(owner, { ...f.input, includeRunHistory: 'true' }));
});

test('unreliable result linkage omits history and invalid private metadata cannot become public fields', t => {
  const f = historyFixture(t);
  for (const override of [{ projectId: f.otherProject.id }, { artifactId: randomUUID() }, { status: 'running' }, { mode: 'demo' }]) {
    const original = { ...f.job }; Object.assign(f.job, override);
    assert.equal(f.showcase.preview(owner, f.input).preview.artifacts[0].run, undefined); Object.assign(f.job, original);
  }
  f.jobs.push({ ...f.job }); assert.equal(f.showcase.preview(owner, f.input).preview.artifacts[0].run, undefined); f.jobs.pop();
  f.job.steps[0].role = '<script>PRIVATE ROLE</script>';
  f.job.steps[0].toolActivity.push({ name: '<script>PRIVATE TOOL</script>', at, finishedAt: at, status: 'completed' });
  f.job.steps[0].callAccounting.chargeWei = '<script>PRIVATE COST</script>';
  const run = f.showcase.preview(owner, f.input).preview.artifacts[0].run;
  assert.equal(run.events[0].role, 'Model stage'); assert.equal(run.charge, null); assert.doesNotMatch(JSON.stringify(run), /PRIVATE|<script>/);
  for (const source of ['https://user:pass@ethereum.org/', 'javascript:alert(1)', 'https://ethereum.org/?key=x', 'https://127.0.0.1/', 'https://ethereum.org/#access_token=x']) {
    f.job.steps[0].toolActivity[0].evidence.source = source;
    assert.equal(f.showcase.preview(owner, f.input).preview.artifacts[0].run.events[1].source, undefined);
  }
  f.job.steps[0].toolActivity = Array.from({ length: 90 }, () => ({ name: 'save_note', status: 'completed', at, finishedAt: at }));
  const bounded = f.showcase.preview(owner, f.input).preview.artifacts[0].run;
  assert.equal(bounded.events.length, 64); assert.equal(bounded.omittedEvents, 27);
});

test('saved-plan source fallback exports only the safe URL from the private result', t => {
  const f=historyFixture(t),action=f.job.steps[0].toolActivity[0];
  action.initiatedBy='saved-plan';action.result={...action.evidence,text:'PRIVATE SOURCE TEXT',wallet:owner};delete action.evidence;
  const run=f.showcase.preview(owner,f.input).preview.artifacts[0].run;
  assert.equal(run.events[1].source,'https://eips.ethereum.org/EIPS/eip-7702');assert.doesNotMatch(JSON.stringify(run),/PRIVATE SOURCE TEXT|wallet/);
});

test('public reads reconstruct nested history from sealed state and never export unknown private metadata', t => {
  const f=historyFixture(t),preview=f.showcase.preview(owner,f.input),saved=f.showcase.publish(owner,{...f.input,previewDigest:preview.previewDigest}).showcase;
  const state=new SealedState(f.config.file,f.config.key,'public-showcase-directory',{}),run=state.data.pages[0].public.artifacts[0].run;
  run.prompt='PRIVATE MALFORMED PROMPT';run.wallet=owner;run.events[0].arguments={secret:'PRIVATE MALFORMED ARGS'};run.events[1].rawOutput='PRIVATE MALFORMED OUTPUT';run.charge.receipt={secret:'PRIVATE RECEIPT'};state.save();
  const publicData=new ShowcaseDirectory(f.config).public(saved.slug);
  assert.ok(publicData.page.artifacts[0].run);assert.doesNotMatch(JSON.stringify(publicData),/PRIVATE|wallet|arguments|rawOutput|receipt/);
  run.charge.settledWei='PRIVATE INVALID AMOUNT';state.save();
  assert.equal(new ShowcaseDirectory(f.config).public(saved.slug).page.artifacts[0].run,undefined);
});

test('public pages contain only selected saved outputs and explicit public text, never default private metadata', t => {
  const f = fixture(t), input = { projectId: f.project.id, title: 'Public research', description: 'Owner-selected findings.', artifactIds: [f.project.artifacts[0].id] };
  assert.deepEqual(f.showcase.owned(owner, f.project.id), { showcase: null });
  const saved = f.showcase.publish(owner, input); assert.match(saved.showcase.slug, /^[A-Za-z0-9_-]{24}$/);
  const { page } = f.showcase.public(saved.showcase.slug); assert.equal(page.artifacts[0].title, 'Result 1'); assert.equal(page.artifacts[0].content, 'Selected result content'); assert.equal(page.artifacts[0].mode, 'zkapi');
  for (const value of [owner, f.project.id, 'PRIVATE PURPOSE', 'PRIVATE NOTE', 'PRIVATE PROMPT', 'MUST NOT LEAK']) assert.equal(JSON.stringify(page).includes(value), false);
  f.project.artifacts[0].content = 'Private later edit'; assert.equal(f.showcase.public(page.slug).page.artifacts[0].content, 'Selected result content');
  const raw = readFileSync(f.config.file, 'utf8'); for (const value of [owner, 'Selected result content', 'Public research']) assert.equal(raw.includes(value), false);
  assert.equal(new ShowcaseDirectory(f.config).public(page.slug).page.title, input.title);
});

test('showcase ownership, result selection, bounds and revocation cannot expose another project', t => {
  const f = fixture(t), input = { projectId: f.project.id, title: 'Public', description: 'Selected results.', artifactIds: [f.project.artifacts[0].id] };
  assert.throws(() => f.showcase.publish(other, input), error => error.status === 404);
  assert.throws(() => f.showcase.publish(owner, { ...input, artifactIds: [f.otherProject.artifacts[0].id] }), error => error.status === 404);
  assert.throws(() => f.showcase.publish(owner, { ...input, owner: other }));
  assert.throws(() => f.showcase.publish(owner, { ...input, artifactIds: [...input.artifactIds, ...input.artifactIds] }));
  const first = f.showcase.publish(owner, input).showcase; assert.throws(() => f.showcase.revoke(other, { projectId: f.project.id }), error => error.status === 404);
  assert.deepEqual(f.showcase.revoke(owner, { projectId: f.project.id }), { showcase: null });
  assert.throws(() => f.showcase.public(first.slug), error => error.status === 404);
  const second = f.showcase.publish(owner, input).showcase; assert.notEqual(first.slug, second.slug);
  assert.throws(() => f.showcase.public(first.slug), error => error.status === 404);
  f.project.artifacts[0].content = '界'.repeat(32000); f.project.artifacts.push({ ...f.project.artifacts[0], id: randomUUID() });
  assert.throws(() => f.showcase.publish(owner, { ...input, artifactIds: f.project.artifacts.map(item => item.id) }), error => error.status === 413);
});

test('public reads fail closed if a revoke cannot be persisted', t => {
  const f = fixture(t), saved = f.showcase.publish(owner, { projectId: f.project.id, title: 'Public', description: 'Selected result.', artifactIds: [f.project.artifacts[0].id] });
  writeFileSync(f.config.file + '.write-lock', 'fixture');
  assert.throws(() => f.showcase.revoke(owner, { projectId: f.project.id }), /persistence/);
  assert.equal(f.showcase.healthy, false); assert.throws(() => f.showcase.public(saved.showcase.slug), error => error.status === 503);
});

test('private notifications deduplicate persisted job, research and connection events and acknowledge by exact owner state', t => {
  const f = fixture(t), p = f.project;
  p.research = { checks: [{ id: randomUUID(), status: 'error', startedAt: at, finishedAt: at, report: { status: 'blocked', error: 'Budget cannot cover task', attemptedAt: at }, review: { status: 'none' } }] };
  const input = { projects: [p], jobs: [{ id: randomUUID(), projectId: p.id, status: 'completed', finishedAt: at, at }], socialSnapshots: [{ projectId: p.id, accounts: { x: { connectionId: randomUUID(), connectedAt: Date.parse(at), status: 'reconnect_required' } }, outbox: [] }] };
  const snapshot = f.notifications.sync(input); assert.equal(snapshot.notifications.length, 4); assert.equal(snapshot.unread, 4);
  assert.equal(f.notifications.sync(input).notifications.length, 4);
  f.notifications.ack({ id: snapshot.notifications[0].id }); assert.equal(f.notifications.snapshot().unread, 3);
  const restarted = new ExperienceNotifications(f.notificationsConfig); assert.equal(restarted.sync(input).unread, 3);
  assert.equal(restarted.ack({ id: 'all' }).unread, 0); assert.equal(restarted.sync(input).unread, 0);
  assert.throws(() => restarted.ack({ id: 'f'.repeat(64) }), error => error.status === 404);
  assert.throws(() => new ExperienceNotifications({ ...f.notificationsConfig, owner: other }), /original key/);
  assert.equal(readFileSync(f.notificationsConfig.file, 'utf8').includes(p.id), false);
});

test('notification inbox retains at most100 and does not reintroduce pruned events or foreign project jobs', t => {
  const f = fixture(t), jobs = Array.from({ length: 120 }, (_, i) => ({ id: `job-${i}`, projectId: f.project.id, status: 'completed', at, finishedAt: new Date(Date.parse(at) + i * 1000).toISOString() }));
  jobs.push({ id: 'foreign', projectId: f.otherProject.id, status: 'completed', at, finishedAt: at });
  const input = { projects: [f.project], jobs }; assert.equal(f.notifications.sync(input).notifications.length, 100);
  f.notifications.ack({ id: 'all' }); assert.equal(new ExperienceNotifications(f.notificationsConfig).sync(input).unread, 0);
  assert.equal(f.notifications.snapshot().notifications.some(item => item.projectId === f.otherProject.id), false);
});

test('low-budget notices count reserved caps and deduplicate per day and policy; autonomous cycles summarize their jobs', t => {
  const f = fixture(t), p = f.project, cycleId = randomUUID();
  p.policy = { total: 1000000, daily: 500000, request: 50000 }; p.committed = 940000; p.days = { '2026-10-02': 490000 };
  p.autonomy = { cycles: [{ id: cycleId, status: 'completed', at, finishedAt: at }, { id: randomUUID(), status: 'blocked', at, finishedAt: at, error: 'Budget cannot cover planner' }] };
  const input = { projects: [p], jobs: [{ id: randomUUID(), projectId: p.id, status: 'completed', at, finishedAt: at, autonomy: { cycleId } }] };
  const first = f.notifications.sync(input); assert.equal(first.notifications.length, 3);
  const budget = first.notifications.find(item => item.kind === 'low-budget'); assert.match(budget.message, /0.060000 total and \$0.010000 today/); assert.equal(first.notifications.filter(item => item.kind === 'job-completed').length, 0);
  f.notifications.ack({ id: 'all' }); p.committed = 980000; assert.equal(f.notifications.sync(input).unread, 0);
  p.policy.total = 1100000; assert.equal(f.notifications.sync(input).unread, 1);
});
