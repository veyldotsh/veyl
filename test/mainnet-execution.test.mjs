import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, erc20Abi, getAddress, parseEther, zeroAddress } from 'viem';
import { MainnetMarkets, ETHEREUM_POOL_MANAGER } from '../src/mainnet.mjs';

const address = n => getAddress(`0x${n.toString(16).padStart(40, '0')}`), hash = n => `0x${n.toString(16).padStart(64, '0')}`;
const account = address(1), factory = address(2), standard = address(3), legacy = address(4), quote = address(8), supply = parseEther('1000000000'), Q96 = 1n << 96n;
const type = 'VeylAgentExecutionFactory', version = 'execution-agent-v1';
const config = { project: { name: 'Veyl', symbol: 'VEYL' }, addresses: { protocolRecipient: address(11) }, agentMarkets: { quoteAsset: quote, conversionSwapRouter: address(12), mainMarketFactory: address(13), marketFactory: legacy, sharedInfrastructure: true, standardLaunch: true, standardFactory: standard, executionLaunch: true, executionFactory: factory } };
const project = () => ({ id: 'execution-test', name: 'Research', symbol: 'READ' });

function fixture({ buy = '0', token0 = true } = {}) {
  const state = { allowance: 0n, saves: 0, timestamp: 1000n, clock: 1000000, block: 80n, calls: [], price: Q96, lower: token0 ? 0 : -887272, upper: token0 ? 887272 : 0, liquidity: 1000n, used: supply - 10n, expected: parseEther('100'), vault: address(18), existing: false };
  const actual = { creator: account, treasuryOwner: account, token: token0 ? address(5) : address(9), treasury: address(14), revenueRouter: address(15), hook: address(0x20cc), swapRouter: address(17), liquidityVault: state.vault, poolId: hash(19), quoteAsset: quote };
  const service = new MainnetMarkets({ config: structuredClone(config), now: () => state.clock, client: { getBlock: async () => ({ number: state.block, timestamp: state.timestamp }), estimateGas: async () => 100000n, readContract: async request => { state.calls.push(request); return state.allowance; } } });
  const infra = { ...service.quotePolicy(project()), quoter: address(20), marketDeployer: address(21), liquidityDeployer: address(24), manager: ETHEREUM_POOL_MANAGER, protocol: config.addresses.protocolRecipient };
  service.infrastructure = async () => infra; service.checkChain = async () => {}; service.identity = async () => {};
  service.read = async (target, name, fn, args, options) => {
    state.calls.push({ target, name, fn, args, options });
    if (fn === 'standardLaunchConfig') return [{ ...args[1], sqrtPriceX96: state.price, tickLower: state.lower, tickUpper: state.upper, liquidity: state.liquidity }, parseEther('2'), state.used, supply - state.used, Q96];
    if (fn === 'predictLaunch') return [hash(22), { ...actual, treasuryOwner: args[1].treasuryOwner, liquidityVault: state.vault }, hash(23)];
    if (fn === 'previewSeed') return token0 ? [state.used, 0n] : [0n, state.used];
    if (fn === 'previewInitialBuy') return args[2] === 0n ? [0n, 0n, state.price] : [state.expected, args[2] * 180n / 10000n, token0 ? state.price + 100n : state.price - 100n];
    if (fn === 'getMarket') return state.existing ? { ...actual, liquidityVault: state.vault } : { token: zeroAddress };
    if (fn === 'predict') { assert.equal(target, infra.liquidityDeployer); assert.equal(args[2], factory); assert.equal(args[3].tickLower, state.lower); assert.equal(args[3].tickUpper, state.upper); return state.vault; }
    throw Error(`Unexpected ${name}.${fn}`);
  };
  return { service, state, actual, infra, agent: project(), input: { account, devBuyQuote: buy }, save: () => state.saves++ };
}

test('execution mode needs its own verified pin and preserves both older market versions', () => {
  const service = new MainnetMarkets({ config: structuredClone(config), client: {} });
  let caps = service.capabilities(project());
  assert.equal(caps.factoryType, type); assert.equal(caps.marketVersion, version); assert.equal(caps.standardLaunch.pricing, 'execution'); assert.equal(caps.standardLaunch.referenceDriftBps, null);
  delete service.config.agentMarkets.executionFactory;
  assert.equal(service.capabilities(project()).canPrepareLaunch, false); assert.equal(service.capabilities(project()).factory, null);
  service.config.agentMarkets.executionFactory = factory;
  for (const [saved, expected] of [[factory, version], [standard, 'standard-agent-v1'], [legacy, 'legacy-v1']]) {
    caps = service.capabilities({ ...project(), mainnet: { factory: saved, marketVersion: expected } });
    assert.equal(caps.marketVersion, expected); assert.equal(caps.factory, saved); assert.equal(caps.canPrepareLaunch, true);
  }
  assert.equal(service.capabilities({ ...project(), mainnet: { factory, marketVersion: 'standard-agent-v1' } }).canPrepareLaunch, false);
  delete service.config.agentMarkets.executionLaunch;
  assert.equal(service.capabilities(project()).factory, standard, 'no replacement is activated implicitly');
});

