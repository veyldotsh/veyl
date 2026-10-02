import { readFileSync } from 'node:fs';
import { getAddress, isAddress, zeroAddress, keccak256, encodeAbiParameters, getContractAddress, formatEther } from 'viem';
import { MainnetMarkets, ETHEREUM_POOL_MANAGER, VEYL_MAIN_TOKEN_SALT } from './mainnet.mjs';
import { Problem } from './agent.mjs';

export const PLATFORM_MARKET_ID = 'platform-veyl-mainnet';
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => /^0x[0-9a-f]{64}$/i.test(value || '');
const address = value => isAddress(value || '') && !same(value, zeroAddress);
const fields = { token: 'AgentToken', treasury: 'AgentTreasury', revenueRouter: 'RevenueRouter', hook: 'VeylFeeHook', swapRouter: 'VeylSwapRouter', liquidityVault: 'VeylMainLiquidityPosition' };
const helpers = { factory: 'VeylMarketFactory', quoter: 'VeylQuoter', projectBuilder: 'VeylProjectBuilder', marketBuilder: 'VeylMarketBuilder', liquidityBuilder: 'VeylMainLiquidityBuilder', projectDeployer: 'VeylProjectDeployer', marketDeployer: 'VeylMarketDeployer', liquidityDeployer: 'VeylMainLiquidityDeployer' };
const actions = new Set(['flush', 'distribute', 'fund', 'recipient', 'daily-limit', 'operator']);
const intentKinds = new Set(['buy', 'sell', 'approve', ...actions]);
const ledgerFields = ['mainnetQuotes', 'mainnetIntents', 'mainnetTrades'];
const serialize = value => JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item));
const fail = () => { throw new Problem('The public VEYL deployment record is unavailable or differs from the configured platform.', 503); };

/** A canonical public market with separate wallet-owned transaction ledgers.
 * It never reads an agent profile or creates a runtime. All transactions remain
 * exact unsigned intents for the caller's wallet. */
