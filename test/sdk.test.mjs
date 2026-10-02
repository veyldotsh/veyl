import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { VeylClient, VeylApiError } from '../packages/veyl/client.mjs';
const token = 'veyl_sk_' + 'a'.repeat(64), requestKey = '12345678-1234-1234-1234-123456789012';
function fixture(handler = () => new Response('{"project":{"id":"p"}}')) {
  const calls = []; const client = new VeylClient({ token, fetch: async (url, init) => { calls.push({ url, init }); return handler(url, init); } }); return { calls, client };
}
test('SDK sends bearer only to HTTPS origin with redirects and browser credentials disabled', async () => {
  const { client, calls } = fixture(); assert.equal((await client.project()).project.id, 'p');
  assert.equal(calls[0].url, 'https://veyl.sh/api/developer/v1/project');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${token}`); assert.equal(calls[0].init.redirect, 'error'); assert.equal(calls[0].init.credentials, 'omit');
  assert.ok(!JSON.stringify(client).includes(token)); assert.ok(!inspect(client).includes(token));
  for (const baseUrl of ['http://example.com', 'https://user:pass@example.com', 'https://veyl.sh?token=x', 'https://veyl.sh/api']) assert.throws(() => new VeylClient({ token, baseUrl }));
});
test('SDK mutation uses the exact durable key and never retries after uncertain network outcomes', async () => {
  const f = fixture(() => { throw Error(`upstream included ${token}`); });
  await assert.rejects(f.client.submitJob({ requestKey, prompt: 'Review saved sources' }), e => e instanceof VeylApiError && e.uncertain && !e.message.includes(token));
  assert.equal(f.calls.length, 1); assert.deepEqual(JSON.parse(f.calls[0].init.body), { requestKey, prompt: 'Review saved sources' });
});
test('SDK distinguishes explicit rejection from uncertain server failure and sanitizes reflected credentials', async () => {
  for (const status of [401, 403, 409, 429, 500, 503]) {
    const f = fixture(() => new Response(JSON.stringify({ error: `Denied ${token}`, code: 'DENIED' }), { status, headers: { 'x-request-id': 'request-1' } }));
    await assert.rejects(f.client.saveMemory({ requestKey, content: 'A note' }), e => e.status === status && e.code === 'DENIED' && e.requestId === 'request-1' && e.uncertain === (status >= 500) && !e.message.includes(token));
    assert.equal(f.calls.length, 1);
  }
});
test('SDK timeout aborts exactly one call and marks mutation acceptance uncertain', async () => {
  let calls = 0;
  const client = new VeylClient({ token, timeoutMs: 5, fetch: (_url, init) => new Promise((_r, reject) => { calls++; init.signal.addEventListener('abort', () => reject(Error('aborted'))); }) });
  await assert.rejects(client.submitJob({ requestKey, prompt: 'Brief' }), e => e.code === 'TIMEOUT' && e.uncertain); assert.equal(calls, 1);
});
test('SDK validates keys, channels and paths before sending any request', () => {
  const f = fixture();
  for (const key of ['', 'short', '../not-a-project-key']) assert.throws(() => f.client.submitJob({ requestKey: key, prompt: 'Brief' }));
  assert.throws(() => f.client.job('../funding/approve')); assert.throws(() => f.client.prepareDraft({ channel: 'email', text: 'Hello', idempotencyKey: requestKey }));
  assert.throws(() => f.client.prepareDraft({ channel: 'x', text: 'x'.repeat(4097), idempotencyKey: requestKey })); assert.equal(f.calls.length, 0);
});
test('SDK exposes only scoped routes and supports read-only reconciliation by exact request key', async () => {
  const f = fixture(() => new Response('{}'));
  await f.client.jobs({ requestKey }); await f.client.job('job-1'); await f.client.models(); await f.client.memory(); await f.client.drafts();
  await f.client.prepareDraft({ channel: 'telegram', text: 'Draft only', idempotencyKey: 'draft-key-1' });
  assert.equal(new URL(f.calls[0].url).searchParams.get('requestKey'), requestKey); assert.ok(f.calls.slice(0, 5).every(c => c.init.method === 'GET'));
  assert.deepEqual(JSON.parse(f.calls[5].init.body), { channel: 'telegram', text: 'Draft only', idempotencyKey: 'draft-key-1', madeWithAi: true });
  for (const unavailable of ['publish', 'approve', 'fund', 'trade', 'request']) assert.equal(f.client[unavailable], undefined);
});
test('SDK refuses malformed or oversized responses without retrying or exposing response contents', async () => {
  for (const body of ['not JSON', '[]', 'x'.repeat(1024 * 1024 + 1)]) {
    const f = fixture(() => new Response(body)); await assert.rejects(f.client.submitJob({ requestKey, prompt: 'Brief' }), e => e instanceof VeylApiError && e.uncertain); assert.equal(f.calls.length, 1);
  }
});

test('SDK forwards bounded raw X text for official server-side weighting instead of rejecting long URLs', async () => {
  const f = fixture(() => new Response('{}')), text = 'https://example.com/' + 'a'.repeat(300);
  await f.client.prepareDraft({ channel: 'x', text, idempotencyKey: requestKey });
  assert.equal(JSON.parse(f.calls[0].init.body).text, text); assert.equal(f.calls.length, 1);
});

test('SDK research routes are fixed-project and require explicit bounded watch settings', async () => {
  const f = fixture(() => new Response('{}'));
  const settings = { requestKey, name: 'Protocol changes', brief: 'Explain material changes.', sources: ['https://ethereum.org/en/'], enabled: false, cadenceMinutes: 60, reviewerModel: null };
  await f.client.research(); await f.client.createWatchlist(settings);
  await f.client.updateWatchlist(requestKey, { enabled: true }); await f.client.checkWatchlist(requestKey, { requestKey });
  assert.deepEqual(f.calls.map(call => new URL(call.url).pathname), ['/api/developer/v1/research', '/api/developer/v1/research/watchlists', `/api/developer/v1/research/watchlists/${requestKey}`, `/api/developer/v1/research/watchlists/${requestKey}/checks`]);
  assert.deepEqual(JSON.parse(f.calls[1].init.body), settings);
  assert.deepEqual(JSON.parse(f.calls[2].init.body), { enabled: true });
  assert.deepEqual(JSON.parse(f.calls[3].init.body), { requestKey });
  const bad = [undefined, { ...settings, enabled: undefined }, { ...settings, projectId: 'other' }, { ...settings, sources: ['http://ethereum.org'] }, { ...settings, sources: ['https://user:pass@ethereum.org'] }, { ...settings, sources: [] }, { ...settings, cadenceMinutes: 1 }];
  for (const value of bad) assert.throws(() => f.client.createWatchlist(value));
  assert.throws(() => f.client.updateWatchlist('../funding', { enabled: true }));
  assert.throws(() => f.client.updateWatchlist(requestKey, {}));
  assert.throws(() => f.client.checkWatchlist(requestKey, { requestKey, projectId: 'other' }));
  assert.equal(f.calls.length, 4);
});

test('SDK never repeats an uncertain research check or settings update', async () => {
  const f = fixture(() => { throw Error('network lost'); });
  await assert.rejects(f.client.checkWatchlist(requestKey, { requestKey }), error => error.uncertain === true);
  await assert.rejects(f.client.updateWatchlist(requestKey, { enabled: false }), error => error.uncertain === true);
  assert.equal(f.calls.length, 2);
});
