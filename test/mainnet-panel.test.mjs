import test from 'node:test';
import assert from 'node:assert/strict';
import { mountMainnetPanel } from '../public/mainnet-panel.js';

const owner = '0x1111111111111111111111111111111111111111', operator = '0x2222222222222222222222222222222222222222', recipient = '0x3333333333333333333333333333333333333333', treasury = '0x4444444444444444444444444444444444444444';
class Element {
  innerHTML = ''; handlers = new Map();
  addEventListener(name, fn) { this.handlers.set(name, fn); }
  removeEventListener(name, fn) { if (this.handlers.get(name) === fn) this.handlers.delete(name); }
  contains(node) { return node?.owned !== false; }
  querySelector() { return null; }
  fire(name, target) { return this.handlers.get(name)?.({ target, preventDefault() {} }); }
}
function form(values) { const node = { values, dataset: { mainnetForm: 'treasury-policy' }, closest: selector => selector === '[data-mainnet-form]' ? node : null }; return node; }
function control(action) { const node = { dataset: { mainnet: action }, disabled: false, closest: selector => selector === '[data-mainnet]' ? node : null }; return node; }
function field(name, value) { const parent = form({}), node = { name, value, closest: selector => selector === '[data-mainnet-form="treasury-policy"]' ? parent : null }; return node; }
async function fixture(t, { account = owner, chainId = 1, transactionsEnabled = false } = {}) {
  t.mock.method(globalThis, 'FormData', function (form) { return new Map(Object.entries(form.values)); });
  const project = { id: 'agent-settings', name: 'Research <agent>', symbol: 'RES' }, element = new Element(), client = new EventTarget(), requests = [], sent = [];
  const state = { launched: true, market: { treasury }, owner, operator, dailyLimit: '0.02', claims: [], intents: [] };
  client.wallet = { account, chainId, state() { return { connected: !!this.account, account: this.account, ethereum: this.chainId === 1, chainId: this.chainId }; } };
  client.status = async () => state; client.capabilities = async () => ({ transactionsEnabled }); client.pending = () => []; client.explorer = () => null;
  client.prepare = async (projectId, action, input) => {
    requests.push({ projectId, action, input });
    return { id: 'intent-' + requests.length, kind: input.action, status: 'prepared', account: owner, chainId: 1, expiresAt: Date.now() + 60000, transaction: { from: owner, to: treasury, value: '0x0', data: '0x1234', chainId: '0x1' }, amountEth: input.amount, operator: input.operator, recipient: input.recipient, allowed: input.allowed };
  };
  client.execute = async (projectId, intent) => { sent.push({ projectId, intent }); return { status: 'confirmed' }; };
  const panel = mountMainnetPanel(element, { project, client, capabilities: { transactionsEnabled } }); t.after(() => panel.destroy()); await panel.refresh();
  return { panel, element, client, requests, sent, state, project };
}

test('treasury controls are owner-only and require Ethereum before preparation', async t => {
  const f = await fixture(t, { account: recipient });
  assert.doesNotMatch(f.element.innerHTML, /data-mainnet-form="treasury-policy"/);
  await f.element.fire('submit', form({ action: 'daily-limit', amount: '0' })); assert.equal(f.requests.length, 0);
  f.client.wallet.account = owner; f.client.wallet.chainId = 8453; f.client.dispatchEvent(new Event('change'));
  assert.match(f.element.innerHTML, /Owner treasury settings/); assert.match(f.element.innerHTML, /disabled>Review treasury change/);
  await f.element.fire('submit', form({ action: 'operator', operator })); assert.equal(f.requests.length, 0);
  f.client.wallet.chainId = 1; f.client.dispatchEvent(new Event('change'));
  assert.match(f.element.innerHTML, /Research &lt;agent&gt; and its operating treasury/);
  await f.element.fire('submit', form({ action: 'daily-limit', amount: '0' })); assert.equal(f.requests.length, 1);
});

