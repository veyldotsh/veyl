import test from 'node:test';
import assert from 'node:assert/strict';
import { Activity, jobCharge } from '../src/activity.mjs';

test('activity charges distinguish exact settled ETH/value from pending initial and extra-round caps', () => {
  const job = { mode: 'zkapi', reservation: 61000, steps: [{ callAccounting: { status: 'settled', chargeWei: '1000000000000', valuationMicroUsd: 30000 }, additionalCalls: [{ callAccounting: { status: 'settled', chargeWei: '2000000000000', valuationMicroUsd: 1000 } }, { callAccounting: { status: 'pending', reservedMicroUsd: 30000 } }] }] };
  assert.deepEqual(jobCharge(job), { mode: 'zkapi', settledWei: '3000000000000', settledMicroUsd: 31000, pendingMicroUsd: 30000, settledCalls: 2, totalCalls: 3 });
  assert.equal(jobCharge({ mode: 'demo', reservation: 10, steps: [{ simulatedCharge: 10 }] }).simulatedMicroUsd, 10);
});

test('activity is project-scoped, chronological, cursor-bounded and excludes raw prompts, output and secrets', () => {
  const at = '2026-10-02T12:00:00.000Z', later = '2026-10-02T12:00:01.000Z';
  const project = { id: 'one', model: 'fixture', events: [{ at, type: 'created', message: 'Created.' }, { at, type: 'task', message: 'Task accepted.' }, { at: later, type: 'delivered', message: 'Deliverable saved.' }], research: { checks: [{ id: 'check', startedAt: at, finishedAt: later, name: 'Source watch', status: 'unchanged', sources: [{ url: 'https://ethereum.org/', attemptedAt: at, finishedAt: later, fetchedAt: later, status: 'unchanged', afterExcerpt: 'PRIVATE_RAW_SOURCE' }] }] } };
  const job = { id: 'job', projectId: 'one', at, finishedAt: later, status: 'completed', mode: 'zkapi', model: 'fixture', reservation: 500000, artifactId: 'artifact', prompt: 'PRIVATE_RAW_PROMPT', steps: [{ role: 'Researcher', at, finishedAt: later, status: 'completed', output: 'PRIVATE_RAW_OUTPUT', toolActivity: [{ id: 'tool', at: later, finishedAt: later, name: 'read_source', status: 'completed', evidence: { source: 'https://ethereum.org/', fetchedAt: later }, result: { text: 'PRIVATE_TOOL_OUTPUT', credentials: 'PRIVATE_SECRET' } }] }] };
  const kit = { project: id => { assert.equal(id, 'one'); return project; }, store: { data: { jobs: [job, { ...job, id: 'other', projectId: 'two' }] } }, now: () => new Date(later) };
  const activity = new Activity(kit), all = activity.snapshot('one');
  assert.equal(all.transport, 'polling'); assert.ok(all.events.some(event => event.type === 'tool' && event.source === 'https://ethereum.org/'));
  assert.equal(all.events.find(event => event.type === 'job').artifactId, 'artifact');
  assert.equal(all.events.filter(event => event.type === 'stage').length, 0);
  assert.deepEqual(all.events.filter(event => event.type === 'project-event').map(event => event.title), ['Agent created']);
  assert.doesNotMatch(JSON.stringify(all), /PRIVATE_|other/); assert.equal(all.events[0].type, 'tool');
  const first = activity.snapshot('one', { limit: 2 }), second = activity.snapshot('one', { limit: 2, before: first.nextCursor });
  assert.equal(first.events.length, 2); assert.equal(second.events.length, 2); assert.ok(!second.events.some(event => first.events.some(previous => previous.id === event.id)));
  assert.throws(() => activity.snapshot('one', { before: 'invalid' }), /cursor/); assert.throws(() => activity.snapshot('one', { limit: 101 }), /limit/);
  assert.ok(Buffer.byteLength(JSON.stringify(all)) < 750000);
  job.steps.push({ role: 'Reviewer', at, status: 'running' });
  assert.deepEqual(activity.snapshot('one').events.filter(event => event.type === 'stage').map(event => event.title).sort(), ['Researcher', 'Reviewer']);
});
