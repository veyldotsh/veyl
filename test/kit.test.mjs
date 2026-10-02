import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { Kit } from '../src/kit.mjs';
import { ZkApiProvider } from '../src/provider.mjs';
import { LocalChain } from '../src/chain.mjs';
import { readSource } from '../src/tools.mjs';
import { createApp } from '../src/server.mjs';

function setup({ live = false, fail = false, total = 5_000_000, daily = 3_000_000, swarm = true } = {}) {
  const file = join(mkdtempSync(join(tmpdir(), 'agentkit-test-')), 'kit.json');
  const requests = [];
  const provider = { mode: live ? 'zkapi' : 'demo', models: async () => [{ id: 'test/model', oa_request_limit_micro_usd: 500_000 }], complete: async body => { requests.push(body); if (fail) throw new Error('upstream secret'); return { answer: 'Useful deliverable', verification: 'fixture', demoCharge: 30_000 }; } };
  const store = new Store(file, provider.mode), kit = new Kit({ store, provider, chain: { status: async () => ({ ready: false }) }, now: () => new Date('2026-10-01T12:00:00Z') });
  const input = { requestKey: randomUUID(), name: 'Test Agent', symbol: 'TEST', purpose: 'Review supplied evidence.', template: 'research', swarm, model: 'test/model', total, daily, request: 1_000_000 };
  const p = kit.create(input); return { kit, p, input, requests, file, provider };
}
test('three-stage swarm reserves before the first call, delivers and recalls memory', async () => {
  const { kit, p, requests, file } = setup(); kit.note(p.id, 'Remember the funding distinction.');
  const original = kit.provider.complete;
  kit.provider.complete = async body => { const disk = JSON.parse(readFileSync(file)); assert.ok(disk.projects[0].committed >= 500_000); assert.equal(disk.jobs[0].status, 'running'); return original(body); };
  const j = await kit.submit(p.id, { requestKey: randomUUID(), prompt: 'Prepare a report' }); await kit.execution;
  assert.equal(j.status, 'completed'); assert.equal(requests.length, 3); assert.equal(p.committed, 90_000); assert.equal(p.artifacts.length, 1);
  assert.match(requests[0].messages[1].content, /Remember the funding distinction/);
  assert.match(requests[2].messages[1].content, /Useful deliverable/);
  const restored = new Store(file, 'demo'); assert.equal(restored.data.projects[0].artifacts.length, 1); assert.equal(restored.data.projects[0].committed, 90_000);
});
test('insufficient total or daily allowance prevents all model calls', async () => {
  for (const args of [{ total: 1_000_000, daily: 1_000_000 }, { total: 4_000_000, daily: 1_000_000 }]) {
    const { kit, p, requests } = setup(args); await assert.rejects(kit.submit(p.id, { requestKey: randomUUID(), prompt: 'Do work' }), /Budget/); assert.equal(requests.length, 0); assert.equal(p.committed, 0);
  }
});
test('paid uncertainty and successful replies both retain full caps', async () => {
  for (const fail of [false, true]) { const { kit, p } = setup({ live: true, fail }); const j = await kit.submit(p.id, { requestKey: randomUUID(), prompt: 'Do work' }); await kit.execution; assert.equal(p.committed, 1_500_000); assert.equal(j.status, fail ? 'interrupted' : 'completed'); assert.doesNotMatch(j.error || '', /upstream secret/); }
});
test('idempotent job submission cannot spend twice, mismatches refused', async () => {
  const { kit, p, requests } = setup(); const input = { requestKey: randomUUID(), prompt: 'Do work' }; const job = await kit.submit(p.id, input); await kit.execution;
  assert.equal((await kit.submit(p.id, input)).id, job.id); assert.equal(requests.length, 3);
  await assert.rejects(kit.submit(p.id, { ...input, prompt: 'different' }), /already used/);
});
test('runtime rejects concurrency and paused projects', async () => {
  const { kit, p } = setup(); let done; kit.provider.complete = () => new Promise(resolve => { done = resolve; });
  const job = await kit.submit(p.id, { requestKey: randomUUID(), prompt: 'Do work' });
  await assert.rejects(kit.submit(p.id, { requestKey: randomUUID(), prompt: 'Other' }), /busy/);
  kit.pause(p.id); done({ answer: 'One stage', demoCharge: 30_000 }); await kit.execution;
  assert.equal(job.status, 'interrupted'); assert.equal(job.steps[1].status, 'queued');
  await assert.rejects(kit.submit(p.id, { requestKey: randomUUID(), prompt: 'Paused' }), /Resume/);
});
test('restart marks unfinished work interrupted without releasing its reservation', () => {
  const { file, p } = setup(); const saved = JSON.parse(readFileSync(file)); saved.projects[0].committed = 1_500_000;
  saved.projects[0].days['2026-10-01'] = 1_500_000;
  saved.jobs.push({ id: randomUUID(), requestKey: randomUUID(), projectId: p.id, mode: 'demo', day: '2026-10-01', cap: 500_000, reservation: 1_500_000, status: 'running', steps: [{ status: 'running' }, { status: 'queued' }, { status: 'queued' }] }); writeFileSync(file, JSON.stringify(saved));
  const next = new Store(file, 'demo'); assert.equal(next.data.jobs[0].status, 'interrupted'); assert.equal(next.data.jobs[0].steps[0].status, 'uncertain'); assert.equal(next.data.projects[0].committed, 1_500_000);
  assert.throws(() => new Store(file, 'zkapi'), /mismatch/);
});
test('project launch deduplicates identical requests and validates budget and symbol', () => {
  const { kit, p, input } = setup(); assert.equal(kit.create(input).id, p.id); assert.throws(() => kit.create({ ...input, name: 'Other' }), /different/);
  assert.throws(() => kit.create({ ...input, requestKey: randomUUID(), symbol: '<bad>' }), /Symbol/);
  assert.throws(() => kit.create({ ...input, requestKey: randomUUID(), daily: 6_000_000 }), /allowance/);
  for (const template of ['constructor', '__proto__', 'toString']) assert.throws(() => kit.create({ ...input, requestKey: randomUUID(), template }), /Unknown template/);
  assert.equal(kit.store.healthy, true);
});