test('zero-buy calldata carries identity and funding, never a saved launch price; indicative reads share one block', async () => {
  for (const token0 of [true, false]) {
    const f = fixture({ token0 }), intent = await f.service.prepareLaunch(f.agent, f.input, f.save);
    const decoded = decodeFunctionData({ abi: f.service.artifact(type).abi, data: intent.transaction.data });
    assert.equal(decoded.functionName, 'launch'); assert.equal(decoded.args[0].sqrtPriceX96, 0n); assert.equal(decoded.args[0].liquidity, 0n);
    assert.equal(decoded.args[0].treasuryOwner, account); assert.equal(decoded.args[0].maxQuote, 0n); assert.equal(intent.transaction.value, '0x0');
    assert.equal(intent.pricing, 'execution'); assert.equal(intent.allocation.creatorTokens, '0'); assert.equal(intent.launchPlan.config.sqrtPriceX96, Q96.toString());
    assert.ok(f.state.calls.filter(call => ['standardLaunchConfig', 'predictLaunch', 'previewInitialBuy'].includes(call.fn)).every(call => call.options.blockNumber === 80n));
    assert.equal(f.state.calls.some(call => call.functionName === 'allowance'), false);
    assert.equal((await f.service.prepareLaunch(f.agent, f.input, f.save)).id, intent.id, 'a still-executable intent is not silently replaced');
  }
});

test('finite approval followed by launch refreshes indicative price and minOut without changing fixed spend or historical approval', async () => {
  const f = fixture({ buy: '10' }), approval = await f.service.prepareLaunch(f.agent, f.input, f.save);
  assert.equal(approval.kind, 'approve'); assert.equal(approval.marketVersion, version);
  assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: approval.transaction.data }).args, [factory, parseEther('10')]);
  const old = structuredClone(approval); approval.status = 'confirmed'; f.state.allowance = parseEther('10');
  f.state.price *= 2n; f.state.lower = 3; f.state.expected *= 2n; f.state.vault = address(88); f.state.block++;
  const intent = await f.service.prepareLaunch(f.agent, f.input, f.save), decoded = decodeFunctionData({ abi: f.service.artifact(type).abi, data: intent.transaction.data });
  assert.equal(intent.creatorBuy.expectedTokens, '200'); assert.equal(intent.creatorBuy.minimumTokens, '199');
  assert.equal(decoded.args[2], parseEther('10')); assert.equal(decoded.args[3], parseEther('199')); assert.equal(decoded.args[0].sqrtPriceX96, 0n);
  assert.deepEqual(approval, { ...old, status: 'confirmed' });
  const saved = structuredClone(intent.launchPlan); f.agent.mainnetPlan.config.tickLower = 10;
  assert.deepEqual(intent.launchPlan, saved, 'recorded transaction owns its immutable recovery snapshot');
});

test('existing launch and uncertain outcomes cannot be rewritten or repriced before their deadline', async () => {
  const f = fixture(), intent = await f.service.prepareLaunch(f.agent, f.input, f.save), original = structuredClone(f.agent.mainnetPlan);
  await assert.rejects(f.service.prepareLaunch(f.agent, { ...f.input, reprice: true }, f.save), /still execute/);
  assert.deepEqual(f.agent.mainnetPlan, original);
  intent.status = 'unknown'; intent.transactionHash = hash(33);
  await assert.rejects(f.service.prepareLaunch(f.agent, f.input, f.save), /uncertain/);
  await assert.rejects(f.service.prepareLaunch(f.agent, { ...f.input, reprice: true }, f.save), /uncertain/);
  intent.status = 'prepared'; delete intent.transactionHash; f.state.clock = intent.expiresAt + 1;
  await assert.rejects(f.service.prepareLaunch(f.agent, f.input, f.save), /earlier launch can still execute/);
  f.state.timestamp = 1901n; f.state.clock = 1901000;
  f.state.price *= 2n; f.state.lower = 4; f.state.vault = address(77);
  const next = await f.service.prepareLaunch(f.agent, f.input, f.save);
  assert.notEqual(next.id, intent.id); assert.deepEqual(intent.launchPlan, original);
  assert.equal(intent.transaction.data, encodeFunctionData({ abi: f.service.artifact(type).abi, functionName: 'launch', args: [Object.fromEntries(Object.entries(original.launchConfig).map(([key, value]) => [key, ['dailyLimit', 'treasuryEth', 'sqrtPriceX96', 'liquidity', 'maxToken', 'maxQuote', 'minToken', 'minQuote', 'deadline'].includes(key) ? BigInt(value) : value])), original.hookSalt] }));
});

