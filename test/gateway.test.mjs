import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import gateway from '../api/gateway.mjs';
import { GatewayVerifier } from '../src/gateway-auth.mjs';

function setup(t) {
  const previous = Object.fromEntries(['PUBLIC_ORIGIN', 'VEYL_RUNTIME_ORIGIN', 'VEYL_GATEWAY_KEY'].map(key => [key, process.env[key]])), originalFetch = globalThis.fetch;
  Object.assign(process.env, { PUBLIC_ORIGIN: 'https://veyl.sh', VEYL_RUNTIME_ORIGIN: 'https://runtime.veyl.sh', VEYL_GATEWAY_KEY: 'ab'.repeat(32) });
  t.after(() => { globalThis.fetch = originalFetch; for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
function response() {
  const data = [], headers = {};
  return { statusCode: 200, headersSent: false, headers, setHeader(name, value) { headers[name.toLowerCase()] = value; }, write(chunk) { this.headersSent = true; data.push(Buffer.from(chunk)); }, end(chunk) { if (chunk) data.push(Buffer.from(chunk)); this.body = Buffer.concat(data).toString(); } };
}
function request(url, options = {}) { const req = Readable.from(options.body ? [Buffer.from(options.body)] : []); req.url = url; req.method = options.method || 'GET'; req.headers = { host: 'veyl.sh', origin: 'https://veyl.sh', ...options.headers }; req.socket = { remoteAddress: '127.0.0.1' }; return req; }

test('Vercel gateway signs preserved query/body and forwards session cookie without exposing service credentials', async t => {
  setup(t); let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++; assert.equal(url, 'https://runtime.veyl.sh/api/projects/abc/mainnet/status?account=0x123&view=current');
    new GatewayVerifier({ key: process.env.VEYL_GATEWAY_KEY }).verify({ method: init.method, path: new URL(url).pathname + new URL(url).search, headers: init.headers, body: Buffer.alloc(0) });
    assert.equal(init.headers.cookie, '__Host-veyl=' + 'a'.repeat(64)); assert.equal(init.headers.authorization, undefined); assert.equal(init.redirect, 'error');
    return new Response(JSON.stringify({ healthy: true }), { headers: { 'content-type': 'application/json', 'set-cookie': '__Host-veyl=session; Secure; HttpOnly; Path=/' } });
  };
  const res = response(); await gateway(request('/api/gateway?veyl_path=projects/abc/mainnet/status&account=0x123&view=current', { headers: { cookie: '__Host-veyl=' + 'a'.repeat(64) } }), res);
  assert.equal(calls, 1); assert.equal(res.statusCode, 200); assert.deepEqual(JSON.parse(res.body), { healthy: true }); assert.ok(res.headers['set-cookie'][0].includes('HttpOnly')); assert.ok(!res.body.includes(process.env.VEYL_GATEWAY_KEY));
});

test('gateway binds bearer only on developer routes and refuses browser or owner-route credential confusion', async t => {
  setup(t); const token = 'veyl_sk_' + 'a'.repeat(64); let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++; assert.equal(url, 'https://runtime.veyl.sh/api/developer/v1/jobs');
    assert.equal(init.headers.authorization, 'Bearer ' + token); assert.equal(init.headers.cookie, undefined); assert.equal(init.headers.origin, undefined);
    const verifier = new GatewayVerifier({ key: process.env.VEYL_GATEWAY_KEY }), signed = { method: init.method, path: '/api/developer/v1/jobs', headers: init.headers, body: init.body };
    assert.throws(() => verifier.verify({ ...signed, headers: { ...signed.headers, authorization: 'Bearer veyl_sk_' + 'b'.repeat(64) } }), /Invalid service/);
    const without = { ...signed.headers }; delete without.authorization; assert.throws(() => verifier.verify({ ...signed, headers: without }), /Invalid service/);
    verifier.verify(signed); return new Response('{"job":{"id":"test"}}', { status: 202, headers: { 'content-type': 'application/json', 'x-request-id': 'worker-request' } });
  };
  const valid = request('/api/gateway?veyl_path=developer/v1/jobs', { method: 'POST', headers: { origin: undefined, authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: '{"requestKey":"request-key-12345","prompt":"Task"}' });
  const res = response(); await gateway(valid, res); assert.equal(res.statusCode, 202); assert.equal(calls, 1); assert.equal(res.headers['x-request-id'], 'worker-request');
  for (const req of [
    request('/api/gateway?veyl_path=state', { headers: { authorization: 'Bearer ' + token } }),
    request('/api/gateway?veyl_path=developer/v1/project', { headers: { authorization: 'Bearer ' + token } }),
    request('/api/gateway?veyl_path=developer/v1/project', { headers: { origin: undefined, authorization: 'Bearer ' + token, cookie: 'session' } }),
    request('/api/gateway?veyl_path=developer/v1/project', { headers: { origin: 'https://evil.invalid', authorization: 'Bearer ' + token } })
  ]) { const rejected = response(); await gateway(req, rejected); assert.equal(rejected.statusCode, 403); assert.ok(!rejected.body.includes(token)); }
  assert.equal(calls, 1);
});

test('gateway rejects cross-origin writes, duplicate routes, oversized bodies and missing worker without contacting upstream', async t => {
  setup(t); globalThis.fetch = async () => { throw new Error('Must not forward'); };
  for (const [req, status] of [
    [request('/api/gateway?veyl_path=projects', { method: 'POST', headers: { origin: 'https://attacker.invalid' }, body: '{}' }), 403],
    [request('/api/gateway?veyl_path=projects&veyl_path=state'), 404],
    [request('/api/gateway?veyl_path=projects', { method: 'POST', body: 'x'.repeat(40001) }), 413]
  ]) { const res = response(); await gateway(req, res); assert.equal(res.statusCode, status); }
  delete process.env.VEYL_RUNTIME_ORIGIN; const res = response(); await gateway(request('/api/gateway?veyl_path=state'), res); assert.equal(res.statusCode, 503); assert.match(res.body, /not connected/);
});