test('swarm stages reserve the UTC day on which each call is dispatched', async () => {
  const { kit, p, requests, file } = setup(); let now = new Date('2026-10-01T23:59:59Z'); kit.now = () => now;
  const complete = kit.provider.complete;
  kit.provider.complete = async body => { const result = await complete(body); now = new Date('2026-10-02T00:00:01Z'); return result; };
  const job = await kit.submit(p.id, { requestKey: randomUUID(), prompt: 'Cross midnight' }); await kit.execution;
  assert.equal(job.status, 'completed'); assert.equal(requests.length, 3);
  assert.deepEqual(p.days, { '2026-10-01': 30_000, '2026-10-02': 60_000 });
  assert.deepEqual(job.steps.map(s => s.day), ['2026-10-01', '2026-10-02', '2026-10-02']);
  assert.equal(new Store(file, 'demo').data.projects[0].committed, 90_000);
});

test('day changes cannot bypass an already exhausted daily allowance', async () => {
  const { kit, p, requests } = setup({ live: true, daily: 1_500_000 });
  await kit.submit(p.id, { requestKey: randomUUID(), prompt: 'First day task' }); await kit.execution;
  kit.now = () => new Date('2026-10-02T00:00:01Z');
  const complete = kit.provider.complete;
  kit.provider.complete = async body => { const result = await complete(body); kit.now = () => new Date('2026-10-01T23:59:59Z'); return result; };
  const job = await kit.submit(p.id, { requestKey: randomUUID(), prompt: 'Clock changed' }); await kit.execution;
  assert.equal(job.status, 'interrupted'); assert.equal(requests.length, 4);
  assert.equal(p.days['2026-10-01'], 1_500_000); assert.equal(p.days['2026-10-02'], 1_500_000);
});

