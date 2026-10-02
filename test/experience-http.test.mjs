import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { WalletAuth, sessionCookie } from '../src/auth.mjs';
import { GatewayVerifier, signGateway } from '../src/gateway-auth.mjs';
import { TenantRegistry, createProductionApp } from '../src/production.mjs';

test('owner controls, scoped reads, private notifications and revocable public snapshots stay separated over HTTP', async t => {
  const directory = mkdtempSync(resolve(tmpdir(), 'veyl-experience-http-'));
  t.after(() => { assert.ok(directory.startsWith(resolve(tmpdir(), 'veyl-experience-http-'))); rmSync(directory, { recursive: true, force: true }); });
  const origin = 'https://veyl.sh', gatewayKey = randomBytes(32).toString('hex');
  const auth = new WalletAuth({ origin, state: { version: 1, challenges: [], sessions: [] }, save() {} });
  const registry = new TenantRegistry({ directory, key: randomBytes(32), mainnet: {} });
  const accounts = [privateKeyToAccount(generatePrivateKey()), privateKeyToAccount(generatePrivateKey())], sessions = [];
  for (const account of accounts) { const challenge = auth.challenge({ address: account.address, chainId: 1 }); sessions.push(await auth.authenticate({ id: challenge.id, signature: await account.signMessage({ message: challenge.message }) })); }
  const kit = registry.get(accounts[0].address);
  const project = kit.create({ requestKey: randomUUID(), name: 'Private fixture', symbol: 'FXT', purpose: 'Never published private purpose', template: 'research', swarm: false, model: 'pending', total: 1000000, daily: 1000000, request: 100000 });
  kit.note(project.id, 'Never published private note');
  const artifact = { id: randomUUID(), title: 'Never published private prompt', content: 'Owner-selected public finding.', at: new Date().toISOString(), mode: 'zkapi' };
  project.artifacts.push(artifact); kit.store.save();
  registry.ready = async () => assert.fail('Read-only and policy tests must not provision a funded runtime');
  const app = createProductionApp({ auth, registry, gateway: new GatewayVerifier({ key: gatewayKey }), origin, mainnet: {} });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => app.close(resolve)));
  async function request(path, { session = sessions[0], body, csrf = session?.csrf, bearer } = {}) {
    const method = body === undefined ? 'GET' : 'POST', raw = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    const headers = bearer ? { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' } : { origin, 'content-type': 'application/json', ...(session ? { cookie: sessionCookie(session.token), 'x-agent-csrf': csrf } : {}) };
    Object.assign(headers, signGateway({ key: gatewayKey, method, path, headers, body: raw }));
    const response = await fetch(`http://127.0.0.1:${app.address().port}${path}`, { method, headers, body: body === undefined ? undefined : raw });
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
  }
  const base = `/api/projects/${project.id}`;
  for (const path of ['/autonomy', '/activity', '/showcase', '/social']) {
    assert.equal((await request(base + path, { session: null })).status, 401);
    assert.equal((await request(base + path, { session: sessions[1] })).status, 404);
  }
  assert.equal((await request(base + '/autonomy')).body.policy.enabled, false);
  assert.equal((await request(base + '/autonomy/run', { body: { requestKey: randomUUID() } })).status, 409);
  const policy = { enabled: true, objective: 'Follow protocol releases', sourceUrls: ['https://ethereum.org/en/'], allowedTools: ['read_source'], dailyRunCap: 1 };
  assert.equal((await request(base + '/autonomy', { body: policy, csrf: 'wrong' })).status, 403);
  assert.equal((await request(base + '/autonomy', { body: policy })).body.policy.enabled, true);
  assert.equal((await request(base + '/autonomy', { body: { enabled: false } })).body.policy.enabled, false);
  assert.equal((await request(base + '/activity?limit=1')).body.events.length, 1);
  for (const suffix of ['?limit=0', '?limit=1&limit=2', '?before=invalid', '?owner=elsewhere']) assert.equal((await request(base + '/activity' + suffix)).status, 400);
  const token = registry.developerKeys.issue(accounts[0].address, project.id, { name: 'Scoped reader', scopes: ['read'], expiresInDays: 1 });
  for (const path of ['autonomy', 'activity']) assert.equal((await request('/api/developer/v1/' + path, { bearer: token.token })).status, 200);
  for (const path of ['autonomy', 'showcase', 'social/posting-policy']) assert.equal((await request('/api/developer/v1/' + path, { bearer: token.token, body: {} })).status, 404);
  assert.equal((await request('/api/notifications', { session: null })).status, 401);
  assert.equal((await request('/api/notifications')).body.unread, 0);
  assert.equal((await request('/api/notifications/ack', { csrf: 'wrong', body: { id: 'all' } })).status, 403);
  const input = { title: 'Public research', description: 'Selected findings', artifactIds: [artifact.id] };
  const historyInput = { ...input, includeRunHistory: true };
  assert.equal((await request(base + '/showcase/preview', { session: null, body: historyInput })).status, 401);
  assert.equal((await request(base + '/showcase/preview', { csrf: 'wrong', body: historyInput })).status, 403);
  assert.equal((await request(base + '/showcase/preview', { session: sessions[1], body: historyInput })).status, 404);
  const preview = await request(base + '/showcase/preview', { body: historyInput }); assert.equal(preview.status, 200); assert.equal(preview.body.preview.artifacts[0].run, undefined);
  assert.equal((await request(base + '/showcase')).body.showcase, null, 'preview must not publish');
  assert.equal((await request(base + '/showcase', { body: historyInput })).status, 409);
  assert.equal((await request(base + '/showcase', { body: { ...historyInput, previewDigest: preview.body.previewDigest } })).status, 200);
  assert.equal((await request(base + '/showcase', { body: { ...input, projectId: project.id } })).status, 400);
  assert.equal((await request(base + '/showcase', { session: sessions[1], body: input })).status, 404);
  const shared = await request(base + '/showcase', { body: input }); assert.equal(shared.status, 200);
  const slug = shared.body.showcase.slug, publicPath = `/api/showcase/${slug}`;
  const published = await request(publicPath, { session: null }); assert.equal(published.status, 200); assert.equal(published.cache, 'no-store');
  assert.equal(published.body.page.artifacts[0].content, artifact.content);
  const publicText = JSON.stringify(published.body);
  for (const secret of [project.purpose, 'Never published private note', artifact.title, accounts[0].address, project.id]) assert.ok(!publicText.includes(secret));
  assert.equal((await request(base + '/showcase/revoke', { body: {} })).status, 200);
  assert.equal((await request(publicPath, { session: null })).status, 404);
  assert.equal((await request(base + '/showcase', { body: input })).status, 200);
  assert.equal((await request(publicPath, { session: null })).status, 404, 'revoked URLs never regain access');
  assert.equal(kit.store.data.jobs.length, 0);
});