test('each owner setting prepares only its exact project maintenance action and reviews the new values', async t => {
  const f = await fixture(t);
  for (const input of [{ action: 'daily-limit', amount: '0' }, { action: 'operator', operator: recipient }, { action: 'recipient', recipient, allowed: 'true' }, { action: 'recipient', recipient, allowed: 'false' }]) {
    await f.element.fire('submit', form({ ...input, account: recipient, arbitrary: 'ignored' }));
    assert.deepEqual(f.requests.at(-1), { projectId: f.project.id, action: 'maintenance', input: { ...input, ...(input.action === 'recipient' ? { allowed: input.allowed === 'true' } : {}) } });
    assert.match(f.element.innerHTML, new RegExp('Review ' + input.action));
    if (input.action === 'daily-limit') assert.match(f.element.innerHTML, /New daily treasury limit<\/dt><dd>0 ETH/);
    if (input.action === 'operator') assert.match(f.element.innerHTML, /New operator/);
    if (input.action === 'recipient') assert.match(f.element.innerHTML, input.allowed === 'true' ? /Allow payments/ : /Revoke payments/);
  }
  assert.equal(f.sent.length, 0);
  await f.element.fire('click', control('send')); assert.equal(f.sent.length, 0); // Global send gate remains off even for synthetic clicks.
});

test('editing a setting retires its preview and requires a fresh review before sending', async t => {
  const f = await fixture(t, { transactionsEnabled: true });
  await f.element.fire('submit', form({ action: 'daily-limit', amount: '0.02' })); assert.match(f.element.innerHTML, /Review daily-limit/);
  f.element.fire('input', field('amount', '0.03'));
  assert.doesNotMatch(f.element.innerHTML, /Review daily-limit/); assert.match(f.element.innerHTML, /name="amount"[^>]*value="0.03"/);
  await f.element.fire('click', control('send')); assert.equal(f.sent.length, 0);
  await f.element.fire('submit', form({ action: 'daily-limit', amount: '0.03' }));
  f.client.dispatchEvent(new Event('change')); // A receipt/client notification with the same wallet must not invalidate a valid review.
  await f.element.fire('click', control('send'));
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].projectId, f.project.id); assert.equal(f.sent[0].intent.amountEth, '0.03');
});

test('recipient permission changes and wallet account or network changes invalidate previews', async t => {
  const f = await fixture(t, { transactionsEnabled: true });
  await f.element.fire('submit', form({ action: 'recipient', recipient, allowed: 'true' }));
  f.element.fire('change', field('allowed', 'false')); assert.doesNotMatch(f.element.innerHTML, /Review recipient/);
  await f.element.fire('submit', form({ action: 'recipient', recipient, allowed: 'false' }));
  f.client.wallet.chainId = 8453; f.client.dispatchEvent(new Event('change')); assert.doesNotMatch(f.element.innerHTML, /Review recipient/);
  f.client.wallet.chainId = 1; f.client.dispatchEvent(new Event('change'));
  await f.element.fire('submit', form({ action: 'operator', operator }));
  f.client.wallet.account = recipient; f.client.dispatchEvent(new Event('change')); assert.doesNotMatch(f.element.innerHTML, /Review operator|Owner treasury settings/);
  await f.element.fire('click', control('send')); assert.equal(f.sent.length, 0);
});

test('a delayed prepared intent cannot reappear after edit, wallet change or panel destruction', async t => {
  const f = await fixture(t, { transactionsEnabled: true }), original = f.client.prepare;
  for (const invalidate of [() => f.element.fire('input', field('amount', '0.04')), () => { f.client.wallet.chainId = 8453; f.client.dispatchEvent(new Event('change')); }, () => f.panel.destroy()]) {
    f.client.wallet.chainId = 1; f.client.dispatchEvent(new Event('change'));
    let resolve; f.client.prepare = async (...args) => { const value = await original(...args); return new Promise(done => { resolve = () => done(value); }); };
    const pending = f.element.fire('submit', form({ action: 'daily-limit', amount: '0.02' }));
    await new Promise(done => setImmediate(done)); invalidate(); resolve(); await pending;
    assert.doesNotMatch(f.element.innerHTML, /Review daily-limit/);
  }
  assert.equal(f.sent.length, 0); assert.equal(f.element.handlers.size, 0);
});

