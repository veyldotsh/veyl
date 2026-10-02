import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, zeroAddress } from 'viem';
import { MainnetMarkets } from '../src/mainnet.mjs';

const address = n => `0x${String(n).repeat(40)}`;
const project = () => ({ id: 'research', name: 'Research', symbol: 'READ' });
const base = { project: { name: 'Veyl', symbol: 'VEYL' }, addresses: { protocolRecipient: address(1) } };
const pins = { quoteAsset: address(2), conversionSwapRouter: address(3), mainMarketFactory: address(4) };
const service = agentMarkets => new MainnetMarkets({ config: { ...base, agentMarkets }, client: {} });

test('missing agent policy and quote pins return ordinary unavailable status without RPC or mutation', async () => {
  for (const agentMarkets of [null, {}, { sharedInfrastructure: true }, { ...pins, quoteAsset: zeroAddress }, { ...pins, mainMarketFactory: 'invalid' }]) {
    const markets = service(agentMarkets), agent = project(), original = structuredClone(agent);
    markets.checkChain = async () => { throw new Error('RPC must not be reached'); };
    const state = await markets.status(agent, address(1));
    assert.equal(state.launched, false);
    assert.equal(state.quoteSymbol, 'VEYL');
    assert.equal(state.readiness.status, 'main-market-unavailable');
    assert.equal(state.canPrepareInfrastructure, false);
    assert.equal(state.canPrepareLaunch, false);
    assert.match(state.readiness.message, /main VEYL/i);
    assert.deepEqual(agent, original);
    await assert.rejects(markets.validateQuoteAsset(agent), error => error.status === 409 && /main VEYL/i.test(error.message));
  }
});

test('shared agent infrastructure is unavailable until pinned and cannot fall back to a workspace factory', async () => {
  const markets = service({ ...pins, sharedInfrastructure: true });
  const agent = { ...project(), mainnetInfrastructure: { factory: address(5) } };
  const state = await markets.status(agent, address(1));
  assert.equal(state.infrastructureMode, 'shared');
  assert.equal(state.factory, null);
  assert.equal(state.configured, false);
  assert.equal(state.readiness.status, 'infrastructure-unavailable');
  assert.equal(state.canPrepareInfrastructure, false);
  assert.equal(state.canPrepareLaunch, false);
  let rpc = 0, saves = 0;
  markets.checkChain = async () => { rpc++; };
  await assert.rejects(markets.prepareFactory(agent, { account: address(1) }, () => saves++), error => error.status === 409 && /shared/i.test(error.message));
  assert.equal(rpc, 0); assert.equal(saves, 0);
});

test('a configured shared factory permits validation but never customer infrastructure preparation', async () => {
  const markets = service({ ...pins, sharedInfrastructure: true, marketFactory: address(5) }), agent = project();
  const state = await markets.status(agent, address(1));
  assert.equal(state.configured, true);
  assert.equal(state.readiness.status, 'ready');
  assert.equal(state.canPrepareLaunch, true);
  assert.equal(state.canPrepareInfrastructure, false);
  let validations = 0, saves = 0;
  markets.infrastructure = async () => { validations++; throw new Error('runtime validation rejected'); };
  await assert.rejects(markets.prepareLaunch(agent, {}, () => saves++), /runtime validation rejected/);
  assert.equal(validations, 1); assert.equal(saves, 0);
  await assert.rejects(markets.prepareFactory(agent, { account: address(1) }, () => saves++), /shared/i);
});

test('a conflicting saved factory cannot replace or launch through the configured shared factory', async () => {
  const markets = service({ ...pins, sharedInfrastructure: true, marketFactory: address(5) });
  const agent = { ...project(), mainnetInfrastructure: { factory: address(6) } };
  assert.equal(markets.quotePolicy(agent).factory, address(5));
  const state = await markets.status(agent);
  assert.equal(state.readiness.status, 'infrastructure-unavailable');
  assert.equal(state.canPrepareLaunch, false);
  markets.checkChain = async () => { throw new Error('RPC must not be reached'); };
  await assert.rejects(markets.infrastructure(agent), error => error.status === 409 && /shared/i.test(error.message));
});

test('legacy per-project and protected main-token infrastructure behavior remains explicit', () => {
  const legacy = new MainnetMarkets({ config: base, client: {} }).capabilities(project());
  assert.equal(legacy.quoteSymbol, 'ETH');
  assert.equal(legacy.infrastructureMode, 'per-project');
  assert.equal(legacy.canPrepareInfrastructure, true);
  const agent = service(pins).capabilities(project());
  assert.equal(agent.quoteSymbol, 'VEYL');
  assert.equal(agent.canPrepareInfrastructure, true);
  const configured = service(pins).capabilities({ ...project(), mainnetInfrastructure: { factory: address(6) } });
  assert.equal(configured.factory, address(6));
  assert.equal(configured.canPrepareLaunch, true);
  assert.equal(configured.canPrepareInfrastructure, false);
  const main = service({ sharedInfrastructure: true }).capabilities({ name: 'Veyl', symbol: 'VEYL' });
  assert.equal(main.quoteSymbol, 'ETH');
  assert.equal(main.infrastructureMode, 'per-project');
  assert.equal(main.canPrepareInfrastructure, true);
});

test('exact runtime code pins are still enforced after compiled-runtime comparison', async () => {
  const target = address(5), code = '0x6000';
  const markets = new MainnetMarkets({ config: { deployments: { codeHashes: { [target]: keccak256('0x6001') } } }, client: { getCode: async () => code } });
  markets.artifact = () => ({ deployedBytecode: { object: code } });
  await assert.rejects(markets.identity(target, 'VeylMarketFactory'), /pinned code hash/);
  markets.config.deployments.codeHashes[target] = keccak256(code);
  assert.equal(await markets.identity(target, 'VeylMarketFactory'), keccak256(code));
});

test('an invalid configured factory never offers a replacement infrastructure deployment', async () => {
  const markets = service({ ...pins, marketFactory: 'invalid' }), agent = project();
  const state = await markets.status(agent);
  assert.equal(state.configured, false);
  assert.equal(state.canPrepareInfrastructure, false);
  assert.equal(state.canPrepareLaunch, false);
  markets.checkChain = async () => { throw new Error('RPC must not be reached'); };
  await assert.rejects(markets.prepareFactory(agent, { account: address(1) }, () => {}), error => error.status === 409 && /invalid/.test(error.message));
});
