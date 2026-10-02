import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { TenantRegistry, createProductionApp } from '../src/production.mjs';
import { WalletAuth, sessionCookie } from '../src/auth.mjs';
import { GatewayVerifier, signGateway } from '../src/gateway-auth.mjs';
import { acquireSmokeRuntime, checkSmokeCatalog } from '../scripts/runtime-smoke-scope.mjs';

test('hosted wallet recovery and explicit recovery smoke survive catalog outage while full provisioning and paid admission fail closed', async t => {
  const directory = mkdtempSync(resolve(tmpdir(), 'veyl-recovery-ready-')), requests = [], journalId = 'a'.repeat(32), callId = randomUUID();
  const daemon = createServer((req, res) => {
    requests.push({ path: req.url, method: req.method }); res.setHeader('Content-Type', 'application/json');
    const replies = { '/healthz': { status: 'ok' }, '/admin/status': { backend: 'zkapi', network: 'mainnet', request_budget_policy: 'model' },
      '/v1/accounting': { version: 1, journal_id: journalId }, ['/v1/call-settlements/' + callId]: { status: 'bound', call_id: callId } };
    if (req.url === '/v1/models') { res.writeHead(502); res.end(JSON.stringify({ error: { code: 'models_unavailable' } })); }
    else if (replies[req.url]) res.end(JSON.stringify(replies[req.url]));
    else { res.writeHead(500); res.end('{}'); }
  });
  await new Promise(r => daemon.listen(0, '127.0.0.1', r));
  const executable = resolve(directory, 'clientd'), walletBinary = resolve(directory, 'walletd'), proofSetupDir = resolve(directory, 'proofs');
  writeFileSync(executable, 'fixture'); writeFileSync(walletBinary, 'fixture'); mkdirSync(proofSetupDir);
  const owner = privateKeyToAccount(generatePrivateKey()), origin = 'https://veyl.sh', gatewayKey = randomBytes(32).toString('hex');
  const registry = new TenantRegistry({ directory, key: randomBytes(32), mainnet: { client: {} }, runtimeSettings: {
    executable, walletBinary, proofSetupDir, firstPort: daemon.address().port, maxProfiles: 1, portFree: async () => true,
    spawnProcess: () => { const child = new EventEmitter(); child.kill = () => child.emit('exit', 0); return child; }
  } });
  const kit = registry.get(owner.address), project = kit.create({ requestKey: randomUUID(), name: 'Wallet recovery', symbol: 'RCV', purpose: 'Recover saved charges without new work.', template: 'research', swarm: false, model: 'test/model', total: 4004000, daily: 4004000, request: 1001000 });
  // Chain expiry is independent of this regression. Its read remains explicit;
  // native identity and catalog requests use the real HTTP provider/provisioner.
  const originalRuntime = registry.runtime.bind(registry); let expiryReads = 0;
  registry.runtime = (...args) => { const runtime = originalRuntime(...args); runtime.noteExpiryGuard.inspect = async () => { expiryReads++; return { status: 'healthy', canInfer: true }; }; return runtime; };
  const auth = new WalletAuth({ origin, state: { version: 1, challenges: [], sessions: [] }, save() {} });
  const challenge = auth.challenge({ address: owner.address, chainId: 1 });
  const session = await auth.authenticate({ id: challenge.id, signature: await owner.signMessage({ message: challenge.message }) });
  const app = createProductionApp({ registry, auth, gateway: new GatewayVerifier({ key: gatewayKey }), origin, mainnet: {}, platformMarket: null });
  await new Promise(r => app.listen(0, '127.0.0.1', r));
  t.after(async () => { await new Promise(r => app.close(r)); registry.scheduler.stop(); await registry.provisioner.stop(); await new Promise(r => daemon.close(r)); assert.ok(directory.startsWith(resolve(tmpdir(), 'veyl-recovery-ready-'))); rmSync(directory, { force: true, recursive: true }); });
  const path = `/api/projects/${project.id}/funding`, headers = { origin, cookie: sessionCookie(session.token) };
  Object.assign(headers, signGateway({ key: gatewayKey, method: 'GET', path, headers, body: Buffer.alloc(0) }));
  const response = await fetch(`http://127.0.0.1:${app.address().port}${path}`, { headers });
  assert.equal(response.status, 200); assert.equal((await response.json()).noteExpiry.canInfer, true); assert.equal(expiryReads, 1);
  assert.ok(requests.some(r => r.path === '/v1/accounting')); assert.ok(!requests.some(r => r.path === '/v1/models'));
  assert.equal(project.model, 'test/model'); assert.equal(project.runtimeProvision, undefined, 'wallet access must not claim model setup completed');
  const runtime = await acquireSmokeRuntime(registry, owner.address, project, 'wallet-recovery');
  assert.equal((await runtime.provider.callSettlement(callId)).status, 'bound');
  assert.equal((await checkSmokeCatalog(runtime.provider, 'wallet-recovery')).catalogChecked, false);
  assert.ok(!requests.some(r => r.path === '/v1/models'));
  await assert.rejects(acquireSmokeRuntime(registry, owner.address, project, 'full'), /HTTP 502/);
  await assert.rejects(kit.submit(project.id, { requestKey: randomUUID(), prompt: 'No dispatch while catalog is unavailable.' }), /HTTP 502/);
  assert.equal(project.committed, 0); assert.equal(kit.store.data.jobs.length, 0);
  assert.equal(requests.filter(r => r.method !== 'GET').length, 0, 'no native lease, payment or inference authorization');
  assert.equal((await (await registry.ready(owner.address, project.id)).provider.callSettlement(callId)).status, 'bound');
  assert.equal(registry.backgroundOwners.get(owner.address.toLowerCase()), 0);
  const before = requests.length; await assert.rejects(registry.ready(owner.address, randomUUID()), /not found/i); assert.equal(requests.length, before);
});
