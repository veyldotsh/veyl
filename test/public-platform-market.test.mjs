import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { getAddress, parseEther, zeroAddress } from 'viem';
import { MainnetMarkets } from '../src/mainnet.mjs';
import { PlatformMarket, PLATFORM_MARKET_ID } from '../src/platform-market.mjs';
import { TenantRegistry, createProductionApp } from '../src/production.mjs';
import { WalletAuth, sessionCookie } from '../src/auth.mjs';
import { GatewayVerifier, signGateway } from '../src/gateway-auth.mjs';

const config = JSON.parse(readFileSync(new URL('../config/mainnet.json', import.meta.url))), record = JSON.parse(readFileSync(new URL('../config/public-addresses.json', import.meta.url)));
const hash = n => '0x' + String(n).repeat(64), address = n => '0x' + String(n).repeat(40);
function fixture({ recordOverride = record, configOverride = config } = {}) {
  let now = 1_800_000_000_000, reads = 0, statusReads = 0, verifyCalls = 0, seenProject;
  const contracts = Object.fromEntries(record.contracts.map(item => [item.contract, item.address]));
  const market = { id: record.token.marketId, token: contracts.AgentToken, treasury: contracts.AgentTreasury, revenueRouter: contracts.RevenueRouter, hook: contracts.VeylFeeHook,
    swapRouter: contracts.VeylSwapRouter, liquidityVault: contracts.VeylMainLiquidityPosition, factory: contracts.VeylMarketFactory, quoter: contracts.VeylQuoter,
    creator: record.creator, protocol: record.protocolRecipient, treasuryOwner: record.creator, quoteAsset: zeroAddress, quoteKind: 'native', quoteSymbol: 'ETH',
    poolId: hash(1), tokenIsCurrency0: false, launchProtection: false, revenueRouterType: 'RevenueRouter' };
  const client = { getBlockNumber: async () => 26105000n, getBalance: async () => parseEther('0.2'), getBlock: async () => ({ timestamp: BigInt(Math.floor(now / 1000)) }),
    estimateGas: async () => 90000n, simulateContract: async () => ({ result: { amountIn: parseEther('0.01'), amountOut: parseEther('10'), hookFee: parseEther('0.00018') } }) };
  const mainnet = new MainnetMarkets({ config: configOverride, client, now: () => now }), markets = new MainnetMarkets({ config: configOverride, client, now: () => now });
  markets.read = async (_target, _name, method) => { reads++; if (method === 'getMarket') return market; if (method === 'owner') return record.creator; if (method === 'pendingFees') return 1n; throw new Error('Unexpected contract read ' + method); };
  markets.validateMarket = async project => { seenProject = project; assert.equal(project.mainnet.factory, contracts.VeylMarketFactory); assert.equal(project.mainnet.token, contracts.AgentToken); return market; };
  markets.status = async (project, account) => { statusReads++; return { configured: true, launched: true, market, account, intents: project.mainnetIntents || [], trades: project.mainnetTrades || [],
    pendingFees: '0.01', treasuryBalance: '0.3', claims: [{ address: record.creator, amountEth: '0.04' }, { address: market.treasury, amountEth: '0.06' }],
    buyFeeBps: 180, sellFeeBps: 180, lpFeePips: 0, position: { owner: '0x000000000000000000000000000000000000dEaD', sentToDead: true, currentLiquidity: '100', positionId: '429089' },
    liquidityCustody: 'deployer-position-nft', sqrtPriceX96: '100', tick: 1, liquidity: '100', priceQuote: 0.0001, launchLimits: { enabled: true, active: false }, privateSentinel: 'never public' }; };
  markets.verify = async (project, input, checkpoint) => { verifyCalls++; const intent = project.mainnetIntents.find(item => item.id === input.intentId); intent.status = 'confirmed'; intent.transactionHash = input.transactionHash; checkpoint(); return intent; };
  const platform = new PlatformMarket({ mainnet, markets, record: recordOverride, now: () => now });
  return { platform, mainnet, markets, market, advance: n => { now += n; }, counts: () => ({ reads, statusReads, verifyCalls }), seen: () => seenProject };
}
async function server(t, options = {}) {
  const f = fixture(options), directory = mkdtempSync(join(tmpdir(), 'veyl-public-market-')), key = randomBytes(32), origin = 'https://veyl.sh', gatewayKey = 'ab'.repeat(32);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const auth = new WalletAuth({ origin, state: { version: 1, challenges: [], sessions: [] }, save() {} }), accounts = [privateKeyToAccount(generatePrivateKey()), privateKeyToAccount(generatePrivateKey())], sessions = [];
  for (const account of accounts) { const challenge = auth.challenge({ address: account.address, chainId: 1 }); sessions.push(await auth.authenticate({ id: challenge.id, signature: await account.signMessage({ message: challenge.message }) })); }
  const registry = new TenantRegistry({ directory, key, mainnet: f.mainnet });
  const app = createProductionApp({ auth, registry, gateway: new GatewayVerifier({ key: gatewayKey }), origin, mainnet: f.mainnet, platformMarket: f.platform, transactionsEnabled: options.transactionsEnabled !== false });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => app.close(resolve)));
  async function request(path, { who, body, csrf, bearer } = {}) {
    const method = body === undefined ? 'GET' : 'POST', bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    const headers = { ...(who === undefined ? {} : { cookie: sessionCookie(sessions[who].token) }), ...(body === undefined ? {} : { origin, 'content-type': 'application/json', 'x-agent-csrf': csrf ?? sessions[who]?.csrf }), ...(bearer ? { authorization: bearer } : {}) };
    if (headers['x-agent-csrf'] === undefined) delete headers['x-agent-csrf'];
    Object.assign(headers, signGateway({ key: gatewayKey, method, path, headers, body: bytes }));
    const response = await fetch(`http://127.0.0.1:${app.address().port}${path}`, { method, headers, ...(body === undefined ? {} : { body: bytes }) });
    return { status: response.status, data: await response.json() };
  }
  return { ...f, registry, accounts, request, directory };
}

