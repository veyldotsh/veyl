import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZkApiFunding, ZKAPI_MAINNET } from '../src/funding.mjs';
import { fundingQuote, fundingStatus, FIXTURE_ADDRESS, FIXTURE_KEY, FIXTURE_MANAGEMENT, FIXTURE_TIME, FIXTURE_TX } from '../fixtures/zkapi-funding.mjs';

const destination = '0x3333333333333333333333333333333333333333';
function recoveryQuote(kind, overrides = {}) {
  const q = fundingQuote({ kind, destination, amount: kind === 'return' ? 0 : 1_000_000,
    principal_wei: kind === 'return' ? '1000000000000000' : '0', required_total_wei: kind === 'return' ? '1012000000000000' : '12000000000000',
    recommended_total_wei: kind === 'return' ? '1120000000000000' : '120000000000000', ...overrides });
  delete q.commitment;
  if (kind === 'withdrawal') { q.note_id = 7; q.binding = `0x${'4'.repeat(64)}`; }
  return q;
}
function status(kind, overrides = {}) {
  const s = { address: FIXTURE_ADDRESS, chain_id: 1, eth_balance: '2000000000000000', phase: 'ready' };
  if (kind === 'withdrawal') Object.assign(s, { deployment_id: ZKAPI_MAINNET.deploymentId, billing_asset: 'native_eth', billing_unit: 'gwei', native_asset_wei_per_unit: '1000000000', token_address: '', token_decimals: 9, note_id: 7, amount: 1_000_000, private_balance: 1_000_000 });
  return { ...s, ...overrides };
}
function fixture(t, kind, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'veyl-recovery-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'funding.json'), calls = []; let q = null, s = status(kind), intercept, clock = FIXTURE_TIME;
  const fetcher = async (url, init) => {
    const path = new URL(url).pathname, body = init.body ? JSON.parse(init.body) : undefined;
    const call = { path, body, method: init.method }; calls.push(call);
    assert.equal(init.headers.Authorization, `Bearer ${FIXTURE_KEY}`); assert.equal(init.headers['X-OA-Management-Token'], FIXTURE_MANAGEMENT); assert.equal(init.redirect, 'error');
    const custom = await intercept?.(call); if (custom) return custom;
    let result;
    if (path === '/admin/funding/address' && init.method === 'GET') result = fundingStatus({ phase: kind === 'withdrawal' ? 'withdrawal_pending' : 'ready' });
    else if (path === `/admin/${kind}` && init.method === 'GET') result = s;
    else if (path === `/admin/${kind}/quote` && init.method === 'GET') result = q;
    else if (path === `/admin/${kind}/quote` && init.method === 'POST') {
      assert.deepEqual(body, kind === 'withdrawal' ? { destination, note_id: 7 } : { destination, amount_wei: '1000000000000000' });
      q = recoveryQuote(kind, { expires_at: clock + 30_000 });
      s = status(kind, { phase: 'quoted', destination, ...(kind === 'return' ? { amount_wei: '1000000000000000' } : {}) }); result = q;
    } else if (path === `/admin/${kind}/approve`) {
      assert.deepEqual(body, { quote_id: q.id }); q = null;
      s = { ...s, phase: `${kind}_pending`, transaction_hash: FIXTURE_TX }; result = s;
    } else if (path === `/admin/${kind}` && init.method === 'POST') {
      assert.deepEqual(body, kind === 'withdrawal' ? { destination, note_id: 7 } : {});
      s = { ...s, phase: 'complete' }; result = s;
    } else assert.fail(path);
    return new Response(JSON.stringify(result), { headers: { date: new Date(clock).toUTCString(), 'cache-control': 'no-store' } });
  };
  const chainCalls = [], chainClient = { getChainId: async () => 1, getTransactionCount: async input => { chainCalls.push(input); return 3; } };
  const config = { file, localMode: true, allowApproval: true, key: FIXTURE_KEY, managementToken: FIXTURE_MANAGEMENT, fetcher, now: () => clock, chainClient, ...opts };
  return { service: new ZkApiFunding(config), calls, file, request: { kind, destination, idempotencyKey: 'recover-fixture-1', ...(kind === 'withdrawal' ? { noteId: 7 } : { amountWei: '1000000000000000' }) },
    restart: () => new ZkApiFunding(config), chainCalls, chainClient: config.chainClient, intercept: fn => { intercept = fn; }, setStatus: value => { s = value; }, setQuote: value => { q = value; }, setClock: value => { clock = value; } };
}
const approve = item => ({ intentId: item.id, quoteId: item.quote.id, approvalDigest: item.approvalDigest });

