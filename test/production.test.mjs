import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { WalletAuth, sessionCookie } from '../src/auth.mjs';
import { encryptedCodec, SealedState } from '../src/encrypted-state.mjs';
import { GatewayVerifier, signGateway } from '../src/gateway-auth.mjs';
import { TenantRegistry, createProductionApp } from '../src/production.mjs';
import { Problem } from '../src/agent.mjs';

const origin = 'https://veyl.sh', key = '11'.repeat(32);
const address = () => privateKeyToAccount(generatePrivateKey());
function temp(t) { const dir = mkdtempSync(resolve(tmpdir(), 'veyl-production-')); t.after(() => { if (!dir.startsWith(resolve(tmpdir(), 'veyl-production-'))) throw new Error('Invalid cleanup target'); rmSync(dir, { recursive: true, force: true }); }); return dir; }
function auth(now) { return new WalletAuth({ origin, state: { version: 1, challenges: [], sessions: [] }, save() {}, ...(now ? { now } : {}) }); }

test('wallet authentication validates the exact challenge, consumes it once, and binds CSRF to its session', async () => {
  const a = auth(), account = address(), challenge = a.challenge({ address: account.address, chainId: 1 });
  const signature = await account.signMessage({ message: challenge.message });
  const session = await a.authenticate({ id: challenge.id, signature });
  assert.equal(a.require(sessionCookie(session.token), session.csrf).address, account.address);
  assert.throws(() => a.require(sessionCookie(session.token), 'different'), /Invalid session/);
  await assert.rejects(a.authenticate({ id: challenge.id, signature }), /expired or already used/);
  a.logout(sessionCookie(session.token), session.csrf); assert.equal(a.session(sessionCookie(session.token)), null);
});
test('wallet auth rejects other wallets and expired challenges', async () => {
  let time = Date.now(); const a = auth(() => time), owner = address(), other = address();
  const challenge = a.challenge({ address: owner.address, chainId: 1 });
  await assert.rejects(a.authenticate({ id: challenge.id, signature: await other.signMessage({ message: challenge.message }) }), /Invalid wallet/);
  time += 300001;
  await assert.rejects(a.authenticate({ id: challenge.id, signature: await owner.signMessage({ message: challenge.message }) }), /expired/);
  assert.throws(() => a.challenge({ address: owner.address, chainId: 8453 }), /mainnet/);
});
test('concurrent verification cannot mint two sessions from one signature', async () => {
  const a = auth(), owner = address(), challenge = a.challenge({ address: owner.address, chainId: 1 });
  const input = { id: challenge.id, signature: await owner.signMessage({ message: challenge.message }) };
  const results = await Promise.allSettled([a.authenticate(input), a.authenticate(input)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
});
test('encrypted state rejects tampering, wrong key and cross-tenant copying', t => {
  const directory = temp(t), secret = randomBytes(32), file = resolve(directory, 'state.json');
  const state = new SealedState(file, secret, 'tenant:a', { privateText: 'private test memory' });
  assert.ok(!readFileSync(file, 'utf8').includes('private test memory'));
  assert.equal(new SealedState(file, secret, 'tenant:a', {}).data.privateText, 'private test memory');
  assert.throws(() => new SealedState(file, secret, 'tenant:b', {}), /cannot be read/);
  assert.throws(() => new SealedState(file, randomBytes(32), 'tenant:a', {}), /cannot be read/);
  const envelope = JSON.parse(readFileSync(file, 'utf8')); envelope.data = 'AAAA' + envelope.data.slice(4);
  assert.throws(() => encryptedCodec(secret, 'tenant:a').decode(JSON.stringify(envelope)));
  state.data.privateText = 'updated'; state.save();
});
test('gateway signature binds body, path, cookie, CSRF and timestamp and rejects replay', () => {
  const verifier = new GatewayVerifier({ key }), request = { method: 'POST', path: '/api/projects', headers: { cookie: 'session', 'x-agent-csrf': 'csrf' }, body: Buffer.from('{}') };
  Object.assign(request.headers, signGateway({ key, ...request }));
  assert.throws(() => verifier.verify({ ...request, body: Buffer.from('{"changed":true}') }), /Invalid service/);
  assert.throws(() => verifier.verify({ ...request, path: '/api/elsewhere' }), /Invalid service/);
  assert.throws(() => verifier.verify({ ...request, headers: { ...request.headers, cookie: 'other' } }), /Invalid service/);
  verifier.verify(request); assert.throws(() => verifier.verify(request), /already used/);
  const stale = { ...request, headers: { origin } }; Object.assign(stale.headers, signGateway({ key, ...stale, now: Date.now() - 31000 }));
  assert.throws(() => verifier.verify(stale), /Invalid service/);
});
test('hosted API isolates project and artifact access across wallet sessions and refuses public daemon approval', async t => {
  const directory = temp(t), a = auth(), first = address(), second = address();
  const registry = new TenantRegistry({ directory, key: randomBytes(32), mainnet: {} });
  const sessions = [];
  for (const account of [first, second]) { const challenge = a.challenge({ address: account.address, chainId: 1 }); sessions.push(await a.authenticate({ id: challenge.id, signature: await account.signMessage({ message: challenge.message }) })); }
  const app = createProductionApp({ auth: a, registry, gateway: new GatewayVerifier({ key }), origin, mainnet: {} });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => app.close(resolve)));
  async function request(path, session, body, csrf = session?.csrf) {
    const method = body === undefined ? 'GET' : 'POST', raw = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    const headers = { origin, 'content-type': 'application/json', ...(session ? { cookie: sessionCookie(session.token), 'x-agent-csrf': csrf } : {}) };
    Object.assign(headers, signGateway({ key, method, path, headers, body: raw }));
    const response = await fetch(`http://127.0.0.1:${app.address().port}${path}`, { method, headers, body: method === 'POST' ? raw : undefined });
    return { status: response.status, body: await response.json() };
  }
  assert.equal((await request('/api/state')).status, 401);
  const created = await request('/api/projects', sessions[0], { requestKey: 'request-key-12345', name: 'Private', symbol: 'PRV', purpose: 'Only owner sees this', template: 'research', swarm: false, model: 'pending', total: 1000000, daily: 1000000, request: 500000 });
  assert.equal(created.status, 201); const id = created.body.id;
  assert.equal((await request('/api/state', sessions[1])).body.projects.length, 0);
  assert.equal((await request(`/api/projects/${id}/notes`, sessions[1], { content: 'attack' })).status, 404);
  assert.equal((await request(`/api/projects/${id}/notes`, sessions[0], { content: 'private memory' }, 'wrong')).status, 403);
  assert.equal((await request(`/api/projects/${id}/notes`, sessions[0], { content: 'private memory' })).status, 200);
  assert.equal((await request(`/api/projects/${id}/funding/approve`, sessions[0], {})).status, 403);
  let retireCalls = 0;
  const retireBody = { intentId: 'saved-recovery-intent', quoteId: 'saved-quote', approvalDigest: 'exact-reviewed-digest' };
  registry.ready = async () => ({ funding: { retireExpiredOperation: async input => {
    retireCalls++; assert.deepEqual(input, retireBody);
    assert.equal(registry.get(first.address).operations.has(id), true);
    return { status: 'expired_unsigned', approvalAttempted: true };
  } } });
  const retirePath = `/api/projects/${id}/funding/operation-retire-expired`;
  assert.equal((await request(retirePath, undefined, retireBody)).status, 401);
  assert.equal((await request(retirePath, sessions[1], retireBody)).status, 404);
  assert.equal((await request(retirePath, sessions[0], retireBody, 'wrong')).status, 403);
  assert.equal((await request(retirePath, sessions[0], { ...retireBody, rpc: 'https://untrusted.invalid' })).status, 400);
  assert.equal((await request(retirePath + '?override=1', sessions[0], retireBody)).status, 400);
  assert.equal(retireCalls, 0);
  assert.equal((await request(retirePath, sessions[0], retireBody)).body.status, 'expired_unsigned');
  assert.equal(retireCalls, 1); assert.equal(registry.get(first.address).operations.has(id), false);
  registry.get(first.address).project(id).artifacts.push({ id: 'artifact-private', title: 'Private', content: 'secret' }); registry.get(first.address).store.save();
  assert.equal((await request('/api/artifacts/artifact-private', sessions[1])).status, 404);
  assert.ok(!readFileSync(resolve(directory, first.address.toLowerCase(), 'kit.sealed.json'), 'utf8').includes('private memory'));
});

