import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, erc721Abi, zeroAddress } from 'viem';
import { MainnetMarkets, ETHEREUM_POSITION_MANAGER } from '../src/mainnet.mjs';
import { predictPublicAddresses } from '../scripts/predict-public-addresses.mjs';

const config = JSON.parse(readFileSync(new URL('../config/mainnet.json', import.meta.url))), plan = predictPublicAddresses({ config });
const account = config.addresses.deployer, transactionHash = '0x' + 'a'.repeat(64), blockHash = '0x' + 'b'.repeat(64), other = '0x' + '1'.repeat(40);
function fixture() {
  const service = new MainnetMarkets({ config, client: {}, now: () => 1000000 });
  const infra = { ...Object.fromEntries(plan.deployments.map((item, i) => [['quoter', 'projectBuilder', 'marketBuilder', 'liquidityBuilder', 'factory'][i], item.address])), ...Object.fromEntries(plan.factoryChildren.map((item, i) => [['projectDeployer', 'marketDeployer', 'liquidityDeployer'][i], item.address])), quoteKind: 'native', quoteAsset: zeroAddress, conversionSwapRouter: zeroAddress };
  const { config: launch } = service.launchConfig({ name: 'Veyl', symbol: 'VEYL' }, { account, treasuryOwner: account, operator: account, treasuryEth: '0', dailyLimitEth: '0' }, 10n);
  Object.assign(launch, { liquidity: 43827373799693085948824n, maxToken: 980000000000000000000012538n });
  const hookSalt = '0x' + '0'.repeat(63) + '1', market = { creator: account, treasuryOwner: account, token: plan.token.address, treasury: other, revenueRouter: other, hook: other, swapRouter: other, liquidityVault: other, poolId: blockHash, quoteAsset: zeroAddress };
  const factoryAbi = service.artifact('VeylMarketFactory').abi;
  const tx = { from: account, to: infra.factory, chainId: 1, nonce: 5, value: 0n, input: encodeFunctionData({ abi: factoryAbi, functionName: 'launch', args: [launch, hookSalt] }) };
  const receipt = { transactionHash, blockNumber: 100n, blockHash, status: 'success', logs: [
    { address: infra.factory, topics: encodeEventTopics({ abi: factoryAbi, eventName: 'MarketLaunched', args: { id: plan.token.marketId, creator: account, token: market.token } }), data: encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }], [market.treasury, market.revenueRouter, market.hook, market.swapRouter, market.liquidityVault, market.poolId]) },
    { address: ETHEREUM_POSITION_MANAGER, topics: encodeEventTopics({ abi: erc721Abi, eventName: 'Transfer', args: { from: zeroAddress, to: account, tokenId: 42n } }), data: '0x' }
  ] };
  service.checkChain = async () => {};
  service.infrastructure = async () => infra;
  service.client = { getTransaction: async () => tx, getTransactionReceipt: async () => receipt, getBlock: async () => ({ hash: blockHash }), getBlockNumber: async () => 101n };
  service.read = async (_a, _name, fn) => fn === 'predictLaunch' ? [plan.token.marketId, market] : fn === 'getMarket' ? market : fn === 'owner' ? account : assert.fail(fn);
  let checked = 0, saved = 0;
  service.validateMarket = async project => { checked++; assert.equal(project.mainnetPlan.config.launchProtection, true); assert.equal(project.mainnet.token, plan.token.address); return { ...market, position: { positionId: 42n } }; };
  const project = { id: 'owner-workspace', name: 'Veyl', symbol: 'VEYL' }, input = { account, transactionHash }, checkpoint = () => saved++;
  const changeLaunch = fields => { Object.assign(launch, fields); tx.input = encodeFunctionData({ abi: factoryAbi, functionName: 'launch', args: [launch, hookSalt] }); };
  return { service, project, input, checkpoint, tx, receipt, market, infra, changeLaunch, counts: () => ({ checked, saved }) };
}

