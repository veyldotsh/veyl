import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { RuntimeProvisioner } from '../src/runtime-provision.mjs';
import { ZkApiProvider } from '../src/provider.mjs';
import { Store } from '../src/store.mjs';
import { Kit } from '../src/kit.mjs';

function fixture(t, overrides = {}) {
  const directory = mkdtempSync(resolve(tmpdir(), 'veyl-provision-'));
  t.after(() => { if (!directory.startsWith(resolve(tmpdir(), 'veyl-provision-'))) throw new Error('Invalid cleanup target'); rmSync(directory, { force: true, recursive: true }); });
  const executable = resolve(directory, 'clientd'), walletBinary = resolve(directory, 'walletd'), proofSetupDir = resolve(directory, 'proofs');
  writeFileSync(executable, 'fixture'); writeFileSync(walletBinary, 'fixture'); mkdirSync(proofSetupDir);
  const configuration = { version: 1, projects: [] }, calls = [], saves = [];
  const provisioner = new RuntimeProvisioner({ directory, executable, walletBinary, proofSetupDir, configuration, save: () => saves.push(structuredClone(configuration)), portFree: async () => true,
    spawnProcess: (...args) => { calls.push(args); const child = new EventEmitter(); child.kill = () => { child.emit('exit', 0); }; return child; }, checkReady: async () => true, ...overrides });
  t.after(() => provisioner.stop());
  return { directory, configuration, calls, saves, provisioner };
}
const owner = '0x0000000000000000000000000000000000000001';
test('daemon provision is idempotent and assigns distinct keys, profiles and loopback ports without a funding action', async t => {
  const { directory, configuration, calls, saves, provisioner } = fixture(t), projectId = randomUUID();
  const [first, duplicate] = await Promise.all([provisioner.provision(owner, projectId), provisioner.provision(owner, projectId)]);
  assert.equal(first, duplicate); assert.equal(calls.length, 1); assert.equal(saves.length, 1);
  assert.equal(first.approvalEnabled, false); assert.equal(new Set([first.key, first.managementToken, first.bridgeToken]).size, 3);
  assert.equal(calls[0][1][0], '--config-dir'); assert.equal(calls[0][1][2], 'serve-control'); assert.equal(calls[0][2].shell, false); assert.equal(calls[0][2].stdio, 'ignore');
  assert.deepEqual(Object.keys(calls[0][2].env).sort(), ['GOMAXPROCS', 'HOME', 'LANG', 'PATH', 'RAYON_NUM_THREADS']);
  const file = resolve(directory, owner, projectId, 'daemon', 'config.json'), config = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(config.require_api_key, true); assert.equal(config.key_reuse_window_seconds, 0); assert.equal(config.listen, '127.0.0.1:19000');
  assert.equal(config.verifier_url, 'https://verifier-production-20260917.openanonymity.ai');
  const other = await provisioner.provision(owner, randomUUID());
  assert.notEqual(first.origin, other.origin); assert.notEqual(first.key, other.key); assert.equal(configuration.projects.length, 2);
});
test('runtime slots are bounded and an occupied saved port does not overwrite recovery files', async t => {
  const { provisioner, directory, configuration } = fixture(t, { maxRuntimes: 1, maxProfiles: 1 });
  const projectId = randomUUID(), entry = await provisioner.provision(owner, projectId);
  await assert.rejects(provisioner.provision(owner, randomUUID()), /profiles are allocated/);
  const file = resolve(directory, owner, projectId, 'daemon', 'config.json'), before = readFileSync(file, 'utf8');
  provisioner.children.get(projectId).kill(); provisioner.portFree = async () => false;
  await assert.rejects(provisioner.provision(owner, projectId), /reserved ports/);
  assert.equal(provisioner.children.size, 1); provisioner.portFree = async () => true;
  assert.equal(readFileSync(file, 'utf8'), before); assert.equal(configuration.projects[0].key, entry.key);
});
test('many prepared profiles share bounded process slots without reassigning wallets or evicting leases', async t => {
  const { provisioner, configuration, calls, directory } = fixture(t, { maxRuntimes: 1, maxProfiles: 10, canStop: async () => true });
  const firstId = randomUUID(), secondId = randomUUID(), thirdId = randomUUID();
  const first = await provisioner.prepare(owner, firstId); await provisioner.prepare(owner, secondId); await provisioner.prepare(owner, thirdId);
  assert.equal(calls.length, 0); assert.equal(configuration.projects.length, 3);
  const held = await provisioner.acquire(owner, firstId);
  await assert.rejects(provisioner.provision(owner, secondId), /slots are busy/);
  assert.equal(provisioner.children.size, 1); held.release();
  await provisioner.provision(owner, secondId); assert.equal(provisioner.children.size, 1); assert.equal(provisioner.children.has(firstId), false);
  assert.equal(configuration.projects[0].key, first.key);
  assert.ok(readFileSync(resolve(directory, owner, firstId, 'daemon', 'config.json'), 'utf8').includes(first.key));
  await provisioner.provision(owner, firstId); assert.equal(configuration.projects[0].origin, first.origin); assert.equal(provisioner.children.size, 1);
});
test('idle eviction refuses a pending settlement even without an active model lease', async t => {
  const { provisioner } = fixture(t, { maxRuntimes: 1, canStop: async () => false });
  await provisioner.provision(owner, randomUUID());
  await assert.rejects(provisioner.provision(owner, randomUUID()), /slots are busy or settling/);
  assert.equal(provisioner.children.size, 1);
});
test('profile or credential drift blocks daemon startup instead of replacing its wallet', async t => {
  const { provisioner, directory, calls } = fixture(t), projectId = randomUUID();
  await provisioner.provision(owner, projectId); provisioner.children.get(projectId).kill();
  writeFileSync(resolve(directory, owner, projectId, 'daemon', 'management-token'), 'different');
  await assert.rejects(provisioner.provision(owner, projectId), /credential differs/);
  assert.equal(calls.length, 1);
});
test('reviewed former mainnet verifier loads without rewriting credentials or recovery state', async t => {
  const { provisioner, directory, calls } = fixture(t), projectId = randomUUID();
  const entry = await provisioner.prepare(owner, projectId);
  const dir = resolve(directory, owner, projectId, 'daemon'), file = resolve(dir, 'config.json');
  const saved = JSON.parse(readFileSync(file, 'utf8')); saved.verifier_url = 'https://verifier2.openanonymity.ai';
  const bytes = JSON.stringify(saved); writeFileSync(file, bytes);
  const recovery = resolve(dir, 'wallet-recovery.fixture'); writeFileSync(recovery, 'preserve existing note and pending request');
  const actual = await provisioner.provision(owner, projectId);
  assert.equal(actual, entry); assert.equal(calls.length, 1);
  assert.equal(readFileSync(file, 'utf8'), bytes); assert.equal(readFileSync(recovery, 'utf8'), 'preserve existing note and pending request');
});
test('verifier migration does not accept arbitrary origins or simultaneous profile drift', async t => {
  for (const mutation of [c => { c.verifier_url = 'https://untrusted.example'; }, c => { c.verifier_url = 'https://verifier2.openanonymity.ai'; c.zkapi.network = 'sepolia'; }, c => { c.verifier_url = 'https://verifier2.openanonymity.ai'; c.zkapi.bridge_token = 'altered'; }]) {
    const { provisioner, directory, calls } = fixture(t), projectId = randomUUID(); await provisioner.prepare(owner, projectId);
    const file = resolve(directory, owner, projectId, 'daemon', 'config.json'), saved = JSON.parse(readFileSync(file, 'utf8'));
    mutation(saved); const bytes = JSON.stringify(saved); writeFileSync(file, bytes);
    await assert.rejects(provisioner.provision(owner, projectId), /profile differs/);
    assert.equal(calls.length, 0); assert.equal(readFileSync(file, 'utf8'), bytes);
  }
});
test('catalog outage leaves existing wallet accounting reachable but cannot admit a paid job', async t => {
  const requests = [], journalId = 'a'.repeat(32), callId = randomUUID();
  const server = createServer((req, res) => {
    requests.push({ path: req.url, method: req.method }); res.setHeader('Content-Type', 'application/json');
    const responses = { '/healthz': { status: 'ok' }, '/admin/status': { backend: 'zkapi', network: 'mainnet', request_budget_policy: 'model' },
      '/v1/accounting': { version: 1, journal_id: journalId }, ['/v1/call-settlements/' + callId]: { status: 'bound', call_id: callId } };
    if (req.url === '/v1/models') { res.writeHead(500); res.end('{}'); }
    else if (responses[req.url]) res.end(JSON.stringify(responses[req.url]));
    else { res.writeHead(500); res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const { provisioner, directory } = fixture(t, { firstPort: server.address().port, maxProfiles: 2, checkReady: undefined });
  const projectId = randomUUID(), entry = await provisioner.provision(owner, projectId);
  const provider = new ZkApiProvider({ base: entry.origin, key: entry.key });
  assert.equal((await provider.callSettlement(callId)).status, 'bound');
  assert.ok(!requests.some(r => r.path === '/v1/models'), 'runtime readiness must not depend on public catalog');
  const store = new Store(resolve(directory, 'kit.json'), 'zkapi'), kit = new Kit({ store, provider, chain: { status: async () => ({ ready: false }) } });
  const project = kit.create({ requestKey: randomUUID(), name: 'Recovery fixture', symbol: 'RCV', purpose: 'Test policy outage.', template: 'research', swarm: false, model: 'test/model', total: 4004000, daily: 4004000, request: 1001000 });
  await assert.rejects(kit.submit(project.id, { requestKey: randomUUID(), prompt: 'Do not dispatch during outage.' }), /HTTP 500/);
  assert.equal(project.committed, 0); assert.equal(store.data.jobs.length, 0);
  assert.equal(requests.filter(r => r.method !== 'GET').length, 0, 'no lease or inference dispatch');
  assert.equal((await provider.callSettlement(callId)).status, 'bound', 'recovery reads remain available after failed admission');
});
