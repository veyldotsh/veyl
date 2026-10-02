import test from 'node:test';
import assert from 'node:assert/strict';
import { BaseError, ContractFunctionRevertedError, decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeEventTopics, erc20Abi, getAddress, parseEther, zeroAddress } from 'viem';
import { MainnetMarkets, ETHEREUM_POOL_MANAGER } from '../src/mainnet.mjs';

const address = n => getAddress(`0x${n.toString(16).padStart(40, '0')}`), hash = n => `0x${n.toString(16).padStart(64, '0')}`;
const account = address(1), factory = address(2), legacy = address(3), token = address(4), quote = address(8), Q96 = 1n << 96n, supply = parseEther('1000000000');
const type = 'VeylAgentLaunchFactory';
const config = { project: { name: 'Veyl', symbol: 'VEYL' }, addresses: { protocolRecipient: address(11) }, agentMarkets: { quoteAsset: quote, conversionSwapRouter: address(12), mainMarketFactory: address(13), marketFactory: legacy, sharedInfrastructure: true, standardLaunch: true, standardFactory: factory } };
const project = () => ({ id: 'standard-test', name: 'Research', symbol: 'READ' });

function fixture({ token0 = true, buy = '0' } = {}) {
  const state = { allowance: 0n, saves: 0, timestamp: 1000n, clock: 1000000, requests: [], rejectReference: false, mutateConfig: null, mutateQuote: null, seedQuote: 0n, existing: false };
  const actual = { creator: account, treasuryOwner: account, token: token0 ? token : address(9), treasury: address(14), revenueRouter: address(15), hook: address(16), swapRouter: address(17), liquidityVault: address(18), poolId: hash(19), quoteAsset: quote };
  const service = new MainnetMarkets({ config: structuredClone(config), now: () => state.clock, client: {
    getBlock: async () => ({ timestamp: state.timestamp }), estimateGas: async () => 100000n,
    readContract: async request => { state.requests.push(request); return state.allowance; }
  } });
  const infra = { ...service.quotePolicy(project()), quoter: address(20), marketDeployer: address(21), manager: ETHEREUM_POOL_MANAGER, protocol: config.addresses.protocolRecipient };
  service.infrastructure = async () => infra;
  service.checkChain = async () => {};
  service.read = async (target, name, fn, args) => {
    state.requests.push({ target, name, fn, args });
    if (fn === 'standardLaunchConfig') {
      const derived = { ...args[1], sqrtPriceX96: Q96, tickLower: token0 ? 0 : -887272, tickUpper: token0 ? 887272 : 0, liquidity: 1000n };
      state.mutateConfig?.(derived);
      return [derived, parseEther('2'), supply - 10n, 10n, Q96];
    }
    if (fn === 'predictLaunch') return [hash(22), { ...actual, treasuryOwner: args[1].treasuryOwner }, hash(23)];
    if (fn === 'previewSeed') return token0 ? [supply - 10n, state.seedQuote] : [state.seedQuote, supply - 10n];
    if (fn === 'previewInitialBuy') {
      if (state.rejectReference) throw new Error('ReferencePriceMoved');
      const result = args[2] === 0n ? [0n, 0n, Q96] : [parseEther('100'), args[2] * 180n / 10000n, token0 ? Q96 + 100n : Q96 - 100n];
      state.mutateQuote?.(result); return result;
    }
    if (fn === 'getMarket') return state.existing ? actual : { token: zeroAddress };
    throw new Error(`Unexpected ${name}.${fn}`);
  };
  return { service, agent: project(), input: { account, devBuyQuote: buy }, state, actual, infra, save: () => state.saves++ };
}