test('hosted automatic funding requires owner opt-in, both worker gates and the matching dedicated operator', async t => {
  const treasury = '0x2222222222222222222222222222222222222222', operator = '0x3333333333333333333333333333333333333333';
  for (const [transactionsEnabled, approvalEnabled] of [[false, false], [false, true], [true, false], [true, true]]) {
    const directory = temp(t), a = auth(), account = address(), challenge = a.challenge({ address: account.address, chainId: 1 });
    const session = await a.authenticate({ id: challenge.id, signature: await account.signMessage({ message: challenge.message }) });
    let actualOperator = operator, configured = 0, approved = 0, runtimeAccess = 0, configurationGate, enteredConfigure;
    const mainnet = { status: async () => ({ launched: true, owner: account.address, operator: actualOperator, market: { treasury } }) };
    const registry = new TenantRegistry({ directory, key: randomBytes(32), mainnet, fundingSettings: { transactionsEnabled, approvalEnabled }, treasuryOperator: { enabled: true, signer: { address: operator } } });
    const kit = registry.get(account.address), project = kit.create({ requestKey: 'automatic-policy-test', name: 'Private', symbol: 'PRV', purpose: 'Bounded work', template: 'research', swarm: false, model: 'pending', total: 1000000, daily: 1000000, request: 500000 });
    let policy = null;
    registry.ready = async () => { runtimeAccess++; return {
      runway: { configure: async input => { configured++; policy = input; if (configurationGate) { enteredConfigure(); await configurationGate; } return { policy }; }, snapshot: () => ({ policy }) },
      funding: { approve: async input => { if (input.intentId !== 'saved-intent' || input.quoteId !== 'saved-quote' || input.approvalDigest !== 'exact-reviewed-digest') throw new Problem('Approval differs from saved quote.', 409); approved++; return { status: 'pending' }; } }
    }; };
    const app = createProductionApp({ auth: a, registry, gateway: new GatewayVerifier({ key }), origin, mainnet, transactionsEnabled });
    await new Promise(resolve => app.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => app.close(resolve)));
    const request = async (suffix, body, csrf = session.csrf) => {
      const path = `/api/projects/${project.id}/${suffix}`, method = body ? 'POST' : 'GET', raw = Buffer.from(body ? JSON.stringify(body) : '');
      const headers = { origin, 'content-type': 'application/json', cookie: sessionCookie(session.token), 'x-agent-csrf': csrf }; Object.assign(headers, signGateway({ key, method, path, headers, body: raw }));
      const response = await fetch(`http://127.0.0.1:${app.address().port}${path}`, { method, headers, body: body ? raw : undefined }); return { status: response.status, body: await response.json() };
    };
    const input = { automatic: true, closeBeforeExpiry: true, treasury: account.address, owner: operator, operator: account.address };
    assert.equal((await request('runway/configure', input, 'wrong')).status, 403); assert.equal(configured, 0);
    const result = await request('runway/configure', input), enabled = transactionsEnabled && approvalEnabled;
    assert.equal(result.status, enabled ? 200 : 409); assert.equal(configured, enabled ? 1 : 0);
    if (enabled) { assert.equal(policy.treasury, treasury); assert.equal(policy.owner, account.address); assert.equal(policy.operator, operator); assert.equal(project.runwayAutomation.automatic, true); assert.equal(project.runwayAutomation.closeBeforeExpiry, true); }
    assert.equal((await request('runway')).body.capabilities.automaticAvailable, enabled);
    actualOperator = account.address; assert.equal((await request('runway/configure', input)).status, 409);
    await request('runway/configure', { automatic: false, closeBeforeExpiry: false }); assert.equal(project.runwayAutomation.automatic, false); assert.equal(project.runwayAutomation.closeBeforeExpiry, false);
    const before = runtimeAccess;
    assert.equal((await request('funding/approve', {})).status, enabled ? 409 : 403); assert.equal(approved, 0);
    if (!enabled) assert.equal(runtimeAccess, before);
    assert.equal((await request('funding/approve', { intentId: 'saved-intent', quoteId: 'saved-quote', approvalDigest: 'exact-reviewed-digest' })).status, enabled ? 200 : 403); assert.equal(approved, enabled ? 1 : 0);
    if (enabled) {
      actualOperator = operator; let finish; const entered = new Promise(resolve => enteredConfigure = resolve); configurationGate = new Promise(resolve => finish = resolve);
      const staleConfiguration = request('runway/configure', input); await entered;
      const pause = await request('runway/pause', {}); assert.equal(pause.status, 200); assert.equal(pause.body.operationInProgress, true);
      finish(); assert.equal((await staleConfiguration).status, 409); assert.equal(project.runwayAutomation.automatic, false);
    }
    registry.ready = async () => assert.fail('Pause must not contact a daemon or RPC');
    assert.equal((await request('runway/pause', {}, 'wrong')).status, 403);
    const outagePause = await request('runway/pause', {}); assert.equal(outagePause.status, 200); assert.equal(outagePause.body.cancellation, 'new-authorizations-only'); assert.equal(project.runwayAutomation.automatic, false);
  }
});
