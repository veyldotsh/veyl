import test from 'node:test';
import assert from 'node:assert/strict';
import { ZkApiProvider, ZKAPI_SOURCE_REVISION } from '../src/provider.mjs';

const answer = { choices: [{ message: { content: 'A model reply.' } }] };
const responseProvider = (headers, extra = {}) => new ZkApiProvider({ fetcher: async () => new Response(JSON.stringify({ ...answer, ...extra }), { headers }) });

test('zkAPI ownership verification never promotes provider usage to signed settlement', async () => {
  const provider = responseProvider({ 'x-oa-verification-status': 'verified' }, { usage: { cost: 0.01 }, charge_applied: 1, signature: 'provider-controlled', settled: true });
  const result = await provider.complete({});
  assert.equal(result.verification, 'daemon-reported verified');
  assert.deepEqual(result.settlement, { status: 'unreconciled', signedReceiptVerified: false });
  assert.equal(result.usage, undefined); assert.equal(result.charge_applied, undefined); assert.equal(result.signature, undefined);
});

test('zkAPI recognizes only the pinned daemon trusted-station fallback combination', async () => {
  const provider = responseProvider({ 'x-oa-verification-status': 'verifier-unavailable', 'x-oa-verification-detail': 'trusted_station_fallback' });
  const result = await provider.complete({});
  assert.equal(result.verification, 'daemon-reported verification unavailable');
  assert.equal(result.verificationDetail, 'trusted_station_fallback');
  assert.equal(result.settlement.signedReceiptVerified, false);
  for (const headers of [
    { 'x-oa-verification-status': 'verified', 'x-oa-verification-detail': 'trusted_station_fallback' },
    { 'x-oa-verification-status': 'verifier-unavailable' },
    { 'x-oa-verification-status': 'verifier-unavailable', 'x-oa-verification-detail': 'unknown_station' },
    { 'x-oa-verification-status': 'verified, verifier-unavailable' },
    { 'x-oa-verification-detail': 'trusted_station_fallback' },
    { 'x-oa-verification-status': 'settled' }
  ]) await assert.rejects(responseProvider(headers).complete({}), error => error.status === 502 && /Budget stays reserved/.test(error.message));
});

