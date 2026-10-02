import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZkApiFunding, ZKAPI_MAINNET } from '../src/funding.mjs';
import { fundingQuote, FIXTURE_ADDRESS, FIXTURE_KEY, FIXTURE_MANAGEMENT, FIXTURE_TIME, FIXTURE_TX } from '../fixtures/zkapi-funding.mjs';

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
    if (path === `/admin/${kind}` && init.method === 'GET') result = s;
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
    return new Response(JSON.stringify(result));
  };
  const config = { file, localMode: true, allowApproval: true, key: FIXTURE_KEY, managementToken: FIXTURE_MANAGEMENT, fetcher, now: () => clock, ...opts };
  return { service: new ZkApiFunding(config), calls, file, request: { kind, destination, idempotencyKey: 'recover-fixture-1', ...(kind === 'withdrawal' ? { noteId: 7 } : { amountWei: '1000000000000000' }) },
    restart: () => new ZkApiFunding(config), intercept: fn => { intercept = fn; }, setStatus: value => { s = value; }, setQuote: value => { q = value; }, setClock: value => { clock = value; } };
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