test('public market coalesces fixed reads, returns current custody and no wallet data or tenant', async t => {
  const f = await server(t), responses = await Promise.all(Array.from({ length: 8 }, () => f.request('/api/market')));
  assert.ok(responses.every(item => item.status === 200)); assert.equal(f.counts().statusReads, 1); assert.equal(f.registry.owners.size, 0);
  const value = responses[0].data; assert.equal(value.token, record.token.address); assert.equal(value.routerBalanceEth, '0.2'); assert.equal(value.pendingFeesEth, '0.01');
  assert.deepEqual(value.claims[0].roles, ['creator', 'protocol']); assert.equal(value.position.sentToDead, true); assert.equal(value.blockNumber, '26105000');
  for (const name of ['account', 'intents', 'trades', 'quotes', 'projects', 'market', 'privateSentinel']) assert.equal(Object.hasOwn(value, name), false);
  assert.equal((await f.request('/api/market?address=' + address(8))).status, 400); assert.equal(f.counts().statusReads, 1);
  f.advance(15001); assert.equal((await f.request('/api/market')).status, 200); assert.equal(f.counts().statusReads, 2);
});

test('any authenticated wallet can quote and prepare its own canonical swap without an agent profile', async t => {
  const f = await server(t);
  assert.equal((await f.request('/api/platform-market/status')).status, 401);
  const caps = await f.request('/api/platform-market/capabilities', { who: 0 }); assert.equal(caps.status, 200); assert.equal(caps.data.canPrepareLaunch, false); assert.equal(caps.data.canPrepareInfrastructure, false);
  assert.equal((await f.request('/api/platform-market/quote', { who: 0, csrf: 'wrong', body: { side: 'buy', amount: '0.01' } })).status, 403);
  const quoted = await f.request('/api/platform-market/quote', { who: 0, body: { side: 'buy', amount: '0.01', account: f.accounts[1].address, factory: address(8), hook: address(9) } });
  assert.equal(quoted.status, 200); assert.equal(quoted.data.account, f.accounts[0].address); assert.equal(f.seen().mainnet.factory, f.market.factory);
  const wrong = await f.request('/api/platform-market/swap', { who: 1, body: { quoteId: quoted.data.id } }); assert.equal(wrong.status, 409);
  const swap = await f.request('/api/platform-market/swap', { who: 0, body: { quoteId: quoted.data.id, account: f.accounts[1].address } });
  assert.equal(swap.status, 200); assert.equal(swap.data.transaction.from, f.accounts[0].address); assert.equal(swap.data.transaction.to, f.market.swapRouter); assert.equal(swap.data.transaction.value, '0x2386f26fc10000');
  assert.equal(f.registry.get(f.accounts[0].address).store.data.projects.length, 0); assert.equal(f.registry.configuration.data.projects.length, 0);
  const state = await f.request('/api/state', { who: 0 }); assert.equal(state.data.projects.length, 0); assert.equal(Object.hasOwn(state.data, 'platformMarket'), false);
});