test('operator pause during awaited withdrawal status prevents approval intent and signing request', async t => {
  let paused = false;
  const f = fixture(t, 'withdrawal', { authorizeApproval: () => { if (paused) throw new Error('operator paused'); } });
  const intent = await f.service.quoteOperation(f.request);
  f.intercept(call => { if (call.path === '/admin/withdrawal' && call.method === 'GET') paused = true; });
  await assert.rejects(f.service.approveOperation(approve(intent)));
  assert.equal(f.service.snapshot().operations[0].approvalAttempted, false);
  assert.equal(f.calls.some(call => call.path === '/admin/withdrawal/approve'), false);
});

for (const kind of ['withdrawal', 'return']) {
  test(`${kind} pins exact quote, persists signing intent and resumes only saved transaction`, async t => {
    const f = fixture(t, kind), q = await f.service.quoteOperation(f.request);
    assert.equal(q.status, 'quoted'); assert.equal(q.request.destination, destination);
    assert.deepEqual(await f.restart().quoteOperation(f.request), q);
    const pending = await f.service.approveOperation(approve(q)); assert.equal(pending.status, 'pending');
    assert.deepEqual(await f.service.approveOperation(approve(q)), pending);
    const before = f.calls.filter(c => c.method === 'POST').length;
    assert.equal((await f.service.recoverOperation(q.id)).status, 'pending'); assert.equal(f.calls.filter(c => c.method === 'POST').length, before);
    await assert.rejects(f.service.resumeOperation({ intentId: q.id, transactionHash: `0x${'b'.repeat(64)}` }), e => e.status === 409);
    assert.equal((await f.service.resumeOperation({ intentId: q.id, transactionHash: FIXTURE_TX })).status, 'complete');
    assert.equal(f.restart().snapshot().operations[0].status, 'complete');
    const saved = readFileSync(f.file + '.operations', 'utf8'); assert.equal(saved.includes(FIXTURE_KEY), false); assert.equal(saved.includes(FIXTURE_MANAGEMENT), false);
  });
  test(`${kind} never replays lost approval or adopts an unrelated transaction`, async t => {
    const f = fixture(t, kind), q = await f.service.quoteOperation(f.request);
    f.intercept(call => { if (call.path.endsWith('/approve')) { const saved = JSON.parse(readFileSync(f.file + '.operations', 'utf8')).intents[0]; assert.equal(saved.approvalAttempted, true); assert.equal(saved.status, 'approving'); throw new Error('lost transport response'); } });
    await assert.rejects(f.service.approveOperation(approve(q)), e => e.status === 502);
    f.setStatus(status(kind, { phase: 'complete', destination, transaction_hash: FIXTURE_TX, ...(kind === 'return' ? { amount_wei: '1000000000000000' } : {}) }));
    const restarted = f.restart(); assert.equal((await restarted.recoverOperation(q.id)).status, 'recovery_required');
    await restarted.approveOperation(approve(q));
    assert.equal(f.calls.filter(c => c.path.endsWith('/approve')).length, 1);
    await assert.rejects(restarted.resumeOperation({ intentId: q.id, transactionHash: FIXTURE_TX }), e => e.status === 409);
  });
  test(`${kind} approval is disabled and stale/replaced destination is rejected`, async t => {
    const f = fixture(t, kind, { allowApproval: false }), q = await f.service.quoteOperation(f.request);
    assert.throws(() => f.service.approveOperation(approve(q)), e => e.status === 403);
    const g = fixture(t, kind), original = await g.service.quoteOperation(g.request);
    g.setQuote(recoveryQuote(kind, { destination: FIXTURE_ADDRESS }));
    await assert.rejects(g.service.approveOperation(approve(original)), e => e.status === 502);
    g.setQuote(recoveryQuote(kind)); g.setClock(FIXTURE_TIME + 30_001);
    await assert.rejects(g.service.approveOperation(approve(original)), e => e.status === 409);
    assert.equal(g.calls.filter(c => c.path.endsWith('/approve')).length, 0);
  });
}

