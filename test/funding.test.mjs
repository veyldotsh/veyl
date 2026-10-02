import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZkApiFunding, fundingFromEnv } from '../src/funding.mjs';
import { fundingStatus, fundingQuote, FIXTURE_TIME, FIXTURE_KEY, FIXTURE_MANAGEMENT, FIXTURE_TX } from '../fixtures/zkapi-funding.mjs';

function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'veyl-funding-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'intents.json'), calls = [];
  let clock = FIXTURE_TIME, status = fundingStatus(), quote = null, intercept;
  const fetcher = async (url, init) => {
    const path = new URL(url).pathname, body = init.body ? JSON.parse(init.body) : undefined;
    const call = { path, method: init.method, body, headers: init.headers }; calls.push(call);
    assert.equal(new URL(url).origin, 'http://127.0.0.1:8787'); assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Origin, undefined); assert.equal(init.headers.Authorization, `Bearer ${FIXTURE_KEY}`);
    if (path === '/healthz' || path === '/admin/status') assert.equal(init.headers['X-OA-Management-Token'], undefined);
    else assert.equal(init.headers['X-OA-Management-Token'], FIXTURE_MANAGEMENT);
    const injected = await intercept?.(call);
    if (injected !== undefined) return injected;
    let result;
    if (path === '/healthz') result = { status: 'ok' };
    else if (path === '/admin/status') result = { backend: 'zkapi', network: 'mainnet', request_budget_policy: 'model' };
    else if (path === '/admin/funding/address' && init.method === 'GET') result = status;
    else if (path === '/admin/funding/quote' && init.method === 'POST') {
      assert.deepEqual(body, { amount: 1_000_000 });
      status = fundingStatus({ phase: 'waiting_funds', amount: body.amount });
      quote = fundingQuote({ expires_at: clock + 30_000 }); result = quote;
    } else if (path === '/admin/funding/quote' && init.method === 'GET') result = quote;
    else if (path === '/admin/funding/approve' && init.method === 'POST') {
      assert.deepEqual(body, { quote_id: quote.id }); quote = null;
      status = fundingStatus({ amount: 1_000_000, phase: 'deposit_pending', deposit_stage: 'pending', transaction_hash: FIXTURE_TX }); result = status;
    } else if (path === '/admin/funding/deposit' && init.method === 'POST') {
      assert.deepEqual(body, { amount: 1_000_000 });
      status = fundingStatus({ amount: 1_000_000, phase: 'active', deposit_stage: 'active', transaction_hash: FIXTURE_TX }); result = status;
    } else assert.fail(`Unexpected offline route ${path}`);
    return new Response(JSON.stringify(result));
  };
  const config = { file, key: FIXTURE_KEY, managementToken: FIXTURE_MANAGEMENT, localMode: true, fetcher, now: () => clock, ...options };
  const service = new ZkApiFunding(config);
  return { service, file, dir, calls, config, setClock: value => { clock = value; }, intercept: handler => { intercept = handler; },
    setStatus: value => { status = value; }, setQuote: value => { quote = value; }, restart: () => new ZkApiFunding(config) };
}
const makeQuote = service => service.quote({ idempotencyKey: 'offline-request-1', amountGwei: '1000000' });
const approval = intent => ({ intentId: intent.id, quoteId: intent.quote.id, approvalDigest: intent.approvalDigest });

test('operator pause during awaited deposit validation prevents approval intent and signing request', async t => {
  let paused = false;
  const f = fixture(t, { allowApproval: true, authorizeApproval: () => { if (paused) throw new Error('operator paused'); } });
  const intent = await makeQuote(f.service);
  f.intercept(call => { if (call.path === '/admin/funding/quote' && call.method === 'GET') paused = true; });
  await assert.rejects(f.service.approve(approval(intent)));
  assert.equal(f.service.snapshot().intents[0].approvalAttempted, false);
  assert.equal(f.calls.some(call => call.path === '/admin/funding/approve'), false);
});