test('unsupported policy actions and malformed permission choices never reach preparation', async t => {
  const f = await fixture(t);
  for (const input of [{ action: 'withdraw', amount: '1' }, { action: 'recipient', recipient, allowed: 'maybe' }]) await f.element.fire('submit', form(input));
  assert.equal(f.requests.length, 0); assert.equal(f.sent.length, 0);
});

test('only the configured platform owner sees launch import, which sends just the receipt hash without a wallet transaction', async t => {
  const f = await fixture(t), transactionHash = '0x' + 'a'.repeat(64);
  f.state.launched = false;
  f.client.capabilities = async () => ({ liquidityCustody: 'deployer-position-nft', mainTokenLaunch: { recipient: owner }, transactionsEnabled: false });
  await f.panel.refresh(); assert.match(f.element.innerHTML, /VEYL platform token/); assert.match(f.element.innerHTML, /data-mainnet-form="adopt"/);
  const target = form({ transactionHash, account: recipient }); target.dataset.mainnetForm = 'adopt';
  f.client.prepare = async (projectId, action, input) => { f.requests.push({ projectId, action, input }); f.state.launched = true; return { token: recipient }; };
  await f.element.fire('submit', target);
  assert.deepEqual(f.requests, [{ projectId: f.project.id, action: 'adopt', input: { transactionHash } }]); assert.equal(f.sent.length, 0);
  assert.match(f.element.innerHTML, /Platform operating treasury/); assert.doesNotMatch(f.element.innerHTML, /data-mainnet-form="adopt"/);
  f.state.launched = false; f.client.wallet.account = recipient; f.client.dispatchEvent(new Event('change')); await f.panel.refresh();
  assert.doesNotMatch(f.element.innerHTML, /data-mainnet-form="adopt"/);
  await f.element.fire('submit', target); assert.equal(f.requests.length, 1);
});

const sharedPolicy = (ready = false) => ({ transactionsEnabled: false, quoteKind: 'veyl', quoteSymbol: 'VEYL', infrastructureMode: 'shared', configured: ready, canPrepareInfrastructure: false, canPrepareLaunch: ready, readiness: { status: ready ? 'ready' : 'infrastructure-unavailable', message: null } });
const launchValues = { liquidityQuote: '25', liquidityTokens: '500000000', tokensPerQuote: '20000000', treasuryEth: '0', treasuryOwner: owner, operator, dailyLimitEth: '0', tickLower: '-887200', tickUpper: '887200', slippageBps: '50' };
function launchForm(values = launchValues) { const target = form(values); target.dataset.mainnetForm = 'launch'; return target; }
const standardPolicy = (ready = true) => ({ ...sharedPolicy(ready), standardLaunch: { enabled: true, supply: '1000000000', targetFdvEth: '2', allocationBps: 10000, creatorAllocation: '0', quoteSeed: '0', optionalCreatorBuy: true } });
function launchField(name, value) { const parent = launchForm({}); return { name, value, closest: selector => selector === '[data-mainnet-form="launch"]' ? parent : null }; }
async function standardFixture(t, options = {}) {
  const f = await fixture(t, options); f.state.launched = false;
  f.client.capabilities = async () => ({ ...standardPolicy(), transactionsEnabled: !!options.transactionsEnabled });
  await f.panel.refresh(); await f.element.fire('click', control('open-launch'));
  const prepare = f.client.prepare;
  f.client.prepare = async (...args) => ({ ...await prepare(...args), kind: 'launch', marketVersion: 'standard-agent-v1',
    allocation: { liquidityQuote: '0', quoteSymbol: 'VEYL', liquidityTokens: '999999999.999999999999999999', lockedDustTokens: '0.000000000000000001', creatorTokens: '0', treasuryEth: '0', targetFdvEth: '2', startingFdvEth: '2.00001' },
    creatorBuy: { quoteAmount: args[2].devBuyQuote || '0', quoteSymbol: 'VEYL', expectedTokens: '1000', minimumTokens: '995', hookFeeQuote: '0.18' }
  });
  return f;
}

