import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { DeveloperKeys } from '../src/developer-auth.mjs';
import { WalletAuth, sessionCookie } from '../src/auth.mjs';
import { GatewayVerifier, signGateway } from '../src/gateway-auth.mjs';
import { TenantRegistry, createProductionApp } from '../src/production.mjs';

const owner = '0x1111111111111111111111111111111111111111', other = '0x2222222222222222222222222222222222222222', origin = 'https://veyl.sh', gatewayKey = '1a'.repeat(32);
function directory(t) { const dir = mkdtempSync(resolve(tmpdir(), 'veyl-developer-')); t.after(() => { assert.ok(dir.startsWith(resolve(tmpdir(), 'veyl-developer-'))); rmSync(dir, { recursive: true, force: true }); }); return dir; }
function keyFixture(t, options = {}) { const file = resolve(directory(t), 'keys.sealed.json'), key = randomBytes(32); let clock = Date.now(); const config = { file, key, now: () => clock, ...options }; return { service: new DeveloperKeys(config), file, config, advance: ms => clock += ms, restart: () => new DeveloperKeys(config) }; }

test('developer key plaintext appears only on issue; encrypted hash registry survives restart and revocation', t => {
  const f = keyFixture(t), projectId = randomUUID(), issued = f.service.issue(owner, projectId, { name: 'SDK', scopes: ['read', 'jobs'] });
  assert.match(issued.token, /^veyl_sk_[a-f0-9]{64}$/); assert.equal(issued.key.projectId, projectId); assert.equal(issued.key.hash, undefined);
  const raw = readFileSync(f.file, 'utf8'); assert.ok(!raw.includes(issued.token)); assert.ok(!raw.includes(owner)); assert.ok(!raw.includes('SDK'));
  assert.ok(!JSON.stringify(f.service.list(owner, projectId)).includes(issued.token)); assert.equal(f.service.list(other, projectId).length, 0);
  const next = f.restart(); assert.equal(next.authenticate('Bearer ' + issued.token).projectId, projectId);
  assert.throws(() => next.revoke(other, projectId, issued.key.id), /not found/);
  next.revoke(owner, projectId, issued.key.id); assert.throws(() => next.authenticate('Bearer ' + issued.token), /revoked/);
  assert.throws(() => f.restart().authenticate('Bearer ' + issued.token), /revoked/);
});
test('invalid scopes, expiry and active-key capacity fail closed; expired keys cannot authenticate', t => {
  const f = keyFixture(t, { maxActivePerProject: 1 }), id = randomUUID();
  for (const input of [{ name: 'Bad', scopes: ['funding'] }, { name: 'Bad', scopes: ['read', 'read'] }, { name: 'Bad', scopes: ['read'], expiresInDays: 91 }, { name: 'Bad', scopes: ['read'], owner: other }]) assert.throws(() => f.service.issue(owner, id, input));
  const issued = f.service.issue(owner, id, { name: 'Short', scopes: ['read'], expiresInDays: 1 });
  assert.throws(() => f.service.issue(owner, id, { name: 'Second', scopes: ['read'] }), /capacity/);
  f.advance(86400000); assert.throws(() => f.service.authenticate('Bearer ' + issued.token), /expired/);
  assert.ok(f.service.issue(owner, id, { name: 'Replacement', scopes: ['read'] }).token);
  assert.throws(() => f.service.authenticate('Bearer ' + issued.token + ', Bearer ' + issued.token), /Invalid/);
});
test('developer authentication is indexed and bounded by key/client rates; persistence failure disables auth', t => {
  const f = keyFixture(t), id = randomUUID(), issued = f.service.issue(owner, id, { name: 'Rate', scopes: ['read'] });
  for (let i = 0; i < 60; i++) f.service.authenticate('Bearer ' + issued.token, 'client');
  assert.throws(() => f.service.authenticate('Bearer ' + issued.token, 'client'), error => error.status === 429);
  f.advance(60001); assert.equal(f.service.authenticate('Bearer ' + issued.token).projectId, id);
  mkdirSync(f.file + '.tmp'); assert.throws(() => f.service.revoke(owner, id, issued.key.id), /persistence/);
  assert.throws(() => f.service.authenticate('Bearer ' + issued.token), /persistence/);
});

