import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { WalletAuth, sessionCookie } from '../src/auth.mjs';
import { GatewayVerifier, signGateway } from '../src/gateway-auth.mjs';
import { TenantRegistry, createProductionApp } from '../src/production.mjs';

test('owner X app route requires wallet session and CSRF, isolates projects and never returns credentials', async t => {
  const prefix = resolve(tmpdir(), 'veyl-x-app-route-'), directory = mkdtempSync(prefix);
  t.after(() => { assert.ok(resolve(directory).startsWith(prefix)); rmSync(directory, { recursive: true, force: true }); });
  const origin = 'https://veyl.sh', gatewayKey = 'ab'.repeat(32), stateKey = randomBytes(32);
  const auth = new WalletAuth({ origin, state: { version: 1, challenges: [], sessions: [] }, save() {} });
  const accounts = [privateKeyToAccount(generatePrivateKey()), privateKeyToAccount(generatePrivateKey())], sessions = [];
  for (const account of accounts) { const challenge = auth.challenge({ address: account.address, chainId: 1 }); sessions.push(await auth.authenticate({ id: challenge.id, signature: await account.signMessage({ message: challenge.message }) })); }
  const registry = new TenantRegistry({ directory, key: stateKey, mainnet: {}, socialSettings: { x: { redirectUri: origin + '/oauth/x' }, fetcher: async () => { assert.fail('App settings must make no provider request.'); } } });
  const kit = registry.get(accounts[0].address), project = kit.create({ requestKey: 'x-app-owner-route-fixture', name: 'Fixture', symbol: 'FIX', purpose: 'Offline route test', template: 'research', swarm: false, model: 'pending', total: 1000, daily: 1000, request: 1000 });
  const app = createProductionApp({ auth, registry, gateway: new GatewayVerifier({ key: gatewayKey }), origin, mainnet: {} });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => app.close(resolve)));
  const base = `/api/projects/${project.id}/social`;
  async function request(path, session, body, csrf = session?.csrf) {
    const method = body ? 'POST' : 'GET', bytes = Buffer.from(body ? JSON.stringify(body) : '');
    const headers = { origin, 'content-type': 'application/json', ...(session ? { cookie: sessionCookie(session.token), 'x-agent-csrf': csrf } : {}) };
    Object.assign(headers, signGateway({ key: gatewayKey, method, path, headers, body: bytes }));
    const response = await fetch(`http://127.0.0.1:${app.address().port}${path}`, { method, headers, body: body ? bytes : undefined });
    return { status: response.status, body: await response.json() };
  }
  const credentials = { mode: 'custom', clientId: 'offline-route-app', clientSecret: 'offline-route-secret' };
  assert.equal((await request(base + '/x-app', null, credentials)).status, 401);
  assert.equal((await request(base + '/x-app', sessions[1], credentials)).status, 404);
  assert.equal((await request(base + '/x-app', sessions[0], credentials, 'wrong')).status, 403);
  const saved = await request(base + '/x-app', sessions[0], credentials); assert.equal(saved.status, 200);
  const snapshot = await request(base, sessions[0]); assert.equal(snapshot.body.xConfigured, true); assert.equal(snapshot.body.xApp.mode, 'custom');
  const raw = readFileSync(resolve(directory, accounts[0].address.toLowerCase(), project.id, 'social.sealed.json'), 'utf8');
  for (const value of [credentials.clientId, credentials.clientSecret]) { assert.equal(raw.includes(value), false); assert.equal(JSON.stringify([saved, snapshot]).includes(value), false); }
  const invalid = await request(base + '/x-app', sessions[0], { ...credentials, redirectUri: 'https://other.example/callback' }); assert.equal(invalid.status, 400); assert.equal(JSON.stringify(invalid).includes(credentials.clientSecret), false);
  assert.equal((await request(base + '/x-app', sessions[0], { mode: 'platform' })).status, 200);
  assert.equal((await request(base, sessions[0])).body.xConfigured, false);
});