test('a pause after the approval request has started preserves its submitted identity instead of pretending to cancel', async t => {
  let paused = false;
  const f = fixture(t, { allowApproval: true, authorizeApproval: () => { if (paused) throw new Error('operator paused'); } });
  const intent = await makeQuote(f.service);
  f.intercept(call => { if (call.path === '/admin/funding/approve') paused = true; });
  const pending = await f.service.approve(approval(intent)); assert.equal(pending.status, 'pending'); assert.equal(pending.transactionHash, FIXTURE_TX); assert.equal(pending.approvalAttempted, true);
  assert.deepEqual(await f.service.approve(approval(intent)), pending);
  assert.equal(f.calls.filter(call => call.path === '/admin/funding/approve').length, 1);
});

test('an unsigned quote can be retired durably without deleting history or permitting its later approval', async t => {
  const f = fixture(t, { allowApproval: true }), intent = await makeQuote(f.service), before = f.calls.filter(c => c.method === 'POST').length;
  const abandoned = await f.service.abandonUnsigned(intent.id); assert.equal(abandoned.status, 'abandoned'); assert.equal(abandoned.approvalAttempted, false);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, before);
  const restarted = f.restart(); assert.deepEqual(await restarted.abandonUnsigned(intent.id), abandoned); assert.deepEqual(await restarted.recover(intent.id), abandoned);
  await assert.rejects(restarted.approve(approval(intent)), /not ready/); await assert.rejects(restarted.refresh(intent.id), /approval may already exist/);
  assert.equal((await restarted.quote({ idempotencyKey: 'replacement-unsigned-quote', amountGwei: '1000000' })).status, 'quoted');
  assert.equal(restarted.snapshot().intents.length, 2); assert.equal(restarted.snapshot().intents[0].status, 'abandoned');
});

test('unsigned retirement rejects changed daemon state and any attempted or uncertain approval', async t => {
  const changed = fixture(t), intent = await makeQuote(changed.service); changed.setStatus(fundingStatus({ phase: 'deposit_pending', amount: 1000000, transaction_hash: FIXTURE_TX }));
  await assert.rejects(changed.service.abandonUnsigned(intent.id), /does not prove/); assert.equal(changed.service.snapshot().intents[0].status, 'quoted');
  const uncertain = fixture(t, { allowApproval: true }), quote = await makeQuote(uncertain.service);
  uncertain.intercept(call => call.path.endsWith('/approve') ? new Response('{}', { status: 502 }) : undefined);
  await assert.rejects(uncertain.service.approve(approval(quote)));
  await assert.rejects(uncertain.restart().abandonUnsigned(quote.id), /provably unsigned/);
});

test('funding inspection separates management credentials and exposes no private data', async t => {
  const f = fixture(t);
  f.setStatus(fundingStatus({ private_key: 'do-not-copy', message: 'do-not-copy' }));
  const report = await f.service.inspect();
  assert.equal(report.funding.chainId, 1); assert.equal(report.approvalEnabled, false);
  assert.equal(report.perJobSignedSettlementAvailable, false);
  assert.deepEqual(f.calls.map(c => [c.method, c.path]), [['GET', '/healthz'], ['GET', '/admin/status'], ['GET', '/admin/funding/address']]);
  const serialized = JSON.stringify([report, f.service, f.service.snapshot()]);
  for (const secret of [FIXTURE_KEY, FIXTURE_MANAGEMENT, 'do-not-copy']) assert.equal(serialized.includes(secret), false);
});

