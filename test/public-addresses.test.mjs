import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeFunctionData, encodeAbiParameters, encodeDeployData, getCreate2Address, keccak256, parseEther, stringToHex, zeroAddress, ContractFunctionRevertedError } from 'viem';
import { MainnetMarkets, VEYL_MAIN_TOKEN_SALT, ETHEREUM_POOL_MANAGER } from '../src/mainnet.mjs';
import { predictPublicAddresses } from '../scripts/predict-public-addresses.mjs';
import { mountMainnetPanel } from '../public/mainnet-panel.js';
const config = JSON.parse(readFileSync(new URL('../config/mainnet.json', import.meta.url)));
const published = JSON.parse(readFileSync(new URL('../config/public-addresses.json', import.meta.url)));
const account = config.addresses.deployer, owner = config.addresses.owner, other = '0x1111111111111111111111111111111111111111';
const terms = { account, treasuryOwner: owner, operator: other, dailyLimitEth: '0.01', treasuryEth: '0' };
const exactSeed = 980000000000000000000012538n, exactLiquidity = 43827373799693085948824n;

test('published address plan matches current bytecode, canonical salt and exact nonce order', () => {
  const actual = predictPublicAddresses({ config });
  assert.equal(actual.token.address, published.token.address); assert.equal(actual.token.launchSalt, VEYL_MAIN_TOKEN_SALT);
  assert.deepEqual(actual.artifacts, published.artifacts);
  assert.deepEqual(actual.deployments.map(x => [x.contract, x.nonce, x.address]), published.deployments.map(x => [x.contract, x.nonce, x.address]));
  assert.equal(actual.deployments[0].contract, 'VeylQuoter'); assert.notEqual(actual.deployments[0].address, actual.token.address);
  assert.notEqual(predictPublicAddresses({ config, startNonce: 1n }).token.address, actual.token.address);
  assert.throws(() => predictPublicAddresses({ config, creator: other }), /configured creator/);
});

test('actual unsigned protected launch encodes the published salt and token prediction regardless of workspace ID', async () => {
  const addresses = Object.fromEntries(published.deployments.map(item => [item.contract, item.address]));
  const children = Object.fromEntries(published.factoryChildren.map(item => [item.contract, item.address]));
  const service = new MainnetMarkets({ config, now: () => 1000, client: { getBlock: async () => ({ timestamp: 1n }), estimateGas: async () => 1000000n } });
  service.infrastructure = async () => ({ factory: addresses.VeylMarketFactory, projectDeployer: children.VeylProjectDeployer, marketDeployer: children.VeylMarketDeployer, quoter: addresses.VeylQuoter, quoteKind: 'native', quoteSymbol: 'ETH', quoteAsset: zeroAddress });
  service.read = async (_address, _artifact, fn, args) => {
    if (fn === 'getMarket') return { token: zeroAddress };
    if (fn === 'previewLiquidity') { assert.equal(args[3], 0n); return [exactLiquidity - 1n, 0n, parseEther('980000000') - 9823n]; }
    if (fn === 'previewSeed') { assert.equal(args[3], exactLiquidity); return [0n, exactSeed]; }
    assert.equal(fn, 'predictLaunch');
    const [creator, launch] = args, id = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [creator, launch.salt]));
    assert.equal(launch.minToken, parseEther('980000000'));
    const artifact = service.artifact('AgentToken');
    const init = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [launch.name, launch.symbol, addresses.VeylMarketFactory, launch.launchProtection, ETHEREUM_POOL_MANAGER] });
    return [id, { token: getCreate2Address({ from: children.VeylProjectDeployer, salt: id, bytecodeHash: keccak256(init) }), quoteAsset: zeroAddress }, '0x' + '1'.repeat(64)];
  };
  for (const id of ['first-workspace', 'different-workspace']) {
    const project = { id, name: 'Veyl', symbol: 'VEYL' }; let checkpoints = 0;
    const intent = await service.prepareLaunch(project, terms, () => checkpoints++);
    const decoded = decodeFunctionData({ abi: service.artifact('VeylMarketFactory').abi, data: intent.transaction.data });
    assert.equal(decoded.functionName, 'launch'); assert.equal(decoded.args[0].salt, published.token.launchSalt);
    assert.equal(decoded.args[0].maxToken, exactSeed); assert.equal(decoded.args[0].liquidity, exactLiquidity);
    assert.equal(decoded.args[0].maxQuote, 0n); assert.equal(decoded.args[0].minQuote, 0n); assert.equal(intent.transaction.value, '0x0');
    assert.equal(intent.allocation.creatorTokens, '19999999.999999999999987462'); assert.equal(intent.allocation.permanentlyLocked, false);
    assert.equal(intent.allocation.nftRecipient, account); assert.equal(intent.allocation.roundingDustTokens, '0.000000000000012538');
    assert.equal(intent.predicted.token, published.token.address); assert.equal(intent.transaction.to, addresses.VeylMarketFactory); assert.ok(checkpoints > 0);
  }
});