test('standard launch fixes the economics and offers only a paid creator buy and treasury settings', async t => {
  const f = await standardFixture(t);
  assert.match(f.element.innerHTML, /100% permanently locked liquidity/);
  assert.match(f.element.innerHTML, /Starting valuation target<\/dt><dd>2 ETH/);
  assert.match(f.element.innerHTML, /Initial VEYL deposit<\/dt><dd>0 VEYL/);
  assert.match(f.element.innerHTML, /name="devBuyQuote"[^>]*value="0"/);
  for (const name of ['operator', 'treasuryOwner']) assert.match(f.element.innerHTML, new RegExp(`name="${name}"[^>]*value="${owner}"`));
  for (const name of ['treasuryEth', 'dailyLimitEth']) assert.match(f.element.innerHTML, new RegExp(`name="${name}"[^>]*value="0"`));
  assert.doesNotMatch(f.element.innerHTML, /name="(?:liquidityQuote|liquidityTokens|tokensPerQuote|tickLower|tickUpper)"/);
  assert.doesNotMatch(f.element.innerHTML, /remaining supply goes to/);
});

test('standard launch submits only owner choices, never hidden economic or account overrides', async t => {
  const f = await standardFixture(t);
  await f.element.fire('submit', launchForm({ ...launchValues, devBuyQuote: '10', account: recipient, factory: treasury, arbitrary: 'ignored' }));
  assert.deepEqual(f.requests.at(-1).input, { devBuyQuote: '10', slippageBps: 50, treasuryOwner: owner, operator, treasuryEth: '0', dailyLimitEth: '0' });
  assert.match(f.element.innerHTML, /Creator allocation<\/dt><dd>0 RES/);
  assert.match(f.element.innerHTML, /Paid creator buy<\/dt><dd>10 VEYL/);
  assert.match(f.element.innerHTML, /Minimum purchased tokens<\/dt><dd>995 RES/);
  assert.match(f.element.innerHTML, /Locked rounding remainder<\/dt><dd>0\.000000000000000001 RES/);
  assert.match(f.element.innerHTML, /Rounded starting valuation<\/dt><dd>2\.00001 ETH/);
  assert.equal(f.sent.length, 0);
});

test('standard launch defaults to no purchase, zero treasury funding and connected owner permissions', async t => {
  const f = await standardFixture(t);
  await f.element.fire('submit', launchForm({}));
  assert.deepEqual(f.requests.at(-1).input, { devBuyQuote: '0', slippageBps: 50, treasuryOwner: owner, operator: owner, treasuryEth: '0', dailyLimitEth: '0' });
  f.client.wallet.chainId = 8453; f.client.dispatchEvent(new Event('change'));
  await f.element.fire('submit', launchForm({})); assert.equal(f.requests.length, 1);
});

test('editing a creator buy retires both approval and launch previews before another send', async t => {
  const f = await standardFixture(t, { transactionsEnabled: true }), prepare = f.client.prepare;
  for (const approval of [false, true]) {
    f.client.prepare = async (...args) => ({ ...await prepare(...args), ...(approval ? { kind: 'approve', purpose: 'launch-creator-buy' } : {}) });
    await f.element.fire('submit', launchForm({ devBuyQuote: '10' }));
    assert.match(f.element.innerHTML, /Paid creator buy/);
    f.element.fire('input', launchField('devBuyQuote', '20'));
    assert.doesNotMatch(f.element.innerHTML, /Paid creator buy/);
    assert.match(f.element.innerHTML, /name="devBuyQuote"[^>]*value="20"/);
    await f.element.fire('click', control('send')); assert.equal(f.sent.length, 0);
  }
});