export class PlatformMarket {
  constructor({ mainnet, record, markets, now = Date.now } = {}) {
    this.mainnet = mainnet; this.record = record; this.now = now;
    this.cache = null; this.pending = null; this.template = null;
    this.markets = markets || null;
  }
  definition() {
    if (this.template) return this.template;
    const r = this.record, c = this.mainnet.config;
    if (!r || r.version !== 1 || r.chainId !== 1 || r.calculationOnly !== false || r.token?.deployed !== true || r.token.status !== 'deployed' ||
        !address(r.deployer) || !same(r.deployer, c.addresses?.deployer) || !same(r.creator, r.deployer) || !same(r.protocolRecipient, c.addresses?.protocolRecipient) ||
        !same(r.poolManager, ETHEREUM_POOL_MANAGER) || !same(r.quoteAsset, zeroAddress) || !same(r.token.launchSalt, VEYL_MAIN_TOKEN_SALT) || !hash(r.token.receipt?.transactionHash) ||
        c.project?.name !== 'Veyl' || c.project?.symbol !== 'VEYL' || c.trading?.liquidityCustody !== 'deployer-position-nft' || !Array.isArray(r.contracts)) fail();
    const contracts = new Map();
    for (const item of r.contracts) {
      if (contracts.has(item.contract) || !address(item.address) || !hash(item.runtimeCodeHash)) fail();
      contracts.set(item.contract, item);
    }
    const infrastructure = {}, mainnet = {};
    for (const [field, name] of Object.entries({ ...helpers, ...fields })) {
      const entry = contracts.get(name); if (!entry) fail();
      (field in helpers ? infrastructure : mainnet)[field] = getAddress(entry.address);
    }
    const id = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [r.creator, VEYL_MAIN_TOKEN_SALT]));
    if (!same(id, r.token.marketId) || !same(mainnet.token, r.token.address) || !same(infrastructure.factory, getContractAddress({ from: r.deployer, nonce: 4n })) ||
        (c.agentMarkets?.quoteAsset && !same(mainnet.token, c.agentMarkets.quoteAsset)) || (c.agentMarkets?.mainMarketFactory && !same(infrastructure.factory, c.agentMarkets.mainMarketFactory)) ||
        (c.agentMarkets?.conversionSwapRouter && !same(mainnet.swapRouter, c.agentMarkets.conversionSwapRouter))) fail();
    Object.assign(mainnet, { id, factory: infrastructure.factory, creator: getAddress(r.creator), treasuryOwner: getAddress(r.creator), quoteAsset: zeroAddress, hash: r.token.receipt.transactionHash, chainId: 1, type: 'ethereum-mainnet' });
    if (!this.markets) this.markets = new MainnetMarkets({ config: { ...c, deployments: { ...c.deployments, marketFactory: infrastructure.factory,
      codeHashes: { ...c.deployments?.codeHashes, ...Object.fromEntries([...contracts.values()].map(item => [item.address.toLowerCase(), item.runtimeCodeHash])) } } }, client: this.mainnet.client, now: this.mainnet.now, confirmations: this.mainnet.confirmations });
    this.template = { id: PLATFORM_MARKET_ID, name: 'Veyl', symbol: 'VEYL', mainnetInfrastructure: infrastructure, mainnetPlan: { config: { launchProtection: true } }, mainnet };
    return this.template;
  }
  async project() {
    const project = structuredClone(this.definition());
    // Only the fixed configured factory and market ID can be queried. The pool
    // ID is recovered from that immutable factory record, never browser input.
    const actual = await this.markets.read(project.mainnet.factory, 'VeylMarketFactory', 'getMarket', [project.mainnet.id]);
    for (const field of [...Object.keys(fields), 'creator', 'treasuryOwner', 'quoteAsset']) if (!same(project.mainnet[field], actual[field])) fail();
    if (!hash(actual.poolId)) fail();
    project.mainnet.poolId = actual.poolId;
    return project;
  }
  capabilities() {
    const project = this.definition();
    return { ...this.markets.capabilities(project), canPrepareInfrastructure: false, canPrepareLaunch: false, platformMarket: true };
  }
  ledger(kit, account, project, create = false) {
    const saved = kit.store.data.platformMarket;
    if (saved === undefined) {
      const fresh = { version: 1, owner: getAddress(account), marketId: project.mainnet.id, mainnetQuotes: [], mainnetIntents: [], mainnetTrades: [] };
      if (create) { kit.store.data.platformMarket = fresh; kit.store.save(); }
      return fresh;
    }
    if (!object(saved) || saved.version !== 1 || !same(saved.owner, account) || !same(saved.marketId, project.mainnet.id) ||
        Object.keys(saved).some(key => !['version', 'owner', 'marketId', ...ledgerFields].includes(key)) || ledgerFields.some(key => !Array.isArray(saved[key]) || saved[key].length > 1000) ||
        saved.mainnetQuotes.some(item => !object(item) || !same(item.account, account) || !same(item.poolId, project.mainnet.poolId)) ||
        saved.mainnetIntents.some(item => !object(item) || !intentKinds.has(item.kind) || !same(item.account, account) || !same(item.transaction?.from, account)) ||
        saved.mainnetTrades.some(item => !object(item) || !same(item.account, account))) throw new Problem('Platform transaction records are inconsistent. Preserve them for recovery.', 503);
    return saved;
  }
  async status(kit, account) {
    const project = await this.project(), ledger = this.ledger(kit, account, project);
    for (const field of ledgerFields) project[field] = structuredClone(ledger[field]);
    return this.markets.status(project, account);
  }
  async execute(kit, account, method, input, transactionsEnabled) {
    if (!['quote', 'swap', 'maintenance', 'verify'].includes(method)) throw new Problem('Platform market operation not found.', 404);
    if (!transactionsEnabled && method !== 'verify') throw new Problem('Wallet transaction preparation is disabled by the worker.', 403);
    if (method === 'maintenance' && !actions.has(input.action)) throw new Problem('Unsupported platform maintenance action.', 400);
    kit.store.assertHealthy();
    if (kit.operations.has(PLATFORM_MARKET_ID)) throw new Problem('Another platform market operation is running.', 409);
    kit.operations.add(PLATFORM_MARKET_ID);
    try {
      const project = await this.project(), ledger = this.ledger(kit, account, project, true);
      if (method !== 'verify') {
        kit.store.assertCapacity(16384);
        if (ledgerFields.some(field => ledger[field].length >= 1000)) throw new Problem('Platform transaction history is full. Existing records remain available for confirmation.', 507);
      }
      for (const field of ledgerFields) project[field] = structuredClone(ledger[field]);
      if (method === 'verify') {
        const intent = project.mainnetIntents.find(item => item.id === input.intentId);
        if (!intent || !same(intent.account, account) || !same(intent.transaction?.from, account)) throw new Problem('Platform intent not found for this wallet.', 404);
      }
      const checkpoint = () => { for (const field of ledgerFields) ledger[field] = project[field] || []; kit.store.save(); };
      const call = { quote: 'quote', swap: 'prepareSwap', maintenance: 'prepareMaintenance', verify: 'verify' }[method];
      return await this.markets[call](project, { ...input, account: getAddress(account) }, checkpoint);
    } finally { kit.operations.delete(PLATFORM_MARKET_ID); }
  }
  async publicSnapshot(transactionsEnabled = false) {
    if (this.cache && this.now() - this.cache.at < 15000) return { ...structuredClone(this.cache.value), transactionsEnabled };
    if (!this.pending) this.pending = (async () => {
      const project = await this.project(), status = await this.markets.status(project, null), market = status.market;
      const [blockNumber, routerBalance] = await Promise.all([this.markets.client.getBlockNumber({ cacheTime: 0 }), this.markets.client.getBalance({ address: market.revenueRouter })]);
      const value = { chainId: 1, launched: true, name: 'Veyl', symbol: 'VEYL', quoteSymbol: 'ETH', checkedAt: new Date(this.now()).toISOString(), blockNumber: String(blockNumber),
        ...Object.fromEntries(['token', 'factory', 'poolId', 'hook', 'revenueRouter', 'treasury', 'swapRouter', 'creator', 'protocol'].map(field => [field, market[field]])),
        pendingFeesEth: status.pendingFees, routerBalanceEth: formatEther(routerBalance), treasuryBalanceEth: status.treasuryBalance,
        claims: status.claims.map(claim => ({ address: claim.address, amountEth: claim.amountEth, roles: ['treasury', 'creator', 'protocol'].filter(role => same(market[role], claim.address)) })),
        buyFeeBps: status.buyFeeBps, sellFeeBps: status.sellFeeBps, lpFeePips: status.lpFeePips, collection: { automatic: false }, position: status.position,
        liquidityCustody: status.liquidityCustody, sqrtPriceX96: status.sqrtPriceX96, tick: status.tick, liquidity: status.liquidity, priceQuote: status.priceQuote, launchLimits: status.launchLimits };
      this.cache = { at: this.now(), value: serialize(value) }; return this.cache.value;
    })().finally(() => { this.pending = null; });
    return { ...structuredClone(await this.pending), transactionsEnabled };
  }
}

export function configuredPlatformMarket(mainnet) {
  let record;
  try { record = JSON.parse(readFileSync(new URL('../config/public-addresses.json', import.meta.url), 'utf8')); } catch { /* Fail closed when requested, without preventing unrelated agent recovery. */ }
  return new PlatformMarket({ mainnet, record });
}