test('funding quote persists exact units and idempotency without signing', async t => {
  const f = fixture(t);
  const intent = await makeQuote(f.service);
  assert.equal(intent.status, 'quoted'); assert.equal(intent.amountGwei, '1000000');
  assert.equal(intent.quote.principal_wei, '1000000000000000'); assert.equal(intent.approvalDigest.length, 64);
  const before = f.calls.length;
  assert.deepEqual(await makeQuote(f.service), intent);
  assert.deepEqual(await makeQuote(f.restart()), intent); assert.equal(f.calls.length, before);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  assert.equal(f.calls.find(c => c.path.endsWith('/approve')), undefined);
  const disk = readFileSync(f.file, 'utf8'); assert.equal(disk.includes(FIXTURE_MANAGEMENT), false); assert.equal(disk.includes(FIXTURE_KEY), false);
  await assert.rejects(f.service.quote({ idempotencyKey: 'offline-request-1', amountGwei: '2' }), e => e.status === 409);
  for (const amountGwei of [1000000, '0', '0.1', '01', '-1', '1e6', '1000000000001']) await assert.rejects(f.service.quote({ idempotencyKey: 'another-request', amountGwei }), e => e.status === 400);
});

test('approval is disabled by default and requires local mode plus distinct credentials', async t => {
  const f = fixture(t); const intent = await makeQuote(f.service); const before = f.calls.length;
  await assert.rejects(f.service.approve(approval(intent)), e => e.status === 403); assert.equal(f.calls.length, before);
  for (const extra of [{ localMode: false }, { key: '' }, { managementToken: FIXTURE_KEY }, { managementToken: 'short' }]) {
    const service = new ZkApiFunding({ ...f.config, ...extra, allowApproval: true });
    await assert.rejects(service.inspect(), e => e.status === 503);
  }
  assert.equal(f.calls.length, before);
});

test('exact quote approval is written before the request and never automatically replayed', async t => {
  const f = fixture(t, { allowApproval: true }); const intent = await makeQuote(f.service);
  f.intercept(call => { if (call.path.endsWith('/approve')) {
    const disk = JSON.parse(readFileSync(f.file, 'utf8')).intents[0];
    assert.equal(disk.status, 'approving'); assert.equal(disk.approvalAttempted, true);
  } });
  const pending = await f.service.approve(approval(intent));
  assert.equal(pending.status, 'pending'); assert.equal(pending.transactionHash, FIXTURE_TX);
  assert.deepEqual(await f.service.approve(approval(intent)), pending);
  assert.deepEqual(await f.restart().approve(approval(intent)), pending);
  assert.equal(f.calls.filter(c => c.path.endsWith('/approve')).length, 1);
});

test('approval rejects tampered digest, changed quote, expiry and insufficient funding', async t => {
  const f = fixture(t, { allowApproval: true }); const intent = await makeQuote(f.service);
  await assert.rejects(f.service.approve({ ...approval(intent), approvalDigest: '0'.repeat(64) }), e => e.status === 409);
  f.setQuote(fundingQuote({ id: '3'.repeat(64) }));
  await assert.rejects(f.service.approve(approval(intent)), e => e.status === 409);
  f.setQuote(fundingQuote()); f.setStatus(fundingStatus({ phase: 'waiting_funds', amount: 1_000_000, eth_balance: '0' }));
  await assert.rejects(f.service.approve(approval(intent)), e => e.status === 409);
  f.setClock(FIXTURE_TIME + 30_000);
  await assert.rejects(f.service.approve(approval(intent)), e => e.status === 409);
  assert.equal(f.calls.filter(c => c.path.endsWith('/approve')).length, 0);
});

test('quote rejects chain, vault, units, fee arithmetic and amount substitution', async t => {
  const cases = [{ chain_id: 8453 }, { contract_address: `0x${'4'.repeat(40)}` }, { amount: 999999 },
    { principal_wei: '1000000' }, { fee_reserve_wei: '1' }, { required_total_wei: '1' }, { shortfall_wei: '1' },
    { deployment_id: 'different-deployment' }, { gas_limit: Number.MAX_SAFE_INTEGER + 1 }, { principal_wei: '1e15' }];
  for (const mutation of cases) {
    const f = fixture(t);
    f.intercept(call => call.path.endsWith('/quote') && call.method === 'POST' ? new Response(JSON.stringify(fundingQuote(mutation))) : undefined);
    await assert.rejects(makeQuote(f.service), e => e.status === 502);
    assert.equal(f.service.snapshot().intents[0].status, 'quote_unknown');
    assert.equal(f.calls.some(c => c.path.endsWith('/approve')), false);
  }
});