test('corrupt or inconsistent budget state refuses startup without rewriting recovery data', async () => {
  const { kit, p, file } = setup({ live: true });
  await kit.submit(p.id, { requestKey: randomUUID(), prompt: 'Durable cap' }); await kit.execution;
  const original = readFileSync(file, 'utf8');
  const corruptions = [
    state => { state.projects[0].committed = '0'; },
    state => { state.projects[0].committed = 0; },
    state => { state.projects[0].days['2026-10-01'] = 0; },
    state => { state.jobs[0].reservation = 0; },
    state => { state.jobs.push(state.jobs[0]); },
    state => { state.jobs[0].steps[0].simulatedCharge = 0; },
    state => { state.projects[0].policy.daily = null; },
    state => { state.projects[0].days['2026-99-99'] = 0; }
  ];
  for (const corrupt of corruptions) {
    const state = JSON.parse(original); corrupt(state); const damaged = JSON.stringify(state); writeFileSync(file, damaged);
    assert.throws(() => new Store(file, 'zkapi'), /mismatch/); assert.equal(readFileSync(file, 'utf8'), damaged);
  }
});

test('failed durable reservation blocks further work and cannot dispatch a paid call', async () => {
  const { kit, p, input, file, requests } = setup({ live: true }); const durable = readFileSync(file, 'utf8');
  mkdirSync(file + '.tmp');
  await assert.rejects(kit.submit(p.id, { requestKey: randomUUID(), prompt: 'Cannot persist' }), error => error.status === 503);
  assert.equal(requests.length, 0); assert.equal(readFileSync(file, 'utf8'), durable); assert.equal(kit.snapshot().persistence, 'blocked');
  await assert.rejects(kit.submit(p.id, { requestKey: randomUUID(), prompt: 'Do not retry' }), /Persistence failed/);
  assert.throws(() => kit.create({ ...input, requestKey: randomUUID() }), /Persistence failed/);
  assert.throws(() => kit.note(p.id, 'Do not silently recover'), /Persistence failed/);
});

test('a mid-flight persistence failure halts the swarm and retains live caps', async () => {
  const { kit, p, file, requests } = setup({ live: true }); const complete = kit.provider.complete;
  kit.provider.complete = async body => { const result = await complete(body); mkdirSync(file + '.tmp'); return result; };
  const job = await kit.submit(p.id, { requestKey: randomUUID(), prompt: 'Disk fills while waiting' }); await kit.execution;
  assert.equal(job.status, 'interrupted'); assert.equal(requests.length, 1); assert.equal(p.committed, 1_500_000);
  assert.equal(kit.store.healthy, false); assert.equal(JSON.parse(readFileSync(file)).projects[0].committed, 1_500_000);
});
test('live schedules retain full caps and pause before exceeding their daily allowance', async () => {
  const { kit, p, requests } = setup({ live: true, total: 3_000_000, daily: 2_000_000 });
  kit.schedule(p.id, { enabled: true, minutes: 15, prompt: 'Recurring' }); p.schedule.nextAt = '2026-10-01T11:00:00Z';
  await kit.tick(); await kit.execution; assert.equal(p.committed, 1_500_000); assert.equal(requests.length, 3);
  p.schedule.nextAt = '2026-10-01T11:00:00Z'; await kit.tick();
  assert.equal(p.schedule, null); assert.equal(p.committed, 1_500_000); assert.equal(requests.length, 3);
});

