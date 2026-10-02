import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { VeylClient, VeylApiError } from '../packages/veyl/client.mjs';
import { WalletAuth } from '../src/auth.mjs';
import { GatewayVerifier, signGateway } from '../src/gateway-auth.mjs';
import { TenantRegistry, createProductionApp } from '../src/production.mjs';
import { Problem } from '../src/agent.mjs';

test('distributable SDK works against real scoped HTTP routes, queue idempotency, memory and revocation', async t => {
  const directory = mkdtempSync(resolve(tmpdir(), 'veyl-sdk-integration-'));
  t.after(() => { assert.ok(directory.startsWith(resolve(tmpdir(), 'veyl-sdk-integration-'))); rmSync(directory, { recursive: true, force: true }); });
  const owner = '0x1111111111111111111111111111111111111111', origin = 'https://veyl.sh', gatewayKey = randomBytes(32).toString('hex');
  const auth = new WalletAuth({ origin, state: { version: 1, challenges: [], sessions: [] }, save() {} });
  const registry = new TenantRegistry({ directory, key: randomBytes(32), mainnet: {} }), kit = registry.get(owner);
  const project = kit.create({ requestKey: randomUUID(), name: 'SDK fixture', symbol: 'SDK', purpose: 'Local interface verification', template: 'research', swarm: false, model: 'fixture/model', total: 2000, daily: 2000, request: 1000 });
  registry.catalog = async () => [{ id: 'fixture/model', oa_request_limit_micro_usd: 1000 }];
  kit.providerCatalogForProject = registry.catalog; registry.scheduler.tick = async () => {}; // No inference dispatch.
  const issued = registry.developerKeys.issue(owner, project.id, { name: 'SDK test', scopes: ['read', 'jobs', 'memory'] });
  const app = createProductionApp({ auth, registry, gateway: new GatewayVerifier({ key: gatewayKey }), origin, mainnet: {} });
  await new Promise(r => app.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => app.close(r)));
  const client = new VeylClient({ token: issued.token, baseUrl: `http://127.0.0.1:${app.address().port}`, fetch: async (url, init) => {
    // Test-only gateway boundary: equivalent to the authenticated deployment proxy.
    const parsed = new URL(url), path = parsed.pathname + parsed.search, headers = Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init.body === undefined ? Buffer.alloc(0) : Buffer.from(init.body);
    Object.assign(headers, signGateway({ key: gatewayKey, method: init.method, path, headers, body }));
    return fetch(url, { ...init, headers });
  } });
  assert.equal((await client.project()).project.id, project.id); assert.equal((await client.models()).models[0].id, 'fixture/model');
  const requestKey = randomUUID(), input = { requestKey, prompt: 'Queue a fixture task' };
  registry.inferenceAdmission = async () => { throw new Problem('No active private note.', 409); };
  await assert.rejects(client.submitJob(input), error => error.status === 409 && !error.uncertain);
  assert.equal(project.committed, 0); assert.equal(kit.store.data.jobs.length, 0);
  registry.inferenceAdmission = async () => ({ status: 'healthy', canInfer: true }); // Explicit funded fixture only.
  const first = await client.submitJob(input), repeated = await client.submitJob(input); assert.equal(first.job.id, repeated.job.id);
  assert.equal(project.committed, 1000); assert.equal((await client.jobs({ requestKey })).jobs[0].id, first.job.id); assert.equal((await client.job(first.job.id)).artifact, null);
  await assert.rejects(client.submitJob({ ...input, prompt: 'Changed request' }), e => e.status === 409 && !e.uncertain);
  const memoryInput = { requestKey: randomUUID(), content: 'Persisted SDK note' }, memory = await client.saveMemory(memoryInput);
  assert.equal((await client.saveMemory(memoryInput)).memory.id, memory.memory.id); assert.equal((await client.memory()).memory.length, 1);
  await assert.rejects(client.prepareDraft({ channel: 'x', text: 'No draft permission', idempotencyKey: randomUUID() }), e => e.status === 403 && e.code === 'INSUFFICIENT_SCOPE');
  registry.developerKeys.revoke(owner, project.id, issued.key.id);
  await assert.rejects(client.project(), e => e instanceof VeylApiError && e.status === 401 && e.code === 'UNAUTHENTICATED');
});