test('standard mode cannot fall back to the old factory and preserves explicitly pinned launched versions', async () => {
  const service = new MainnetMarkets({ config: structuredClone(config), client: {} });
  let caps = service.capabilities(project());
  assert.equal(caps.factory, factory); assert.equal(caps.factoryType, type); assert.equal(caps.standardLaunch.enabled, true);
  assert.equal(caps.standardLaunch.allocationBps, 10000); assert.equal(caps.tickSpacing, 1); assert.equal(caps.canPrepareInfrastructure, false);
  delete service.config.agentMarkets.standardFactory;
  caps = service.capabilities(project());
  assert.equal(caps.factory, null); assert.equal(caps.canPrepareLaunch, false); assert.equal(caps.canPrepareInfrastructure, false);
  service.config.agentMarkets.standardFactory = factory;
  for (const [deployed, version] of [[legacy, 'legacy-v1'], [factory, 'standard-agent-v1']]) {
    const agent = { ...project(), mainnet: { factory: deployed }, mainnetInfrastructure: { factory: deployed } };
    assert.equal(service.capabilities(agent).factory, deployed); assert.equal(service.capabilities(agent).marketVersion, version); assert.equal(service.capabilities(agent).canPrepareLaunch, true);
  }
  for (const saved of [{ factory: address(99) }, { factory, marketVersion: 'legacy-v1' }, { factory: legacy, marketVersion: 'standard-agent-v1' }]) assert.equal(service.capabilities({ ...project(), mainnet: saved }).canPrepareLaunch, false);
  assert.equal(service.capabilities({ name: 'Veyl', symbol: 'VEYL' }).standardLaunch.enabled, false);
});

test('standard requests default to zero funding and reject every economic or arbitrary input', () => {
  const service = new MainnetMarkets({ config, client: {} });
  const result = service.standardRequest(project(), { account }, 10n);
  assert.equal(result.config.treasuryOwner, account); assert.equal(result.config.operator, account);
  assert.equal(result.buyQuote, 0n); assert.equal(result.config.treasuryEth, 0n); assert.equal(result.config.dailyLimit, 0n);
  assert.equal(result.config.maxToken, supply); assert.equal(result.config.launchProtection, false);
  for (const field of ['liquidityTokens', 'liquidityQuote', 'liquidityEth', 'tokensPerQuote', 'sqrtPriceX96', 'tickLower', 'tickUpper', 'buyFeeBps', 'launchProtection', 'salt', 'factory', 'minDevBuyTokens']) assert.throws(() => service.standardRequest(project(), { account, [field]: '0' }, 10n), /derive all/);
  for (const input of [{ devBuyQuote: '-1' }, { devBuyQuote: 1 }, { slippageBps: 501 }, { operator: zeroAddress }]) assert.throws(() => service.standardRequest(project(), { account, ...input }, 10n));
});

test('zero-buy launch derives fixed terms, locks supply including dust, and never requests a VEYL allowance', async () => {
  for (const token0 of [true, false]) {
    const f = fixture({ token0 });
    const intent = await f.service.prepareLaunch(f.agent, f.input, f.save);
    assert.equal(intent.kind, 'launch'); assert.equal(intent.transaction.value, '0x0'); assert.equal(intent.transaction.to, factory);
    const decoded = decodeFunctionData({ abi: f.service.artifact(type).abi, data: intent.transaction.data });
    assert.equal(decoded.functionName, 'launch'); assert.equal(decoded.args[0].maxToken, supply); assert.equal(decoded.args[0].maxQuote, 0n);
    assert.equal(intent.allocation.creatorTokens, '0'); assert.equal(intent.allocation.lockedDustTokens, '0.00000000000000001'); assert.equal(intent.allocation.permanentlyLocked, true);
    assert.equal(parseEther(intent.allocation.liquidityTokens) + parseEther(intent.allocation.lockedDustTokens), supply);
    assert.equal(f.state.requests.some(call => call.functionName === 'allowance'), false);
    assert.equal(intent.tokenIsCurrency0, token0); assert.equal(f.agent.mainnetPlan.marketVersion, 'standard-agent-v1');
    assert.equal((await f.service.prepareLaunch(f.agent, f.input, f.save)).id, intent.id);
  }
});