async function apiFixture(t) {
  const dir = directory(t), auth = new WalletAuth({ origin, state: { version: 1, challenges: [], sessions: [] }, save() {} });
  const account = privateKeyToAccount(generatePrivateKey()), second = privateKeyToAccount(generatePrivateKey()), sessions = [];
  for (const a of [account, second]) { const challenge = auth.challenge({ address: a.address, chainId: 1 }); sessions.push(await auth.authenticate({ id: challenge.id, signature: await a.signMessage({ message: challenge.message }) })); }
  const registry = new TenantRegistry({ directory: dir, key: randomBytes(32), mainnet: {} }), kit = registry.get(account.address), foreignKit = registry.get(second.address);
  const create = (k, name) => k.create({ requestKey: randomUUID(), name, symbol: 'TEST', purpose: 'API fixture', template: 'research', swarm: false, model: 'fixture/model', total: 2000, daily: 2000, request: 1000 });
  const project = create(kit, 'API project'), sibling = create(kit, 'Sibling private'), foreign = create(foreignKit, 'Other owner private');
  registry.catalog = async (_owner, id) => { assert.equal(id, project.id); return [{ id: 'fixture/model', oa_request_limit_micro_usd: 1000 }]; };
  kit.providerCatalogForProject = async () => [{ id: 'fixture/model', oa_request_limit_micro_usd: 1000 }]; registry.scheduler.tick = async () => {};
  registry.inferenceAdmission = async () => ({ status: 'healthy', canInfer: true }); // Fixture note; no daemon or paid call.
  let publications = 0, drafted = [];
  registry.social = (who, id) => { assert.equal(who.toLowerCase(), account.address.toLowerCase()); assert.equal(id, project.id); return { snapshot: () => ({ outbox: drafted }), draft: async body => { const item = { id: randomUUID(), status: 'draft', preview: body }; drafted.push(item); return item; }, publish: () => { publications++; assert.fail('Developer tokens cannot publish'); } }; };
  const app = createProductionApp({ auth, registry, gateway: new GatewayVerifier({ key: gatewayKey }), origin, mainnet: {} });
  await new Promise(r => app.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => app.close(r)));
  async function request(path, { token, body, session, csrf, extraHeaders = {} } = {}) {
    const method = body === undefined ? 'GET' : 'POST', raw = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    const headers = { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...(session ? { cookie: sessionCookie(session.token), 'x-agent-csrf': csrf ?? session.csrf, origin } : {}), ...extraHeaders };
    Object.assign(headers, signGateway({ key: gatewayKey, method, path, headers, body: raw }));
    const result = await fetch(`http://127.0.0.1:${app.address().port}${path}`, { method, headers, ...(method === 'POST' ? { body: raw } : {}) });
    return { status: result.status, body: await result.json(), requestId: result.headers.get('x-request-id') };
  }
  const issue = (scopes = ['read', 'jobs', 'memory', 'drafts']) => registry.developerKeys.issue(account.address, project.id, { name: 'Fixture key', scopes });
  return { registry, kit, project, sibling, foreign, sessions, request, issue, publications: () => publications };
}

test('wallet+CSRF manages keys; bearer cannot reach owner operations or another project', async t => {
  const f = await apiFixture(t), path = `/api/projects/${f.project.id}/developer-keys`, session = f.sessions[0];
  assert.equal((await f.request(path, { body: { name: 'Key', scopes: ['read'] }, session, csrf: 'bad' })).status, 403);
  assert.equal((await f.request(path, { body: { name: 'Key', scopes: ['read'] }, session: f.sessions[1] })).status, 404);
  const issued = await f.request(path, { body: { name: 'Key', scopes: ['read'] }, session }); assert.equal(issued.status, 201);
  const token = issued.body.token, keyId = issued.body.key.id;
  const listed = await f.request(path, { session }); assert.equal(listed.body.keys.length, 1); assert.ok(!JSON.stringify(listed.body).includes(token));
  const read = await f.request('/api/developer/v1/project', { token }); assert.equal(read.status, 200); assert.equal(read.body.project.id, f.project.id); assert.equal(read.body.project.mainnet, undefined); assert.equal(read.body.project.tools.length, 4);
  for (const route of ['/api/state', `/api/projects/${f.sibling.id}/notes`, `/api/projects/${f.project.id}/funding/approve`, `/api/projects/${f.project.id}/social/publish`, `/api/projects/${f.project.id}/mainnet/launch`, path]) assert.equal((await f.request(route, { token, body: {} })).status, 403);
  assert.equal((await f.request('/api/developer/v1/project?projectId=' + f.foreign.id, { token })).status, 400);
  assert.equal((await f.request('/api/developer/v1/project', { token, extraHeaders: { origin: 'https://evil.invalid' } })).status, 403);
  assert.equal((await f.request('/api/developer/v1/project', { token, session })).status, 403);
  const revoked = await f.request(path + '/' + keyId + '/revoke', { session, body: {} }); assert.equal(revoked.status, 200);
  const rejected = await f.request('/api/developer/v1/project', { token }); assert.equal(rejected.status, 401); assert.equal(rejected.body.code, 'UNAUTHENTICATED'); assert.equal(rejected.body.requestId, rejected.requestId);
});