test('a delayed standard preview cannot restore an edited amount or a previous wallet', async t => {
  const f = await standardFixture(t), prepare = f.client.prepare;
  for (const invalidate of [() => f.element.fire('input', launchField('devBuyQuote', '20')), () => { f.client.wallet.account = recipient; f.client.dispatchEvent(new Event('change')); }]) {
    let finish;
    f.client.prepare = async (...args) => { const intent = await prepare(...args); return new Promise(resolve => { finish = () => resolve(intent); }); };
    const pending = f.element.fire('submit', launchForm({ devBuyQuote: '10' }));
    await new Promise(resolve => setImmediate(resolve)); invalidate(); finish(); await pending;
    assert.doesNotMatch(f.element.innerHTML, /Paid creator buy/);
  }
});

test('an unavailable standard factory never falls back to custom launch terms or an old approval', async t => {
  const f = await standardFixture(t, { transactionsEnabled: true }), prepare = f.client.prepare;
  f.client.prepare = async (...args) => ({ ...await prepare(...args), kind: 'approve', purpose: 'launch-creator-buy' });
  await f.element.fire('submit', launchForm({ devBuyQuote: '10' }));
  f.client.capabilities = async () => ({ ...standardPolicy(false), transactionsEnabled: true });
  await f.panel.refresh();
  assert.doesNotMatch(f.element.innerHTML, /data-mainnet-form="launch"|Set launch terms|Paid creator buy/);
  await f.element.fire('click', control('send')); assert.equal(f.sent.length, 0);
  await f.element.fire('submit', launchForm()); assert.equal(f.requests.length, 1);
});

test('standard creator-buy approvals are also disabled when market availability disappears', async t => {
  const f = await standardFixture(t, { transactionsEnabled: true }), prepare = f.client.prepare;
  f.client.prepare = async (...args) => ({ ...await prepare(...args), kind: 'approve', purpose: 'launch-creator-buy' });
  await f.element.fire('submit', launchForm({ devBuyQuote: '10' }));
  f.client.capabilities = async () => ({ ...standardPolicy(false), transactionsEnabled: true });
  await f.panel.refresh(); await f.element.fire('click', control('send'));
  assert.equal(f.sent.length, 0);
});

test('refreshing expired launch terms is explicit, uses current choices and cannot bypass availability', async t => {
  const f = await standardFixture(t);
  f.element.fire('input', launchField('devBuyQuote', '25'));
  f.element.fire('change', launchField('slippageBps', '100'));
  assert.equal(f.requests.length, 0);
  await f.element.fire('click', control('reprice-launch'));
  assert.deepEqual(f.requests[0].input, { devBuyQuote: '25', slippageBps: 100, treasuryOwner: owner, operator: owner, treasuryEth: '0', dailyLimitEth: '0', reprice: true });
  f.client.capabilities = async () => standardPolicy(false); await f.panel.refresh();
  await f.element.fire('click', control('reprice-launch')); assert.equal(f.requests.length, 1);
});

test('missing shared setup shows a compact readiness state and never exposes infrastructure or raw status errors', async t => {
  const f = await fixture(t); f.state.launched = false;
  f.client.capabilities = async () => sharedPolicy();
  f.client.status = async () => { throw new Error('Enter a valid public reviewed main VEYL token address.'); };
  await f.panel.refresh();
  assert.match(f.element.innerHTML, /Agent market launch is not available yet/);
  assert.match(f.element.innerHTML, /continue configuring your agent/);
  assert.doesNotMatch(f.element.innerHTML, /Prepare infrastructure|Set launch terms|valid public reviewed|data-mainnet-form="launch"/);
  await f.element.fire('click', control('factory'));
  await f.element.fire('click', control('open-launch'));
  await f.element.fire('submit', launchForm());
  assert.equal(f.requests.length, 0);
  assert.equal(f.client.transactionsEnabled, false);
});

