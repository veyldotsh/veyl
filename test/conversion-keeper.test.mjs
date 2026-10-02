import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { decodeFunctionData, encodeFunctionData, keccak256, parseTransaction } from 'viem';
import { ConversionKeeper } from '../src/conversion-keeper.mjs';
import { CONVERSION_ABI, CONVERSION_OPERATOR_ARM, loadConversionOperator } from '../src/conversion-operator.mjs';
import { configuredConversionKeeper } from '../src/production.mjs';

const owner = '0x1111111111111111111111111111111111111111', treasury = '0x2222222222222222222222222222222222222222', hook = '0x3333333333333333333333333333333333333333', router = '0x4444444444444444444444444444444444444444', protocol = '0x5555555555555555555555555555555555555555', quoteAsset = '0x6666666666666666666666666666666666666666', swapRouter = '0x7777777777777777777777777777777777777777';
const BLOCK = `0x${'a'.repeat(64)}`, ID = `0x${'b'.repeat(64)}`, NOW = 1_800_000_000_000;
function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'veyl-conversion-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'conversion.json'), account = privateKeyToAccount(generatePrivateKey());
  const f = { now: NOW, sends: 0, signs: 0, receiptReady: false, final: 9n, lost: false, chain: 1, invalid: false, fee: 2n, nonce: 0, pendingNonce: 0, reserve: 10n ** 18n, spent: 0n, output: 10n ** 16n, partial: false, policyReads: 0, stale: false };
  f.policy = { executor: account.address, maxQuotePerConversion: 10n ** 18n, maxQuotePerDay: 2n * 10n ** 18n, minEthPerVeylX18: 5n * 10n ** 15n, enabled: true };
  const client = {
    getBalance: async () => 10n ** 18n,
    getTransactionCount: async ({ blockTag }) => blockTag === 'pending' ? f.pendingNonce : f.nonce,
    estimateFeesPerGas: async () => ({ maxFeePerGas: f.fee, maxPriorityFeePerGas: 1n }),
    estimateGas: async () => 100000n,
    getBlock: async ({ blockTag } = {}) => ({ number: blockTag === 'finalized' ? f.final : 10n, hash: BLOCK, baseFeePerGas: 1n, timestamp: BigInt(Math.floor(f.now / 1000) - (f.stale ? 60 : 0)) }),
    simulateContract: async request => { assert.equal(request.args[0], hook); assert.equal(request.args[1], false); f.lastQuote = request; return { result: { amountIn: f.partial ? request.args[2] - 1n : request.args[2], amountOut: f.output } }; },
    sendRawTransaction: async ({ serializedTransaction }) => {
      f.sends++; f.last = parseTransaction(serializedTransaction); f.last.hash = keccak256(serializedTransaction);
      const saved = JSON.parse(readFileSync(file, 'utf8')).entries.at(-1);
      assert.equal(saved.status, 'broadcasting'); assert.equal(saved.transactionHash, f.last.hash); assert.ok(!readFileSync(file, 'utf8').includes(serializedTransaction));
      if (f.lost) throw new Error('lost response'); return f.last.hash;
    },
    getTransactionReceipt: async ({ hash }) => {
      if (!f.receiptReady) throw new Error('missing');
      return { transactionHash: hash, blockHash: BLOCK, blockNumber: 10n, status: f.reverted ? 'reverted' : 'success', gasUsed: 80000n, effectiveGasPrice: 2n, ...f.receiptMutation };
    },
    getTransaction: async () => ({ ...f.last, from: account.address, input: f.last.data, value: 0n, ...f.transactionMutation })
  };
  const markets = { client, config: {}, async checkChain() { if (f.chain !== 1) throw new Error('wrong chain'); }, async validateMarket() { await this.checkChain(); if (f.invalid) throw new Error('wrong identity'); return { id: ID, quoteAsset: f.native ? '0x0000000000000000000000000000000000000000' : quoteAsset, revenueRouterType: 'QuoteRevenueRouter', conversionSwapRouter: swapRouter, conversionHook: hook, quoter: router, treasury, revenueRouter: router, creator: owner, protocol }; }, artifact: () => ({ abi: CONVERSION_ABI }), read: async (_address, _contract, field) => {
    if (field === 'conversionPolicy') { f.policyReads++; if (f.pauseDuringPrep && f.policyReads > 1) return { ...f.policy, enabled: false }; return { ...f.policy }; }
    return { pendingQuote: f.reserve, spentOnDay: f.spent, owner, operator: owner }[field];
  } };
  const signer = { address: account.address, async signTransaction(request) { f.signs++; assert.equal(JSON.parse(readFileSync(file, 'utf8')).entries.at(-1).status, 'reserved'); return account.signTransaction(f.tamper ? { ...request, to: protocol } : request); } };
  const config = { file, markets, signer, enabled: true, dailyGasLimitWei: '10000000', maxFeePerGasWei: '10', maxPriorityFeePerGasWei: '3', maxGasPerTransaction: '200000', minQuoteAmount: '100', slippageBps: 50, now: () => f.now, ...options };
  return Object.assign(f, { dir, file, client, markets, signer, config, keeper: new ConversionKeeper(config), project: { id: 'conversion-fixture', mainnet: { id: ID } }, restart: () => new ConversionKeeper(config) });
}