test('platform recovery is caller-bound, durable, isolated and never imports launch intents', async t => {
  const f = await server(t), quote = await f.request('/api/platform-market/quote', { who: 0, body: { side: 'buy', amount: '0.01' } }), swap = await f.request('/api/platform-market/swap', { who: 0, body: { quoteId: quote.data.id } });
  assert.equal((await f.request('/api/platform-market/verify', { who: 1, body: { intentId: swap.data.id, transactionHash: hash(5) } })).status, 404); assert.equal(f.counts().verifyCalls, 0);
  f.registry.kits.delete(f.accounts[0].address.toLowerCase());
  const before = await f.request('/api/platform-market/status', { who: 0 }); assert.equal(before.data.intents[0].id, swap.data.id);
  assert.equal((await f.request('/api/platform-market/verify', { who: 0, body: { intentId: swap.data.id, transactionHash: hash(5), account: f.accounts[1].address } })).status, 200);
  assert.equal((await f.request('/api/platform-market/status', { who: 1 })).data.intents.length, 0);
  assert.equal((await f.request('/api/market')).data.intents, undefined);
  for (const action of ['launch', 'factory', 'adopt', 'funding', 'recover', 'configure']) assert.equal((await f.request('/api/platform-market/' + action, { who: 0, body: {} })).status, 404);
  const raw = readFileSync(join(f.directory, f.accounts[0].address.toLowerCase(), 'kit.sealed.json'), 'utf8'); assert.equal(raw.includes(swap.data.id), false);
});

test('platform maintenance preserves real onchain ownership and fixed beneficiary checks', async t => {
  const f = await server(t);
  for (const action of ['operator', 'recipient', 'daily-limit']) {
    const result = await f.request('/api/platform-market/maintenance', { who: 0, body: { action, account: record.creator, operator: address(3), recipient: address(4), amount: '1', allowed: true } });
    assert.equal(result.status, 403);
  }
  assert.equal((await f.request('/api/platform-market/maintenance', { who: 0, body: { action: 'distribute', beneficiary: f.accounts[0].address } })).status, 400);
  const valid = await f.request('/api/platform-market/maintenance', { who: 0, body: { action: 'distribute', beneficiary: f.market.creator } }); assert.equal(valid.status, 200); assert.equal(valid.data.transaction.to, f.market.revenueRouter);
  assert.equal((await f.request('/api/platform-market/maintenance', { who: 0, body: { action: 'configure-conversion' } })).status, 400);
});

test('disabled preparation and corrupt cross-wallet history fail closed without losing records', async t => {
  const f = await server(t, { transactionsEnabled: false });
  assert.equal((await f.request('/api/platform-market/quote', { who: 0, body: { side: 'buy', amount: '0.01' } })).status, 403);
  const kit = f.registry.get(f.accounts[0].address), project = await f.platform.project(), ledger = f.platform.ledger(kit, f.accounts[0].address, project, true);
  ledger.mainnetIntents.push({ id: randomUUID(), kind: 'buy', account: f.accounts[1].address, transaction: { from: f.accounts[1].address } }); kit.store.save();
  const original = JSON.stringify(ledger);
  assert.equal((await f.request('/api/platform-market/status', { who: 0 })).status, 503); assert.equal(JSON.stringify(ledger), original);
  kit.operations.add(PLATFORM_MARKET_ID); await assert.rejects(f.platform.execute(kit, f.accounts[0].address, 'verify', {}, true), /operation is running/);
});

test('platform definition rejects predictions, changed identities and pins every runtime hash', async () => {
  for (const change of [r => { r.token.deployed = false; }, r => { r.chainId = 8453; }, r => { r.token.marketId = hash(3); }, r => { r.creator = address(4); }, r => { r.contracts[0].runtimeCodeHash = '0x'; }, r => { r.contracts.push(r.contracts[0]); }]) {
    const changed = structuredClone(record); change(changed); assert.throws(() => fixture({ recordOverride: changed }).platform.definition(), /deployment record/);
  }
  const service = new PlatformMarket({ mainnet: new MainnetMarkets({ config, client: {} }), record }); service.definition();
  for (const entry of record.contracts) assert.equal(service.markets.config.deployments.codeHashes[entry.address.toLowerCase()], entry.runtimeCodeHash);
  const wrong = structuredClone(config); wrong.agentMarkets.conversionSwapRouter = address(9); assert.throws(() => fixture({ configOverride: wrong }).platform.definition(), /deployment record/);
});

test('public market limits the gateway client even when its shared snapshot is cached', async t => {
  const f = await server(t);
  for (let count = 0; count < 180; count++) assert.equal((await f.request('/api/market')).status, 200);
  assert.equal((await f.request('/api/market')).status, 429); assert.equal(f.counts().statusReads, 1); assert.equal(f.registry.owners.size, 0);
});