test('a configured but unavailable shared factory cannot expose launch terms', async t => {
  const f = await fixture(t); f.state.launched = false; f.state.configured = true;
  f.client.capabilities = async () => ({ ...sharedPolicy(), configured: true, canPrepareInfrastructure: true });
  await f.panel.refresh();
  assert.match(f.element.innerHTML, /Agent market launch is not available yet/);
  assert.doesNotMatch(f.element.innerHTML, /Prepare infrastructure|Set launch terms/);
  await f.element.fire('click', control('factory')); assert.equal(f.requests.length, 0);
});

test('shared readiness enables the agent launch form with VEYL inputs and no infrastructure setup', async t => {
  const f = await fixture(t); f.state.launched = false;
  f.client.capabilities = async () => sharedPolicy(true);
  await f.panel.refresh();
  assert.match(f.element.innerHTML, /Set launch terms/); assert.doesNotMatch(f.element.innerHTML, /Prepare infrastructure/);
  await f.element.fire('click', control('open-launch'));
  assert.match(f.element.innerHTML, /VEYL for liquidity/);
  await f.element.fire('submit', launchForm());
  assert.deepEqual(f.requests, [{ projectId: f.project.id, action: 'launch', input: { ...launchValues, tickLower: -887200, tickUpper: 887200, slippageBps: 50 } }]);
  assert.equal(f.sent.length, 0);
});

test('status failures preserve successful capabilities while capability failures close launch controls', async t => {
  const f = await fixture(t); f.state.launched = false;
  f.client.capabilities = async () => sharedPolicy(true);
  f.client.status = async () => { throw new Error('internal_rpc_error'); };
  await f.panel.refresh();
  assert.match(f.element.innerHTML, /Market status is temporarily unavailable/);
  assert.doesNotMatch(f.element.innerHTML, /internal_rpc_error|Prepare infrastructure|Set launch terms/);
  f.client.status = async () => f.state;
  f.client.capabilities = async () => { throw new Error('internal_config_error'); };
  await f.panel.refresh();
  assert.match(f.element.innerHTML, /Market availability could not be checked/);
  assert.doesNotMatch(f.element.innerHTML, /internal_config_error|Set launch terms/);
  f.client.capabilities = async () => sharedPolicy(true); await f.panel.refresh();
  assert.match(f.element.innerHTML, /Set launch terms/);
});

test('explicit per-project setup remains available and platform setup remains owner-only', async t => {
  const f = await fixture(t); f.state.launched = false;
  f.client.capabilities = async () => ({ infrastructureMode: 'per-project', canPrepareInfrastructure: true, canPrepareLaunch: false, infrastructureStep: 2, transactionsEnabled: false });
  await f.panel.refresh(); assert.match(f.element.innerHTML, /Prepare infrastructure · step 2 of 5/);
  f.client.capabilities = async () => ({ infrastructureMode: 'per-project', canPrepareInfrastructure: true, liquidityCustody: 'deployer-position-nft', mainTokenLaunch: { recipient: owner }, transactionsEnabled: false });
  await f.panel.refresh(); assert.match(f.element.innerHTML, /Prepare infrastructure/); assert.match(f.element.innerHTML, /Import confirmed VEYL/);
  f.client.wallet.account = recipient; f.client.dispatchEvent(new Event('change'));
  assert.doesNotMatch(f.element.innerHTML, /Prepare infrastructure|Import confirmed VEYL/);
  await f.element.fire('click', control('factory')); assert.equal(f.requests.length, 0);
});

test('a configuration change during launch preparation produces a useful refresh message without internal errors', async t => {
  const f = await fixture(t); f.state.launched = false;
  f.client.capabilities = async () => sharedPolicy(true); await f.panel.refresh();
  await f.element.fire('click', control('open-launch'));
  f.client.prepare = async () => { throw new Error('Enter a valid public reviewed main VEYL token address.'); };
  await f.element.fire('submit', launchForm());
  assert.match(f.element.innerHTML, /Market availability changed/);
  assert.doesNotMatch(f.element.innerHTML, /valid public reviewed|data-mainnet-form="launch"|Prepare infrastructure/);
});