test('settings cannot erase commitments and per-project provider cannot change during a swarm', async () => {
  const { kit, p, provider } = setup({ live: true }); const calls = [];
  const isolated = { ...provider, complete: async () => { calls.push(p.id); kit.providerForProject = () => ({ ...provider, complete: () => { throw new Error('Wrong project provider'); } }); return { answer: 'Isolated output' }; } };
  kit.providerForProject = project => { assert.equal(project.id, p.id); return isolated; };
  const job = await kit.submit(p.id, { requestKey: randomUUID(), prompt: 'Isolation' });
  assert.throws(() => kit.settings(p.id, { model: 'other', total: 5_000_000, daily: 3_000_000, request: 1_000_000 }), /current work/);
  await kit.execution; assert.equal(job.status, 'completed'); assert.equal(calls.length, 3);
  assert.throws(() => kit.settings(p.id, { model: p.model, total: 1_000_000, daily: 1_000_000, request: 500_000 }), /reservations/);
  kit.settings(p.id, { model: p.model, total: 6_000_000, daily: 4_000_000, request: 1_000_000 });
  assert.equal(p.committed, 1_500_000); assert.equal(p.policy.total, 6_000_000);
});
test('source reader rejects private, credentialed and unreviewed destinations', async () => {
  for (const url of ['http://127.0.0.1:8547', 'https://169.254.169.254/', 'https://github.com.evil.test', 'https://x:y@github.com/', 'file:///etc/passwd']) await assert.rejects(readSource(url));
});

test('source reader bounds data, strips HTML scripts and sanitizes network failures', async () => {
  const url = 'https://ethereum.org/';
  const html = await readSource(url, { fetcher: async (_url, options) => { assert.equal(options.redirect, 'error'); return new Response('<p>Evidence</p><script>untrusted code</script><style>hidden</style>', { headers: { 'content-type': 'text/html' } }); } });
  assert.equal(html.text, 'Evidence');
  const json = await readSource(url, { fetcher: async () => new Response('{"code":"a < b > c"}', { headers: { 'content-type': 'application/json' } }) });
  assert.equal(json.text, '{"code":"a < b > c"}');
  await assert.rejects(readSource(url, { fetcher: async () => new Response('x'.repeat(500_001), { headers: { 'content-type': 'text/plain' } }) }), error => error.status === 413);
  await assert.rejects(readSource(url, { fetcher: async () => { throw new Error('upstream secret'); } }), error => error.status === 502 && !error.message.includes('secret'));
  await assert.rejects(readSource(url, { fetcher: async () => new Response('', { headers: { 'content-type': 'text/plain' } }) }), /no readable text/);
});

test('fee receipt flow persists router setup, preserves allowances and refuses overlapping or live tests', async () => {
  const { kit, p, file } = setup(); p.chain = { treasury: 'fixture' };
  assert.deepEqual(kit.snapshot().feeAllocation, { treasuryBps: 7000, creatorBps: 2000, protocolBps: 1000 });
  const policy = { ...p.policy }; let finish;
  kit.chain.testRevenue = async (project, checkpoint) => {
    project.chain.revenueRouter = 'router-fixture'; checkpoint();
    assert.equal(JSON.parse(readFileSync(file)).projects[0].chain.revenueRouter, 'router-fixture');
    await new Promise(resolve => { finish = resolve; }); return { amount: '0.01', hash: 'tx-fixture' };
  };
  const receipt = kit.revenue(p.id);
  await assert.rejects(kit.revenue(p.id), /already running/);
  finish(); await receipt;
  assert.deepEqual(p.policy, policy); assert.equal(p.committed, 0); assert.equal(kit.operations.size, 0);
  kit.chain.distributeRevenue = async () => ({ hashes: ['a', 'b', 'c'] }); await kit.revenue(p.id, true);
  assert.match(p.events.at(-1).message, /3 pending/);
  kit.chain.testRevenue = async () => { throw new Error('fixture failure'); };
  await assert.rejects(kit.revenue(p.id), /fixture failure/); assert.equal(kit.operations.size, 0);
  const live = setup({ live: true }); await assert.rejects(live.kit.revenue(live.p.id), /demo mode/);
});
test('daemon adapter preserves budget metadata and verification status; never retries', async () => {
  let calls = 0;
  const provider = new ZkApiProvider({ fetcher: async (_url, options) => { calls++; assert.equal(options.redirect, 'error'); return new Response(JSON.stringify({ choices: [{ message: { content: 'Hi' } }] }), { headers: { 'x-oa-verification-status': 'verifier-unavailable', 'x-oa-verification-detail': 'trusted_station_fallback' } }); } });
  assert.match((await provider.complete({})).verification, /unavailable/); assert.equal(calls, 1);
  const fail = new ZkApiProvider({ fetcher: async () => { calls++; throw new Error('secret'); } }); await assert.rejects(fail.complete({}), /Cannot read/); assert.equal(calls, 2);
  assert.throws(() => new ZkApiProvider({ base: 'https://remote.test' }), /127.0.0.1/);
  assert.throws(() => new LocalChain('https://base-mainnet.g.alchemy.com'), /loopback/);
});

