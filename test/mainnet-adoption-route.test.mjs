import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { WalletAuth, sessionCookie } from '../src/auth.mjs';
import { GatewayVerifier, signGateway } from '../src/gateway-auth.mjs';
import { TenantRegistry, createProductionApp } from '../src/production.mjs';

test('platform adoption route requires the owner session and CSRF, pins its account, and needs no transaction enable flag', async t => {
  const origin = 'https://veyl.sh', gatewayKey = '11'.repeat(32), directory = mkdtempSync(join(tmpdir(), 'veyl-adopt-route-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const auth = new WalletAuth({ origin, state: { version: 1, challenges: [], sessions: [] }, save() {} }), owner = privateKeyToAccount(generatePrivateKey()), other = privateKeyToAccount(generatePrivateKey()), sessions = [];
  for (const account of [owner, other]) { const challenge = auth.challenge({ address: account.address, chainId: 1 }); sessions.push(await auth.authenticate({ id: challenge.id, signature: await account.signMessage({ message: challenge.message }) })); }
  const calls = [], mainnet = { adoptMainnet: async (project, input, checkpoint) => { calls.push({ projectId: project.id, input }); checkpoint(); return { imported: true }; } };
  const registry = new TenantRegistry({ directory, key: randomBytes(32), mainnet }), kit = registry.get(owner.address);
  const project = kit.create({ requestKey: 'mainnet-import-route', name: 'Veyl', symbol: 'VEYL', purpose: 'Platform market', template: 'research', swarm: false, model: 'pending', total: 1000000, daily: 1000000, request: 500000 });
  project.status = 'paused'; kit.store.save();
  const app = createProductionApp({ auth, registry, gateway: new GatewayVerifier({ key: gatewayKey }), origin, mainnet, transactionsEnabled: false });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => app.close(resolve)));
  async function request(session, csrf = session.csrf) {
    const path = `/api/projects/${project.id}/mainnet/adopt`, body = Buffer.from(JSON.stringify({ transactionHash: '0x' + 'a'.repeat(64), account: other.address }));
    const headers = { origin, 'content-type': 'application/json', cookie: sessionCookie(session.token), 'x-agent-csrf': csrf };
    Object.assign(headers, signGateway({ key: gatewayKey, method: 'POST', path, headers, body }));
    return fetch(`http://127.0.0.1:${app.address().port}${path}`, { method: 'POST', headers, body });
  }
  assert.equal((await request(sessions[1])).status, 404); assert.equal((await request(sessions[0], 'wrong')).status, 403); assert.equal(calls.length, 0);
  const response = await request(sessions[0]); assert.equal(response.status, 200); assert.equal((await response.json()).imported, true);
  assert.equal(calls.length, 1); assert.equal(calls[0].input.account, owner.address); assert.equal(calls[0].projectId, project.id); assert.equal(project.status, 'paused');
});