test('canonical main launch rejects a different creator or treasury owner; legacy agents keep their own salt', () => {
  const service = new MainnetMarkets({ config, client: {} }), project = { id: 'main', name: 'Veyl', symbol: 'VEYL' };
  assert.throws(() => service.launchConfig(project, { ...terms, account: other }, 1n), /configured main-token deployer/);
  assert.throws(() => service.launchConfig(project, { ...terms, treasuryOwner: other }, 1n), /configured main-token deployer/);
  const agent = { id: 'ordinary-project', name: 'Research', symbol: 'RES' };
  const legacyConfig = structuredClone(config); Object.assign(legacyConfig.agentMarkets, { standardLaunch: false, standardFactory: null, executionLaunch: false, executionFactory: null, tickSpacing: 200 });
  const legacy = new MainnetMarkets({ config: legacyConfig, client: {} });
  const result = legacy.launchConfig(agent, { ...terms, account: other, treasuryOwner: other, liquidityQuote: '10', liquidityTokens: '100000000', tokensPerQuote: '1000000', tickLower: -887200, tickUpper: 887200 }, 1n);
  assert.equal(result.config.salt, keccak256(stringToHex('veyl:ethereum:ordinary-project'))); assert.notEqual(result.config.salt, VEYL_MAIN_TOKEN_SALT);
  assert.equal(result.config.tickSpacing, 200); assert.equal(legacy.capabilities(agent).liquidityCustody, 'permanently-locked');
});

test('activated public agent config advertises the standard one-sided policy independently of the main token', () => {
  assert.equal(config.agentMarkets.standardLaunch, true); assert.equal(config.agentMarkets.sharedInfrastructure, true);
  assert.notEqual(config.agentMarkets.standardFactory.toLowerCase(), config.agentMarkets.marketFactory.toLowerCase());
  const service = new MainnetMarkets({ config, client: {} });
  const policy = service.capabilities({ id: 'standard-project', name: 'Research', symbol: 'RES' });
  assert.equal(policy.standardLaunch.enabled, true); assert.equal(policy.tickSpacing, 1);
  assert.equal(policy.standardLaunch.allocationBps, 10000); assert.equal(policy.standardLaunch.creatorAllocation, '0');
  assert.equal(policy.standardLaunch.targetFdvEth, '2'); assert.equal(policy.standardLaunch.quoteSeed, '0');
  assert.equal(service.capabilities({ id: 'main', name: 'Veyl', symbol: 'VEYL' }).standardLaunch.enabled, false);
});

test('main NFT terms are fixed while treasury amounts remain explicit', () => {
  const service = new MainnetMarkets({ config, client: {} }), project = { name: 'Veyl', symbol: 'VEYL' };
  for (const mutation of [{ liquidityEth: '2' }, { liquidityTokens: '1000000000' }, { tickUpper: 200312 }, { tokensPerQuote: '500000000' }, { sqrtPriceX96: '1' }]) assert.throws(() => service.launchConfig(project, { ...terms, ...mutation }, 1n), /approved|reviewed/);
  assert.throws(() => service.launchConfig(project, { ...terms, treasuryEth: undefined }, 1n), /initial treasury ETH/);
  assert.equal(service.launchConfig(project, terms, 1n).config.sqrtPriceX96.toString(), config.mainTokenLaunch.sqrtPriceX96);
});