test('private withdrawal binds the selected note and public return requires exact positive amount', async t => {
  const f = fixture(t, 'withdrawal'); f.setStatus(status('withdrawal', { note_id: 8 }));
  await assert.rejects(f.service.quoteOperation(f.request), e => e.status === 409);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
  for (const amountWei of ['', '0', 'all', 1, '01']) assert.throws(() => f.service.quoteOperation({ kind: 'return', destination, amountWei, idempotencyKey: 'explicit-exact-return' }));
});

test('quote expiry during the final awaited status check does not mark an approval attempted', async t => {
  const f = fixture(t, 'withdrawal'), q = await f.service.quoteOperation(f.request);
  f.intercept(call => { if (call.path === '/admin/withdrawal' && call.method === 'GET') f.setClock(FIXTURE_TIME + 30_001); });
  await assert.rejects(f.service.approveOperation(approve(q)), /expired while checking readiness/);
  assert.equal(f.service.snapshot().operations[0].approvalAttempted, false);
  assert.equal(f.calls.some(c => c.path.endsWith('/approve')), false);
});

async function ambiguous(t, kind = 'withdrawal', opts = {}) {
  const f = fixture(t, kind, opts), q = await f.service.quoteOperation(f.request);
  f.intercept(call => { if (call.path.endsWith('/approve')) throw new Error('fixture lost response'); });
  await assert.rejects(f.service.approveOperation(approve(q)), e => e.status === 502);
  f.intercept(null); f.setClock(FIXTURE_TIME + 32_000);
  return { ...f, q };
}

for (const kind of ['withdrawal', 'return']) test(`${kind} retires only an expired unsigned authorization and preserves the original attempt across restart`, async t => {
  const f = await ambiguous(t, kind), before = f.calls.filter(c => c.method === 'POST').length;
  const recovered = await f.service.recoverOperation(f.q.id); assert.equal(recovered.status, 'recovery_required');
  const retired = await f.service.retireExpiredOperation(approve(f.q));
  assert.equal(retired.status, 'expired_unsigned'); assert.equal(retired.approvalAttempted, true); assert.equal(retired.transactionHash, undefined);
  assert.deepEqual(retired.quote, f.q.quote); assert.equal(retired.approvalDigest, f.q.approvalDigest);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, before);
  assert.deepEqual(f.chainCalls, ['latest', 'pending'].map(blockTag => ({ address: FIXTURE_ADDRESS, blockTag })));
  const restarted = f.restart(); assert.deepEqual(await restarted.retireExpiredOperation(approve(f.q)), retired);
  assert.deepEqual(await restarted.recoverOperation(f.q.id), retired);
  assert.deepEqual(await restarted.approveOperation(approve(f.q)), retired);
  await assert.rejects(restarted.refreshOperation(f.q.id), /Approval may exist/);
  assert.equal(f.calls.filter(c => c.path.endsWith('/approve')).length, 1);
  assert.deepEqual(await restarted.quoteOperation(f.request), retired);
  const next = await restarted.quoteOperation({ ...f.request, idempotencyKey: 'fresh-reviewed-recovery' });
  assert.notEqual(next.id, f.q.id); assert.equal(next.status, 'quoted'); assert.equal(next.approvalAttempted, false);
  assert.equal(restarted.snapshot().operations[0].status, 'expired_unsigned');
});

