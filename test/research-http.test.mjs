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
import { readSource, validateSourceUrl } from '../src/tools.mjs';

test('research HTTP routes require owner session and CSRF, persist sources privately, and avoid inference on baseline or unchanged reads', async t => {
  const directory = mkdtempSync(resolve(tmpdir(), 'veyl-research-http-'));
  t.after(() => { assert.ok(directory.startsWith(resolve(tmpdir(), 'veyl-research-http-'))); rmSync(directory, { recursive: true, force: true }); });
  const origin = 'https://veyl.sh', gatewayKey = randomBytes(32).toString('hex');
  const auth = new WalletAuth({ origin, state: { version: 1, challenges: [], sessions: [] }, save() {} });
  const registry = new TenantRegistry({ directory, key: randomBytes(32), mainnet: {} });
  const accounts = [privateKeyToAccount(generatePrivateKey()), privateKeyToAccount(generatePrivateKey())];
  const sessions = [];
  for (const account of accounts) {
    const challenge = auth.challenge({ address: account.address, chainId: 1 });
    sessions.push(await auth.authenticate({ id: challenge.id, signature: await account.signMessage({ message: challenge.message }) }));
  }
  const kit = registry.get(accounts[0].address);
  const project = kit.create({ requestKey: randomUUID(), name: 'Source watch', symbol: 'SRC', purpose: 'Track public evidence', template: 'research', swarm: false, model: 'pending', total: 1000000, daily: 1000000, request: 500000 });
  let reads = 0;
  kit.research.reader = async url => { reads++; return { url, text: 'Published evidence version one', fetchedAt: new Date().toISOString(), responseBytes: 30, possiblyTruncated: false }; };
  registry.ready = async () => assert.fail('Baseline and unchanged source checks must not initialize a paid runtime');
  const app = createProductionApp({ auth, registry, gateway: new GatewayVerifier({ key: gatewayKey }), origin, mainnet: {} });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.close(resolve)));
  async function request(suffix, { session = sessions[0], body, csrf = session?.csrf } = {}) {
    const path = `/api/projects/${project.id}/${suffix}`, method = body === undefined ? 'GET' : 'POST';
    const raw = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    const headers = { origin, 'content-type': 'application/json', ...(session ? { cookie: sessionCookie(session.token), 'x-agent-csrf': csrf } : {}) };
    Object.assign(headers, signGateway({ key: gatewayKey, method, path, headers, body: raw }));
    const response = await fetch(`http://127.0.0.1:${app.address().port}${path}`, { method, headers, body: body === undefined ? undefined : raw });
    return { status: response.status, body: await response.json() };
  }
  assert.equal((await request('research', { session: null })).status, 401);
  assert.equal((await request('research', { session: sessions[1] })).status, 404);
  assert.deepEqual((await request('research')).body.watchlists, []);
  const input = { requestKey: randomUUID(), name: 'Protocol updates', brief: 'Explain changes with evidence', sources: ['https://ethereum.org/en/#intro'], enabled: false, cadenceMinutes: 1440, reviewerModel: null };
  assert.equal((await request('watches', { body: input, csrf: 'invalid' })).status, 403);
  assert.equal((await request('watches', { session: sessions[1], body: input })).status, 404);
  assert.equal((await request('watches', { body: { ...input, sources: ['http://127.0.0.1/private'] } })).status, 400);
  const created = await request('watches', { body: input });
  assert.equal(created.status, 201); assert.deepEqual(created.body.sources, ['https://ethereum.org/en/']);
  const id = created.body.id, firstKey = randomUUID();
  const first = await request(`watches/${id}/check`, { body: { requestKey: firstKey } });
  assert.equal(first.status, 202); assert.equal(first.body.status, 'baseline'); assert.equal(reads, 1);
  assert.equal((await request(`watches/${id}/check`, { body: { requestKey: firstKey } })).body.id, first.body.id);
  assert.equal(reads, 1);
  const second = await request(`watches/${id}/check`, { body: { requestKey: randomUUID() } });
  assert.equal(second.body.status, 'unchanged'); assert.equal(reads, 2); assert.equal(kit.store.data.jobs.length, 0);
  const history = await request('research');
  assert.equal(history.body.checks.length, 2); assert.equal(history.body.watchlists[0].snapshots, undefined);
  assert.equal((await request(`watches/${id}`, { body: { brief: 'Updated research brief' } })).body.brief, 'Updated research brief');
  assert.equal((await request('research?include=private')).status, 400);
  assert.equal((await request(`watches/${id}/check`, { session: sessions[1], body: { requestKey: randomUUID() } })).status, 404);
  const paused = await request('pause', { body: {} });
  assert.equal(paused.status, 200); assert.equal(paused.body.status, 'paused'); assert.equal(paused.body.research, undefined);
  assert.equal((await request(`watches/${id}/check`, { body: { requestKey: randomUUID() } })).status, 409);
  assert.equal(reads, 2);
});

test('research source validation rejects URL tricks and exposes capture limits without executing page scripts', async () => {
  for (const url of ['https://ethereum.org.evil.test/', 'https://ethereum.org@127.0.0.1/', 'https://ethereum.org:8443/', 'file:///etc/passwd', 'https://[::1]/', 'https://user:pass@github.com/']) assert.throws(() => validateSourceUrl(url));
  assert.equal(validateSourceUrl('https://api.github.com/repos/ethereum/zkapi#readme'), 'https://api.github.com/repos/ethereum/zkapi');
  const document = '<script>do not execute</script><style>invisible</style><p>' + 'evidence '.repeat(3000) + '</p>';
  let options;
  const result = await readSource('https://ethereum.org/#fragment', { fetcher: async (_url, input) => { options = input; return new Response(document, { headers: { 'content-type': 'text/html' } }); } });
  assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
  assert.equal(result.url, 'https://ethereum.org/'); assert.equal(result.text.length, 20000); assert.equal(result.possiblyTruncated, true);
  assert.equal(result.excerptLimit, 20000); assert.equal(result.responseBytes, Buffer.byteLength(document));
  assert.ok(!result.text.includes('execute')); assert.ok(!result.text.includes('invisible')); assert.ok(Number.isFinite(Date.parse(result.fetchedAt)));
});