test('scoped job requests use the original durable queue, unchanged budgets and idempotency', async t => {
  const f = await apiFixture(t), token = f.issue().token, requestKey = randomUUID();
  const first = await f.request('/api/developer/v1/jobs', { token, body: { requestKey, prompt: 'Prepare a bounded fixture' } }); assert.equal(first.status, 202); assert.equal(first.body.job.status, 'queued'); assert.equal(f.project.committed, 1000);
  const repeated = await f.request('/api/developer/v1/jobs', { token, body: { requestKey, prompt: 'Prepare a bounded fixture' } }); assert.equal(repeated.body.job.id, first.body.job.id); assert.equal(f.project.committed, 1000);
  const found = await f.request('/api/developer/v1/jobs?requestKey=' + requestKey, { token }); assert.equal(found.body.jobs[0].id, first.body.job.id);
  assert.equal((await f.request('/api/developer/v1/jobs/' + first.body.job.id, { token })).body.artifact, null);
  assert.equal((await f.request('/api/developer/v1/jobs', { token, body: { requestKey, prompt: 'Different' } })).status, 409);
  assert.equal((await f.request('/api/developer/v1/jobs', { token, body: { requestKey: randomUUID(), prompt: 'Second' } })).status, 202);
  assert.equal((await f.request('/api/developer/v1/jobs', { token, body: { requestKey: randomUUID(), prompt: 'Over budget' } })).status, 409); assert.equal(f.project.committed, 2000);
  assert.equal((await f.request('/api/developer/v1/jobs', { token, body: { requestKey: randomUUID(), prompt: 'Override', total: 1000000 } })).status, 400);
  assert.equal(f.registry.scheduler.snapshot(f.sessions[0].address).entries?.length ?? f.registry.queueState.data.entries.length, 2);
});

test('direct memory is idempotent and project-bound; draft scope only prepares an approval outbox', async t => {
  const f = await apiFixture(t), token = f.issue().token, requestKey = randomUUID();
  const input = { requestKey, content: 'Project memory only' }, first = await f.request('/api/developer/v1/memory', { token, body: input }); assert.equal(first.status, 201);
  assert.equal((await f.request('/api/developer/v1/memory', { token, body: input })).body.memory.id, first.body.memory.id); assert.equal(f.project.notes.length, 1); assert.equal(f.sibling.notes.length, 0);
  assert.equal((await f.request('/api/developer/v1/memory', { token, body: { ...input, content: 'Changed' } })).status, 409);
  assert.equal((await f.request('/api/developer/v1/memory', { token })).body.memory[0].content, input.content);
  const draft = await f.request('/api/developer/v1/drafts', { token, body: { channel: 'x', text: 'Review this', idempotencyKey: randomUUID() } }); assert.equal(draft.status, 201); assert.equal(draft.body.draft.status, 'draft');
  assert.equal((await f.request('/api/developer/v1/drafts/publish', { token, body: { intentId: draft.body.draft.id } })).status, 404); assert.equal(f.publications(), 0);
  assert.equal((await f.request('/api/developer/v1/drafts', { token })).body.drafts.length, 1);
});

test('read-only keys cannot mutate and write-only keys cannot enumerate project state', async t => {
  const f = await apiFixture(t), read = f.issue(['read']).token, write = f.issue(['memory']).token;
  for (const route of ['jobs', 'memory', 'drafts']) { const res = await f.request('/api/developer/v1/' + route, { token: read, body: {} }); assert.equal(res.status, 403); assert.equal(res.body.code, 'INSUFFICIENT_SCOPE'); }
  assert.equal((await f.request('/api/developer/v1/project', { token: write })).status, 403);
  assert.equal((await f.request('/api/developer/v1/memory', { token: write, body: { requestKey: randomUUID(), content: 'Allowed memory' } })).status, 201);
  assert.equal((await f.request('/api/developer/v1/project', { session: f.sessions[0] })).status, 401);
});

