import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { WalletAuth, sessionCookie } from '../src/auth.mjs';
import { GatewayVerifier, signGateway } from '../src/gateway-auth.mjs';
import { TenantRegistry, createProductionApp } from '../src/production.mjs';
import { createApp } from '../src/server.mjs';
import { createContext, runInContext } from 'node:vm';

test('hosted unsigned funding cancellation requires owner session, CSRF and exact intent-only body even with signing disabled', async t => {
  const directory = mkdtempSync(resolve(tmpdir(), 'veyl-abandon-route-'));
  t.after(() => { assert.ok(directory.startsWith(resolve(tmpdir(), 'veyl-abandon-route-'))); rmSync(directory, { recursive: true, force: true }); });
  const origin = 'https://veyl.sh', key = '11'.repeat(32), auth = new WalletAuth({ origin, state: { version: 1, challenges: [], sessions: [] }, save() {} });
  const owners = [privateKeyToAccount(generatePrivateKey()), privateKeyToAccount(generatePrivateKey())], sessions = [];
  for (const owner of owners) { const c = auth.challenge({ address: owner.address, chainId: 1 }); sessions.push(await auth.authenticate({ id: c.id, signature: await owner.signMessage({ message: c.message }) })); }
  const registry = new TenantRegistry({ directory, key: randomBytes(32), mainnet: {} }), calls = [];
  registry.ready = async (owner, projectId) => ({ funding: { abandonUnsigned: async intentId => { calls.push({ owner, projectId, intentId }); return { id: intentId, status: 'abandoned', approvalAttempted: false }; } } });
  const project = registry.get(owners[0].address).create({ requestKey: 'abandon-route-project', name: 'Private', symbol: 'PRV', purpose: 'Test owner cancellation', template: 'research', swarm: false, model: 'pending', total: 1000000, daily: 1000000, request: 500000 });
  const app = createProductionApp({ auth, registry, gateway: new GatewayVerifier({ key }), origin, mainnet: {}, transactionsEnabled: false });
  await new Promise(r => app.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => app.close(r)));
  const path = `/api/projects/${project.id}/funding/abandon-unsigned`;
  async function request(session, body, csrf = session?.csrf, suffix = '') {
    const raw = Buffer.from(JSON.stringify(body)), headers = { origin, 'content-type': 'application/json', ...(session ? { cookie: sessionCookie(session.token), 'x-agent-csrf': csrf } : {}) };
    Object.assign(headers, signGateway({ key, method: 'POST', path: path + suffix, headers, body: raw }));
    return fetch(`http://127.0.0.1:${app.address().port}${path}${suffix}`, { method: 'POST', headers, body: raw });
  }
  assert.equal((await request(null, { intentId: 'saved' })).status, 401);
  assert.equal((await request(sessions[1], { intentId: 'saved' })).status, 404);
  assert.equal((await request(sessions[0], { intentId: 'saved' }, 'wrong')).status, 403);
  assert.equal((await request(sessions[0], { intentId: 'saved', projectId: 'other' })).status, 400);
  assert.equal((await request(sessions[0], { intentId: 'saved' }, sessions[0].csrf, '?override=1')).status, 400);
  assert.equal(calls.length, 0);
  const result = await request(sessions[0], { intentId: 'saved' }); assert.equal(result.status, 200); assert.equal((await result.json()).status, 'abandoned');
  assert.equal(calls.length, 1); assert.equal(calls[0].owner.toLowerCase(), owners[0].address.toLowerCase()); assert.equal(calls[0].projectId, project.id); assert.equal(calls[0].intentId, 'saved');
});

test('local cancellation keeps same-origin CSRF and exact body validation', async t => {
  const calls = [], kit = { snapshot: () => ({}), store: { assertHealthy() {} }, funding: { abandonUnsigned: async id => { calls.push(id); return { id, status: 'abandoned' }; } } };
  const app = createApp(kit); await new Promise(r => app.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => app.close(r)));
  const base = `http://127.0.0.1:${app.address().port}`, csrf = (await (await fetch(base + '/api/state')).json()).csrf;
  const post = (body, token = csrf) => fetch(base + '/api/funding/abandon-unsigned', { method: 'POST', headers: { origin: base, 'content-type': 'application/json', 'x-agent-csrf': token }, body: JSON.stringify(body) });
  assert.equal((await post({ intentId: 'saved' }, 'wrong')).status, 403);
  assert.equal((await post({ intentId: 'saved', amountGwei: '2' })).status, 400);
  assert.deepEqual(calls, []); assert.equal((await post({ intentId: 'saved' })).status, 200); assert.deepEqual(calls, ['saved']);
});

test('funding panel cancellation appears only for untouched quotes and abandoned intents lose all action buttons', async () => {
  const element = { innerHTML: '' }, item = { id: 'saved', status: 'quoted', amountGwei: '1000000', approvalAttempted: false };
  const context = createContext({ selected: 'project', state: { hosted: true, capabilities: { transactionsEnabled: false } }, $: () => element, esc: value => String(value), api: async () => ({ approvalEnabled: false, intents: [item] }) });
  runInContext(readFileSync(new URL('../public/panels.js', import.meta.url), 'utf8'), context);
  await runInContext('loadFundingPanel()', context); assert.match(element.innerHTML, /data-funding="abandon-unsigned"/);
  item.transactionHash = '0x' + 'a'.repeat(64); await runInContext('loadFundingPanel()', context); assert.doesNotMatch(element.innerHTML, /data-funding="abandon-unsigned"/);
  delete item.transactionHash; item.status = 'abandoned'; await runInContext('loadFundingPanel()', context); assert.match(element.innerHTML, /Unsigned quote cancelled/); assert.doesNotMatch(element.innerHTML, /data-funding=/);
});