test('mainnet control plane rejects wrong network before any funding route', async t => {
  const f = fixture(t);
  f.intercept(call => call.path === '/admin/status' ? new Response(JSON.stringify({ backend: 'zkapi', network: 'sepolia', request_budget_policy: 'model' })) : undefined);
  await assert.rejects(makeQuote(f.service), e => e.status === 502);
  assert.equal(f.calls.some(c => c.path.startsWith('/admin/funding')), false);
});

test('lost quote response can recover a matching unsigned quote without approval', async t => {
  const f = fixture(t);
  f.intercept(call => { if (call.path.endsWith('/quote') && call.method === 'POST') {
    f.setQuote(fundingQuote()); f.setStatus(fundingStatus({ phase: 'waiting_funds', amount: 1_000_000 })); throw new Error('synthetic private transport detail');
  } });
  await assert.rejects(makeQuote(f.service), e => !e.message.includes('private transport'));
  const id = f.service.snapshot().intents[0].id;
  const recovered = await f.restart().recover(id);
  assert.equal(recovered.status, 'quoted'); assert.equal(recovered.quote.id, '1'.repeat(64));
  assert.equal(f.calls.some(c => c.path.endsWith('/approve')), false);
});

test('lost approval remains uncertain across restart and never adopts a same-amount transaction', async t => {
  const f = fixture(t, { allowApproval: true }); const intent = await makeQuote(f.service);
  f.intercept(call => { if (call.path.endsWith('/approve')) {
    f.setStatus(fundingStatus({ phase: 'active', amount: 1_000_000, transaction_hash: FIXTURE_TX })); throw new Error('lost approved response');
  } });
  await assert.rejects(f.service.approve(approval(intent)), e => e.status === 502);
  assert.equal(f.service.snapshot().intents[0].status, 'approval_unknown');
  const restarted = f.restart();
  const recovered = await restarted.recover(intent.id);
  assert.equal(recovered.status, 'recovery_required'); assert.equal(recovered.transactionHash, undefined);
  assert.equal(recovered.observed.transactionHash, FIXTURE_TX);
  await restarted.approve(approval(intent));
  await assert.rejects(restarted.refresh(intent.id), e => e.status === 409);
  await assert.rejects(restarted.resume({ intentId: intent.id, transactionHash: FIXTURE_TX }), e => e.status === 409);
  assert.equal(f.calls.filter(c => c.path.endsWith('/approve')).length, 1);
  assert.equal(f.calls.some(c => c.path.endsWith('/deposit')), false);
});

test('explicit recovery replays only the exact known transaction and read-only refresh never posts', async t => {
  const f = fixture(t, { allowApproval: true }); const intent = await makeQuote(f.service);
  await f.service.approve(approval(intent));
  const before = f.calls.filter(c => c.method === 'POST').length;
  assert.equal((await f.service.recover(intent.id)).status, 'pending');
  assert.equal(f.calls.filter(c => c.method === 'POST').length, before);
  await assert.rejects(f.service.resume({ intentId: intent.id, transactionHash: `0x${'b'.repeat(64)}` }), e => e.status === 409);
  const active = await f.service.resume({ intentId: intent.id, transactionHash: FIXTURE_TX });
  assert.equal(active.status, 'active');
  assert.equal(f.calls.filter(c => c.path.endsWith('/deposit')).length, 1);
  assert.equal(f.calls.filter(c => c.path.endsWith('/approve')).length, 1);
});

test('funding response errors are sanitized and oversized responses rejected', async t => {
  for (const response of [new Response('private daemon details', { status: 502 }), new Response('x'.repeat(131_073)), new Response('{broken')]) {
    const f = fixture(t); f.intercept(call => call.path.endsWith('/address') ? response : undefined);
    await assert.rejects(f.service.inspect(), e => e.status === 502 && !e.message.includes('private daemon details'));
  }
});

