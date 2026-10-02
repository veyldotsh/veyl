import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, keccak256 } from 'viem';
import { prepareVerification, verifyLive, executeVerification, forgeArguments, sourceDigestMatches } from '../scripts/verify-contracts.mjs';

const address = '0x1111111111111111111111111111111111111111', code = '0x6001600055';
const compiled = () => ({ abi: [{ type: 'constructor', inputs: [{ name: 'recipient', type: 'address' }] }], deployedBytecode: { object: code, immutableReferences: {} }, metadata: { compiler: { version: '0.8.26+commit.8a97fa7a' }, settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', compilationTarget: { 'src/AgentKit.sol': 'AgentToken' } } } });
const manifest = () => ({ version: 1, chainId: 1, contracts: [{ address, contract: 'AgentToken', constructorArgs: encodeAbiParameters([{ type: 'address' }], [address]) }] });
const prepare = input => prepareVerification(input, { readArtifact: compiled, verifySources() {} });
const client = overrides => ({ getChainId: async () => 1, getBlockNumber: async () => 123n, getCode: async () => code, ...overrides });

test('source hash verification tolerates only Windows CRLF normalization, not source edits', () => {
  const source = Buffer.from('contract Example {\n}\n'), digest = keccak256(source);
  assert.equal(sourceDigestMatches(Buffer.from('contract Example {\r\n}\r\n'), digest), true);
  assert.equal(sourceDigestMatches(Buffer.from('contract Other {\n}\n'), digest), false);
});

test('verification rejects malformed manifests, foreign contracts and noncanonical constructor arguments', () => {
  const valid = manifest(); assert.equal(prepare(valid).entries[0].target, 'src/AgentKit.sol:AgentToken');
  for (const changed of [
    { ...valid, chainId: 8453 }, { ...valid, apiKey: 'not-an-allowed-field' }, { ...valid, contracts: [] },
    { ...valid, contracts: [valid.contracts[0], valid.contracts[0]] },
    { ...valid, contracts: [{ ...valid.contracts[0], contract: '../Injected.sol' }] },
    { ...valid, contracts: [{ ...valid.contracts[0], constructorArgs: '0x01' }] },
    { ...valid, contracts: [{ ...valid.contracts[0], constructorArgs: valid.contracts[0].constructorArgs + '00'.repeat(32) }] },
    { ...valid, contracts: [{ ...valid.contracts[0], address: 'not-an-address' }] }
  ]) assert.throws(() => prepare(changed));
});

test('default dry-run makes no RPC call or explorer submission', async () => {
  let calls = 0;
  const forbidden = async () => { calls++; throw new Error('No external operation is allowed'); };
  const result = await executeVerification(prepare(manifest()), { client: { getChainId: forbidden }, submit: forbidden });
  assert.equal(calls, 0); assert.equal(result.mode, 'dry-run'); assert.equal(result.explorerSubmitted, false); assert.equal(result.transactionsSent, 0);
});

test('verification recognizes converter and factory builders with each exact artifact target', () => {
  const paths = { QuoteRevenueRouter: 'src/QuoteRevenueRouter.sol', VeylProjectBuilder: 'src/market/VeylProjectBuilder.sol', VeylMarketBuilder: 'src/market/VeylMarketBuilder.sol', VeylLiquidityBuilder: 'src/market/VeylLiquidityBuilder.sol', VeylLiquidityDeployer: 'src/market/VeylLiquidityDeployer.sol' };
  for (const [name, source] of Object.entries(paths)) {
    const input = manifest(); input.contracts[0].contract = name;
    const result = prepareVerification(input, { verifySources() {}, readArtifact() { const value = compiled(); value.metadata.settings.compilationTarget = { [source]: name }; return value; } });
    assert.equal(result.entries[0].target, `${source}:${name}`);
  }
});

test('wrong chain, no deployed code, opcode mismatch and incorrect pinned hash all block before explorer contact', async () => {
  const plan = prepare(manifest()); let submissions = 0;
  for (const rpc of [client({ getChainId: async () => 8453 }), client({ getCode: async () => '0x' }), client({ getCode: async () => '0x6002600055' })]) {
    await assert.rejects(executeVerification(plan, { mode: 'submit', client: rpc, key: 'test-key-never-real-12345', submit: async () => submissions++ }));
  }
  const pinned = manifest(); pinned.contracts[0].runtimeCodeHash = '0x' + '12'.repeat(32);
  await assert.rejects(verifyLive(prepare(pinned), client()), /runtime hash differs/);
  assert.equal(submissions, 0);
});

test('explicit submission follows complete live-code checks and passes no API key or signing option on the Forge command line', async () => {
  const data = manifest(); data.contracts[0].runtimeCodeHash = keccak256(code); const plan = prepare(data), events = [];
  const rpc = client({ getCode: async input => { assert.equal(input.blockNumber, 123n); events.push('code'); return code; } });
  const key = 'test-key-never-real-12345';
  const result = await executeVerification(plan, { mode: 'submit', client: rpc, key, submit: async (entry, secret) => { events.push('submit'); assert.equal(secret, key); assert.equal(entry.address, address); return { address, status: 'verified' }; } });
  assert.deepEqual(events, ['code', 'submit']); assert.equal(result.explorerSubmitted, true); assert.equal(result.transactionsSent, 0);
  const args = forgeArguments(plan.entries[0]); assert.ok(args.includes('--watch')); assert.ok(args.includes('etherscan'));
  assert.equal(args[args.indexOf('--chain') + 1], '1'); assert.ok(!args.some(arg => /api.key|private.key|broadcast/i.test(arg))); assert.ok(!args.includes(key));
});