test('optional creator buy returns exact finite approval, then a bounded atomic launch after a separate owner action', async () => {
  const f = fixture({ buy: '10' });
  const approval = await f.service.prepareLaunch(f.agent, f.input, f.save);
  assert.equal(approval.kind, 'approve'); assert.equal(approval.purpose, 'launch-creator-buy'); assert.equal(approval.transaction.value, '0x0');
  assert.equal(approval.marketVersion, 'standard-agent-v1');
  const allowance = decodeFunctionData({ abi: erc20Abi, data: approval.transaction.data });
  assert.deepEqual(allowance.args, [factory, parseEther('10')]); assert.equal(approval.creatorBuy.minimumTokens, '99.5');
  f.state.allowance = parseEther('10'); approval.status = 'confirmed';
  const intent = await f.service.prepareLaunch(f.agent, f.input, f.save);
  const decoded = decodeFunctionData({ abi: f.service.artifact(type).abi, data: intent.transaction.data });
  assert.equal(decoded.functionName, 'launchAndBuy'); assert.equal(decoded.args[2], parseEther('10')); assert.equal(decoded.args[3], parseEther('99.5'));
  assert.equal(intent.allocation.creatorTokens, '0'); assert.equal(intent.creatorBuy.expectedTokens, '100'); assert.equal(intent.transaction.value, '0x0');
  assert.equal(f.state.requests.filter(call => call.fn === 'standardLaunchConfig').length, 1, 'approval cannot silently replace the originally derived plan');
});

test('legacy or changed saved plans and changed reference price cannot silently reprice or reauthorize a launch', async () => {
  const f = fixture({ buy: '10' });
  await f.service.prepareLaunch(f.agent, f.input, f.save);
  const saved = structuredClone(f.agent.mainnetPlan), saves = f.state.saves;
  for (const input of [{ ...f.input, devBuyQuote: '11' }, { ...f.input, treasuryEth: '0.01' }, { ...f.input, account: address(6) }]) await assert.rejects(f.service.prepareLaunch(f.agent, input, f.save), /different terms/);
  assert.deepEqual(f.agent.mainnetPlan, saved); assert.equal(f.state.saves, saves);
  f.state.rejectReference = true;
  await assert.rejects(f.service.prepareLaunch(f.agent, f.input, f.save), /ReferencePriceMoved/);
  assert.deepEqual(f.agent.mainnetPlan, saved);
  const legacyFixture = fixture(); legacyFixture.agent.mainnetPlan = { marketVersion: 'legacy-v1', factory: legacy };
  await assert.rejects(legacyFixture.service.prepareLaunch(legacyFixture.agent, legacyFixture.input, legacyFixture.save), /legacy factory/);
  assert.equal(legacyFixture.state.saves, 0);
});

test('malformed helper economics, seed settlement and initial buy quotes reject before any plan or intent', async () => {
  for (const mutation of [c => c.maxToken--, c => c.buyFeeBps = 0, c => c.tickSpacing = 200, c => c.launchProtection = true, c => c.treasuryOwner = address(99), c => c.name = 'Different']) {
    const f = fixture(); f.state.mutateConfig = mutation;
    await assert.rejects(f.service.prepareLaunch(f.agent, f.input, f.save)); assert.equal(f.state.saves, 0); assert.equal(f.agent.mainnetPlan, undefined);
  }
  const seeded = fixture(); seeded.state.seedQuote = 1n;
  await assert.rejects(seeded.service.prepareLaunch(seeded.agent, seeded.input, seeded.save), /one-sided allocation/); assert.equal(seeded.state.saves, 0);
  const quoteFixture = fixture({ buy: '10' }); quoteFixture.state.mutateQuote = result => result[1]++;
  await assert.rejects(quoteFixture.service.prepareLaunch(quoteFixture.agent, quoteFixture.input, quoteFixture.save), /exact-output preview/); assert.equal(quoteFixture.state.saves, 0);
});

function eventLog(service, eventName, args) {
  const abi = service.artifact(type).abi, item = abi.find(item => item.type === 'event' && item.name === eventName);
  const plain = item.inputs.filter(input => !input.indexed);
  return { address: factory, topics: encodeEventTopics({ abi, eventName, args }), data: encodeAbiParameters(plain, plain.map(input => args[input.name])) };
}