test('main deployment refuses a nonce that would invalidate the published token address', async () => {
  const service = new MainnetMarkets({ config, client: { getTransactionCount: async () => 1 } }), project = { name: 'Veyl', symbol: 'VEYL' };
  await assert.rejects(service.checkDeploymentNonce(project, account, 0), /published main-token address/);
  assert.equal(await service.checkDeploymentNonce(project, account, 1), published.deployments[1].address);
});

test('position owner may change to the dead address without invalidating its verified identity', async () => {
  let ownerNow = account;
  const service = new MainnetMarkets({ config, client: { readContract: async req => req.functionName === 'ownerOf' ? ownerNow : exactLiquidity } });
  service.read = async (_a, _type, fn) => ({ positionManager: config.mainTokenLaunch.positionManager, positionId: 42n, seededTokens: exactSeed })[fn];
  const before = await service.positionStatus(other); assert.equal(before.owner, account); assert.equal(before.sentToDead, false);
  ownerNow = '0x000000000000000000000000000000000000dEaD';
  const after = await service.positionStatus(other); assert.equal(after.positionId, 42n); assert.equal(after.sentToDead, true); assert.equal(after.currentLiquidity, exactLiquidity);
});

test('burned empty NFT does not block fee inspection and a transport failure is never treated as burned', async () => {
  let transportFailure = false, liquidity = 0n;
  const service = new MainnetMarkets({ config, client: { readContract: async req => {
    if (req.functionName === 'getPositionLiquidity') return liquidity;
    throw transportFailure ? new Error('RPC unavailable') : new ContractFunctionRevertedError({ abi: [], functionName: 'ownerOf', message: 'NOT_MINTED' });
  } } });
  service.read = async (_a, _type, fn) => ({ positionManager: config.mainTokenLaunch.positionManager, positionId: 42n, seededTokens: exactSeed })[fn];
  assert.equal((await service.positionStatus(other)).burned, true);
  liquidity = 1n; await assert.rejects(service.positionStatus(other), /ownerless/);
  liquidity = 0n; transportFailure = true; await assert.rejects(service.positionStatus(other), /RPC unavailable/);
});

test('main-token browser form presents approved one-sided NFT terms without a permanent-lock claim', async () => {
  const project = { id: 'main', name: 'Veyl', symbol: 'VEYL', mainnetInfrastructure: { factory: published.deployments.find(item => item.contract === 'VeylMarketFactory').address } };
  const policy = new MainnetMarkets({ config, client: {} }).capabilities(project);
  assert.equal(policy.canPrepareLaunch, true); assert.equal(policy.canPrepareInfrastructure, false); assert.equal(policy.readiness.status, 'ready');
  const handlers = {}, element = { innerHTML: '', addEventListener: (name, handler) => { handlers[name] = handler; }, removeEventListener() {}, contains: () => true };
  const client = { wallet: { account, state: () => ({ connected: true, ethereum: true, account }) }, addEventListener() {}, removeEventListener() {}, pending: () => [], status: async () => ({ launched: false }), capabilities: async () => policy };
  const panel = mountMainnetPanel(element, { project, client, capabilities: policy });
  await panel.refresh();
  const button = { dataset: { mainnet: 'open-launch' }, disabled: false };
  await handlers.click({ target: { closest: () => button } });
  assert.match(element.innerHTML, /canonical Uniswap v4 position NFT/); assert.match(element.innerHTML, /0 ETH/);
  assert.match(element.innerHTML, /2\.000040289648088261/); assert.match(element.innerHTML, /remains withdrawable/);
  assert.doesNotMatch(element.innerHTML, /stay permanently locked|at least 980 million tokens must actually enter locked liquidity/);
  panel.destroy();
});
