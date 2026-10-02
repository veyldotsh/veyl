import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { keccak256 } from 'viem';
import { validateConfig, preflight } from '../scripts/preflight-mainnet.mjs';
import { readManifest, verifyMainnet } from '../scripts/check-mainnet.mjs';

const example = JSON.parse(await readFile(new URL('../config/mainnet.example.json', import.meta.url), 'utf8'));
const config = () => structuredClone(example);
const bytecode = '0x60006000';
const manifest = () => ({
  chain_id: 1, billing_asset: 'native_eth', proof_setup: { circuit_id: 'zkapi-v2-note-bound-v1' },
  contract_address: '0x1111111111111111111111111111111111111111',
  proof_adapter_address: '0x2222222222222222222222222222222222222222',
  deployment_evidence: { vault_runtime_keccak256: keccak256(bytecode), verifier_runtime_keccak256: keccak256(bytecode) },
});
const response = object => async () => new Response(JSON.stringify(object));
const client = overrides => ({
  getChainId: async () => 1, getBlockNumber: async () => 42n,
  getCode: async () => bytecode, getBlock: async () => ({ hash: `0x${'12'.repeat(32)}` }), ...overrides,
});

test('public config leaves missing launch decisions explicit and does not invent swap rates', () => {
  const result = validateConfig(config());
  assert.equal(result.complete, false);
  assert.ok(result.missing.includes('trading.buyFeeBps'));
  assert.ok(result.missing.includes('addresses.protocolRecipient'));
  assert.ok(result.invalid.includes('confirmations.freshSignerConfirmed'));
  assert.deepEqual(result.allocationBps, { treasury: 7000, creator: 2000, protocol: 1000 });
});

test('public config rejects key material and unsupported fields without reflecting values', () => {
  const unknown = config(); unknown.privateKey = 'must-not-appear';
  assert.throws(() => validateConfig(unknown), error => !error.message.includes('must-not-appear'));
  const wrongType = config(); wrongType.project.name = { nested: 'not supported' };
  assert.throws(() => validateConfig(wrongType), /type/);
  const keySized = config(); keySized.project.name = 'ab'.repeat(32);
  assert.throws(() => validateConfig(keySized), /key-sized/);
  const wrongChain = config(); wrongChain.chainId = 8453;
  assert.ok(validateConfig(wrongChain).invalid.includes('chainId'));
});

test('public config enforces fee, amount, address and price boundaries', () => {
  const value = config();
  value.trading.buyFeeBps = 10000;
  value.trading.sellFeeBps = -1;
  value.trading.tickSpacing = 32768;
  value.trading.initialSqrtPriceX96 = '4295128738';
  value.funding.initialTreasuryEth = '1e18';
  value.addresses.protocolRecipient = '0x0000000000000000000000000000000000000000';
  assert.equal(validateConfig(value).invalid.length, 7);
});

test('offline preflight never calls network verification and cannot authorize deployment', async () => {
  const report = await preflight(config(), { offline: true, verify: () => { throw new Error('network called'); }, artifacts: async () => [] });
  assert.equal(report.mode, 'read-only-no-signing');
  assert.equal(report.deploymentReady, false);
  assert.equal(report.zkapi.checked, false);
  assert.ok(report.blockers.some(item => item.includes('Canonical mainnet pool creation') && item.includes('launch-factory wiring')));
});

test('reviewed Veyl main launch requires protection and compatible token input without setting unapproved terms', () => {
  const value = config(); value.project = { name: 'Veyl', symbol: 'VEYL' };
  assert.ok(validateConfig(value).missing.includes('trading.launchProtection'));
  value.trading.launchProtection = false;
  assert.ok(validateConfig(value).invalid.includes('trading.launchProtection'));
  value.trading.launchProtection = true;
  assert.ok(validateConfig(value).missing.includes('funding.initialLiquidityTokens'));
  value.funding.initialLiquidityTokens = '979999999.999999999999999999';
  assert.ok(validateConfig(value).invalid.includes('funding.initialLiquidityTokens'));
  value.funding.initialLiquidityTokens = '980000000';
  assert.ok(!validateConfig(value).invalid.includes('funding.initialLiquidityTokens'));
  value.project = { name: 'Example agent', symbol: 'AGENT' }; value.trading.launchProtection = false;
  assert.ok(!validateConfig(value).invalid.includes('trading.launchProtection'));
});

test('preflight contains network failure without printing upstream details', async () => {
  const report = await preflight(config(), { verify: async () => { throw new Error('must-not-appear'); }, artifacts: async () => [] });
  assert.equal(report.deploymentReady, false);
  assert.equal(report.zkapi.checked, false);
  assert.ok(!JSON.stringify(report).includes('must-not-appear'));
});

test('zkAPI verification reads both code values at the recorded block', async () => {
  const calls = [];
  const report = await verifyMainnet({ fetchImpl: response(manifest()), client: client({ getCode: async args => { calls.push(args); return bytecode; } }) });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.blockNumber === 42n));
  assert.equal(report.block, '42');
  assert.equal(report.runtimeMatchesManifest, true);
});

test('zkAPI verification rejects wrong chain, empty code and hash mismatch', async () => {
  await assert.rejects(verifyMainnet({ fetchImpl: response(manifest()), client: client({ getChainId: async () => 8453 }) }), /chain mismatch/);
  await assert.rejects(verifyMainnet({ fetchImpl: response(manifest()), client: client({ getCode: async () => '0x' }) }), /Missing runtime/);
  await assert.rejects(verifyMainnet({ fetchImpl: response(manifest()), client: client({ getCode: async () => '0x6001' }) }), /differs/);
});

test('zkAPI manifest rejects HTTP failure, malformed schema and oversized content', async () => {
  await assert.rejects(readManifest(async () => new Response('no', { status: 503 })), /request failed/);
  await assert.rejects(readManifest(response({ chain_id: 1 })), /Unexpected/);
  await assert.rejects(readManifest(async () => new Response('a'.repeat(1_000_001))), /size limit/);
});
