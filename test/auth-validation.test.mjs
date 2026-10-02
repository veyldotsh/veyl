import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { WalletAuth } from '../src/auth.mjs';
import { GatewayVerifier, signGateway } from '../src/gateway-auth.mjs';
import { createProductionApp } from '../src/production.mjs';
import { Problem } from '../src/agent.mjs';

const origin = 'https://veyl.sh', key = '22'.repeat(32);

test('malformed wallet signatures return 401 without consuming a usable challenge or leaking crypto errors', async t => {
  const state = { version: 1, challenges: [], sessions: [] };
  const auth = new WalletAuth({ origin, state, save() {} });
  const app = createProductionApp({ auth, registry: {}, gateway: new GatewayVerifier({ key }), origin, mainnet: {} });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.close(resolve)));
  async function request(path, body) {
    const method = 'POST', raw = Buffer.from(JSON.stringify(body)), headers = { origin, 'content-type': 'application/json' };
    Object.assign(headers, signGateway({ key, method, path, headers, body: raw }));
    const response = await fetch(`http://127.0.0.1:${app.address().port}${path}`, { method, headers, body: raw });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  const owner = privateKeyToAccount(generatePrivateKey());
  const challenge = await request('/api/auth/challenge', { address: owner.address, chainId: 1 });
  assert.equal(challenge.status, 200);
  const signature = await owner.signMessage({ message: challenge.body.message });
  for (const malformed of ['0x' + '00'.repeat(65), '0x' + 'ff'.repeat(65), signature.slice(0, -2) + 'ff', '0x1234']) {
    const result = await request('/api/auth/verify', { id: challenge.body.id, signature: malformed });
    assert.equal(result.status, 401);
    assert.equal(result.body.error, 'Invalid wallet signature.');
    assert.equal(result.body.code, 'UNAUTHENTICATED');
    assert.equal(result.headers.has('set-cookie'), false);
    assert.equal(state.sessions.length, 0);
    assert.equal(auth.verifying.size, 0);
  }
  const malformedBody = await request('/api/auth/verify', null);
  assert.equal(malformedBody.status, 400);
  const valid = await request('/api/auth/verify', { id: challenge.body.id, signature });
  assert.equal(valid.status, 200);
  assert.equal(valid.body.address, owner.address);
  assert.match(valid.headers.get('set-cookie'), /__Host-veyl=.*; Secure; HttpOnly;/);
  assert.equal(state.sessions.length, 1);
  assert.equal((await request('/api/auth/verify', { id: challenge.body.id, signature })).status, 401);
});

test('signature failure handling does not hide authentication persistence failures', async () => {
  let failSave = false;
  const auth = new WalletAuth({ origin, state: { version: 1, challenges: [], sessions: [] }, save() { if (failSave) throw new Error('private storage diagnostics'); } });
  const owner = privateKeyToAccount(generatePrivateKey());
  const challenge = auth.challenge({ address: owner.address, chainId: 1 });
  const signature = await owner.signMessage({ message: challenge.message });
  failSave = true;
  await assert.rejects(auth.authenticate({ id: challenge.id, signature }), error => error instanceof Problem && error.status === 503 && error.message === 'Authentication persistence is blocked.');
  assert.equal(auth.verifying.size, 0);
  assert.equal(auth.healthy, false);
});