test('expired unsigned retirement rejects every changed binding and never changes the saved attempt', async t => {
  for (const mutation of [q => ({ ...q, id: '5'.repeat(64) }), q => ({ ...q, destination: FIXTURE_ADDRESS }), q => ({ ...q, note_id: 8 }), q => ({ ...q, binding: '0x' + '5'.repeat(64) }), q => ({ ...q, amount: q.amount - 1 }), q => ({ ...q, nonce: q.nonce + 1 }), q => ({ ...q, address: destination }), q => ({ ...q, chain_id: 2 }), q => ({ ...q, deployment_id: 'another-deployment' }), () => null]) {
    const f = await ambiguous(t); f.setQuote(mutation(f.q.quote)); const original = f.service.snapshot();
    await assert.rejects(f.service.retireExpiredOperation(approve(f.q)));
    assert.deepEqual(f.service.snapshot(), original); assert.equal(f.calls.filter(c => c.path.endsWith('/approve')).length, 1);
  }
});

test('signed, pending, incomplete, stale-clock and changed-nonce observations cannot retire an approval', async t => {
  const scenarios = [
    f => f.setStatus(status('withdrawal', { phase: 'quoted', destination, transaction_hash: FIXTURE_TX })),
    f => f.setStatus(status('withdrawal', { phase: 'waiting_funds', destination })),
    f => f.setStatus(status('withdrawal', { phase: 'quoted', destination, amount: 999999 })),
    f => f.setStatus(status('withdrawal', { phase: 'quoted', destination, transaction_hash: false })),
    f => f.intercept(c => c.path === '/admin/funding/address' ? new Response(JSON.stringify(fundingStatus({ phase: 'withdrawal_pending', transaction_hash: FIXTURE_TX }))) : undefined),
    f => f.intercept(c => c.path === '/admin/funding/address' ? new Response(JSON.stringify(fundingStatus({ phase: 'active' }))) : undefined),
    f => f.intercept(c => c.path.endsWith('/quote') ? new Response(JSON.stringify(f.q.quote)) : undefined),
    f => f.intercept(c => c.path.endsWith('/quote') ? new Response(JSON.stringify(f.q.quote), { headers: { date: new Date(FIXTURE_TIME + 29_000).toUTCString(), 'cache-control': 'no-store' } }) : undefined),
    f => { f.chainClient.getChainId = async () => 2; },
    f => { f.chainClient.getTransactionCount = async ({ blockTag }) => blockTag === 'pending' ? 4 : 3; },
    f => { f.chainClient.getTransactionCount = async () => 4; },
    f => { f.chainClient.getTransactionCount = async () => { throw new Error('RPC unavailable'); }; },
    f => { let calls = 0; f.intercept(c => c.path.endsWith('/quote') && ++calls === 2 ? new Response('null', { headers: { date: new Date(FIXTURE_TIME + 32_000).toUTCString(), 'cache-control': 'no-store' } }) : undefined); }
  ];
  for (const scenario of scenarios) {
    const f = await ambiguous(t); scenario(f); const before = f.service.snapshot();
    await assert.rejects(f.service.retireExpiredOperation(approve(f.q)));
    assert.deepEqual(f.service.snapshot(), before); assert.equal(f.calls.filter(c => c.path.endsWith('/approve')).length, 1);
  }
  const f = await ambiguous(t, 'withdrawal', { chainClient: null });
  await assert.rejects(f.service.retireExpiredOperation(approve(f.q)), /unavailable/);
});

test('retirement never reopens a signed pending operation or retires an unattempted quote', async t => {
  const f = fixture(t, 'withdrawal'), q = await f.service.quoteOperation(f.request);
  f.setClock(FIXTURE_TIME + 32_000);
  await assert.rejects(f.service.retireExpiredOperation(approve(q)), /cannot be proven/);
  f.setClock(FIXTURE_TIME + 1000);
  const pending = await f.service.approveOperation(approve(q));
  f.setClock(FIXTURE_TIME + 32_000);
  const reads = f.calls.length;
  await assert.rejects(f.service.retireExpiredOperation(approve(q)), /cannot be proven/);
  assert.equal(f.calls.length, reads); assert.equal(f.service.snapshot().operations[0].transactionHash, pending.transactionHash);
  await assert.rejects(f.service.retireExpiredOperation({ ...approve(q), approvalDigest: '0'.repeat(64) }), /differs/);
});
