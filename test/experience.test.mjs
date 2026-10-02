import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ExperienceNotifications, ShowcaseDirectory } from '../src/experience.mjs';
import { Problem } from '../src/agent.mjs';

const owner = '0x1111111111111111111111111111111111111111', other = '0x2222222222222222222222222222222222222222', at = '2026-10-02T12:00:00.000Z';
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'veyl-experience-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const project = { id: randomUUID(), purpose: 'PRIVATE PURPOSE', notes: [{ content: 'PRIVATE NOTE' }], artifacts: [{ id: randomUUID(), title: 'PRIVATE PROMPT', content: 'Selected result content', at, mode: 'zkapi', privateField: 'MUST NOT LEAK' }] };
  const otherProject = { id: randomUUID(), artifacts: [{ id: randomUUID(), title: 'Another secret', content: 'Foreign output', at, mode: 'zkapi' }] };
  const key = Buffer.alloc(32, 23), config = { file: join(dir, 'showcase.sealed.json'), key, now: () => at, projectForOwner: (who, id) => { const p = who === owner ? project : who === other ? otherProject : null; if (!p || p.id !== id) throw new Problem('Project not found.', 404); return p; } };
  const notificationsConfig = { file: join(dir, 'notifications.sealed.json'), key, owner, now: () => at };
  return { dir, project, otherProject, config, notificationsConfig, showcase: new ShowcaseDirectory(config), notifications: new ExperienceNotifications(notificationsConfig) };
}

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