test('moving from the older factory is explicit and retains recoverable old calldata and approvals', async () => {
  const f = fixture(), current = await f.service.prepareLaunch(f.agent, f.input, f.save);
  const old = structuredClone(current.launchPlan); old.marketVersion = 'standard-agent-v1'; old.factory = standard;
  const oldIntent = structuredClone(current); oldIntent.marketVersion = 'standard-agent-v1'; oldIntent.transaction.to = standard; oldIntent.launchPlan = structuredClone(old);
  const approval = { id: 'old-approval', kind: 'approve', status: 'confirmed', transactionHash: hash(80), spender: standard, amount: '10' };
  f.agent.mainnetPlan = old; f.agent.mainnetIntents = [oldIntent, approval];
  await assert.rejects(f.service.prepareLaunch(f.agent, f.input, f.save), /different terms or factory/);
  await assert.rejects(f.service.prepareLaunch(f.agent, { ...f.input, reprice: true }, f.save), /still execute/);
  f.state.timestamp = 1901n; f.state.clock = 1901000;
  const historical = structuredClone(oldIntent), approvalBefore = structuredClone(approval);
  const intent = await f.service.prepareLaunch(f.agent, { ...f.input, reprice: true }, f.save);
  assert.equal(intent.transaction.to, factory); assert.equal(intent.marketVersion, version);
  assert.deepEqual(oldIntent, { ...historical, status: 'expired' }); assert.deepEqual(approval, approvalBefore);
  assert.equal(oldIntent.transaction.data, historical.transaction.data); assert.equal(oldIntent.launchPlan.factory, standard);
});

function event(f, name, args) {
  const abi = f.service.artifact(type).abi, item = abi.find(item => item.type === 'event' && item.name === name), plain = item.inputs.filter(input => !input.indexed);
  return { address: factory, topics: encodeEventTopics({ abi, eventName: name, args }), data: encodeAbiParameters(plain, plain.map(input => args[input.name])) };
}
function logs(f, edits = {}) {
  const id = f.agent.mainnetPlan.id, amount = BigInt(f.agent.mainnetPlan.buyQuote);
  return [event(f, 'LaunchAllocation', { id, treasuryEth: 0n, liquidityQuote: 0n, liquidityTokens: f.state.used, creatorTokens: 0n, ...edits.allocation }), event(f, 'StandardLiquidityLocked', { id, seededTokens: f.state.used, lockedDust: supply - f.state.used, referenceSqrtPriceX96: Q96 * 3n, startingFdvEth: parseEther('2.0001'), ...edits.locked }), event(f, 'StandardLaunchTerms', { id, sqrtPriceX96: f.state.price, tickLower: f.state.lower, tickUpper: f.state.upper, liquidity: f.state.liquidity, ...edits.terms }), ...(amount ? [event(f, 'CreatorBought', { id, creator: account, quotePaid: amount, tokensBought: parseEther('99.7'), ...edits.buy })] : [])];
}

test('executed terms and finite minOut accept a different real outcome but reject altered identity, allocation and output', async () => {
  const f = fixture({ buy: '10' }); f.state.allowance = parseEther('10');
  const intent = await f.service.prepareLaunch(f.agent, f.input, f.save), plan = intent.launchPlan;
  f.state.price *= 3n; f.state.lower = 5; f.state.liquidity = 2000n; f.state.used = supply - 20n;
  const actual = f.service.verifyExecutionAllocation(plan, intent, { logs: logs(f) });
  assert.equal(actual.config.tickLower, 5); assert.equal(actual.evidence.lockedDust, 20n); assert.equal(actual.evidence.creatorBuyTokens, parseEther('99.7'));
  assert.notEqual(actual.evidence.creatorBuyTokens, parseEther(plan.creatorBuy.expectedTokens));
  for (const edits of [{ allocation: { creatorTokens: 1n } }, { allocation: { liquidityQuote: 1n } }, { locked: { lockedDust: 21n } }, { locked: { startingFdvEth: parseEther('3') } }, { terms: { tickUpper: 100 } }, { buy: { creator: address(99) } }, { buy: { quotePaid: parseEther('11') } }, { buy: { tokensBought: parseEther('99') } }]) assert.throws(() => f.service.verifyExecutionAllocation(plan, intent, { logs: logs(f, edits) }));
  assert.throws(() => f.service.verifyExecutionAllocation(plan, intent, { logs: logs(f).filter(log => log.topics[0] !== logs(f)[2].topics[0]) }), /one StandardLaunchTerms/);
  const changed = structuredClone(plan); changed.launchConfig.operator = address(99);
  assert.throws(() => f.service.verifyExecutionAllocation(changed, intent, { logs: logs(f) }), /calldata/);
});