test('conversion defaults off, leaves key unloaded, and requires mainnet gate separately', async t => {
  const f = fixture(t, { enabled: false }); assert.equal((await f.keeper.tick(f.project)).status, 'disabled'); assert.equal(f.signs, 0);
  const env = { VEYL_CONVERSION_OPERATOR_PRIVATE_KEY: 'not-a-key' }; assert.equal(loadConversionOperator({ env }), null); assert.equal(env.VEYL_CONVERSION_OPERATOR_PRIVATE_KEY, undefined);
  assert.throws(() => configuredConversionKeeper({ directory: f.dir, mainnet: f.markets, env: { VEYL_CONVERSION_KEEPER_ENABLED: 'true' } }), /Mainnet transactions/);
});
test('exact quote, owner floor and gas are persisted before signing and never replay pending', async t => {
  const f = fixture(t); const entry = await f.keeper.tick(f.project);
  assert.equal(entry.status, 'pending'); assert.equal(entry.quoteAmount, '1000000000000000000'); assert.equal(entry.minEthOut, '9950000000000000');
  const decoded = decodeFunctionData({ abi: CONVERSION_ABI, data: entry.transaction.data }); assert.equal(decoded.functionName, 'convertFees'); assert.equal(decoded.args[3], BigInt(NOW / 1000) + 120n);
  assert.equal(entry.transaction.to, router); assert.equal(entry.transaction.value, '0'); assert.equal(entry.reservedGasWei, '240000');
  assert.equal((await f.restart().tick(f.project)).recovery, 'receipt-unavailable-no-replay'); assert.equal(f.sends, 1); assert.equal(f.signs, 1);
});
test('owner floor overrides weaker slippage minimum and cannot use stale/partial quotes', async t => {
  const f = fixture(t); f.policy.minEthPerVeylX18 = 999n * 10n ** 13n;
  const entry = await f.keeper.tick(f.project); assert.equal(entry.minEthOut, '9990000000000000');
  const partial = fixture(t); partial.partial = true; assert.equal((await partial.keeper.tick(partial.project)).status, 'full-fill-unavailable'); assert.equal(partial.signs, 0);
  const stale = fixture(t); stale.stale = true; assert.equal((await stale.keeper.tick(stale.project)).status, 'stale-chain-time'); assert.equal(stale.signs, 0);
});
test('owner pause after awaited quote/gas prep stops before reserving nonce or signing', async t => {
  const f = fixture(t); f.pauseDuringPrep = true;
  assert.equal((await f.keeper.tick(f.project)).status, 'policy-changed'); assert.equal(f.signs, 0); assert.equal(f.keeper.snapshot().entries.length, 0);
});
test('enabled service alone cannot bypass owner policy or wrong executor', async t => {
  for (const change of [{ enabled: false }, { executor: owner }]) { const f = fixture(t); Object.assign(f.policy, change); assert.equal((await f.keeper.tick(f.project)).status, 'owner-policy-disabled'); assert.equal(f.signs, 0); }
  const native = fixture(t); native.native = true; assert.equal((await native.keeper.tick(native.project)).status, 'native-market'); assert.equal(native.signs, 0);
});
test('gas budgets, nonce gaps, exhausted quote budget and owner floor block new signatures', async t => {
  for (const [options, setup, status] of [
    [{}, f => { f.fee = 11n; }, 'gas-price-limited'],
    [{ dailyGasLimitWei: '239999' }, () => {}, 'daily-gas-limited'],
    [{ maxGasPerTransaction: '119999' }, () => {}, 'transaction-gas-limited'],
    [{}, f => { f.pendingNonce = 1; }, 'operator-busy'],
    [{}, f => { f.spent = f.policy.maxQuotePerDay; }, 'below-conversion-threshold'],
    [{}, f => { f.policy.minEthPerVeylX18 = 2n * 10n ** 16n; }, 'owner-price-floor']
  ]) { const f = fixture(t, options); setup(f); assert.equal((await f.keeper.tick(f.project)).status, status); assert.equal(f.signs, 0); }
});
test('lost submission response keeps precomputed hash and never retries after restart', async t => {
  const f = fixture(t); f.lost = true; await assert.rejects(f.keeper.tick(f.project), /uncertain/);
  const next = f.restart(); assert.equal(next.snapshot().pending.status, 'send_unknown'); await next.tick(f.project); assert.equal(f.sends, 1);
  f.receiptReady = true; assert.equal((await next.recover()).recovery, 'awaiting-canonical-finality'); f.final = 10n;
  assert.equal((await next.recover()).status, 'confirmed'); assert.equal(f.sends, 1); assert.equal(next.snapshot().dayReservedGasWei, '240000');
});
test('signing/persistence uncertainty blocks every later project and cannot be retried', async t => {
  const f = fixture(t); f.tamper = true; await assert.rejects(f.keeper.tick(f.project), /cannot be automatically retried/);
  assert.equal((await f.restart().tick({ id: 'other', mainnet: {} })).recovery, 'operator-inspection-required-no-replay'); assert.equal(f.sends, 0);
  const failed = fixture(t); mkdirSync(failed.file); await assert.rejects(failed.keeper.tick(failed.project)); assert.equal(failed.signs, 0);
});
test('receipt mismatch/reorg never frees nonce; reverted exact receipt is recorded honestly', async t => {
  const f = fixture(t); await f.keeper.tick(f.project); f.receiptReady = true; f.final = 10n;
  f.transactionMutation = { to: protocol }; await assert.rejects(f.keeper.recover(), /exact saved transaction/);
  f.transactionMutation = {}; f.receiptMutation = { blockHash: `0x${'c'.repeat(64)}` }; assert.equal((await f.keeper.recover()).recovery, 'awaiting-canonical-finality');
  f.receiptMutation = {}; f.reverted = true; assert.equal((await f.keeper.recover()).status, 'reverted'); assert.equal(f.keeper.snapshot().pending, null);
});
test('reserved daily gas survives restart and cannot be refunded by success', async t => {
  const f = fixture(t, { dailyGasLimitWei: '240000' }); await f.keeper.tick(f.project); f.receiptReady = true; f.final = 10n; await f.keeper.recover(); f.nonce = f.pendingNonce = 1;
  const next = f.restart(); assert.equal((await next.tick(f.project)).status, 'daily-gas-limited'); f.now += 86400000; assert.equal((await next.tick(f.project)).status, 'pending');
});
test('wrong chain, market identity and corrupt journal cannot silently proceed', async t => {
  const f = fixture(t); f.chain = 31337; await assert.rejects(f.keeper.tick(f.project)); f.chain = 1; f.invalid = true; await assert.rejects(f.keeper.tick(f.project)); assert.equal(f.signs, 0);
  const saved = fixture(t); await saved.keeper.tick(saved.project); const state = JSON.parse(readFileSync(saved.file, 'utf8')); state.entries[0].secret = 'forbidden'; writeFileSync(saved.file, JSON.stringify(state)); assert.throws(saved.restart, /Invalid public operation journal/);
});
test('sign-only operator requires separate explicit arm, removes child secret and restricts ABI', async () => {
  const secret = generatePrivateKey(), account = privateKeyToAccount(secret);
  const base = { VEYL_CONVERSION_KEEPER_ENABLED: 'true', VEYL_CONVERSION_OPERATOR_ADDRESS: account.address, VEYL_CONVERSION_OPERATOR_PRIVATE_KEY: secret };
  assert.throws(() => loadConversionOperator({ env: { ...base } }), /not explicitly armed/);
  assert.throws(() => loadConversionOperator({ env: { ...base, VEYL_CONVERSION_OPERATOR_ARM: CONVERSION_OPERATOR_ARM }, forbiddenAddresses: [account.address] }), /separate public/);
  const env = { ...base, VEYL_CONVERSION_OPERATOR_ARM: CONVERSION_OPERATOR_ARM }, signer = loadConversionOperator({ env });
  assert.equal(env.VEYL_CONVERSION_OPERATOR_PRIVATE_KEY, undefined); assert.deepEqual(Object.keys(signer), ['address', 'signTransaction']);
  const request = { type: 'eip1559', chainId: 1, to: router, data: encodeFunctionData({ abi: CONVERSION_ABI, functionName: 'convertFees', args: [1n, 1n, 1n, 1n] }), value: 0n, nonce: 0, gas: 100000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n };
  assert.equal(parseTransaction(await signer.signTransaction(request)).to, router);
  for (const change of [{ chainId: 31337 }, { value: 1n }, { data: '0x' }, { accessList: [] }, { data: request.data + '00' }]) await assert.rejects(signer.signTransaction({ ...request, ...change }), /non-conversion/);
});