test('canonical main adoption reuses full receipt verification and is idempotent without overwriting the workspace', async () => {
  const f = fixture(), result = await f.service.adoptMainnet(f.project, f.input, f.checkpoint);
  assert.equal(result.token, plan.token.address); assert.equal(result.hash, transactionHash); assert.equal(result.positionId, '42');
  assert.equal(f.project.id, 'owner-workspace'); assert.equal(f.project.mainnetIntents.length, 1); assert.equal(f.project.mainnetIntents[0].status, 'confirmed');
  assert.equal(f.project.mainnetIntents[0].source, 'verified-platform-adoption'); assert.deepEqual(f.counts(), { checked: 1, saved: 1 });
  const again = await f.service.adoptMainnet(f.project, f.input, f.checkpoint); assert.deepEqual(again, result); assert.deepEqual(f.counts(), { checked: 2, saved: 1 });
  await assert.rejects(f.service.adoptMainnet(f.project, { ...f.input, transactionHash: blockHash }, f.checkpoint), /another verified launch/);
});

test('wrong owner, project, transaction, launch terms, token and helper addresses reject without binding', async () => {
  const cases = [
    f => { f.input.account = other; }, f => { f.project.name = 'Someone else'; }, f => { f.project.symbol = 'VEYL2'; },
    f => { f.tx.from = other; }, f => { f.tx.to = other; }, f => { f.tx.chainId = 8453; }, f => { f.tx.nonce = 6; }, f => { f.tx.value = 1n; },
    f => f.changeLaunch({ salt: blockHash }), f => f.changeLaunch({ name: 'veyl' }), f => f.changeLaunch({ treasuryOwner: other }), f => f.changeLaunch({ operator: other }),
    f => f.changeLaunch({ dailyLimit: 1n }), f => f.changeLaunch({ treasuryEth: 1n }), f => f.changeLaunch({ launchProtection: false }), f => f.changeLaunch({ maxToken: 980000000000000000000012539n }),
    f => { f.market.token = other; }, f => { f.infra.quoter = other; }, f => { f.project.mainnetPlan = { id: plan.token.marketId }; }
  ];
  for (const alter of cases) { const f = fixture(); alter(f); const before = JSON.stringify(f.project); await assert.rejects(f.service.adoptMainnet(f.project, f.input, f.checkpoint)); assert.equal(JSON.stringify(f.project), before); assert.equal(f.counts().saved, 0); }
});

test('reverted, unconfirmed, reorged, mismatched and missing-NFT receipts never enter project state', async () => {
  for (const alter of [
    f => { f.receipt.status = 'reverted'; }, f => { f.service.client.getBlockNumber = async () => 100n; }, f => { f.service.client.getBlock = async () => ({ hash: transactionHash }); },
    f => { f.receipt.transactionHash = blockHash; }, f => { f.receipt.logs = f.receipt.logs.slice(0, 1); }, f => { f.receipt.logs[0].address = other; },
    f => { f.service.validateMarket = async () => { throw new Error('Runtime or immutable binding mismatch'); }; }
  ]) { const f = fixture(); alter(f); await assert.rejects(f.service.adoptMainnet(f.project, f.input, f.checkpoint)); assert.equal(f.project.mainnet, undefined); assert.equal(f.project.mainnetPlan, undefined); assert.equal(f.project.mainnetIntents, undefined); assert.equal(f.counts().saved, 0); }
});

test('historical launch ownership cannot import a treasury whose current owner changed', async () => {
  for (const alreadyImported of [false, true]) {
    const f = fixture(); if (alreadyImported) await f.service.adoptMainnet(f.project, f.input, f.checkpoint);
    const read = f.service.read; f.service.read = async (...args) => args[2] === 'owner' ? other : read(...args);
    const before = JSON.stringify(f.project), saved = f.counts().saved;
    await assert.rejects(f.service.adoptMainnet(f.project, f.input, f.checkpoint), /no longer.*owner/);
    assert.equal(JSON.stringify(f.project), before); assert.equal(f.counts().saved, saved);
  }
});