function standardLogs(f, overrides = {}) {
  const plan = f.agent.mainnetPlan;
  const allocation = { id: plan.id, treasuryEth: 0n, liquidityQuote: 0n, liquidityTokens: supply - 10n, creatorTokens: 0n, ...overrides.allocation };
  const locked = { id: plan.id, seededTokens: supply - 10n, lockedDust: 10n, referenceSqrtPriceX96: Q96, startingFdvEth: parseEther('2.001'), ...overrides.locked };
  const logs = [eventLog(f.service, 'LaunchAllocation', allocation), eventLog(f.service, 'StandardLiquidityLocked', locked)];
  if (BigInt(plan.buyQuote) > 0n || overrides.buy) logs.push(eventLog(f.service, 'CreatorBought', { id: plan.id, creator: account, quotePaid: BigInt(plan.buyQuote), tokensBought: parseEther('100'), ...overrides.buy }));
  return logs;
}

test('standard receipt binds exact full-supply locked allocation, creator buy amount and recipient', async () => {
  const f = fixture({ buy: '10' }); f.state.allowance = parseEther('10');
  const intent = await f.service.prepareLaunch(f.agent, f.input, f.save), plan = f.agent.mainnetPlan;
  const verified = f.service.verifyStandardAllocation(plan, intent, { logs: standardLogs(f) });
  assert.equal(verified.marketVersion, 'standard-agent-v1'); assert.equal(verified.creatorBuyTokens, parseEther('100'));
  assert.equal(verified.startingFdvEth, parseEther('2.001'), 'execution valuation is recorded rather than invented from the earlier quote');
  for (const overrides of [{ allocation: { creatorTokens: 1n } }, { allocation: { liquidityQuote: 1n } }, { locked: { lockedDust: 11n } }, { locked: { startingFdvEth: parseEther('2.02') } }, { buy: { creator: address(99) } }, { buy: { quotePaid: parseEther('11') } }, { buy: { tokensBought: parseEther('99') } }]) assert.throws(() => f.service.verifyStandardAllocation(plan, intent, { logs: standardLogs(f, overrides) }), /receipt/);
  assert.throws(() => f.service.verifyStandardAllocation(plan, intent, { logs: [...standardLogs(f), standardLogs(f)[0]] }), /requires one/);
  const original = plan.config.deadline; plan.config.deadline = (BigInt(original) + 900n).toString();
  assert.doesNotThrow(() => f.service.verifyStandardAllocation(plan, intent, { logs: standardLogs(f) }), 'an earlier exact recorded intent remains verifiable after a later preparation refreshed its deadline');
  plan.config.buyFeeBps = 0;
  assert.throws(() => f.service.verifyStandardAllocation(plan, intent, { logs: standardLogs(f) }), /calldata/);
});

test('zero-buy receipt rejects any fabricated creator acquisition', async () => {
  const f = fixture(); const intent = await f.service.prepareLaunch(f.agent, f.input, f.save);
  assert.equal(f.service.verifyStandardAllocation(f.agent.mainnetPlan, intent, { logs: standardLogs(f) }).creatorBuyTokens, 0n);
  assert.throws(() => f.service.verifyStandardAllocation(f.agent.mainnetPlan, intent, { logs: standardLogs(f, { buy: { quotePaid: 1n } }) }), /Creator buy receipt/);
});

test('confirmed standard receipt uses the new factory ABI and keeps versioned market evidence', async () => {
  const f = fixture(); const intent = await f.service.prepareLaunch(f.agent, f.input, f.save), plan = f.agent.mainnetPlan;
  const launch = eventLog(f.service, 'MarketLaunched', { id: plan.id, ...f.actual });
  f.state.existing = true;
  f.service.client.getTransaction = async () => ({ from: account, to: factory, input: intent.transaction.data, value: 0n, chainId: 1 });
  f.service.client.getTransactionReceipt = async () => ({ transactionHash: hash(77), blockNumber: 100n, blockHash: hash(88), status: 'success', logs: [launch, ...standardLogs(f)] });
  f.service.client.getBlock = async () => ({ hash: hash(88), timestamp: 1000n }); f.service.client.getBlockNumber = async () => 101n;
  f.service.validateMarket = async candidate => { assert.equal(candidate.mainnet.marketVersion, 'standard-agent-v1'); assert.equal(candidate.mainnet.factory, factory); return {}; };
  const result = await f.service.verify(f.agent, { intentId: intent.id, transactionHash: hash(77) }, f.save);
  assert.equal(result.status, 'confirmed'); assert.equal(f.agent.mainnet.lockedDust, '10'); assert.equal(f.agent.mainnet.creatorBuyTokens, '0');
  assert.ok(f.state.requests.filter(call => call.fn === 'getMarket').every(call => call.name === type));
});