test('canonical receipt imports the execution vault only after runtime relationships and actual-range derivation pass', async () => {
  const f = fixture(), intent = await f.service.prepareLaunch(f.agent, f.input, f.save), before = structuredClone(intent.launchPlan);
  f.state.existing = true; f.state.vault = address(90); f.state.lower = 5; f.state.liquidity = 2000n; f.state.used = supply - 20n;
  const launch = event(f, 'MarketLaunched', { id: before.id, ...f.actual, liquidityVault: f.state.vault });
  f.service.client.getTransaction = async () => ({ from: account, to: factory, input: intent.transaction.data, value: 0n, chainId: 1 });
  f.service.client.getTransactionReceipt = async () => ({ transactionHash: hash(77), blockNumber: 100n, blockHash: hash(88), status: 'success', logs: [launch, ...logs(f)] });
  f.service.client.getBlock = async () => ({ hash: hash(88), timestamp: 1000n }); f.service.client.getBlockNumber = async () => 101n;
  let checked = 0;
  f.service.validateMarket = async candidate => { checked++; assert.equal(candidate.mainnet.liquidityVault, f.state.vault); assert.equal(candidate.mainnetPlan.config.tickLower, 5); assert.equal(candidate.mainnetPlan.tokenUsed, f.state.used.toString()); return f.infra; };
  const originalRead = f.service.read;
  f.service.read = async (...args) => args[2] === 'predict' ? address(91) : originalRead(...args);
  await assert.rejects(f.service.verify(f.agent, { intentId: intent.id, transactionHash: hash(77) }, f.save), /Executed liquidity vault/);
  assert.equal(f.agent.mainnet, undefined); assert.deepEqual(intent.launchPlan, before);
  f.service.read = originalRead;
  assert.equal((await f.service.verify(f.agent, { intentId: intent.id, transactionHash: hash(77) }, f.save)).status, 'confirmed');
  assert.equal(checked, 2); assert.equal(f.agent.mainnet.liquidityVault, address(90)); assert.equal(f.agent.mainnet.marketVersion, version);
  assert.deepEqual(intent.launchPlan, before);
});

test('policy3 infrastructure checks execution pricing and cannot authenticate old or arbitrary code through getter values alone', async () => {
  const service = new MainnetMarkets({ config, client: {} }), identities = [];
  const fields = { poolManager: ETHEREUM_POOL_MANAGER, protocol: config.addresses.protocolRecipient, quoteAsset: quote, conversionSwapRouter: config.agentMarkets.conversionSwapRouter, quoter: address(40), projectBuilder: address(41), marketBuilder: address(42), liquidityBuilder: address(43), projectDeployer: address(44), marketDeployer: address(45), liquidityDeployer: address(46), LAUNCH_POLICY_VERSION: 3n, TOKEN_SUPPLY: supply, TARGET_FDV_ETH: parseEther('2'), MAX_SEED_DUST: 1000000n, EXECUTION_PRICED: true, referenceHook: address(47) };
  service.checkChain = async () => {}; service.identity = async (_address, name) => identities.push(name);
  service.validateQuoteAsset = async () => ({ ...service.quotePolicy(project()), conversionHook: address(47) });
  service.read = async (target, _name, field) => target === factory ? fields[field] : field === 'factory' ? factory : fields[field];
  assert.equal((await service.infrastructure(project())).factoryType, type); assert.ok(identities.includes(type));
  for (const [field, value] of [['LAUNCH_POLICY_VERSION', 2n], ['EXECUTION_PRICED', false], ['TOKEN_SUPPLY', supply - 1n], ['referenceHook', address(99)]]) { const old = fields[field]; fields[field] = value; await assert.rejects(service.infrastructure(project()), /policy or canonical price reference/); fields[field] = old; }
  service.identity = async () => { throw Error('Runtime does not match'); };
  await assert.rejects(service.infrastructure(project()), /Runtime does not match/);
});