test('persistence failure blocks funding before any quote, approval or network access', async t => {
  const f = fixture(t); mkdirSync(f.file);
  await assert.rejects(makeQuote(f.service), e => e.status === 503);
  assert.equal(f.calls.length, 0); assert.equal(f.service.snapshot().persistence, 'blocked');
  await assert.rejects(f.service.inspect(), e => e.status === 503);
});

test('journal corruption and changed daemon origin fail closed', async t => {
  const f = fixture(t); const intent = await makeQuote(f.service);
  const saved = JSON.parse(readFileSync(f.file, 'utf8')); saved.intents[0].quote.amount = 2;
  writeFileSync(f.file, JSON.stringify(saved)); assert.throws(() => f.restart(), e => e.status === 503);
  saved.intents[0].quote.amount = intent.quote.amount; writeFileSync(f.file, JSON.stringify(saved));
  assert.throws(() => new ZkApiFunding({ ...f.config, base: 'http://127.0.0.1:9999' }), e => e.status === 503);
});

test('simultaneous funding operations cannot race a saved quote', async t => {
  const f = fixture(t); let release; const gate = new Promise(resolve => { release = resolve; });
  f.intercept(async call => { if (call.path === '/healthz') await gate; });
  const first = makeQuote(f.service);
  await assert.rejects(f.service.inspect(), e => e.status === 409);
  release(); assert.equal((await first).status, 'quoted');
});

test('separate processes cannot race or overwrite a newer funding journal', async t => {
  const f = fixture(t); const stale = f.restart(); let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.intercept(async call => { if (call.path === '/healthz') await gate; });
  const pending = makeQuote(f.service);
  await assert.rejects(stale.inspect(), e => e.status === 409 && /locked/.test(e.message));
  release(); await pending;
  const count = f.calls.length;
  await assert.rejects(stale.inspect(), e => e.status === 503 && /another process/.test(e.message));
  assert.equal(f.calls.length, count); assert.equal(stale.snapshot().persistence, 'blocked');
});

test('crash states and unexpected journal fields cannot become an approval', async t => {
  const f = fixture(t, { allowApproval: true }); await makeQuote(f.service);
  const saved = JSON.parse(readFileSync(f.file, 'utf8'));
  saved.intents[0].status = 'approving'; saved.intents[0].approvalAttempted = true;
  writeFileSync(f.file, JSON.stringify(saved));
  assert.equal(f.restart().snapshot().intents[0].status, 'approval_unknown');
  saved.intents[0].private_key = 'must-not-be-accepted'; writeFileSync(f.file, JSON.stringify(saved));
  assert.throws(() => f.restart(), e => e.status === 503);
});

test('expired quotes need explicit refresh and a newly reviewed digest', async t => {
  const f = fixture(t, { allowApproval: true }); const intent = await makeQuote(f.service);
  f.setClock(FIXTURE_TIME + 30_000);
  const expired = await makeQuote(f.service); assert.equal(expired.quoteExpired, true);
  const refreshed = await f.service.refresh(intent.id);
  assert.equal(refreshed.quoteExpired, false); assert.notEqual(refreshed.approvalDigest, intent.approvalDigest);
  await assert.rejects(f.service.approve(approval(intent)), e => e.status === 409);
  assert.equal((await f.service.approve(approval(refreshed))).status, 'pending');
});

test('environment adapter accepts only explicit server approval enablement', t => {
  const f = fixture(t);
  const env = { ZKAPI_LOCAL_KEY: FIXTURE_KEY, ZKAPI_MANAGEMENT_TOKEN: FIXTURE_MANAGEMENT, VEYL_ENABLE_ZKAPI_APPROVAL: 'true' };
  assert.equal(fundingFromEnv({ ...f.config, env }).capabilities().approvalEnabled, true);
  assert.equal(fundingFromEnv({ ...f.config, env: { ...env, VEYL_ENABLE_ZKAPI_APPROVAL: '1' } }).capabilities().approvalEnabled, false);
});