test('explicit repricing waits for launch expiry, preserves old receipt evidence, and never discards an uncertain hash', async () => {
  const f = fixture(); const first = await f.service.prepareLaunch(f.agent, f.input, f.save), original = structuredClone(f.agent.mainnetPlan);
  const next = { ...f.input, devBuyQuote: '10', reprice: true };
  await assert.rejects(f.service.prepareLaunch(f.agent, next, f.save), /still execute/);
  assert.deepEqual(f.agent.mainnetPlan, original);
  f.state.timestamp = 1901n; f.state.clock = 1901000;
  first.transactionHash = hash(77); first.status = 'unknown';
  await assert.rejects(f.service.prepareLaunch(f.agent, next, f.save), /uncertain transaction/);
  assert.deepEqual(f.agent.mainnetPlan, original);
  delete first.transactionHash; first.status = 'prepared'; f.state.existing = true;
  await assert.rejects(f.service.prepareLaunch(f.agent, next, f.save), /already exists/);
  assert.deepEqual(f.agent.mainnetPlan, original);
  f.state.existing = false;
  const approval = await f.service.prepareLaunch(f.agent, next, f.save);
  assert.equal(approval.kind, 'approve'); assert.equal(first.status, 'expired'); assert.deepEqual(first.launchPlan, original);
  assert.equal(f.agent.mainnetPlan.buyQuote, parseEther('10').toString()); assert.notEqual(f.agent.mainnetPlan.fingerprint, original.fingerprint);
  const oldProject = f.agent.mainnetPlan; f.agent.mainnetPlan = first.launchPlan;
  const oldLogs = standardLogs(f); f.agent.mainnetPlan = oldProject;
  assert.equal(f.service.verifyStandardAllocation(first.launchPlan, first, { logs: oldLogs }).creatorBuyTokens, 0n);
});

test('explicit review can change a buy before launch preparation while retaining finite approval history', async () => {
  const f = fixture({ buy: '10' }); const oldApproval = await f.service.prepareLaunch(f.agent, f.input, f.save);
  const replacement = await f.service.prepareLaunch(f.agent, { account, devBuyQuote: '5', reprice: true }, f.save);
  assert.equal(replacement.kind, 'approve'); assert.equal(replacement.amount, parseEther('5').toString());
  assert.equal(oldApproval.status, 'prepared', 'ERC20 approvals are not falsely marked expired onchain');
  assert.equal(f.agent.mainnetIntents.includes(oldApproval), true); assert.notEqual(replacement.id, oldApproval.id);
});

test('standard infrastructure validates the distinct compiled factory, version, fixed constants and canonical reference', async () => {
  const service = new MainnetMarkets({ config, client: {} }), agent = project(), identities = [];
  const fields = { poolManager: ETHEREUM_POOL_MANAGER, protocol: config.addresses.protocolRecipient, quoteAsset: quote, conversionSwapRouter: config.agentMarkets.conversionSwapRouter,
    quoter: address(40), projectBuilder: address(41), marketBuilder: address(42), liquidityBuilder: address(43), projectDeployer: address(44), marketDeployer: address(45), liquidityDeployer: address(46),
    LAUNCH_POLICY_VERSION: 2n, TOKEN_SUPPLY: supply, TARGET_FDV_ETH: parseEther('2'), MAX_SEED_DUST: 1000000n, MAX_REFERENCE_DRIFT_BPS: 50, referenceHook: address(47) };
  service.checkChain = async () => {}; service.identity = async (_address, name) => identities.push(name);
  service.validateQuoteAsset = async () => ({ ...service.quotePolicy(agent), conversionHook: address(47) });
  service.read = async (target, _name, field) => target === factory ? fields[field] : field === 'factory' ? factory : fields[field];
  const infra = await service.infrastructure(agent);
  assert.equal(infra.factoryType, type); assert.ok(identities.includes(type)); assert.equal(identities.includes('VeylMarketFactory'), false);
  for (const [field, bad] of [['LAUNCH_POLICY_VERSION', 1n], ['TARGET_FDV_ETH', parseEther('3')], ['MAX_SEED_DUST', 1000001n], ['MAX_REFERENCE_DRIFT_BPS', 100], ['referenceHook', address(99)]]) {
    const previous = fields[field]; fields[field] = bad;
    await assert.rejects(service.infrastructure(agent), /policy or canonical price reference/); fields[field] = previous;
  }
});