test('zkAPI read-only diagnostics check exact status fields without wallet or funding endpoints', async () => {
  const calls = [], key = 'offline-fixture-inference-key-not-a-real-credential';
  const provider = new ZkApiProvider({ key, fetcher: async (url, options) => {
    const path = new URL(url).pathname; calls.push(path);
    assert.equal(options.method, 'GET'); assert.equal(options.body, undefined); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${key}`); assert.equal(options.headers['X-OA-Management-Token'], undefined);
    assert.ok(['/healthz', '/admin/status'].includes(path));
    return new Response(JSON.stringify(path === '/healthz' ? { status: 'ok' } : { backend: 'zkapi', network: 'mainnet', request_budget_policy: 'model', unexpected_private_field: 'must not be copied' }));
  } });
  const report = await provider.diagnostics();
  assert.deepEqual(calls, ['/healthz', '/admin/status']);
  assert.equal(report.network, 'mainnet'); assert.equal(report.sourceRevision, ZKAPI_SOURCE_REVISION);
  assert.equal(report.configuration, 'daemon-reported match');
  assert.equal(report.configurationVerified, false); assert.equal(report.fundedBalanceVerified, false); assert.equal(report.signedSettlementAvailable, false);
  assert.equal(report.unexpected_private_field, undefined);
});

test('zkAPI diagnostics do not bypass authenticated status when inference is keyless', async () => {
  const calls = [];
  const provider = new ZkApiProvider({ fetcher: async (url, options) => { calls.push(new URL(url).pathname); assert.equal(options.headers.Authorization, undefined); return new Response('{"status":"ok"}'); } });
  const report = await provider.diagnostics();
  assert.deepEqual(calls, ['/healthz']); assert.match(report.configuration, /not checked/); assert.equal(report.configurationVerified, false);
});

test('zkAPI diagnostics reject a different network, policy or backend without exposing upstream fields', async () => {
  for (const status of [
    { backend: 'zkapi', network: 'sepolia', request_budget_policy: 'model' },
    { backend: 'zkapi', network: 'mainnet', request_budget_policy: 'unbounded' },
    { backend: 'proxy', network: 'mainnet', request_budget_policy: 'model' }, null
  ]) {
    const provider = new ZkApiProvider({ key: 'offline-fixture', fetcher: async url => new Response(JSON.stringify(new URL(url).pathname === '/healthz' ? { status: 'ok' } : status)) });
    await assert.rejects(provider.diagnostics(), error => error.status === 502);
  }
  const sepolia = new ZkApiProvider({ key: 'offline-fixture', fetcher: async url => new Response(JSON.stringify(new URL(url).pathname === '/healthz' ? { status: 'ok' } : { backend: 'zkapi', network: 'sepolia', request_budget_policy: 'model' })) });
  assert.equal((await sepolia.diagnostics({ expectedNetwork: 'sepolia' })).network, 'sepolia');
});

test('zkAPI preserves bounded offered function calls without pretending they are model answers or settlements', async () => {
  const call = { id: 'call_1', type: 'function', function: { name: 'read_source', arguments: '{"id":"source-1"}' } };
  const provider = responseProvider({}, { choices: [{ message: { role: 'assistant', content: null, tool_calls: [call] } }] });
  const result = await provider.complete({ tools: [{ type: 'function', function: { name: 'read_source' } }] });
  assert.equal(result.answer, ''); assert.deepEqual(result.toolCalls, [call]); assert.equal(result.settlement.signedReceiptVerified, false);
  for (const tool_calls of [[{ ...call, function: { ...call.function, name: 'publish_social' } }], [call, call], [{ ...call, function: { ...call.function, arguments: '[]' } }], [{ ...call, function: { ...call.function, arguments: '{bad' } }], Array.from({ length: 9 }, (_, i) => ({ ...call, id: 'call_' + i }))]) {
    const bad = responseProvider({}, { choices: [{ message: { content: null, tool_calls } }] });
    await assert.rejects(bad.complete({ tools: [{ type: 'function', function: { name: 'read_source' } }] }), e => e.status === 502 && /Budget stays reserved/.test(e.message));
  }
});
test('tracked provider admission stays in authenticated local headers and never provider JSON', async () => {
  const calls = [], callId = 'a0000000-0000-4000-8000-000000000001', journalId = 'a'.repeat(32);
  const provider = new ZkApiProvider({ key: 'local-fixture', fetcher: async (url, options) => {
    const path = new URL(url).pathname; calls.push(path); assert.equal(options.headers.Authorization, 'Bearer local-fixture');
    if (path === '/v1/accounting') return new Response(JSON.stringify({ version: 1, journal_id: journalId }));
    if (path.includes('/call-settlements/')) return new Response(JSON.stringify({ version: 1, journal_id: journalId, call_id: callId, status: 'reserved' }));
    assert.equal(options.headers['X-Veyl-Call-Id'], callId); assert.equal(options.headers['X-Veyl-Journal-Id'], journalId); assert.equal(options.headers['X-Veyl-Reserved-Micro-Usd'], '1001000');
    assert.deepEqual(JSON.parse(options.body), { model: 'fixture' }); return new Response(JSON.stringify(answer));
  } });
  assert.equal((await provider.accountingIdentity()).journal_id, journalId);
  await provider.complete({ model: 'fixture' }, { callId, journalId, reservedMicroUsd: 1001000 });
  assert.equal((await provider.callSettlement(callId)).status, 'reserved'); assert.equal(calls.length, 3);
  await assert.rejects(provider.complete({}, { callId, journalId, reservedMicroUsd: 1.5 }), /accounting context/); assert.equal(calls.length, 3);
});
