import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeFunctionData, encodeAbiParameters, encodeDeployData, getCreate2Address, keccak256, parseEther, stringToHex, zeroAddress } from 'viem';
import { MainnetMarkets, VEYL_MAIN_TOKEN_SALT, ETHEREUM_POOL_MANAGER } from '../src/mainnet.mjs';
import { predictPublicAddresses } from '../scripts/predict-public-addresses.mjs';
const config = JSON.parse(readFileSync(new URL('../config/mainnet.json', import.meta.url)));
const published = JSON.parse(readFileSync(new URL('../config/public-addresses.json', import.meta.url)));
const account = config.addresses.deployer, owner = config.addresses.owner, other = '0x1111111111111111111111111111111111111111';
const terms = { account, treasuryOwner: owner, operator: other, dailyLimitEth: '0.01', treasuryEth: '0', liquidityEth: '10', liquidityTokens: '1000000000', sqrtPriceX96: ((1n << 96n) * 10000n).toString(), tickLower: -887200, tickUpper: 887200 };

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
    if (fn === 'previewLiquidity') return [10n ** 18n, parseEther('10'), parseEther('990000000')];
    assert.equal(fn, 'predictLaunch');
    const [creator, launch] = args, id = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [creator, launch.salt]));
    const artifact = service.artifact('AgentToken');
    const init = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [launch.name, launch.symbol, addresses.VeylMarketFactory, launch.launchProtection, ETHEREUM_POOL_MANAGER] });
    return [id, { token: getCreate2Address({ from: children.VeylProjectDeployer, salt: id, bytecodeHash: keccak256(init) }), quoteAsset: zeroAddress }, '0x' + '1'.repeat(64)];
  };
  for (const id of ['first-workspace', 'different-workspace']) {
    const project = { id, name: 'Veyl', symbol: 'VEYL' }; let checkpoints = 0;
    const intent = await service.prepareLaunch(project, terms, () => checkpoints++);
    const decoded = decodeFunctionData({ abi: service.artifact('VeylMarketFactory').abi, data: intent.transaction.data });
    assert.equal(decoded.functionName, 'launch'); assert.equal(decoded.args[0].salt, published.token.launchSalt);
    assert.equal(intent.predicted.token, published.token.address); assert.equal(intent.transaction.to, addresses.VeylMarketFactory); assert.ok(checkpoints > 0);
  }
});

test('canonical main launch rejects a different creator or treasury owner; ordinary agents keep their own salt', () => {
  const service = new MainnetMarkets({ config, client: {} }), project = { id: 'main', name: 'Veyl', symbol: 'VEYL' };
  assert.throws(() => service.launchConfig(project, { ...terms, account: other }, 1n), /configured main-token deployer/);
  assert.throws(() => service.launchConfig(project, { ...terms, treasuryOwner: other }, 1n), /configured main-token deployer/);
  const agent = { id: 'ordinary-project', name: 'Research', symbol: 'RES' };
  const result = service.launchConfig(agent, { ...terms, account: other, treasuryOwner: other, liquidityQuote: '10', tokensPerQuote: '1000000' }, 1n);
  assert.equal(result.config.salt, keccak256(stringToHex('veyl:ethereum:ordinary-project'))); assert.notEqual(result.config.salt, VEYL_MAIN_TOKEN_SALT);
});
