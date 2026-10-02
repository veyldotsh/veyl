import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient, decodeFunctionData, encodeAbiParameters, encodeDeployData, encodeFunctionData, erc20Abi, erc721Abi, BaseError, ContractFunctionRevertedError,
  formatEther, getAddress, getContractAddress, getCreate2Address, http, isAddress, keccak256, parseEther,
  parseEventLogs, stringToHex, toHex, zeroAddress
} from 'viem';
import { mainnet } from 'viem/chains';
import { Problem } from './agent.mjs';

export const ETHEREUM_POOL_MANAGER = '0x000000000004444c5dc75cB358380D2e3dE08A90';
export const ETHEREUM_POSITION_MANAGER = '0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e';
export const VEYL_MAIN_TOKEN_SALT_LABEL = 'veyl:ethereum:main-token:v1';
export const VEYL_MAIN_TOKEN_SALT = keccak256(stringToHex(VEYL_MAIN_TOKEN_SALT_LABEL));
const Q96 = 1n << 96n, SUPPLY = parseEther('1000000000');
const LAUNCH_LIMIT = parseEther('20000000');
const MAIN_INITIAL_PRICE = 1771577727172025373304338615273325n;
const STANDARD_FACTORY = 'VeylAgentLaunchFactory', STANDARD_VERSION = 'standard-agent-v1';
const EXECUTION_FACTORY = 'VeylAgentExecutionFactory', EXECUTION_VERSION = 'execution-agent-v1';
const fixedFactory = type => [STANDARD_FACTORY, EXECUTION_FACTORY].includes(type);
const factoryForVersion = version => version === EXECUTION_VERSION ? EXECUTION_FACTORY : version === STANDARD_VERSION ? STANDARD_FACTORY : 'VeylMarketFactory';
const STANDARD_DUST = 1000000n, STANDARD_FDV = parseEther('2');
const SIGNING_MARGIN_MS = 45000;
const INFRA_STAGES = [
  { kind: 'quoter', field: 'quoter', artifact: 'VeylQuoter' },
  { kind: 'project-builder', field: 'projectBuilder', artifact: 'VeylProjectBuilder' },
  { kind: 'market-builder', field: 'marketBuilder', artifact: 'VeylMarketBuilder' },
  { kind: 'liquidity-builder', field: 'liquidityBuilder', artifact: 'VeylLiquidityBuilder' }
];
const LIMIT = { buy: 4295128740n, sell: 1461446703485210103287273052203988822378723970341n };
const BIG_FIELDS = ['dailyLimit', 'treasuryEth', 'sqrtPriceX96', 'liquidity', 'maxToken', 'maxQuote', 'minToken', 'minQuote', 'deadline'];
const serialize = v => JSON.parse(JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x));
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const validPublicAddress = value => typeof value === 'string' && isAddress(value) && !equal(value, zeroAddress);
const nativeQuote = market => market.quoteKind !== 'veyl' && (!market.quoteAsset || equal(market.quoteAsset, zeroAddress));
const swapLimit = (market, side) => LIMIT[(side === 'buy') !== (market.tokenIsCurrency0 === true) ? 'buy' : 'sell'];
const sqrt = n => { if (n < 2n) return n; let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; };
export function quotePriceX96(tokensPerQuote, tokenIsCurrency0 = false) {
  const amount = decimal(tokensPerQuote, 'tokens per quote asset');
  const scaled = tokenIsCurrency0 ? (10n ** 18n << 192n) / amount : (amount << 192n) / 10n ** 18n;
  const price = sqrt(scaled);
  if (price < LIMIT.buy || price > LIMIT.sell) throw new Problem('Starting price is outside the v4 range.');
  return price;
}
const decodeConfig = c => ({ ...c, ...Object.fromEntries(BIG_FIELDS.map(k => [k, BigInt(c[k])])) });
const nonzero = (value, name) => {
  if (!isAddress(value || '') || equal(value, zeroAddress)) throw new Problem(`Enter a valid public ${name} address.`);
  return getAddress(value);
};
const decimal = (value, name, zero = false) => {
  if (typeof value !== 'string' || !/^\d{1,12}(\.\d{1,18})?$/.test(value)) throw new Problem(`Enter ${name} as a decimal string.`);
  const amount = parseEther(value);
  if (amount < 0n || (!zero && amount === 0n)) throw new Problem(`${name} must be positive.`);
  return amount;
};
const slippageOf = input => {
  const value = input ?? 50;
  if (!Number.isSafeInteger(value) || value < 1 || value > 500) throw new Problem('Slippage must be between 0.01% and 5%.');
  return value;
};

/** Compare every runtime instruction, masking solc-declared immutable slots and only
 * the canonical CBOR IPFS source digest. Solc compilation groups may embed a different
 * source metadata hash for identical executable code. Metadata format/compiler version
 * remain checked; configured exact code hashes are additionally enforced by identity().
 * Immutable values are separately checked through getters before preparing a transaction. */
export function matchesRuntime(actual, artifact) {
  let expected = artifact?.deployedBytecode?.object;
  if (!/^0x[\da-f]*$/i.test(actual || '') || !/^0x[\da-f]*$/i.test(expected || '') || actual.length !== expected.length) return false;
  let found = actual.toLowerCase(); expected = expected.toLowerCase();
  for (const refs of Object.values(artifact.deployedBytecode.immutableReferences || {})) for (const { start, length } of refs) {
    const at = 2 + start * 2, end = at + length * 2;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 1 || end > expected.length) return false;
    const blank = '0'.repeat(length * 2);
    found = found.slice(0, at) + blank + found.slice(end);
    expected = expected.slice(0, at) + blank + expected.slice(end);
  }
  const canonicalMetadata = /a2646970667358221220[0-9a-f]{64}64736f6c6343[0-9a-f]{6}0033$/;
  const normalizeMetadata = hex => hex.replace(canonicalMetadata, metadata => metadata.slice(0, 20) + '0'.repeat(64) + metadata.slice(84));
  return normalizeMetadata(found) === normalizeMetadata(expected);
}

/** Read-only Ethereum client. There is deliberately no wallet, private-key input or RPC passthrough.
 * Every write is an exact unsigned intent returned to the connected user's wallet. */