test('standard market validation keeps permanent vault ownership and fixed fees distinct from legacy creator refunds', async () => {
  const f = fixture(); await f.service.prepareLaunch(f.agent, f.input, f.save);
  f.agent.mainnet = { ...f.actual, id: f.agent.mainnetPlan.id, factory, marketVersion: 'standard-agent-v1' };
  const state = { tokenRefundRecipient: factory, refundRecipient: factory, seeded: true, lockedLiquidity: 1000n, tickLower: 0, tickUpper: 887272, buyFeeBps: 180, sellFeeBps: 180, lpFee: 0, tickSpacing: 1 };
  f.service.identity = async () => {};
  f.service.read = async (_target, name, field) => {
    if (field === 'getMarket') return f.actual;
    if (field === 'quoteAsset') return quote;
    if (field === 'tokenIsCurrency0') return true;
    if (field === 'poolManager') return ETHEREUM_POOL_MANAGER;
    if (field === 'hook') return f.actual.hook;
    if (name === 'QuoteRevenueRouter') return { treasury: f.actual.treasury, creator: account, protocol: config.addresses.protocolRecipient, conversionSwapRouter: config.agentMarkets.conversionSwapRouter }[field];
    if (name === 'VeylFeeHook') return { token: f.actual.token, revenueRouter: f.actual.revenueRouter, ...state }[field];
    if (name === 'AgentToken') return { launchProtectionEnabled: false, launchFactory: factory, activated: false, launchBlock: 0n, bootstrapVault: zeroAddress }[field];
    return state[field];
  };
  assert.equal((await f.service.validateMarket(f.agent)).liquidityCustody, 'permanently-locked');
  for (const [field, bad] of [['tokenRefundRecipient', account], ['refundRecipient', account], ['seeded', false], ['lockedLiquidity', 999n], ['buyFeeBps', 0], ['lpFee', 100], ['tickSpacing', 200]]) {
    const previous = state[field]; state[field] = bad;
    await assert.rejects(f.service.validateMarket(f.agent), /relationships|liquidity or immutable fee/); state[field] = previous;
  }
});

test('every standard factory read explains reference-price drift without masking other RPC or contract failures', async () => {
  const f = fixture(), abi = f.service.artifact(type).abi;
  const drift = new ContractFunctionRevertedError({ abi, functionName: 'predictLaunch', data: encodeErrorResult({ abi, errorName: 'ReferencePriceMoved' }) });
  const cause = new BaseError('Read failed', { cause: drift });
  f.service.read = async () => { throw cause; };
  for (const name of ['standardLaunchConfig', 'predictLaunch', 'previewInitialBuy']) await assert.rejects(f.service.standardRead(factory, name), error => error.status === 409 && /0.5%.*explicitly refresh/.test(error.message));
  const rpc = new Error('RPC unavailable'); f.service.read = async () => { throw rpc; };
  await assert.rejects(f.service.standardRead(factory, 'predictLaunch'), error => error === rpc);
  const invalid = new ContractFunctionRevertedError({ abi, functionName: 'predictLaunch', data: encodeErrorResult({ abi, errorName: 'InvalidLaunchTerms' }) });
  f.service.read = async () => { throw invalid; };
  await assert.rejects(f.service.standardRead(factory, 'predictLaunch'), error => error === invalid);
  const early = fixture(), originalRead = early.service.read;
  early.service.read = async (target, name, fn, args) => { if (fn === 'predictLaunch') throw cause; return originalRead(target, name, fn, args); };
  await assert.rejects(early.service.prepareLaunch(early.agent, early.input, early.save), error => error.status === 409 && /explicitly refresh/.test(error.message));
  assert.equal(early.state.saves, 0);
});