test('daemon rejects malformed and ambiguous catalogs without trusting missing caps', async () => {
  const model = { id: 'test/model', oa_request_limit_micro_usd: 500_000 };
  for (const data of [null, {}, { data: [null] }, { data: [{ id: 'test/model' }] }, { data: [{ ...model, oa_request_limit_micro_usd: '500000' }] }, { data: [model, model] }]) {
    let calls = 0; const provider = new ZkApiProvider({ fetcher: async () => { calls++; return new Response(JSON.stringify(data)); } });
    await assert.rejects(provider.models(), error => error.status === 502); assert.equal(calls, 1);
  }
  const provider = new ZkApiProvider({ fetcher: async () => new Response(JSON.stringify({ data: [model] })) });
  assert.deepEqual(await provider.models(), [model]);
});

test('daemon rejects oversized or non-text responses and never upgrades missing verification', async () => {
  const answer = new ZkApiProvider({ fetcher: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Answer' } }] })) });
  assert.equal((await answer.complete({})).verification, 'not reported');
  for (const data of [null, { choices: [] }, { choices: [{ message: { content: [] } }] }]) {
    const provider = new ZkApiProvider({ fetcher: async () => new Response(JSON.stringify(data)) });
    await assert.rejects(provider.complete({}), error => error.status === 502);
  }
  const oversized = new ZkApiProvider({ fetcher: async () => new Response('x'.repeat(2_000_001)) });
  await assert.rejects(oversized.complete({}), /too large/);
});
test('HTTP origin, CSRF, request validation and artifact access', async t => {
  const { kit } = setup(); const server = createApp(kit); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`; const state = await (await fetch(base + '/api/state')).json();
  assert.equal((await fetch(base + '/api/state', { headers: { Origin: 'https://evil.test' } })).status, 403);
  assert.equal((await fetch(base + '/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  const headers = { 'Content-Type': 'application/json', 'X-Agent-CSRF': state.csrf };
  assert.equal((await fetch(base + '/api/projects', { method: 'POST', headers, body: 'null' })).status, 400);
  assert.equal((await fetch(base + '/api/artifacts/missing')).status, 404);
  assert.equal((await fetch(base + '/')).status, 200);
});

test('market and funding endpoints retain origin, CSRF, mode and persistence boundaries', async t => {
  const { kit, p } = setup({ live: true }); let calls = 0;
  kit.markets = { launch: async () => { calls++; }, status: async () => ({ configured: false }) };
  kit.funding = { snapshot: () => ({ approvalEnabled: false, intents: [] }), capabilities: () => ({ approvalEnabled: false }), approve: async () => { calls++; return { attempted: true }; } };
  const server = createApp(kit); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`, state = await (await fetch(base + '/api/state')).json();
  const headers = { 'Content-Type': 'application/json', 'X-Agent-CSRF': state.csrf };
  for (const path of [`/api/projects/${p.id}/market-launch`, '/api/funding/approve']) {
    assert.equal((await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await fetch(base + path, { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.test' }, body: '{}' })).status, 403);
  }
  assert.equal((await fetch(base + `/api/projects/${p.id}/market-launch`, { method: 'POST', headers, body: '{}' })).status, 409);
  kit.store.healthy = false;
  assert.equal((await fetch(base + '/api/funding/approve', { method: 'POST', headers, body: '{}' })).status, 503);
  assert.equal(calls, 0);
});