export class MainnetMarkets {
  constructor({ config = {}, origin = process.env.ETHEREUM_RPC_URL || 'https://ethereum-rpc.publicnode.com', client, now = () => Date.now(), confirmations = 2 } = {}) {
    const url = new URL(origin);
    if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.protocol === 'http:'))) throw new Problem('Ethereum RPC must use HTTPS or a loopback test endpoint.');
    this.config = config; this.now = now;
    this.confirmations = Math.max(1, confirmations);
    this.client = client || createPublicClient({ chain: mainnet, transport: http(origin, { retryCount: 0, timeout: 20000, fetchOptions: { redirect: 'error' } }) });
    this.artifacts = new Map();
  }
  artifact(name) {
    if (!this.artifacts.has(name)) {
      const source = ['AgentToken', 'AgentTreasury', 'AgentFactory'].includes(name) ? 'AgentKit' : ['RevenueRouter', 'JobEscrow'].includes(name) ? 'Funding' : name;
      this.artifacts.set(name, JSON.parse(readFileSync(fileURLToPath(new URL(`../contracts/out/${source}.sol/${name}.json`, import.meta.url)), 'utf8')));
    }
    return this.artifacts.get(name);
  }
  read(address, name, functionName, args = [], options = {}) { return this.client.readContract({ address, abi: this.artifact(name).abi, functionName, args, ...options }); }
  protectedPreset(project) {
    return this.config.project?.name === 'Veyl' && this.config.project?.symbol === 'VEYL' && project?.name === 'Veyl' && project?.symbol === 'VEYL';
  }
  mainPosition(project) { return this.protectedPreset(project) && this.config.trading?.liquidityCustody === 'deployer-position-nft'; }
  liquidityTypes(project) { return this.mainPosition(project) ? { builder: 'VeylMainLiquidityBuilder', deployer: 'VeylMainLiquidityDeployer', position: 'VeylMainLiquidityPosition' } : { builder: 'VeylLiquidityBuilder', deployer: 'VeylLiquidityDeployer', position: 'VeylLiquidityVault' }; }
  stages(project) { return INFRA_STAGES.map(stage => stage.field === 'liquidityBuilder' ? { ...stage, artifact: this.liquidityTypes(project).builder } : stage); }
  async checkMainBuilder(address, project) {
    if (!this.mainPosition(project)) return;
    const [positionManager, creator, salt] = await Promise.all(['positionManager', 'mainCreator', 'mainLaunchSalt'].map(field => this.read(address, 'VeylMainLiquidityBuilder', field)));
    if (!equal(positionManager, ETHEREUM_POSITION_MANAGER) || !equal(creator, this.config.addresses?.deployer) || !equal(salt, VEYL_MAIN_TOKEN_SALT)) throw new Problem('Main liquidity builder differs from the approved PositionManager, creator or launch salt.', 409);
  }
  quotePolicy(project) {
    const agent = this.config.agentMarkets !== undefined && !this.protectedPreset(project);
    const policy = agent ? this.config.agentMarkets || {} : {};
    const savedFactory = project?.mainnet?.factory;
    const savedStandard = agent && savedFactory && validPublicAddress(policy.standardFactory) && equal(savedFactory, policy.standardFactory);
    const savedExecution = agent && savedFactory && validPublicAddress(policy.executionFactory) && equal(savedFactory, policy.executionFactory);
    const execution = agent && (savedFactory ? savedExecution : policy.executionLaunch === true);
    const standard = agent && !execution && (savedFactory ? savedStandard : policy.standardLaunch === true);
    const shared = agent && (policy.sharedInfrastructure === true || standard || execution);
    const knownSaved = !agent || !savedFactory || savedStandard || savedExecution || equal(savedFactory, policy.marketFactory) || (!shared && equal(savedFactory, project?.mainnetInfrastructure?.factory));
    const factory = savedFactory && agent ? savedFactory : execution ? policy.executionFactory : standard ? policy.standardFactory : shared ? policy.marketFactory : project?.mainnetInfrastructure?.factory || (agent ? policy.marketFactory : this.config.deployments?.marketFactory);
    return { quoteKind: agent ? 'veyl' : 'native', quoteAsset: agent ? policy.quoteAsset || null : zeroAddress,
      quoteSymbol: agent ? 'VEYL' : 'ETH', quoteDecimals: 18,
      conversionSwapRouter: agent ? policy.conversionSwapRouter || null : zeroAddress,
      mainMarketFactory: agent ? policy.mainMarketFactory || null : null,
      infrastructureMode: shared ? 'shared' : 'per-project',
      factory: factory || null, factoryType: execution ? EXECUTION_FACTORY : standard ? STANDARD_FACTORY : 'VeylMarketFactory',
      marketVersion: execution ? EXECUTION_VERSION : standard ? STANDARD_VERSION : 'legacy-v1', factoryAllowed: knownSaved && (!project?.mainnet?.marketVersion || project.mainnet.marketVersion === (execution ? EXECUTION_VERSION : standard ? STANDARD_VERSION : 'legacy-v1')) };
  }
  configurationReadiness(project, quote = this.quotePolicy(project)) {
    const shared = quote.infrastructureMode === 'shared', configured = validPublicAddress(quote.factory);
    const invalidFactory = Boolean(quote.factory) && !configured;
    const mainUnavailable = quote.quoteKind === 'veyl' && ![quote.quoteAsset, quote.conversionSwapRouter, quote.mainMarketFactory].every(validPublicAddress);
    const savedFactory = project?.mainnetInfrastructure?.factory;
    const sharedMismatch = shared && configured && savedFactory && !equal(savedFactory, quote.factory);
    const missing = [];
    if (mainUnavailable) missing.push('Agent launches require the reviewed main VEYL/ETH market to be deployed and configured.');
    if (!quote.factoryAllowed) missing.push('This market does not match a reviewed factory version.');
    else if (sharedMismatch) missing.push('This workspace references different infrastructure from the configured shared agent factory.');
    else if (invalidFactory) missing.push('The configured market factory address is invalid.');
    else if (!configured) missing.push(shared ? 'Agent launches are unavailable until the shared market infrastructure is configured.' : 'Deploy and verify the market infrastructure before launching.');
    return {
      configured, missing,
      canPrepareInfrastructure: !shared && !configured && !mainUnavailable && !invalidFactory && quote.factoryAllowed,
      canPrepareLaunch: configured && !mainUnavailable && !sharedMismatch && quote.factoryAllowed,
      // This is configuration readiness. Runtime and relationship checks remain
      // mandatory in infrastructure() before any launch intent can be prepared.
      readiness: { status: mainUnavailable ? 'main-market-unavailable' : !configured || sharedMismatch || !quote.factoryAllowed ? 'infrastructure-unavailable' : 'ready', message: missing[0] || null }
    };
  }
  capabilities(project) {
    const quote = this.quotePolicy(project);
    return { ...quote, ...this.configurationReadiness(project, quote), infrastructureStep: (INFRA_STAGES.findIndex(stage => !project?.mainnetInfrastructure?.[stage.field]) + 1) || 5, infrastructureSteps: 5, chainId: 1, quoter: project?.mainnetInfrastructure?.quoter || null, poolManager: ETHEREUM_POOL_MANAGER,
      protocol: this.config.addresses?.protocolRecipient || null, walletTransactions: 'unsigned', broadcasting: false,
      confirmations: this.confirmations,
      feeBps: { buy: fixedFactory(quote.factoryType) ? 180 : this.config.trading?.buyFeeBps ?? 180, sell: fixedFactory(quote.factoryType) ? 180 : this.config.trading?.sellFeeBps ?? 180 }, lpFeePips: 0,
      tickSpacing: fixedFactory(quote.factoryType) ? 1 : quote.quoteKind === 'veyl' ? this.config.agentMarkets?.tickSpacing ?? 200 : this.config.trading?.tickSpacing ?? 200, tokenSupply: '1000000000', liquidityCustody: this.mainPosition(project) ? 'deployer-position-nft' : 'permanently-locked',
      standardLaunch: { enabled: fixedFactory(quote.factoryType), pricing: quote.factoryType === EXECUTION_FACTORY ? 'execution' : 'saved-plan', supply: '1000000000', targetFdvEth: '2', allocationBps: 10000, creatorAllocation: '0', quoteSeed: '0', optionalCreatorBuy: true, quoteSymbol: 'VEYL', referenceKind: 'canonical-pool-spot', referenceDriftBps: quote.factoryType === EXECUTION_FACTORY ? null : 50, maxLockedDustWei: STANDARD_DUST.toString() },
      ...(this.mainPosition(project) ? { mainTokenLaunch: this.config.mainTokenLaunch } : {}),
      launchProtection: this.protectedPreset(project), launchLimits: { maxTransactionTokens: '20000000', maxWalletTokens: '20000000', blocks: 10 },
      launchType: 'direct-uniswap-v4', automatedSigning: false };
  }
  /** Adopt only the reviewed six-transaction platform launch. Historical calldata
   * is decoded and checked before using the existing receipt/runtime verifier on
   * an isolated candidate. No imported file, signer or arbitrary market is accepted. */
  async adoptMainnet(project, input, checkpoint) {
    if (!checkpoint) throw new Problem('Durable project storage is required.', 500);
    const account = nonzero(input.account, 'owner'), deployer = nonzero(this.config.addresses?.deployer, 'configured deployer');
    if (!this.mainPosition(project) || !equal(account, deployer) || !equal(account, this.config.addresses?.owner)) throw new Problem('Only the configured owner can import the canonical Veyl platform launch.', 403);
    if (!/^0x[\da-f]{64}$/i.test(input.transactionHash || '')) throw new Problem('Enter the exact confirmed platform launch transaction hash.');
    if (project.mainnet) {
      if (!equal(project.mainnet.hash, input.transactionHash)) throw new Problem('This workspace already has another verified launch.', 409);
      await this.validateMarket(project);
      if (!equal(await this.read(project.mainnet.treasury, 'AgentTreasury', 'owner'), account)) throw new Problem('This wallet is no longer the platform treasury owner.', 403);
      return serialize(project.mainnet);
    }
    if (project.mainnetPlan || project.mainnetIntents?.some(item => !['confirmed', 'failed'].includes(item.status))) throw new Problem('Recover this workspace’s existing intent before importing another launch.', 409);
    await this.checkChain();
    const factory = getContractAddress({ from: deployer, nonce: 4n });
    if ((this.config.deployments?.marketFactory && !equal(this.config.deployments.marketFactory, factory)) || (project.mainnetInfrastructure?.factory && !equal(project.mainnetInfrastructure.factory, factory))) throw new Problem('The configured factory differs from the canonical deployment sequence.', 409);
    const tx = await this.client.getTransaction({ hash: input.transactionHash });
    if (!equal(tx.from, account) || !equal(tx.to, factory) || tx.chainId !== 1 || tx.nonce !== 5 || tx.value !== 0n) throw new Problem('The transaction is not the reviewed zero-value platform launch.', 409);
    let decoded;
    try { decoded = decodeFunctionData({ abi: this.artifact('VeylMarketFactory').abi, data: tx.input }); } catch { throw new Problem('The transaction does not contain a valid platform launch.', 409); }
    if (decoded.functionName !== 'launch') throw new Problem('The transaction is not a platform launch.', 409);
    const [config, hookSalt] = decoded.args;
    const { config: expected } = this.launchConfig(project, { account, treasuryOwner: account, operator: account, treasuryEth: '0', dailyLimitEth: '0' }, 0n);
    Object.assign(expected, { liquidity: 43827373799693085948824n, maxToken: 980000000000000000000012538n, deadline: config.deadline });
    if (Object.keys(expected).some(field => typeof expected[field] === 'string' ? !equal(expected[field], config[field]) : expected[field] !== config[field]) ||
        !equal(tx.input, encodeFunctionData({ abi: this.artifact('VeylMarketFactory').abi, functionName: 'launch', args: [expected, hookSalt] }))) throw new Problem('The launch differs from the reviewed platform owner, salt, zero funding or exact liquidity terms.', 409);
    const candidate = { ...project, mainnetInfrastructure: { ...project.mainnetInfrastructure, factory } }, infra = await this.infrastructure(candidate);
    for (const [index, stage] of this.stages(project).entries()) if (!equal(infra[stage.field], getContractAddress({ from: deployer, nonce: BigInt(index) }))) throw new Problem('Platform infrastructure differs from the canonical nonce sequence.', 409);
    const id = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [account, VEYL_MAIN_TOKEN_SALT]));
    const [predictedId, predicted] = await this.read(factory, 'VeylMarketFactory', 'predictLaunch', [account, config, hookSalt]);
    const tokenArtifact = this.artifact('AgentToken'), tokenCode = encodeDeployData({ abi: tokenArtifact.abi, bytecode: tokenArtifact.bytecode.object, args: ['Veyl', 'VEYL', factory, true, ETHEREUM_POOL_MANAGER] });
    const token = getCreate2Address({ from: infra.projectDeployer, salt: id, bytecodeHash: keccak256(tokenCode) });
    if (!equal(predictedId, id) || !equal(predicted.token, token) || !equal(predicted.creator, account) || !equal(predicted.treasuryOwner, account)) throw new Problem('The launch prediction does not match the canonical platform token and owner.', 409);
    candidate.mainnetPlan = serialize({ ...infra, account, config, id, hookSalt, predicted, tokenUsed: config.maxToken, quoteUsed: 0n, tokenIsCurrency0: false, creatorTokens: SUPPLY - config.maxToken,
      fingerprint: keccak256(stringToHex(JSON.stringify(serialize({ account, factory, ...config, deadline: 0n })))) });
    const intent = { id: randomUUID(), kind: 'launch', status: 'prepared', account, chainId: 1, marketId: id, createdAt: this.now(), expiresAt: this.now(), source: 'verified-platform-adoption',
      transaction: { from: account, to: factory, data: tx.input, value: '0x0', chainId: '0x1' } };
    intent.digest = keccak256(stringToHex(JSON.stringify(intent.transaction)));
    candidate.mainnetIntents = [...(project.mainnetIntents || []), intent];
    const result = await this.verify(candidate, { intentId: intent.id, transactionHash: input.transactionHash }, () => {});
    if (result.status !== 'confirmed') throw new Problem('Wait for the required canonical Ethereum confirmations before importing.', 409);
    if (!equal(await this.read(candidate.mainnet.treasury, 'AgentTreasury', 'owner'), account)) throw new Problem('This wallet is no longer the platform treasury owner.', 403);
    candidate.mainnetInfrastructure = serialize(infra);
    // Only fully verified candidates reach the tenant's durable state.
    Object.assign(project, { mainnet: candidate.mainnet, mainnetPlan: candidate.mainnetPlan, mainnetInfrastructure: candidate.mainnetInfrastructure, mainnetIntents: candidate.mainnetIntents });
    checkpoint(); return serialize(project.mainnet);
  }
  async checkChain() {
    if (await this.client.getChainId() !== 1) throw new Problem('Ethereum integration requires chain ID 1. No transaction was prepared.', 409);
    const code = await this.client.getCode({ address: ETHEREUM_POOL_MANAGER });
    if (!code || code === '0x') throw new Problem('The canonical Ethereum PoolManager is absent.', 409);
    const expected = this.config.deployments?.poolManagerCodeHash;
    if (expected && !equal(keccak256(code), expected)) throw new Problem('PoolManager bytecode differs from the pinned deployment.', 409);
  }
  async identity(address, name) {
    const code = await this.client.getCode({ address });
    if (!matchesRuntime(code, this.artifact(name))) {
      const expected = this.artifact(name).deployedBytecode.object;
      let at = 2; while (at < Math.min(expected.length, code?.length || 0) && expected[at].toLowerCase() === code[at].toLowerCase()) at++;
      throw new Problem(`${name} does not match the compiled Veyl runtime (first difference at byte ${Math.floor((at - 2) / 2)}, received ${(code?.length - 2) / 2 || 0}, expected ${(expected.length - 2) / 2}).`, 409);
    }
    const expected = this.config.deployments?.codeHashes?.[address.toLowerCase()];
    if (expected && !equal(keccak256(code), expected)) throw new Problem(`${name} differs from the pinned code hash.`, 409);
    return keccak256(code);
  }
  async validateQuoteAsset(project) {
    const quote = this.quotePolicy(project);
    if (quote.quoteKind === 'native') return { ...quote, conversionHook: null };
    const readiness = this.configurationReadiness(project, quote).readiness;
    if (readiness.status === 'main-market-unavailable') throw new Problem(readiness.message, 409);
    const token = nonzero(quote.quoteAsset, 'reviewed main VEYL token'), router = nonzero(quote.conversionSwapRouter, 'reviewed main VEYL/ETH router'), factory = nonzero(quote.mainMarketFactory, 'reviewed main VEYL factory');
    await Promise.all([[token, 'AgentToken'], [router, 'VeylSwapRouter'], [factory, 'VeylMarketFactory']].map(([a, name]) => this.identity(a, name)));
    const [hook, routerToken, routerQuote, routerManager, tokenFactory, factoryQuote, factoryConversion, factoryManager, protocol, protection, activated] = await Promise.all([
      ...['hook', 'token', 'quoteAsset', 'poolManager'].map(f => this.read(router, 'VeylSwapRouter', f)), this.read(token, 'AgentToken', 'launchFactory'),
      ...['quoteAsset', 'conversionSwapRouter', 'poolManager', 'protocol'].map(f => this.read(factory, 'VeylMarketFactory', f)),
      this.read(token, 'AgentToken', 'launchProtectionEnabled'), this.read(token, 'AgentToken', 'activated')
    ]);
    if (!equal(routerToken, token) || !equal(routerQuote, zeroAddress) || !equal(routerManager, ETHEREUM_POOL_MANAGER) || !equal(tokenFactory, factory) || !equal(factoryQuote, zeroAddress) || !equal(factoryConversion, zeroAddress) || !equal(factoryManager, ETHEREUM_POOL_MANAGER) || !equal(protocol, this.config.addresses?.protocolRecipient) || protection !== true || activated !== true) throw new Problem('Pinned VEYL/ETH conversion market identity is inconsistent.', 409);
    await this.identity(hook, 'VeylFeeHook');
    const [hookToken, hookQuote, hookManager, initializer, revenue, tokenName, tokenSymbol] = await Promise.all([
      ...['token', 'quoteAsset', 'poolManager', 'initializer', 'revenueRouter'].map(f => this.read(hook, 'VeylFeeHook', f)), this.read(token, 'AgentToken', 'name'), this.read(token, 'AgentToken', 'symbol')
    ]);
    if (!equal(hookToken, token) || !equal(hookQuote, zeroAddress) || !equal(hookManager, ETHEREUM_POOL_MANAGER) || !equal(initializer, factory) || tokenName !== 'Veyl' || tokenSymbol !== 'VEYL') throw new Problem('Pinned quote asset is not the reviewed Veyl main market.', 409);
    await this.identity(revenue, 'RevenueRouter');
    if (!equal(await this.read(revenue, 'RevenueRouter', 'protocol'), protocol)) throw new Problem('Main market platform recipient differs from the reviewed configuration.', 409);
    return { ...quote, conversionHook: hook };
  }
  async infrastructure(project) {
    const policy = this.capabilities(project);
    if (!policy.canPrepareLaunch) throw new Problem(policy.readiness.message, 409);
    await this.checkChain(); const quote = await this.validateQuoteAsset(project);
    const factory = nonzero(quote.factory, 'deployed factory');
    await this.identity(factory, quote.factoryType);
    const names = ['poolManager', 'protocol', 'projectDeployer', 'marketDeployer', 'liquidityDeployer', 'quoter', 'quoteAsset', 'conversionSwapRouter', 'projectBuilder', 'marketBuilder', 'liquidityBuilder'];
    const values = await Promise.all(names.map(f => this.read(factory, quote.factoryType, f)));
    const fields = Object.fromEntries(names.map((name, i) => [name, values[i]]));
    if (!equal(fields.poolManager, ETHEREUM_POOL_MANAGER) || !equal(fields.protocol, this.config.addresses?.protocolRecipient) || !equal(fields.quoteAsset, quote.quoteAsset) || !equal(fields.conversionSwapRouter, quote.conversionSwapRouter)) throw new Problem('Factory assets, manager or platform recipient differ from the reviewed policy.', 409);
    const artifacts = { projectDeployer: 'VeylProjectDeployer', marketDeployer: 'VeylMarketDeployer', liquidityDeployer: this.liquidityTypes(project).deployer, ...Object.fromEntries(this.stages(project).map(stage => [stage.field, stage.artifact])) };
    await Promise.all(Object.entries(artifacts).map(async ([field, name]) => {
      await this.identity(fields[field], name);
      if (!equal(await this.read(fields[field], name, 'poolManager'), fields.poolManager)) throw new Problem('Factory helper manager relationship is inconsistent.', 409);
      if (field.endsWith('Deployer') && !equal(await this.read(fields[field], name, 'factory'), factory)) throw new Problem('Factory helper authority relationship is inconsistent.', 409);
      if (project?.mainnetInfrastructure?.[field] && !equal(project.mainnetInfrastructure[field], fields[field])) throw new Problem('Factory helper differs from its recorded deployment.', 409);
    }));
    await this.checkMainBuilder(fields.liquidityBuilder, project);
    if (!equal(await this.read(fields.projectDeployer, 'VeylProjectDeployer', 'protocol'), fields.protocol)) throw new Problem('Project deployer platform recipient differs.', 409);
    const bound = await Promise.all([
      this.read(fields.projectDeployer, 'VeylProjectDeployer', 'quoteAsset'), this.read(fields.projectDeployer, 'VeylProjectDeployer', 'conversionSwapRouter'),
      this.read(fields.marketDeployer, 'VeylMarketDeployer', 'quoteAsset')
    ]);
    if (!equal(bound[0], quote.quoteAsset) || !equal(bound[1], quote.conversionSwapRouter) || !equal(bound[2], quote.quoteAsset)) throw new Problem('Creation modules use different fixed quote assets.', 409);
    if (fixedFactory(quote.factoryType)) {
      const execution = quote.factoryType === EXECUTION_FACTORY;
      const [version, supply, target, dust, pricing, reference] = await Promise.all(['LAUNCH_POLICY_VERSION', 'TOKEN_SUPPLY', 'TARGET_FDV_ETH', 'MAX_SEED_DUST', execution ? 'EXECUTION_PRICED' : 'MAX_REFERENCE_DRIFT_BPS', 'referenceHook'].map(field => this.read(factory, quote.factoryType, field)));
      if (version !== (execution ? 3n : 2n) || supply !== SUPPLY || target !== STANDARD_FDV || dust !== STANDARD_DUST || (execution ? pricing !== true : Number(pricing) !== 50) || !equal(reference, quote.conversionHook)) throw new Problem('Standard factory policy or canonical price reference differs from the reviewed launch configuration.', 409);
    }
    return { ...quote, ...fields, factory, manager: fields.poolManager };
  }
  async makeIntent(project, kind, account, request, metadata, checkpoint, { simulate = true } = {}) {
    if (!checkpoint) throw new Problem('Durable intent storage is required.', 500);
    let gas;
    if (simulate) gas = await this.client.estimateGas({ account, ...request });
    const intent = serialize({ id: randomUUID(), kind, status: 'prepared', account, chainId: 1, createdAt: this.now(),
      expiresAt: metadata.expiresAt || this.now() + 900000, transaction: { from: account, ...(request.to ? { to: request.to } : {}),
        data: request.data || '0x', value: toHex(request.value || 0n), chainId: '0x1', ...(gas ? { gas: toHex(gas * 120n / 100n) } : {}) }, ...metadata });
    intent.digest = keccak256(stringToHex(JSON.stringify(intent.transaction)));
    project.mainnetIntents ||= []; project.mainnetIntents.push(intent); checkpoint();
    return intent;
  }
  executionTiming(expiresAt, blockTimestamp) {
    const deadline = BigInt(Math.floor(expiresAt / 1000));
    const signingExpiresAt = Number(deadline) * 1000 - SIGNING_MARGIN_MS;
    if (signingExpiresAt <= this.now() || deadline <= blockTimestamp + BigInt(SIGNING_MARGIN_MS / 1000)) throw new Problem('Too little time remains to sign and mine this transaction. Request a fresh quote.', 409);
    return { deadline, metadata: { executionDeadline: deadline.toString(), expiresAt: signingExpiresAt } };
  }
  async prepareFactory(project, input, checkpoint) {
    const policy = this.capabilities(project);
    if (policy.infrastructureMode === 'shared') throw new Problem('Agent markets use shared infrastructure managed by Veyl. Customers do not deploy the platform factory.', 409);
    if (policy.readiness.status === 'main-market-unavailable' || (!policy.canPrepareInfrastructure && !policy.configured)) throw new Problem(policy.readiness.message, 409);
    await this.checkChain(); const quote = await this.validateQuoteAsset(project);
    const account = nonzero(input.account, 'connected wallet'), protocol = nonzero(this.config.addresses?.protocolRecipient, 'platform treasury');
    if (this.mainPosition(project) && !equal(account, this.config.addresses?.deployer)) throw new Problem('Only the configured main-token deployer can prepare this infrastructure.', 403);
    if (this.capabilities(project).configured) throw new Problem('A factory is already configured. Verify that deployment instead.', 409);
    const kinds = [...INFRA_STAGES.map(stage => stage.kind), 'factory'];
    const pending = project.mainnetIntents?.find(i => kinds.includes(i.kind) && equal(i.account, account) && !['confirmed', 'failed'].includes(i.status));
    if (pending) return pending;
    for (const [index, stage] of this.stages(project).entries()) {
      const address = project.mainnetInfrastructure?.[stage.field];
      if (!address) {
        const expectedContractAddress = await this.checkDeploymentNonce(project, account, index);
        const artifact = this.artifact(stage.artifact);
        const args = this.mainPosition(project) && stage.field === 'liquidityBuilder' ? [ETHEREUM_POOL_MANAGER, ETHEREUM_POSITION_MANAGER, nonzero(this.config.addresses?.deployer, 'main token creator'), VEYL_MAIN_TOKEN_SALT] : [ETHEREUM_POOL_MANAGER];
        return this.makeIntent(project, stage.kind, account, { data: encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args }), value: 0n }, { deploymentStep: index + 1, deploymentSteps: 5, expectedContractAddress, purpose: 'Verify this fixed-purpose infrastructure receipt before preparing the next deployment.' }, checkpoint);
      }
      await this.identity(address, stage.artifact);
      if (!equal(await this.read(address, stage.artifact, 'poolManager'), ETHEREUM_POOL_MANAGER)) throw new Problem('Saved deployment is bound to another PoolManager.', 409);
      if (stage.field === 'liquidityBuilder') await this.checkMainBuilder(address, project);
    }
    const infrastructure = project.mainnetInfrastructure;
    const artifact = this.artifact('VeylMarketFactory');
    const expectedContractAddress = await this.checkDeploymentNonce(project, account, 4);
    const args = [ETHEREUM_POOL_MANAGER, protocol, infrastructure.quoter, quote.quoteAsset, quote.conversionSwapRouter, infrastructure.projectBuilder, infrastructure.marketBuilder, infrastructure.liquidityBuilder];
    return this.makeIntent(project, 'factory', account, { data: encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args }), value: 0n }, { protocol, quoteAsset: quote.quoteAsset, quoteSymbol: quote.quoteSymbol, conversionSwapRouter: quote.conversionSwapRouter, quoter: infrastructure.quoter, deploymentStep: 5, deploymentSteps: 5, expectedContractAddress }, checkpoint);
  }
  async checkDeploymentNonce(project, account, nonce) {
    if (!this.mainPosition(project)) return undefined;
    const [confirmed, pending] = await Promise.all(['latest', 'pending'].map(blockTag => this.client.getTransactionCount({ address: account, blockTag })));
    if (confirmed !== nonce || pending !== nonce) throw new Problem('The deployer nonce differs from the published main-token address plan. Recalculate and review the public addresses before preparing another deployment.', 409);
    return getContractAddress({ from: account, nonce: BigInt(nonce) });
  }
  launchConfig(project, input, timestamp) {
    const account = nonzero(input.account, 'connected wallet'), owner = nonzero(input.treasuryOwner, 'treasury owner'), operator = nonzero(input.operator, 'operator');
    const policy = this.capabilities(project), main = this.mainPosition(project), terms = this.config.mainTokenLaunch;
    if (main) {
      if (!terms || terms.startingFdvEth !== '2' || terms.actualStartingFdvEth !== '2.000040289648088261' || terms.sqrtPriceX96 !== MAIN_INITIAL_PRICE.toString() || terms.liquidityEth !== '0' || terms.targetLiquidityTokens !== '980000000' || terms.maximumCreatorTokens !== '20000000' || terms.maximumRoundingDustWei !== '1000000' || terms.tickLower !== -887272 || terms.tickUpper !== 200311 || policy.tickSpacing !== 1 || !equal(terms.recipient, this.config.addresses?.deployer) || !equal(terms.positionManager, ETHEREUM_POSITION_MANAGER)) throw new Problem('The main-token NFT launch configuration differs from the approved allocation.', 409);
      const fixed = { liquidityQuote: '0', liquidityEth: '0', liquidityTokens: '980000000', sqrtPriceX96: MAIN_INITIAL_PRICE.toString(), tickLower: terms.tickLower, tickUpper: terms.tickUpper };
      for (const [field, value] of Object.entries(fixed)) if (input[field] !== undefined && String(input[field]) !== String(value)) throw new Problem(`The main-token ${field} differs from the approved launch terms.`, 409);
      if (input.tokensPerQuote !== undefined) throw new Problem('The main-token starting price is fixed at its reviewed v4 tick boundary.', 409);
      input = { ...input, ...fixed };
    }
    const maxQuote = decimal(input.liquidityQuote ?? (policy.quoteKind === 'native' ? input.liquidityEth : undefined), 'liquidity ' + policy.quoteSymbol, main), maxToken = decimal(input.liquidityTokens, 'liquidity tokens');
    let salt = keccak256(stringToHex(`veyl:ethereum:${project.id}`));
    if (this.protectedPreset(project) && this.config.project?.launchSalt !== undefined) {
      if (this.config.project.launchSalt !== VEYL_MAIN_TOKEN_SALT) throw new Problem('The main-token salt differs from the published deterministic launch plan.', 409);
      if (!equal(account, this.config.addresses?.deployer) || !equal(owner, this.config.addresses?.owner)) throw new Problem('Only the configured main-token deployer and treasury owner can prepare the canonical Veyl launch.', 403);
      salt = VEYL_MAIN_TOKEN_SALT;
    }
    if (policy.launchProtection && this.config.trading?.launchProtection !== true) throw new Problem('The reviewed Veyl launch requires its configured 2% launch protection. No launch was prepared.', 409);
    if (input.launchProtection !== undefined && input.launchProtection !== policy.launchProtection) throw new Problem('Launch protection differs from the reviewed project policy.', 409);
    if (maxToken > SUPPLY) throw new Problem('Liquidity tokens exceed the fixed one-billion supply.');
    if (policy.launchProtection && maxToken < SUPPLY - LAUNCH_LIMIT) throw new Problem('The protected Veyl launch requires at least 980 million tokens actually seeded so the creator remains within the 20 million wallet limit. Approve explicit launch amounts first.', 409);
    const lower = input.tickLower, upper = input.tickUpper, spacing = policy.tickSpacing;
    if (!Number.isSafeInteger(lower) || !Number.isSafeInteger(upper) || lower < -887272 || upper > 887272 || lower >= upper || lower % spacing || upper % spacing) throw new Problem(`Choose ordered liquidity ticks aligned to ${spacing}.`);
    if (input.tokensPerQuote === undefined && (policy.quoteKind !== 'native' || typeof input.sqrtPriceX96 !== 'string' || !/^\d{1,49}$/.test(input.sqrtPriceX96))) throw new Problem('Enter an explicit tokens-per-quote starting price.');
    const price = input.tokensPerQuote !== undefined ? quotePriceX96(input.tokensPerQuote) : BigInt(input.sqrtPriceX96);
    if (price < LIMIT.buy || price > LIMIT.sell) throw new Problem('Initial price is outside Uniswap v4 bounds.');
    if (policy.lpFeePips !== 0 || !Number.isSafeInteger(policy.feeBps.buy) || !Number.isSafeInteger(policy.feeBps.sell) || policy.feeBps.buy < 0 || policy.feeBps.sell < 0 || policy.feeBps.buy > 1000 || policy.feeBps.sell > 1000) throw new Problem('Invalid configured Veyl fee policy.', 409);
    return { account, slippage: slippageOf(input.slippageBps), config: {
      salt, name: project.name, symbol: project.symbol, treasuryOwner: owner, operator,
      dailyLimit: decimal(input.dailyLimitEth, 'daily treasury limit', true), treasuryEth: decimal(input.treasuryEth, 'initial treasury ETH', true),
      buyFeeBps: policy.feeBps.buy, sellFeeBps: policy.feeBps.sell, lpFeePips: 0, tickSpacing: spacing,
      sqrtPriceX96: price, tickLower: lower, tickUpper: upper, liquidity: 0n, maxToken, maxQuote, minToken: main ? SUPPLY - LAUNCH_LIMIT : 0n, minQuote: 0n, deadline: timestamp + 900n, launchProtection: policy.launchProtection
    } };
  }
  async prepareLaunch(project, input, checkpoint) {
    if (project.mainnet) throw new Problem('This workspace already has an Ethereum market.', 409);
    const infra = await this.infrastructure(project), block = await this.client.getBlock();
    if (infra.factoryType === STANDARD_FACTORY) return this.prepareStandardLaunch(project, input, checkpoint, infra, block);
    if (infra.factoryType === EXECUTION_FACTORY) return this.prepareExecutionLaunch(project, input, checkpoint, infra, block);
    const { account, slippage, config } = this.launchConfig(project, input, block.timestamp);
    const [predictedId, preview, initHash] = await this.read(infra.factory, 'VeylMarketFactory', 'predictLaunch', [account, config, toHex(0n, { size: 32 })]);
    if (!equal(preview.quoteAsset, infra.quoteAsset)) throw new Problem('Factory prediction uses a different quote asset.', 409);
    const tokenIsCurrency0 = BigInt(preview.token) < BigInt(infra.quoteAsset);
    if (input.tokensPerQuote !== undefined && !this.mainPosition(project)) config.sqrtPriceX96 = quotePriceX96(input.tokensPerQuote, tokenIsCurrency0);
    let [liquidity, amount0, amount1] = await this.read(infra.quoter, 'VeylQuoter', 'previewLiquidity', [config.sqrtPriceX96, config.tickLower, config.tickUpper, tokenIsCurrency0 ? config.maxToken : config.maxQuote, tokenIsCurrency0 ? config.maxQuote : config.maxToken]);
    const mainPosition = this.mainPosition(project), targetTokens = SUPPLY - LAUNCH_LIMIT;
    if (mainPosition && (tokenIsCurrency0 ? amount0 : amount1) < targetTokens) {
      liquidity += 1n;
      [amount0, amount1] = await this.read(infra.quoter, 'VeylQuoter', 'previewSeed', [config.sqrtPriceX96, config.tickLower, config.tickUpper, liquidity]);
    }
    const quoteUsed = tokenIsCurrency0 ? amount1 : amount0, tokenUsed = tokenIsCurrency0 ? amount0 : amount1;
    if (liquidity <= 0n || liquidity >= 1n << 127n || tokenUsed <= 0n || (mainPosition ? quoteUsed !== 0n || tokenIsCurrency0 || tokenUsed < targetTokens || tokenUsed - targetTokens > 1000000n : quoteUsed <= 0n)) throw new Problem(mainPosition ? 'The reviewed one-sided position must seed zero ETH and at least 980 million tokens with only bounded integer rounding.' : 'The selected price/range must seed both the quote asset and agent tokens.', 409);
    if (tokenUsed > SUPPLY || (config.launchProtection && SUPPLY - tokenUsed > LAUNCH_LIMIT)) throw new Problem('Actual seeded liquidity leaves more than 20 million tokens with the creator. These terms cannot launch with the 2% wallet cap; choose and approve compatible seed amounts, price and range.', 409);
    config.liquidity = liquidity; config.minToken = mainPosition ? targetTokens : tokenUsed * BigInt(10000 - slippage) / 10000n; config.minQuote = quoteUsed * BigInt(10000 - slippage) / 10000n;
    if (mainPosition) config.maxToken = tokenUsed;
    if (!config.minToken || (!mainPosition && !config.minQuote)) throw new Problem('Seed is too small for positive minimums.');
    const fingerprint = keccak256(stringToHex(JSON.stringify(serialize({ account, factory: infra.factory, ...config, deadline: 0n }))));
    const prior = project.mainnetPlan;
    if (prior && prior.fingerprint !== fingerprint) throw new Problem('This workspace has a persisted launch plan with different terms. Use a new workspace to avoid replacing an uncertain launch.', 409);
    if (!prior) { project.mainnetPlan = serialize({ fingerprint, ...infra, account, config, quoteUsed, tokenUsed, tokenIsCurrency0, creatorTokens: SUPPLY - tokenUsed }); checkpoint(); }
    const plan = project.mainnetPlan;
    if (!plan.hookSalt) {
      const id = predictedId;
      for (let i = 0; i < 1_000_000; i++) {
        const hookSalt = toHex(BigInt(i), { size: 32 });
        const salt = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [id, hookSalt]));
        if ((BigInt(getCreate2Address({ from: infra.marketDeployer, salt, bytecodeHash: initHash })) & 0x3fffn) === 0x20ccn) { plan.id = id; plan.hookSalt = hookSalt; break; }
        if (i % 1000 === 0) await new Promise(resolve => setImmediate(resolve));
      }
      if (!plan.hookSalt) throw new Problem('Hook address search exhausted. No transaction was sent.', 409);
      const [, predicted] = await this.read(infra.factory, 'VeylMarketFactory', 'predictLaunch', [account, config, plan.hookSalt]);
      plan.predicted = serialize(predicted); checkpoint();
    }
    const market = await this.read(infra.factory, 'VeylMarketFactory', 'getMarket', [plan.id]);
    if (!equal(market.token, zeroAddress)) throw new Problem('This deterministic market already exists. Recover its launch transaction before preparing another.', 409);
    if (!nativeQuote(infra)) {
      const approval = await this.prepareAllowance(project, account, infra.quoteAsset, infra.factory, config.maxQuote, { allowanceFor: plan.fingerprint, purpose: 'launch-liquidity', approvalAssetSymbol: infra.quoteSymbol }, checkpoint);
      if (approval) return approval;
    }
    const pending = project.mainnetIntents?.find(i => i.kind === 'launch' && !['confirmed', 'failed'].includes(i.status) && (i.expiresAt > this.now() || i.transactionHash));
    if (pending) return pending;
    plan.config.deadline = config.deadline.toString(); checkpoint();
    const data = encodeFunctionData({ abi: this.artifact('VeylMarketFactory').abi, functionName: 'launch', args: [config, plan.hookSalt] });
    return this.makeIntent(project, 'launch', account, { to: infra.factory, data, value: config.treasuryEth + (nativeQuote(infra) ? config.maxQuote : 0n) }, {
      marketId: plan.id, predicted: plan.predicted, expiresAt: this.now() + 840000,
      launchProtection: config.launchProtection, quoteAsset: infra.quoteAsset, quoteSymbol: infra.quoteSymbol, tokenIsCurrency0,
      allocation: { treasuryEth: formatEther(config.treasuryEth), liquidityQuote: formatEther(quoteUsed), quoteSymbol: infra.quoteSymbol, ...(nativeQuote(infra) ? { liquidityEth: formatEther(quoteUsed) } : {}), liquidityTokens: formatEther(tokenUsed), creatorTokens: formatEther(SUPPLY - tokenUsed), totalTokens: '1000000000', permanentlyLocked: !mainPosition,
        ...(mainPosition ? { custody: 'deployer-position-nft', nftRecipient: account, positionManager: ETHEREUM_POSITION_MANAGER, targetFdvEth: '2', startingFdvEth: '2.000040289648088261', roundingDustTokens: formatEther(tokenUsed - targetTokens) } : {}) }
    }, checkpoint);
  }
  standardRequest(project, input, timestamp) {
    const allowed = new Set(['account', 'devBuyQuote', 'slippageBps', 'treasuryOwner', 'operator', 'treasuryEth', 'dailyLimitEth', 'reprice']);
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !allowed.has(key))) throw new Problem('Standard agent launches derive all price, supply, fee and liquidity terms. Only the creator buy and treasury settings are editable.');
    if (input.reprice !== undefined && typeof input.reprice !== 'boolean') throw new Problem('Explicit repricing must be a boolean.');
    const account = nonzero(input.account, 'connected wallet');
    return { account, slippage: slippageOf(input.slippageBps), buyQuote: decimal(input.devBuyQuote ?? '0', 'optional creator buy in VEYL', true), config: {
      salt: keccak256(stringToHex(`veyl:ethereum:agent-standard:v1:${project.id}`)), name: project.name, symbol: project.symbol,
      treasuryOwner: nonzero(input.treasuryOwner ?? account, 'treasury owner'), operator: nonzero(input.operator ?? account, 'operator'),
      dailyLimit: decimal(input.dailyLimitEth ?? '0', 'daily treasury limit', true), treasuryEth: decimal(input.treasuryEth ?? '0', 'initial treasury ETH', true),
      buyFeeBps: 180, sellFeeBps: 180, lpFeePips: 0, tickSpacing: 1, sqrtPriceX96: 0n, tickLower: 0, tickUpper: 0,
      liquidity: 0n, maxToken: SUPPLY, maxQuote: 0n, minToken: SUPPLY - STANDARD_DUST, minQuote: 0n, deadline: timestamp + 900n, launchProtection: false
    } };
  }
  async standardRead(address, functionName, args = []) {
    try { return await this.read(address, STANDARD_FACTORY, functionName, args); }
    catch (error) {
      const reverted = error instanceof BaseError ? error.walk(cause => cause instanceof ContractFunctionRevertedError) : null;
      if (reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName === 'ReferencePriceMoved') throw new Problem('The saved launch price moved outside its 0.5% limit. After the old launch deadline, explicitly refresh the plan before signing.', 409);
      throw error;
    }
  }
  validateStandardConfig(config, request, summary) {
    for (const field of ['salt', 'name', 'symbol', 'treasuryOwner', 'operator', 'dailyLimit', 'treasuryEth', 'deadline']) {
      const matches = ['salt', 'treasuryOwner', 'operator'].includes(field) ? equal(config[field], request[field]) : config[field] === request[field];
      if (!matches) throw new Problem('Standard factory changed the saved creator or treasury request.', 409);
    }
    if (config.buyFeeBps !== 180 || config.sellFeeBps !== 180 || config.lpFeePips !== 0 || config.tickSpacing !== 1 || config.launchProtection !== false ||
        config.maxToken !== SUPPLY || config.minToken !== SUPPLY - STANDARD_DUST || config.maxQuote !== 0n || config.minQuote !== 0n ||
        config.liquidity <= 0n || config.liquidity >= 1n << 127n || config.sqrtPriceX96 < LIMIT.buy || config.sqrtPriceX96 > LIMIT.sell ||
        !Number.isSafeInteger(config.tickLower) || !Number.isSafeInteger(config.tickUpper) || config.tickLower < -887272 || config.tickUpper > 887272 || config.tickLower >= config.tickUpper ||
        summary.tokenUsed < SUPPLY - STANDARD_DUST || summary.tokenUsed > SUPPLY || summary.lockedDust < 0n || summary.tokenUsed + summary.lockedDust !== SUPPLY ||
        summary.actualStartingFdvEth * 10000n < STANDARD_FDV * 9950n || summary.actualStartingFdvEth * 10000n > STANDARD_FDV * 10050n ||
        summary.referenceSqrtPriceX96 < LIMIT.buy || summary.referenceSqrtPriceX96 > LIMIT.sell) throw new Problem('Standard launch does not match the fixed supply, locked allocation, fees or 2 ETH valuation bound.', 409);
  }
  async prepareStandardLaunch(project, input, checkpoint, infra, block) {
    if (!checkpoint) throw new Problem('Durable project storage is required.', 500);
    const { account, slippage, buyQuote, config: request } = this.standardRequest(project, input, block.timestamp);
    if (input.reprice === true && project.mainnetPlan) await this.repriceStandardPlan(project, account, infra, block, checkpoint);
    const requestFingerprint = keccak256(stringToHex(JSON.stringify(serialize({ account, factory: infra.factory, request: { ...request, deadline: 0n }, buyQuote, slippage }))));
    const prior = project.mainnetPlan;
    if (prior && (prior.marketVersion !== STANDARD_VERSION || prior.requestFingerprint !== requestFingerprint || !equal(prior.factory, infra.factory))) throw new Problem('This workspace has a persisted launch plan with different terms or a legacy factory. Recover any submitted transaction, then explicitly refresh the standard plan after its launch deadline; it cannot be silently replaced.', 409);
    let config, summary;
    if (prior) {
      config = { ...decodeConfig(prior.config), deadline: request.deadline };
      summary = Object.fromEntries(['actualStartingFdvEth', 'tokenUsed', 'lockedDust', 'referenceSqrtPriceX96'].map(key => [key, BigInt(prior[key])]));
    } else {
      const [derived, actualStartingFdvEth, tokenUsed, lockedDust, referenceSqrtPriceX96] = await this.standardRead(infra.factory, 'standardLaunchConfig', [account, request]);
      config = derived; summary = { actualStartingFdvEth, tokenUsed, lockedDust, referenceSqrtPriceX96 };
    }
    this.validateStandardConfig(config, request, summary);
    const fingerprint = keccak256(stringToHex(JSON.stringify(serialize({ account, factory: infra.factory, ...config, deadline: 0n, buyQuote, slippage }))));
    if (prior && prior.fingerprint !== fingerprint) throw new Problem('The persisted standard launch terms are inconsistent.', 409);
    const [id, preview, initHash] = await this.standardRead(infra.factory, 'predictLaunch', [account, config, toHex(0n, { size: 32 })]);
    if (!equal(preview.quoteAsset, infra.quoteAsset) || !equal(preview.creator, account) || !equal(preview.treasuryOwner, config.treasuryOwner)) throw new Problem('Standard launch prediction differs from its creator or quote asset.', 409);
    const tokenIsCurrency0 = BigInt(preview.token) < BigInt(infra.quoteAsset);
    const [amount0, amount1] = await this.read(infra.quoter, 'VeylQuoter', 'previewSeed', [config.sqrtPriceX96, config.tickLower, config.tickUpper, config.liquidity]);
    if ((tokenIsCurrency0 ? amount0 : amount1) !== summary.tokenUsed || (tokenIsCurrency0 ? amount1 : amount0) !== 0n) throw new Problem('The standard seed preview differs from its full-supply one-sided allocation.', 409);
    const priceLimit = swapLimit({ tokenIsCurrency0 }, 'buy');
    // Also validates the current canonical VEYL/ETH spot against a saved config.
    // A zero buy performs this read without approvals or a provider transaction.
    const [expectedTokens, hookFee, sqrtPriceX96After] = await this.standardRead(infra.factory, 'previewInitialBuy', [account, config, buyQuote, priceLimit]);
    const minimumTokens = expectedTokens * BigInt(10000 - slippage) / 10000n;
    if (buyQuote === 0n ? expectedTokens !== 0n || hookFee !== 0n || sqrtPriceX96After !== config.sqrtPriceX96 : expectedTokens <= 0n || expectedTokens > summary.tokenUsed || minimumTokens <= 0n || hookFee !== buyQuote * 180n / 10000n || sqrtPriceX96After < LIMIT.buy || sqrtPriceX96After > LIMIT.sell) throw new Problem('The initial creator buy has no valid exact-output preview.', 409);
    const creatorBuy = serialize({ quoteAmount: formatEther(buyQuote), quoteSymbol: 'VEYL', expectedTokens: formatEther(expectedTokens), minimumTokens: formatEther(minimumTokens), slippageBps: slippage, hookFeeQuote: formatEther(hookFee), priceLimit, sqrtPriceX96After });
    if (!prior) { project.mainnetPlan = serialize({ ...infra, marketVersion: STANDARD_VERSION, requestFingerprint, fingerprint, account, config, ...summary, quoteUsed: 0n, tokenIsCurrency0, creatorTokens: 0n, buyQuote, minimumBuyTokens: minimumTokens, creatorBuy }); checkpoint(); }
    const plan = project.mainnetPlan;
    if (plan.id && !equal(plan.id, id)) throw new Problem('The persisted standard launch identity changed.', 409);
    if (!plan.hookSalt || !plan.predicted) {
      for (let i = 0; i < 1_000_000; i++) {
        const hookSalt = toHex(BigInt(i), { size: 32 });
        const salt = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [id, hookSalt]));
        if ((BigInt(getCreate2Address({ from: infra.marketDeployer, salt, bytecodeHash: initHash })) & 0x3fffn) === 0x20ccn) { plan.id = id; plan.hookSalt = hookSalt; break; }
        if (i % 1000 === 0) await new Promise(resolve => setImmediate(resolve));
      }
      if (!plan.hookSalt) throw new Problem('Hook address search exhausted. No transaction was sent.', 409);
      const [finalId, predicted] = await this.standardRead(infra.factory, 'predictLaunch', [account, config, plan.hookSalt]);
      if (!equal(finalId, id) || !equal(predicted.token, preview.token) || !equal(predicted.creator, account) || !equal(predicted.treasuryOwner, config.treasuryOwner) || !equal(predicted.quoteAsset, infra.quoteAsset)) throw new Problem('The final standard launch prediction is inconsistent.', 409);
      plan.predicted = serialize(predicted); checkpoint();
    }
    const market = await this.standardRead(infra.factory, 'getMarket', [plan.id]);
    if (!equal(market.token, zeroAddress)) throw new Problem('This deterministic market already exists. Recover its launch transaction before preparing another.', 409);
    const pending = project.mainnetIntents?.find(intent => intent.kind === 'launch' && !['confirmed', 'failed', 'expired'].includes(intent.status) && (intent.expiresAt > this.now() || intent.transactionHash));
    if (pending) return pending;
    if (buyQuote > 0n) {
      const approval = await this.prepareAllowance(project, account, infra.quoteAsset, infra.factory, buyQuote, { allowanceFor: fingerprint, purpose: 'launch-creator-buy', marketVersion: STANDARD_VERSION, approvalAssetSymbol: 'VEYL', creatorBuy }, checkpoint);
      if (approval) return approval;
    }
    plan.config.deadline = config.deadline.toString(); plan.minimumBuyTokens = minimumTokens.toString(); plan.creatorBuy = creatorBuy; checkpoint();
    const data = encodeFunctionData({ abi: this.artifact(STANDARD_FACTORY).abi, functionName: buyQuote > 0n ? 'launchAndBuy' : 'launch', args: buyQuote > 0n ? [config, plan.hookSalt, buyQuote, minimumTokens, priceLimit] : [config, plan.hookSalt] });
    return this.makeIntent(project, 'launch', account, { to: infra.factory, data, value: config.treasuryEth }, {
      marketId: plan.id, marketVersion: STANDARD_VERSION, predicted: plan.predicted, expiresAt: this.now() + 840000,
      launchProtection: false, quoteAsset: infra.quoteAsset, quoteSymbol: 'VEYL', tokenIsCurrency0, creatorBuy,
      allocation: { treasuryEth: formatEther(config.treasuryEth), liquidityQuote: '0', quoteSymbol: 'VEYL', liquidityTokens: formatEther(summary.tokenUsed), lockedDustTokens: formatEther(summary.lockedDust), creatorTokens: '0', totalTokens: '1000000000', permanentlyLocked: true, targetFdvEth: '2', startingFdvEth: formatEther(summary.actualStartingFdvEth), referenceKind: 'canonical-pool-spot', referenceDriftBps: 50 }
    }, checkpoint);
  }
  async repriceStandardPlan(project, account, infra, block, checkpoint) {
    const plan = project.mainnetPlan;
    if (plan.marketVersion !== STANDARD_VERSION || !equal(plan.account, account) || !equal(plan.factory, infra.factory)) throw new Problem('Only the same creator and standard factory can refresh this plan. Recover a legacy or different-wallet launch separately.', 409);
    const active = (project.mainnetIntents || []).filter(intent => !['confirmed', 'failed'].includes(intent.status));
    if (active.some(intent => intent.transactionHash || ['signed', 'submitted', 'unknown'].includes(intent.status))) throw new Problem('Reconcile every submitted or uncertain transaction before refreshing the launch plan.', 409);
    const launches = (project.mainnetIntents || []).filter(intent => intent.kind === 'launch' && intent.marketId === plan.id);
    for (const intent of launches) {
      const decoded = decodeFunctionData({ abi: this.artifact(STANDARD_FACTORY).abi, data: intent.transaction.data });
      if (!['launch', 'launchAndBuy'].includes(decoded.functionName) || block.timestamp <= decoded.args[0].deadline) throw new Problem('The previous launch can still execute. Wait until its onchain deadline before refreshing the plan.', 409);
    }
    if (plan.id && !equal((await this.standardRead(infra.factory, 'getMarket', [plan.id])).token, zeroAddress)) throw new Problem('This market already exists. Recover its launch transaction instead of refreshing.', 409);
    for (const intent of launches) {
      // Retain the exact old terms for canonical receipt recovery, even if an
      // earlier transaction only becomes known after this explicit refresh.
      intent.launchPlan ||= structuredClone(plan);
      if (intent.status === 'prepared') intent.status = 'expired';
    }
    // ERC20 approvals have no onchain expiry. Keep their finite authorization
    // and recovery records; a new launch still requires a new wallet signature.
    delete project.mainnetPlan; checkpoint();
  }
  async prepareExecutionLaunch(project, input, checkpoint, infra, block) {
    if (!checkpoint) throw new Problem('Durable project storage is required.', 500);
    if (typeof block.number !== 'bigint' || block.number < 0n) throw new Problem('A canonical block number is required for the launch preview.', 503);
    const { account, slippage, buyQuote, config: request } = this.standardRequest(project, input, block.timestamp);
    if (input.reprice === true && project.mainnetPlan) await this.retireExecutionPlan(project, account, block, checkpoint);
    const requestFingerprint = keccak256(stringToHex(JSON.stringify(serialize({ account, factory: infra.factory, request: { ...request, deadline: 0n }, buyQuote, slippage }))));
    const prior = project.mainnetPlan;
    if (prior && (prior.marketVersion !== EXECUTION_VERSION || prior.requestFingerprint !== requestFingerprint || !equal(prior.factory, infra.factory))) throw new Problem('This workspace has a saved launch with different terms or factory. Recover pending transactions, then explicitly refresh it after any prior launch deadline.', 409);
    if (prior?.id && !equal((await this.read(infra.factory, EXECUTION_FACTORY, 'getMarket', [prior.id])).token, zeroAddress)) throw new Problem('This market already exists. Recover its launch transaction.', 409);
    const unresolved = (project.mainnetIntents || []).some(intent => !['confirmed', 'failed'].includes(intent.status) && (intent.transactionHash || ['signed', 'submitted', 'unknown'].includes(intent.status)));
    if (unresolved) throw new Problem('Recover every submitted or uncertain transaction before preparing a launch.', 409);
    const launches = (project.mainnetIntents || []).filter(intent => intent.kind === 'launch' && intent.marketVersion === EXECUTION_VERSION && intent.marketId === prior?.id);
    for (const intent of launches) {
      const decoded = decodeFunctionData({ abi: this.artifact(EXECUTION_FACTORY).abi, data: intent.transaction.data });
      if (block.timestamp <= decoded.args[0].deadline) {
        if (intent.status === 'prepared' && intent.expiresAt > this.now()) return intent;
        throw new Problem('The earlier launch can still execute. Recover it or wait until its onchain deadline before requesting another quote.', 409);
      }
    }
    // All indicative reads use one block. Execution derives its own price later;
    // only the separately signed creator-buy minimum constrains purchase output.
    const read = (name, args) => this.read(infra.factory, EXECUTION_FACTORY, name, args, { blockNumber: block.number });
    const [config, actualStartingFdvEth, tokenUsed, lockedDust, referenceSqrtPriceX96] = await read('standardLaunchConfig', [account, request]);
    const summary = { actualStartingFdvEth, tokenUsed, lockedDust, referenceSqrtPriceX96 };
    this.validateStandardConfig(config, request, summary);
    const [id, preview, initHash] = await read('predictLaunch', [account, request, toHex(0n, { size: 32 })]);
    if (!equal(preview.quoteAsset, infra.quoteAsset) || !equal(preview.creator, account) || !equal(preview.treasuryOwner, request.treasuryOwner)) throw new Problem('Execution launch prediction differs from the reviewed creator or quote asset.', 409);
    const tokenIsCurrency0 = BigInt(preview.token) < BigInt(infra.quoteAsset);
    const [amount0, amount1] = await this.read(infra.quoter, 'VeylQuoter', 'previewSeed', [config.sqrtPriceX96, config.tickLower, config.tickUpper, config.liquidity]);
    if ((tokenIsCurrency0 ? amount0 : amount1) !== tokenUsed || (tokenIsCurrency0 ? amount1 : amount0) !== 0n) throw new Problem('Execution launch preview differs from its full-supply one-sided allocation.', 409);
    const priceLimit = swapLimit({ tokenIsCurrency0 }, 'buy');
    const [expectedTokens, hookFee, sqrtPriceX96After] = await read('previewInitialBuy', [account, request, buyQuote, priceLimit]);
    const minimumTokens = expectedTokens * BigInt(10000 - slippage) / 10000n;
    if (buyQuote === 0n ? expectedTokens !== 0n || hookFee !== 0n || sqrtPriceX96After !== config.sqrtPriceX96 : expectedTokens <= 0n || expectedTokens > tokenUsed || minimumTokens <= 0n || hookFee !== buyQuote * 180n / 10000n || sqrtPriceX96After < LIMIT.buy || sqrtPriceX96After > LIMIT.sell || (tokenIsCurrency0 ? sqrtPriceX96After <= config.sqrtPriceX96 : sqrtPriceX96After >= config.sqrtPriceX96)) throw new Problem('Execution launch creator buy differs from its exact-input preview.', 409);
    const creatorBuy = { quoteAmount: formatEther(buyQuote), quoteSymbol: 'VEYL', expectedTokens: formatEther(expectedTokens), minimumTokens: formatEther(minimumTokens), hookFeeQuote: formatEther(hookFee), slippageBps: slippage, priceLimit: priceLimit.toString() };
    const plan = serialize({ ...infra, account, marketVersion: EXECUTION_VERSION, requestFingerprint, fingerprint: requestFingerprint, launchConfig: request, config, id, tokenUsed, quoteUsed: 0n, lockedDust, creatorTokens: 0n, tokenIsCurrency0, actualStartingFdvEth, referenceSqrtPriceX96, buyQuote, minimumBuyTokens: minimumTokens, creatorBuy, quoteBlockNumber: block.number, pricing: 'execution', predicted: preview, hookSalt: prior?.hookSalt });
    if (!plan.hookSalt) {
      for (let i = 0; i < 500000; i++) {
        const hookSalt = toHex(BigInt(i), { size: 32 }), salt = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [id, hookSalt]));
        const candidate = getCreate2Address({ from: infra.marketDeployer, salt, bytecodeHash: initHash });
        if ((BigInt(candidate) & 0x3fffn) === 0x20ccn) { plan.hookSalt = hookSalt; break; }
        if (i % 1000 === 0) await new Promise(resolve => setImmediate(resolve));
      }
      if (!plan.hookSalt) throw new Problem('Hook address search exhausted. No transaction was sent.', 409);
    }
    const [finalId, predicted] = await read('predictLaunch', [account, request, plan.hookSalt]);
    if (!equal(finalId, id) || (prior && !equal(prior.id, id)) || !equal(predicted.token, preview.token) || !equal(predicted.creator, account) || !equal(predicted.treasuryOwner, request.treasuryOwner) || !equal(predicted.quoteAsset, infra.quoteAsset) || (BigInt(predicted.hook) & 0x3fffn) !== 0x20ccn) throw new Problem('The execution launch prediction is inconsistent.', 409);
    if (prior) for (const field of ['creator', 'treasuryOwner', 'token', 'treasury', 'revenueRouter', 'hook', 'swapRouter', 'poolId', 'quoteAsset']) if (!equal(predicted[field], prior.predicted[field])) throw new Problem('Execution launch changed a stable contract identity.', 409);
    if (!equal((await this.read(infra.factory, EXECUTION_FACTORY, 'getMarket', [id])).token, zeroAddress)) throw new Problem('This market already exists. Recover its launch transaction.', 409);
    plan.predicted = serialize(predicted);
    project.mainnetPlan = plan; checkpoint();
    if (buyQuote > 0n) {
      const approval = await this.prepareAllowance(project, account, infra.quoteAsset, infra.factory, buyQuote, { allowanceFor: requestFingerprint, purpose: 'launch-creator-buy', marketVersion: EXECUTION_VERSION, pricing: 'execution', approvalAssetSymbol: 'VEYL', creatorBuy }, checkpoint);
      if (approval) return approval;
    }
    const data = encodeFunctionData({ abi: this.artifact(EXECUTION_FACTORY).abi, functionName: buyQuote > 0n ? 'launchAndBuy' : 'launch', args: buyQuote > 0n ? [request, plan.hookSalt, buyQuote, minimumTokens, priceLimit] : [request, plan.hookSalt] });
    return this.makeIntent(project, 'launch', account, { to: infra.factory, data, value: request.treasuryEth }, {
      marketId: id, marketVersion: EXECUTION_VERSION, pricing: 'execution', launchPlan: structuredClone(plan), predicted: plan.predicted, expiresAt: this.now() + 840000,
      launchProtection: false, quoteAsset: infra.quoteAsset, quoteSymbol: 'VEYL', tokenIsCurrency0, creatorBuy,
      allocation: { treasuryEth: formatEther(request.treasuryEth), liquidityQuote: '0', quoteSymbol: 'VEYL', liquidityTokens: formatEther(tokenUsed), lockedDustTokens: formatEther(lockedDust), creatorTokens: '0', totalTokens: '1000000000', permanentlyLocked: true, targetFdvEth: '2', startingFdvEth: formatEther(actualStartingFdvEth), referenceKind: 'canonical-pool-spot', pricing: 'execution' }
    }, checkpoint);
  }
  async retireExecutionPlan(project, account, block, checkpoint) {
    const plan = project.mainnetPlan, factoryType = factoryForVersion(plan.marketVersion);
    const policy = this.quotePolicy({ ...project, mainnet: { factory: plan.factory, marketVersion: plan.marketVersion } });
    if (!fixedFactory(factoryType) || !policy.factoryAllowed || !equal(account, plan.account)) throw new Problem('Only the same creator can retire a reviewed standard launch plan.', 409);
    await this.identity(plan.factory, factoryType);
    if ((project.mainnetIntents || []).some(intent => !['confirmed', 'failed'].includes(intent.status) && (intent.transactionHash || ['signed', 'submitted', 'unknown'].includes(intent.status)))) throw new Problem('Recover every submitted or uncertain transaction before changing the launch plan.', 409);
    const launches = (project.mainnetIntents || []).filter(intent => intent.kind === 'launch' && equal(intent.marketId, plan.id));
    for (const intent of launches) {
      const decoded = decodeFunctionData({ abi: this.artifact(factoryType).abi, data: intent.transaction.data });
      if (!['launch', 'launchAndBuy'].includes(decoded.functionName) || block.timestamp <= decoded.args[0].deadline) throw new Problem('The previous launch can still execute. Wait until its onchain deadline before changing the plan.', 409);
    }
    if (!equal((await this.read(plan.factory, factoryType, 'getMarket', [plan.id])).token, zeroAddress)) throw new Problem('This market already exists. Recover its launch transaction.', 409);
    for (const intent of launches) { intent.launchPlan ||= structuredClone(plan); if (intent.status === 'prepared') intent.status = 'expired'; }
    delete project.mainnetPlan; checkpoint();
  }
  async prepareAllowance(project, account, asset, spender, amount, metadata, checkpoint) {
    const allowance = await this.client.readContract({ address: asset, abi: erc20Abi, functionName: 'allowance', args: [account, spender] });
    if (allowance >= amount) return null;
    const prior = project.mainnetIntents?.find(i => i.kind === 'approve' && i.allowanceFor === metadata.allowanceFor && equal(i.account, account) && i.status === 'prepared' && i.expiresAt > this.now());
    if (prior) return prior;
    return this.makeIntent(project, 'approve', account, { to: asset, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }) }, { ...metadata, amount: amount.toString(), spender, approvalAsset: asset }, checkpoint);
  }
  async validateMarket(project) {
    const infra = await this.infrastructure(project), saved = project.mainnet;
    if (!saved?.id || !equal(saved.factory, infra.factory)) throw new Problem('No verified Ethereum market belongs to this workspace.', 409);
    const actual = await this.read(infra.factory, infra.factoryType || 'VeylMarketFactory', 'getMarket', [saved.id]);
    for (const field of ['creator', 'treasuryOwner', 'token', 'treasury', 'revenueRouter', 'hook', 'swapRouter', 'liquidityVault', 'poolId', 'quoteAsset']) if (!equal(saved[field], actual[field])) throw new Problem('Recorded market differs from its factory record.', 409);
    if (!equal(actual.quoteAsset, infra.quoteAsset)) throw new Problem('Recorded market quote asset differs from the reviewed policy.', 409);
    const revenueRouterType = nativeQuote(infra) ? 'RevenueRouter' : 'QuoteRevenueRouter';
    const liquidityType = this.liquidityTypes(project).position;
    await Promise.all([['token', 'AgentToken'], ['treasury', 'AgentTreasury'], ['revenueRouter', revenueRouterType], ['hook', 'VeylFeeHook'], ['swapRouter', 'VeylSwapRouter'], ['liquidityVault', liquidityType]].map(([field, name]) => this.identity(actual[field], name)));
    const [treasury, creator, protocol, hookToken, hookRouter, hookManager, swapHook, vaultHook] = await Promise.all([
      ...['treasury', 'creator', 'protocol'].map(f => this.read(actual.revenueRouter, revenueRouterType, f)),
      ...['token', 'revenueRouter', 'poolManager'].map(f => this.read(actual.hook, 'VeylFeeHook', f)),
      this.read(actual.swapRouter, 'VeylSwapRouter', 'hook'), this.read(actual.liquidityVault, liquidityType, 'hook')
    ]);
    if (!equal(treasury, actual.treasury) || !equal(creator, actual.creator) || !equal(protocol, infra.protocol) || !equal(hookToken, actual.token) || !equal(hookRouter, actual.revenueRouter) || !equal(hookManager, infra.manager) || !equal(swapHook, actual.hook) || !equal(vaultHook, actual.hook)) throw new Problem('Market contract relationships are inconsistent.', 409);
    const tokenIsCurrency0 = BigInt(actual.token) < BigInt(actual.quoteAsset);
    for (const [field, name] of [['hook', 'VeylFeeHook'], ['swapRouter', 'VeylSwapRouter'], ['liquidityVault', liquidityType]]) {
      const [quoteAsset, ordered] = await Promise.all(['quoteAsset', 'tokenIsCurrency0'].map(f => this.read(actual[field], name, f)));
      if (!equal(quoteAsset, actual.quoteAsset) || ordered !== tokenIsCurrency0) throw new Problem('Pool asset ordering differs between its contracts.', 409);
    }
    if (!nativeQuote(infra)) {
      const [asset, conversion, manager] = await Promise.all(['quoteAsset', 'conversionSwapRouter', 'poolManager'].map(f => this.read(actual.revenueRouter, revenueRouterType, f)));
      if (!equal(asset, infra.quoteAsset) || !equal(conversion, infra.conversionSwapRouter) || !equal(manager, infra.manager)) throw new Problem('Operating conversion differs from the verified main VEYL market.', 409);
    }
    const expectedProtection = project.mainnetPlan?.config?.launchProtection;
    if (typeof expectedProtection !== 'boolean' || (this.protectedPreset(project) && expectedProtection !== true)) throw new Problem('Saved launch protection policy is missing or differs from the reviewed Veyl preset.', 409);
    const [protection, launchFactory, tokenManager, activated, launchBlock, bootstrapVault, refundRecipient] = await Promise.all([
      ...['launchProtectionEnabled', 'launchFactory', 'poolManager', 'activated', 'launchBlock', 'bootstrapVault'].map(f => this.read(actual.token, 'AgentToken', f)),
      this.read(actual.liquidityVault, liquidityType, 'tokenRefundRecipient')
    ]);
    const standard = fixedFactory(infra.factoryType);
    if (protection !== expectedProtection || !equal(launchFactory, infra.factory) || !equal(tokenManager, infra.manager) || !equal(refundRecipient, protection || standard ? infra.factory : actual.creator) ||
      (protection ? activated !== true || launchBlock <= 0n || !equal(bootstrapVault, actual.liquidityVault) : activated !== false || launchBlock !== 0n || !equal(bootstrapVault, zeroAddress))) throw new Problem('Token launch protection or bootstrap relationships do not match the saved launch.', 409);
    if (standard) {
      const plan = project.mainnetPlan;
      if (plan?.marketVersion !== infra.marketVersion || plan.config?.launchProtection !== false || BigInt(plan.tokenUsed) + BigInt(plan.lockedDust) !== SUPPLY || BigInt(plan.lockedDust) > STANDARD_DUST || BigInt(plan.lockedDust) < 0n || BigInt(plan.creatorTokens) !== 0n) throw new Problem('The recorded standard liquidity allocation is inconsistent.', 409);
      const [seeded, liquidity, refund, lower, upper, buyFee, sellFee, lpFee, spacing] = await Promise.all([
        ...['seeded', 'lockedLiquidity', 'refundRecipient', 'tickLower', 'tickUpper'].map(field => this.read(actual.liquidityVault, liquidityType, field)),
        ...['buyFeeBps', 'sellFeeBps', 'lpFee', 'tickSpacing'].map(field => this.read(actual.hook, 'VeylFeeHook', field))
      ]);
      if (seeded !== true || liquidity !== BigInt(plan.config.liquidity) || !equal(refund, infra.factory) || lower !== plan.config.tickLower || upper !== plan.config.tickUpper || buyFee !== 180 || sellFee !== 180 || lpFee !== 0 || spacing !== 1) throw new Problem('The standard market liquidity or immutable fee policy differs from its reviewed launch.', 409);
    }
    const position = this.mainPosition(project) ? await this.positionStatus(actual.liquidityVault) : null;
    return { ...saved, ...infra, revenueRouterType, liquidityType, liquidityCustody: position ? 'deployer-position-nft' : 'permanently-locked', position, tokenIsCurrency0, launchProtection: protection, launchBlock };
  }
  async positionStatus(adapter) {
    const [positionManager, positionId, seededTokens] = await Promise.all(['positionManager', 'positionId', 'seededTokens'].map(field => this.read(adapter, 'VeylMainLiquidityPosition', field)));
    if (!equal(positionManager, ETHEREUM_POSITION_MANAGER) || positionId <= 0n) throw new Problem('Main liquidity position is not bound to the canonical PositionManager and minted NFT.', 409);
    const [owner, currentLiquidity] = await Promise.all([
      this.client.readContract({ address: positionManager, abi: erc721Abi, functionName: 'ownerOf', args: [positionId] }).catch(error => {
        // The owner may remove and burn its NFT before manually giving custody up.
        // A nonexistent token must not block hook-fee delivery; RPC failures still do.
        if (error instanceof BaseError && error.walk(cause => cause instanceof ContractFunctionRevertedError) instanceof ContractFunctionRevertedError) return null;
        throw error;
      }),
      this.client.readContract({ address: positionManager, abi: [{ type: 'function', name: 'getPositionLiquidity', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'uint128' }] }], functionName: 'getPositionLiquidity', args: [positionId] })
    ]);
    if (!owner && currentLiquidity !== 0n) throw new Problem('An ownerless position still reports liquidity; its state needs review.', 409);
    return { positionManager, positionId, seededTokens, owner, currentLiquidity, burned: owner === null, sentToDead: equal(owner, '0x000000000000000000000000000000000000dEaD') };
  }
  async status(project, account) {
    if (!project.mainnet) return { ...this.capabilities(project), launched: false, plan: project.mainnetPlan || null, intents: (project.mainnetIntents || []).slice(-12) };
    const market = await this.validateMarket(project), wallet = account ? nonzero(account, 'connected wallet') : null;
    const [[sqrtPriceX96, tick, liquidity], pendingFees, lockedLiquidity, treasuryBalance, owner, operator, dailyLimit, ...fees] = await Promise.all([
      this.read(market.quoter, 'VeylQuoter', 'getPoolState', [market.hook]), this.read(market.hook, 'VeylFeeHook', 'pendingFees'),
      this.read(market.liquidityVault, market.liquidityType, 'lockedLiquidity'), this.client.getBalance({ address: market.treasury }),
      ...['owner', 'operator', 'dailyLimit'].map(f => this.read(market.treasury, 'AgentTreasury', f)),
      ...['buyFeeBps', 'sellFeeBps', 'lpFee'].map(f => this.read(market.hook, 'VeylFeeHook', f))
    ]);
    const beneficiaries = [...new Set([market.treasury, market.creator, market.protocol].map(a => a.toLowerCase()))];
    const claims = await Promise.all(beneficiaries.map(async address => { const amountEth = formatEther(await this.read(market.revenueRouter, market.revenueRouterType, 'claimable', [address])); return { address: getAddress(address), amountEth, payoutSymbol: 'ETH' }; }));
    const balances = wallet ? await Promise.all([this.client.getBalance({ address: wallet }), this.client.readContract({ address: market.token, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] }), ...(nativeQuote(market) ? [] : [this.client.readContract({ address: market.quoteAsset, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] })])]) : [];
    const conversion = nativeQuote(market) ? null : await this.conversionStatus(market);
    const block = market.launchProtection ? await this.client.getBlockNumber() : null;
    const launchLimits = { enabled: market.launchProtection, active: market.launchProtection && block < market.launchBlock + 10n, launchBlock: market.launchBlock, endsAtBlock: market.launchProtection ? market.launchBlock + 10n : null, currentBlock: block, maxTransactionTokens: '20000000', maxWalletTokens: '20000000' };
    return serialize({ configured: true, launched: true, chainId: 1, market, account: wallet, sqrtPriceX96, tick, liquidity, lockedLiquidity: market.position ? null : lockedLiquidity, position: market.position, liquidityCustody: market.liquidityCustody,
      priceQuote: market.tokenIsCurrency0 ? Number(sqrtPriceX96) ** 2 / Number(Q96) ** 2 : Number(Q96) ** 2 / Number(sqrtPriceX96) ** 2, quoteAsset: market.quoteAsset, quoteSymbol: market.quoteSymbol, conversion, pendingFees: formatEther(pendingFees), treasuryBalance: formatEther(treasuryBalance), owner, operator,
      dailyLimit: formatEther(dailyLimit), buyFeeBps: fees[0], sellFeeBps: fees[1], lpFeePips: fees[2], claims, launchLimits,
      ...(wallet ? { ethBalance: formatEther(balances[0]), tokenBalance: formatEther(balances[1]), quoteBalance: formatEther(nativeQuote(market) ? balances[0] : balances[2]) } : {}),
      trades: (project.mainnetTrades || []).slice(-8).reverse(), intents: (project.mainnetIntents || []).slice(-12) });
  }
  async quote(project, input, checkpoint) {
    const market = await this.validateMarket(project), account = nonzero(input.account, 'connected wallet');
    if (!['buy', 'sell'].includes(input.side)) throw new Problem('Choose buy or sell.');
    const amount = decimal(input.amount, 'trade amount'), slippage = slippageOf(input.slippageBps);
    const { result } = await this.client.simulateContract({ address: market.quoter, abi: this.artifact('VeylQuoter').abi, functionName: 'quoteExactInput', args: [market.hook, input.side === 'buy', amount, swapLimit(market, input.side)] });
    const minOut = result.amountOut * BigInt(10000 - slippage) / 10000n;
    if (result.amountIn !== amount || minOut <= 0n) throw new Problem('This input cannot be fully quoted within the pool limits.', 409);
    await this.checkLaunchTrade(market, account, input.side, amount, result.amountOut);
    const quote = serialize({ id: randomUUID(), chainId: 1, account, poolId: market.poolId, side: input.side, amountIn: amount, amountOut: result.amountOut, minOut,
      priceLimit: swapLimit(market, input.side), quoteAsset: market.quoteAsset, quoteSymbol: market.quoteSymbol, amount: input.amount, expectedOutput: formatEther(result.amountOut), minimumOutput: formatEther(minOut), feeQuote: formatEther(result.hookFee), ...(nativeQuote(market) ? { feeEth: formatEther(result.hookFee) } : {}), slippageBps: slippage,
      expiresAt: this.now() + 120000, status: 'quoted' });
    project.mainnetQuotes ||= []; project.mainnetQuotes = project.mainnetQuotes.filter(q => q.expiresAt > this.now() || q.intentId); project.mainnetQuotes.push(quote); checkpoint();
    return quote;
  }
  async checkLaunchTrade(market, account, side, amountIn, amountOut) {
    if (!market.launchProtection || !(await this.read(market.token, 'AgentToken', 'launchLimitsActive'))) return;
    const tokens = side === 'buy' ? amountOut : amountIn;
    if (tokens > LAUNCH_LIMIT) throw new Problem('During the first ten launch blocks, each token transfer is limited to 20 million tokens (2%).', 409);
    if (side === 'buy') {
      const balance = await this.client.readContract({ address: market.token, abi: erc20Abi, functionName: 'balanceOf', args: [account] });
      if (balance + tokens > LAUNCH_LIMIT) throw new Problem('This purchase would exceed the 20 million token wallet limit during the first ten launch blocks.', 409);
    }
  }
  async conversionStatus(market) {
    if (nativeQuote(market)) throw new Problem('Native-ETH fee markets do not need VEYL conversion.', 409);
    const block = await this.client.getBlock();
    const [raw, pendingQuote, spentToday] = await Promise.all([
      this.read(market.revenueRouter, 'QuoteRevenueRouter', 'conversionPolicy'),
      this.read(market.revenueRouter, 'QuoteRevenueRouter', 'pendingQuote'),
      this.read(market.revenueRouter, 'QuoteRevenueRouter', 'spentOnDay', [block.timestamp / 86400n])
    ]);
    const names = ['executor', 'maxQuotePerConversion', 'maxQuotePerDay', 'minEthPerVeylX18', 'enabled'];
    const policy = Array.isArray(raw) ? Object.fromEntries(names.map((name, i) => [name, raw[i]])) : raw;
    return serialize({ policy, pendingQuote, pendingVeyl: formatEther(pendingQuote), spentToday, spentTodayVeyl: formatEther(spentToday), destination: market.revenueRouter, conversionSwapRouter: market.conversionSwapRouter, quoteSymbol: 'VEYL' });
  }
  async prepareSwap(project, input, checkpoint) {
    const market = await this.validateMarket(project), account = nonzero(input.account, 'connected wallet');
    const quote = project.mainnetQuotes?.find(q => q.id === input.quoteId);
    if (!quote || !equal(quote.account, account) || !equal(quote.poolId, market.poolId)) throw new Problem('Quote does not belong to this wallet and pool.', 409);
    if (market.quoteAsset && !equal(quote.quoteAsset, market.quoteAsset)) throw new Problem('Quote does not match this market payment asset.', 409);
    if (quote.intentId) {
      const existing = project.mainnetIntents.find(i => i.id === quote.intentId);
      if (existing?.status === 'prepared' && existing.expiresAt <= this.now()) throw new Problem('Transaction signing window expired. Request a fresh quote.', 409);
      return existing;
    }
    if (quote.expiresAt <= this.now()) throw new Problem('Quote expired. Request a fresh quote.', 409);
    await this.checkLaunchTrade(market, account, quote.side, BigInt(quote.amountIn), BigInt(quote.amountOut || 0));
    if (quote.side === 'sell' || !nativeQuote(market)) {
      const asset = quote.side === 'sell' ? market.token : market.quoteAsset;
      const approval = await this.prepareAllowance(project, account, asset, market.swapRouter, BigInt(quote.amountIn), { allowanceFor: quote.id, quoteId: quote.id, approvalAssetSymbol: quote.side === 'sell' ? project.symbol : market.quoteSymbol, expiresAt: quote.expiresAt }, checkpoint);
      if (approval) return approval;
    }
    const block = await this.client.getBlock(), timing = this.executionTiming(quote.expiresAt, block.timestamp);
    const args = [BigInt(quote.minOut), BigInt(quote.priceLimit), timing.deadline];
    args.unshift(BigInt(quote.amountIn));
    const intent = await this.makeIntent(project, quote.side, account, { to: market.swapRouter, data: encodeFunctionData({ abi: this.artifact('VeylSwapRouter').abi, functionName: quote.side, args }), value: quote.side === 'buy' && nativeQuote(market) ? BigInt(quote.amountIn) : 0n }, { quoteId: quote.id, ...timing.metadata, minimumOutput: quote.minimumOutput, expectedOutput: quote.expectedOutput, quoteSymbol: market.quoteSymbol, feeQuote: quote.feeQuote, ...(nativeQuote(market) ? { feeEth: quote.feeEth } : {}) }, checkpoint);
    if (intent.expiresAt <= this.now()) { intent.status = 'expired'; checkpoint(); throw new Problem('Transaction signing window expired during simulation. Request a fresh quote.', 409); }
    quote.intentId = intent.id; checkpoint(); return intent;
  }
  async prepareMaintenance(project, input, checkpoint) {
    const market = await this.validateMarket(project), account = nonzero(input.account, 'connected wallet');
    let request, meta = {};
    if (input.action === 'flush') {
      const pending = await this.read(market.hook, 'VeylFeeHook', 'pendingFees');
      if (!pending) throw new Problem('No hook fees are pending.', 409);
      request = { to: market.hook, data: encodeFunctionData({ abi: this.artifact('VeylFeeHook').abi, functionName: 'flushFees' }) }; meta = { amountQuote: formatEther(pending), quoteSymbol: market.quoteSymbol };
    } else if (input.action === 'distribute') {
      const beneficiary = nonzero(input.beneficiary, 'beneficiary');
      if (![market.treasury, market.creator, market.protocol].some(a => equal(a, beneficiary))) throw new Problem('Distribution can only pay fixed beneficiaries. All VEYL fee receipts require bounded conversion before ETH distribution.');
      request = { to: market.revenueRouter, data: encodeFunctionData({ abi: this.artifact(market.revenueRouterType).abi, functionName: 'distribute', args: [beneficiary] }) }; meta = { beneficiary, payoutSymbol: 'ETH' };
    } else if (input.action === 'configure-conversion') {
      if (nativeQuote(market)) throw new Problem('This market collects ETH and has no VEYL conversion policy.', 409);
      if (!equal(account, await this.read(market.treasury, 'AgentTreasury', 'owner'))) throw new Problem('Only the current treasury owner can configure conversion.', 403);
      if (typeof input.enabled !== 'boolean') throw new Problem('Choose whether to enable the conversion policy.');
      const current = await this.conversionStatus(market);
      const executor = input.enabled ? nonzero(input.executor, 'conversion executor') : current.policy.executor;
      const per = input.enabled ? decimal(input.maxVeylPerConversion, 'maximum VEYL per conversion') : BigInt(current.policy.maxQuotePerConversion);
      const daily = input.enabled ? decimal(input.maxVeylPerDay, 'maximum VEYL per day') : BigInt(current.policy.maxQuotePerDay);
      const floor = input.enabled ? decimal(input.minEthPerVeyl, 'minimum ETH per VEYL') : BigInt(current.policy.minEthPerVeylX18);
      if (input.enabled && daily < per) throw new Problem('Daily conversion limit must cover one conversion.');
      request = { to: market.revenueRouter, data: encodeFunctionData({ abi: this.artifact('QuoteRevenueRouter').abi, functionName: 'configureConversion', args: [executor, per, daily, floor, input.enabled] }) };
      meta = { conversionPolicy: { executor, maxVeylPerConversion: formatEther(per), maxVeylPerDay: formatEther(daily), minEthPerVeyl: formatEther(floor), enabled: input.enabled }, destination: market.revenueRouter };
    } else if (input.action === 'convert-fees') {
      if (nativeQuote(market)) throw new Problem('This market already collects native ETH.', 409);
      const current = await this.conversionStatus(market), amount = decimal(input.amount, 'VEYL amount to convert'), block = await this.client.getBlock();
      const owner = await this.read(market.treasury, 'AgentTreasury', 'owner');
      if (!equal(account, owner) && !equal(account, current.policy.executor)) throw new Problem('Only the treasury owner or configured conversion executor can convert.', 403);
      if (!current.policy.enabled || amount > BigInt(current.pendingQuote) || amount > BigInt(current.policy.maxQuotePerConversion) || amount + BigInt(current.spentToday) > BigInt(current.policy.maxQuotePerDay)) throw new Problem('Conversion is disabled or exceeds the pending fee balance or owner limits.', 409);
      const slippage = slippageOf(input.slippageBps);
      const { result } = await this.client.simulateContract({ address: market.quoter, abi: this.artifact('VeylQuoter').abi, functionName: 'quoteExactInput', args: [market.conversionHook, false, amount, LIMIT.sell] });
      if (result.amountIn !== amount || result.amountOut <= 0n) throw new Problem('The verified VEYL/ETH pool cannot fill this conversion.', 409);
      const floor = (amount * BigInt(current.policy.minEthPerVeylX18) + 10n ** 18n - 1n) / 10n ** 18n;
      const quotedMin = result.amountOut * BigInt(10000 - slippage) / 10000n, minOut = quotedMin > floor ? quotedMin : floor;
      if (!minOut || result.amountOut < minOut) throw new Problem('Current VEYL/ETH price is below the owner floor.', 409);
      const timing = this.executionTiming(this.now() + 120000, block.timestamp);
      request = { to: market.revenueRouter, data: encodeFunctionData({ abi: this.artifact('QuoteRevenueRouter').abi, functionName: 'convertFees', args: [amount, minOut, LIMIT.sell, timing.deadline] }) };
      meta = { amountQuote: formatEther(amount), quoteSymbol: 'VEYL', expectedOutput: formatEther(result.amountOut), minimumOutput: formatEther(minOut), minimumOutputWei: minOut.toString(), amountInWei: amount.toString(), destination: market.revenueRouter, ...timing.metadata };
    } else if (input.action === 'fund') {
      const amount = decimal(input.amount, 'treasury deposit'); request = { to: market.treasury, value: amount }; meta.amountEth = formatEther(amount);
    } else if (input.action === 'recipient' || input.action === 'daily-limit' || input.action === 'operator') {
      if (!equal(account, await this.read(market.treasury, 'AgentTreasury', 'owner'))) throw new Problem('Only the current treasury owner can change this policy.', 403);
      let fn, args;
      if (input.action === 'recipient') { fn = 'setRecipient'; args = [nonzero(input.recipient, 'approved recipient'), input.allowed === true]; meta = { recipient: args[0], allowed: args[1] }; }
      if (input.action === 'daily-limit') { fn = 'setDailyLimit'; args = [decimal(input.amount, 'daily limit', true)]; meta.amountEth = formatEther(args[0]); }
      if (input.action === 'operator') { fn = 'setOperator'; args = [nonzero(input.operator, 'operator')]; meta.operator = args[0]; }
      request = { to: market.treasury, data: encodeFunctionData({ abi: this.artifact('AgentTreasury').abi, functionName: fn, args }) };
    } else throw new Problem('Unsupported maintenance action.');
    const intent = await this.makeIntent(project, input.action, account, request, meta, checkpoint);
    if (meta.executionDeadline && intent.expiresAt <= this.now()) { intent.status = 'expired'; checkpoint(); throw new Problem('Transaction signing window expired during simulation. Prepare a fresh conversion.', 409); }
    return intent;
  }
  async verify(project, input, checkpoint) {
    await this.checkChain();
    const intent = project.mainnetIntents?.find(i => i.id === input.intentId);
    if (!intent || !/^0x[\da-f]{64}$/i.test(input.transactionHash || '')) throw new Problem('A recorded intent and transaction hash are required.');
    if (intent.transactionHash && !equal(intent.transactionHash, input.transactionHash)) throw new Problem('This intent already has a transaction. Inspect it before retrying.', 409);
    const [tx, receipt] = await Promise.all([this.client.getTransaction({ hash: input.transactionHash }), this.client.getTransactionReceipt({ hash: input.transactionHash })]);
    const expected = intent.transaction;
    if (!equal(tx.from, expected.from) || !equal(tx.to || zeroAddress, expected.to || zeroAddress) || !equal(tx.input, expected.data) || tx.value !== BigInt(expected.value) || (tx.chainId && tx.chainId !== 1)) throw new Problem('Transaction does not match the exact recorded wallet intent.', 409);
    if (!equal(receipt.transactionHash, input.transactionHash)) throw new Problem('Receipt transaction hash does not match.', 409);
    const canonical = await this.client.getBlock({ blockNumber: receipt.blockNumber });
    if (!equal(canonical.hash, receipt.blockHash)) throw new Problem('Receipt is not in the canonical Ethereum chain. Retry after confirmation.', 409);
    const head = await this.client.getBlockNumber({ cacheTime: 0 });
    intent.transactionHash = input.transactionHash; intent.status = 'submitted'; checkpoint();
    if (head - receipt.blockNumber + 1n < BigInt(this.confirmations)) return { ...intent, awaitingConfirmations: true };
    if (receipt.status !== 'success') { intent.status = 'failed'; checkpoint(); throw new Problem('The wallet transaction reverted. Its gas was still spent.', 409); }
    if (intent.expectedContractAddress && !equal(receipt.contractAddress, intent.expectedContractAddress)) throw new Problem('Deployment receipt differs from the published nonce-derived address. Preserve the receipt and recalculate the address plan.', 409);
    const stage = this.stages(project).find(item => item.kind === intent.kind);
    if (stage) {
      if (!receipt.contractAddress) throw new Problem('Successful infrastructure receipt has no contract address.', 409);
      await this.identity(receipt.contractAddress, stage.artifact);
      if (!equal(await this.read(receipt.contractAddress, stage.artifact, 'poolManager'), ETHEREUM_POOL_MANAGER)) throw new Problem('Deployed helper is bound to another PoolManager.', 409);
      if (stage.field === 'liquidityBuilder') await this.checkMainBuilder(receipt.contractAddress, project);
      if (project.mainnetInfrastructure?.[stage.field] && !equal(project.mainnetInfrastructure[stage.field], receipt.contractAddress)) throw new Problem('A different deployment is already recorded. Preserve both receipts.', 409);
      project.mainnetInfrastructure = { ...project.mainnetInfrastructure, [stage.field]: receipt.contractAddress, [stage.field + 'Hash']: input.transactionHash };
    } else if (intent.kind === 'factory') {
      if (!receipt.contractAddress) throw new Problem('Successful factory receipt has no contract address.', 409);
      await this.identity(receipt.contractAddress, 'VeylMarketFactory');
      const candidate = { ...project, mainnetInfrastructure: { ...project.mainnetInfrastructure, factory: receipt.contractAddress } };
      const infra = await this.infrastructure(candidate);
      if (!equal(infra.quoter, intent.quoter) || !equal(infra.quoter, project.mainnetInfrastructure?.quoter)) throw new Problem('Factory quoter differs from the verified deployment plan.', 409);
      project.mainnetInfrastructure = { ...infra, hash: input.transactionHash, blockNumber: receipt.blockNumber.toString() };
    } else if (intent.kind === 'launch') {
      const plan = intent.launchPlan || project.mainnetPlan;
      if (!plan || plan.id !== intent.marketId) throw new Problem('Launch plan is absent or mismatched.', 409);
      const factoryType = factoryForVersion(plan.marketVersion), execution = factoryType === EXECUTION_FACTORY;
      const event = parseEventLogs({ abi: this.artifact(factoryType).abi, logs: receipt.logs.filter(l => equal(l.address, expected.to)), eventName: 'MarketLaunched' }).find(e => equal(e.args.id, plan.id));
      if (!event || !equal(event.args.creator, intent.account)) throw new Problem('Launch receipt does not match this creator and market.', 409);
      const actual = await this.read(plan.factory, factoryType, 'getMarket', [plan.id]);
      for (const field of ['creator', 'treasuryOwner', 'token', 'treasury', 'revenueRouter', 'hook', 'swapRouter', 'liquidityVault', 'poolId', 'quoteAsset']) if ((!execution || field !== 'liquidityVault') && !equal(actual[field], plan.predicted[field])) throw new Problem('Created market differs from the deterministic launch plan.', 409);
      if (execution) for (const field of ['creator', 'token', 'treasury', 'revenueRouter', 'hook', 'swapRouter', 'liquidityVault', 'poolId']) if (!equal(event.args[field], actual[field])) throw new Problem('Execution market receipt differs from its verified factory record.', 409);
      const standard = factoryType === STANDARD_FACTORY ? this.verifyStandardAllocation(plan, intent, receipt) : {};
      const executed = execution ? this.verifyExecutionAllocation(plan, intent, receipt) : null;
      const candidate = { ...project, mainnetPlan: executed ? serialize({ ...structuredClone(plan), config: executed.config, predicted: actual, tokenUsed: executed.evidence.seededTokens, lockedDust: executed.evidence.lockedDust, actualStartingFdvEth: executed.evidence.startingFdvEth, referenceSqrtPriceX96: executed.evidence.referenceSqrtPriceX96 }) : plan, mainnet: serialize({ ...actual, id: plan.id, factory: plan.factory, hash: input.transactionHash, chainId: 1, type: 'ethereum-mainnet', ...standard, ...(executed?.evidence || {}) }) };
      const verified = await this.validateMarket(candidate);
      if (executed) {
        const vault = await this.read(verified.liquidityDeployer, 'VeylLiquidityDeployer', 'predict', [plan.id, actual.hook, plan.factory, executed.config]);
        if (!equal(vault, actual.liquidityVault)) throw new Problem('Executed liquidity vault does not match the confirmed range and verified deployer.', 409);
        const [amount0, amount1] = await this.read(verified.quoter, 'VeylQuoter', 'previewSeed', [executed.config.sqrtPriceX96, executed.config.tickLower, executed.config.tickUpper, executed.config.liquidity]);
        const ordered = BigInt(actual.token) < BigInt(actual.quoteAsset);
        if ((ordered ? amount0 : amount1) !== executed.evidence.seededTokens || (ordered ? amount1 : amount0) !== 0n) throw new Problem('Executed seed does not match its confirmed liquidity terms.', 409);
      }
      if (verified.position) {
        const mint = parseEventLogs({ abi: erc721Abi, logs: receipt.logs.filter(log => equal(log.address, ETHEREUM_POSITION_MANAGER)), eventName: 'Transfer' }).find(log => log.args.tokenId === verified.position.positionId && equal(log.args.from, zeroAddress) && equal(log.args.to, intent.account));
        if (!mint) throw new Problem('Launch receipt does not include the exact position NFT minted to the configured deployer.', 409);
        candidate.mainnet.positionId = verified.position.positionId.toString(); candidate.mainnet.positionManager = ETHEREUM_POSITION_MANAGER;
      }
      project.mainnet = candidate.mainnet; project.mainnetPlan = candidate.mainnetPlan;
    } else if (intent.kind === 'convert-fees') {
      const market = await this.validateMarket(project);
      const event = parseEventLogs({ abi: this.artifact('QuoteRevenueRouter').abi, logs: receipt.logs.filter(l => equal(l.address, market.revenueRouter)), eventName: 'FeesConverted' })[0];
      if (!event || !equal(event.args.executor, intent.account) || event.args.quoteSpent !== BigInt(intent.amountInWei) || event.args.ethReceived < BigInt(intent.minimumOutputWei) || !equal(intent.destination, market.revenueRouter)) throw new Problem('Conversion receipt differs from the reviewed amount or ETH payout minimum.', 409);
      intent.actualOutput = formatEther(event.args.ethReceived);
    } else if (intent.kind === 'buy' || intent.kind === 'sell') {
      const market = await this.validateMarket(project), quote = project.mainnetQuotes?.find(q => q.id === intent.quoteId);
      const event = parseEventLogs({ abi: this.artifact('VeylSwapRouter').abi, logs: receipt.logs.filter(l => equal(l.address, market.swapRouter)), eventName: 'Swapped' })[0];
      if (!quote || !event || !equal(event.args.caller, intent.account) || event.args.isBuy !== (intent.kind === 'buy') || event.args.amountIn <= 0n || event.args.amountIn > BigInt(quote.amountIn) || (intent.kind === 'buy' && event.args.amountIn !== BigInt(quote.amountIn)) || event.args.amountOut < BigInt(quote.minOut)) throw new Problem('Trade receipt cannot be reconciled with its quoted minimum.', 409);
      project.mainnetTrades ||= [];
      if (!project.mainnetTrades.some(t => equal(t.hash, input.transactionHash))) project.mainnetTrades.push({ hash: input.transactionHash, side: intent.kind, account: intent.account, amountIn: formatEther(event.args.amountIn), amountOut: formatEther(event.args.amountOut), at: new Date(this.now()).toISOString() });
      quote.status = 'completed';
    }
    intent.status = 'confirmed'; intent.blockNumber = receipt.blockNumber.toString(); intent.blockHash = receipt.blockHash; checkpoint(); return serialize(intent);
  }
  verifyStandardAllocation(plan, intent, receipt) {
    if (intent.marketVersion !== STANDARD_VERSION || !equal(intent.account, plan.account) || !equal(intent.transaction.to, plan.factory)) throw new Problem('Standard launch intent differs from the persisted creator or factory.', 409);
    const abi = this.artifact(STANDARD_FACTORY).abi, logs = receipt.logs.filter(log => equal(log.address, plan.factory));
    const only = name => {
      const events = parseEventLogs({ abi, logs, eventName: name }).filter(event => equal(event.args.id, plan.id));
      if (events.length !== 1) throw new Problem(`Standard launch receipt requires one ${name} event.`, 409);
      return events[0].args;
    };
    const allocation = only('LaunchAllocation'), locked = only('StandardLiquidityLocked');
    if (allocation.treasuryEth !== BigInt(plan.config.treasuryEth) || allocation.liquidityQuote !== 0n || allocation.creatorTokens !== 0n || allocation.liquidityTokens !== BigInt(plan.tokenUsed) ||
        locked.seededTokens !== allocation.liquidityTokens || locked.lockedDust !== BigInt(plan.lockedDust) || locked.seededTokens + locked.lockedDust !== SUPPLY || locked.lockedDust > STANDARD_DUST ||
        locked.startingFdvEth * 10000n < STANDARD_FDV * 9950n || locked.startingFdvEth * 10000n > STANDARD_FDV * 10050n || locked.referenceSqrtPriceX96 < LIMIT.buy || locked.referenceSqrtPriceX96 > LIMIT.sell) throw new Problem('Standard launch receipt differs from the full locked allocation or bounded starting valuation.', 409);
    const decoded = decodeFunctionData({ abi, data: intent.transaction.data }), amount = BigInt(plan.buyQuote);
    const config = { ...decodeConfig(plan.config), deadline: decoded.args?.[0]?.deadline };
    const encoded = encodeFunctionData({ abi, functionName: amount > 0n ? 'launchAndBuy' : 'launch', args: amount > 0n ? [config, plan.hookSalt, amount, BigInt(plan.minimumBuyTokens), BigInt(plan.creatorBuy.priceLimit)] : [config, plan.hookSalt] });
    if (!equal(encoded, intent.transaction.data) || decoded.functionName !== (amount > 0n ? 'launchAndBuy' : 'launch')) throw new Problem('Confirmed launch calldata differs from the persisted standard terms.', 409);
    const buys = parseEventLogs({ abi, logs, eventName: 'CreatorBought' }).filter(event => equal(event.args.id, plan.id));
    if (amount === 0n ? buys.length !== 0 : buys.length !== 1 || !equal(buys[0].args.creator, intent.account) || buys[0].args.quotePaid !== amount || buys[0].args.tokensBought !== parseEther(plan.creatorBuy.expectedTokens) || buys[0].args.tokensBought < BigInt(plan.minimumBuyTokens)) throw new Problem('Creator buy receipt differs from the exact paid amount, recipient or token minimum.', 409);
    return { marketVersion: STANDARD_VERSION, seededTokens: locked.seededTokens, lockedDust: locked.lockedDust, startingFdvEth: locked.startingFdvEth, referenceSqrtPriceX96: locked.referenceSqrtPriceX96, creatorBuyTokens: amount > 0n ? buys[0].args.tokensBought : 0n };
  }
  verifyExecutionAllocation(plan, intent, receipt) {
    if (intent.marketVersion !== EXECUTION_VERSION || plan.marketVersion !== EXECUTION_VERSION || !equal(intent.account, plan.account) || !equal(intent.transaction.to, plan.factory) || !plan.launchConfig) throw new Problem('Execution launch intent differs from the saved creator, request or factory.', 409);
    const abi = this.artifact(EXECUTION_FACTORY).abi, logs = receipt.logs.filter(log => equal(log.address, plan.factory));
    const only = name => {
      const events = parseEventLogs({ abi, logs, eventName: name }).filter(event => equal(event.args.id, plan.id));
      if (events.length !== 1) throw new Problem(`Execution launch receipt requires one ${name} event.`, 409);
      return events[0].args;
    };
    const request = decodeConfig(plan.launchConfig), amount = BigInt(plan.buyQuote), minimum = BigInt(plan.minimumBuyTokens);
    const encoded = encodeFunctionData({ abi, functionName: amount > 0n ? 'launchAndBuy' : 'launch', args: amount > 0n ? [request, plan.hookSalt, amount, minimum, BigInt(plan.creatorBuy.priceLimit)] : [request, plan.hookSalt] });
    if (!equal(encoded, intent.transaction.data) || BigInt(intent.transaction.value) !== request.treasuryEth) throw new Problem('Confirmed execution launch calldata differs from the exact reviewed request.', 409);
    const allocation = only('LaunchAllocation'), locked = only('StandardLiquidityLocked'), terms = only('StandardLaunchTerms');
    if (allocation.treasuryEth !== request.treasuryEth || allocation.liquidityQuote !== 0n || allocation.creatorTokens !== 0n || allocation.liquidityTokens !== locked.seededTokens || locked.seededTokens + locked.lockedDust !== SUPPLY || locked.lockedDust < 0n || locked.lockedDust > STANDARD_DUST) throw new Problem('Execution launch receipt differs from its full-supply locked allocation.', 409);
    const config = { ...request, sqrtPriceX96: terms.sqrtPriceX96, tickLower: terms.tickLower, tickUpper: terms.tickUpper, liquidity: terms.liquidity };
    this.validateStandardConfig(config, request, { tokenUsed: locked.seededTokens, lockedDust: locked.lockedDust, actualStartingFdvEth: locked.startingFdvEth, referenceSqrtPriceX96: locked.referenceSqrtPriceX96 });
    const ordered = BigInt(plan.predicted.token) < BigInt(plan.quoteAsset);
    if (ordered ? config.tickUpper !== 887272 : config.tickLower !== -887272) throw new Problem('Execution launch receipt is not the fixed one-sided range.', 409);
    const buys = parseEventLogs({ abi, logs, eventName: 'CreatorBought' }).filter(event => equal(event.args.id, plan.id));
    if (amount === 0n ? buys.length !== 0 : minimum <= 0n || buys.length !== 1 || !equal(buys[0].args.creator, intent.account) || buys[0].args.quotePaid !== amount || buys[0].args.tokensBought < minimum || buys[0].args.tokensBought > SUPPLY) throw new Problem('Execution creator buy receipt differs from the exact paid amount, recipient or reviewed minimum.', 409);
    return { config, evidence: { marketVersion: EXECUTION_VERSION, pricing: 'execution', seededTokens: locked.seededTokens, lockedDust: locked.lockedDust, startingFdvEth: locked.startingFdvEth, referenceSqrtPriceX96: locked.referenceSqrtPriceX96, creatorBuyTokens: amount > 0n ? buys[0].args.tokensBought : 0n } };
  }
}