test('research developer access requires jobs scope for every mutation and cannot select another project', async t => {
  const f = await apiFixture(t), token = f.issue().token, read = f.issue(['read']).token, write = f.issue(['jobs']).token;
  const input = { requestKey: randomUUID(), name: 'Protocol watch', brief: 'Summarize material source changes.', sources: ['https://ethereum.org/en/'], enabled: false, cadenceMinutes: 60, reviewerModel: null };
  let fetches = 0; f.kit.research.reader = async url => { fetches++; return { url, text: 'Captured source text', fetchedAt: new Date().toISOString() }; };
  const first = await f.request('/api/developer/v1/research/watchlists', { token, body: input }); assert.equal(first.status, 201);
  const id = first.body.watchlist.id, path = `/api/developer/v1/research/watchlists/${id}`;
  assert.equal((await f.request('/api/developer/v1/research/watchlists', { token, body: input })).body.watchlist.id, id);
  assert.equal((await f.request('/api/developer/v1/research/watchlists', { token, body: { ...input, name: 'Changed' } })).status, 409);
  for (const route of ['/api/developer/v1/research/watchlists', path, path + '/checks']) {
    const denied = await f.request(route, { token: read, body: {} }); assert.equal(denied.status, 403); assert.equal(denied.body.code, 'INSUFFICIENT_SCOPE');
  }
  assert.equal((await f.request('/api/developer/v1/research', { token: write })).status, 403);
  assert.equal((await f.request('/api/developer/v1/research?projectId=' + f.foreign.id, { token })).status, 400);
  assert.equal((await f.request(path, { token, body: { enabled: true, projectId: f.sibling.id } })).status, 400);
  const siblingWatch = f.kit.research.create(f.sibling.id, { ...input, requestKey: randomUUID(), name: 'Sibling only' });
  for (const suffix of ['', '/checks']) assert.equal((await f.request(`/api/developer/v1/research/watchlists/${siblingWatch.id}${suffix}`, { token, body: suffix ? { requestKey: randomUUID() } : { enabled: true } })).status, 404);
  const snapshot = await f.request('/api/developer/v1/research', { token: read }); assert.equal(snapshot.status, 200);
  assert.deepEqual(snapshot.body.watchlists.map(watch => watch.id), [id]); assert.equal(snapshot.body.watchlists[0].snapshots, undefined);
  assert.equal(fetches, 0); assert.equal(f.project.committed, 0); assert.equal(f.kit.store.data.jobs.length, 0);
});

test('developer research checks retain real evidence and replay keys without a second fetch or paid job', async t => {
  const f = await apiFixture(t), token = f.issue().token; let value = 'Original captured content', fetches = 0;
  f.kit.research.reader = async url => { fetches++; return { url, text: value, fetchedAt: new Date().toISOString(), responseBytes: Buffer.byteLength(value), possiblyTruncated: false }; };
  const created = await f.request('/api/developer/v1/research/watchlists', { token, body: { requestKey: randomUUID(), name: 'Source history', brief: 'Explain changes with source evidence.', sources: ['https://ethereum.org/en/'], enabled: false, cadenceMinutes: 360 } });
  assert.equal(created.status, 201); const path = `/api/developer/v1/research/watchlists/${created.body.watchlist.id}/checks`;
  const check = requestKey => f.request(path, { token, body: { requestKey } });
  const firstKey = randomUUID(), first = await check(firstKey); assert.equal(first.status, 200); assert.equal(first.body.check.status, 'baseline');
  assert.equal((await check(firstKey)).body.check.id, first.body.check.id); assert.equal(fetches, 1);
  const unchanged = await check(randomUUID()); assert.equal(unchanged.body.check.status, 'unchanged');
  assert.equal(f.project.committed, 0); assert.equal(f.kit.store.data.jobs.length, 0);
  value = 'Changed captured content'; const changedKey = randomUUID(), changed = await check(changedKey);
  assert.equal(changed.status, 200); assert.equal(changed.body.check.status, 'changed');
  assert.notEqual(changed.body.check.sources[0].beforeHash, changed.body.check.sources[0].afterHash);
  assert.match(changed.body.check.sources[0].afterExcerpt, /Changed captured content/);
  assert.equal(changed.body.check.report.status, 'queued', changed.body.check.report.error); assert.equal(f.project.committed, 1000);
  assert.equal((await check(changedKey)).body.check.report.jobId, changed.body.check.report.jobId);
  assert.equal(fetches, 3); assert.equal(f.kit.store.data.jobs.length, 1); assert.equal(f.project.committed, 1000);
});
