import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { encodeFunctionData, keccak256, parseAbi, parseTransaction } from 'viem';
import { FeeKeeper } from '../src/fee-keeper.mjs';
import { FEE_OPERATOR_ARM, loadFeeOperator } from '../src/fee-operator.mjs';

const owner = '0x1111111111111111111111111111111111111111', treasury = '0x2222222222222222222222222222222222222222', hook = '0x3333333333333333333333333333333333333333', router = '0x4444444444444444444444444444444444444444', protocol = '0x5555555555555555555555555555555555555555';
const BLOCK = `0x${'a'.repeat(64)}`, ID = `0x${'b'.repeat(64)}`, NOW = 1_800_000_000_000;
const abi = parseAbi(['function flushFees()', 'function distribute(address beneficiary)']);
function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'veyl-fees-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'fees.json'), account = privateKeyToAccount(generatePrivateKey());
  let revenue = 10n ** 16n, nonce = 0, sends = 0, signs = 0, receiptReady = false, final = 9n, lost = false, chain = 1, invalid = false, gasPrice = 2n, pendingNonce = 0, now = NOW;
  let last, receiptMutation, transactionMutation; const claims = {};
  const client = {
    getChainId: async () => chain,
    getBalance: async () => 10n ** 18n,
    getTransactionCount: async ({ blockTag }) => blockTag === 'pending' ? pendingNonce : nonce,
    estimateFeesPerGas: async () => ({ maxFeePerGas: gasPrice, maxPriorityFeePerGas: 1n }),
    estimateGas: async () => 100_000n,
    getBlock: async ({ blockTag } = {}) => ({ number: blockTag === 'finalized' ? final : 10n, hash: BLOCK, baseFeePerGas: 1n }),
    sendRawTransaction: async ({ serializedTransaction }) => {
      sends++; last = parseTransaction(serializedTransaction); last.hash = keccak256(serializedTransaction);
      const saved = JSON.parse(readFileSync(file, 'utf8')).entries.at(-1);
      assert.equal(saved.status, 'broadcasting'); assert.equal(saved.transactionHash, last.hash);
      assert.ok(!readFileSync(file, 'utf8').includes(serializedTransaction));
      if (lost) throw new Error('lost response'); return last.hash;
    },
    getTransactionReceipt: async ({ hash }) => {
      if (!receiptReady) throw new Error('not found');
      const receipt = { transactionHash: hash, blockHash: BLOCK, blockNumber: 10n, status: 'success', gasUsed: 80_000n, effectiveGasPrice: 2n };
      return receiptMutation ? receiptMutation(receipt) : receipt;
    },
    getTransaction: async () => { const tx = { ...last, from: account.address, input: last.data, value: 0n }; return transactionMutation ? transactionMutation(tx) : tx; }
  };
  const markets = { client, config: {}, async checkChain() { if (chain !== 1) throw new Error('chain mismatch'); },
    async validateMarket() { await this.checkChain(); if (invalid) throw new Error('identity mismatch'); return { id: ID, hook, treasury, revenueRouter: router, creator: owner, protocol }; },
    artifact: () => ({ abi }),
    read: async (address, name, field, args) => ({ owner, operator: owner, pendingFees: revenue, claimable: claims[args?.[0]] || 0n })[field]
  };
  const signer = { address: account.address, async signTransaction(tx) { signs++; assert.equal(JSON.parse(readFileSync(file, 'utf8')).entries.at(-1).status, 'reserved'); return account.signTransaction(tx); } };
  const config = { file, markets, signer, enabled: true, dailyGasLimitWei: '10000000', maxFeePerGasWei: '10', maxPriorityFeePerGasWei: '3', maxGasPerTransaction: '200000', minRevenueWei: '1000000', now: () => now, ...options };
  const keeper = new FeeKeeper(config), project = { id: 'fee-fixture', mainnet: { id: ID } };
  return { keeper, project, config, client, markets, signer, file, dir, claims, restart: () => new FeeKeeper(config), counts: () => ({ sends, signs }), setReceipt: () => { receiptReady = true; }, setFinal: () => { final = 10n; }, failSend: () => { lost = true; }, setRevenue: v => { revenue = v; }, setChain: v => { chain = v; }, setInvalid: () => { invalid = true; }, setGas: v => { gasPrice = v; }, setBusy: () => { pendingNonce = 1; }, advanceNonce: () => { nonce++; pendingNonce = nonce; }, advanceDay: () => { now += 86400000; }, mutateReceipt: fn => { receiptMutation = fn; }, mutateTransaction: fn => { transactionMutation = fn; } };
}

test('fee keeper defaults off without touching a signer or RPC', async t => {
  const f = fixture(t, { enabled: false }); assert.deepEqual(await f.keeper.tick(f.project), { status: 'disabled' }); assert.deepEqual(f.counts(), { sends: 0, signs: 0 });
  assert.equal(loadFeeOperator({ env: { VEYL_FEE_OPERATOR_KEY_FILE: '/does/not/exist' } }), null);
});
test('keeper persists exact nonce and gas before signing, then hash before submission; never resends pending', async t => {
  const f = fixture(t); const entry = await f.keeper.tick(f.project);
  assert.equal(entry.action, 'flush'); assert.equal(entry.status, 'pending'); assert.equal(entry.transaction.to, hook); assert.equal(entry.transaction.value, '0'); assert.equal(entry.reservedGasWei, '240000');
  assert.equal(f.keeper.snapshot().dayReservedGasWei, '240000');
  assert.equal((await f.restart().tick(f.project)).recovery, 'receipt-unavailable-no-replay'); assert.deepEqual(f.counts(), { sends: 1, signs: 1 });
  f.setReceipt(); assert.equal((await f.keeper.recover()).recovery, 'awaiting-canonical-finality');
  f.setFinal(); assert.equal((await f.keeper.recover()).status, 'confirmed'); assert.equal(f.keeper.snapshot().dayReservedGasWei, '240000', 'worst-case gas reservation is not refunded');
});
test('lost RPC response is recovered by precomputed hash after restart, without replay', async t => {
  const f = fixture(t); f.failSend(); await assert.rejects(f.keeper.tick(f.project), /uncertain/);
  const next = f.restart(); assert.equal(next.snapshot().pending.status, 'send_unknown'); assert.ok(next.snapshot().pending.transactionHash);
  await next.tick(f.project); assert.deepEqual(f.counts(), { sends: 1, signs: 1 });
  f.setReceipt(); f.setFinal(); assert.equal((await next.recover()).status, 'confirmed'); assert.deepEqual(f.counts(), { sends: 1, signs: 1 });
});
test('ambiguous signing is never retried and blocks all projects after restart', async t => {
  const f = fixture(t); f.signer.signTransaction = async () => { throw new Error('sign failure'); };
  await assert.rejects(f.keeper.tick(f.project), /cannot be automatically retried/);
  const result = await f.restart().tick({ id: 'other', mainnet: {} }); assert.equal(result.recovery, 'operator-inspection-required-no-replay'); assert.equal(f.counts().sends, 0);
});
test('journal persistence failure prevents signing', async t => {
  const f = fixture(t); mkdirSync(f.file);
  await assert.rejects(f.keeper.tick(f.project)); assert.deepEqual(f.counts(), { sends: 0, signs: 0 });
});
test('keeper ignores arbitrary requested destinations and delivers fixed beneficiaries before new flushes', async t => {
  const f = fixture(t); f.claims[treasury] = 10n ** 15n;
  const entry = await f.keeper.tick({ ...f.project, beneficiary: protocol, destination: owner });
  assert.equal(entry.action, 'distribute'); assert.equal(entry.beneficiary, treasury); assert.equal(entry.transaction.to, router);
  assert.equal(entry.transaction.data, encodeFunctionData({ abi, functionName: 'distribute', args: [treasury] }));
});

test('an uneconomic claim cannot starve a profitable fee flush', async t => {
  const f = fixture(t, { minRevenueWei: '1' }); f.claims[owner] = 1000n;
  const entry = await f.keeper.tick(f.project);
  assert.equal(entry.action, 'flush'); assert.equal(entry.transaction.to, hook);
  assert.deepEqual(f.counts(), { signs: 1, sends: 1 });
  assert.equal(f.keeper.snapshot().dayReservedGasWei, '240000');
});

test('a beneficiary that rejects payment cannot block another callable fee action', async t => {
  const f = fixture(t); f.claims[owner] = 10n ** 15n;
  const estimated = [];
  f.client.estimateGas = async request => { estimated.push(request.to); if (request.to === router) throw new Error('Recipient rejects ETH'); return 100000n; };
  const entry = await f.keeper.tick(f.project);
  assert.deepEqual(estimated, [router, hook]); assert.equal(entry.action, 'flush');
  assert.deepEqual(f.counts(), { signs: 1, sends: 1 });
});
test('gas price, worst-case daily cost, nonce gaps and small harvests stop before signing', async t => {
  for (const [options, setup, status] of [
    [{}, f => f.setGas(11n), 'gas-price-limited'],
    [{ dailyGasLimitWei: '239999' }, () => {}, 'daily-gas-limited'],
    [{ maxGasPerTransaction: '119999' }, () => {}, 'transaction-gas-limited'],
    [{}, f => f.setBusy(), 'operator-busy'],
    [{ minRevenueWei: '1' }, f => f.setRevenue(100n), 'uneconomic']
  ]) { const f = fixture(t, options); setup(f); assert.equal((await f.keeper.tick(f.project)).status, status); assert.deepEqual(f.counts(), { sends: 0, signs: 0 }); }
});
test('daily limit survives restart and only resets on the next UTC day', async t => {
  const f = fixture(t, { dailyGasLimitWei: '240000' }); await f.keeper.tick(f.project); f.setReceipt(); f.setFinal(); await f.keeper.recover(); f.advanceNonce();
  const next = f.restart(); assert.equal((await next.tick(f.project)).status, 'daily-gas-limited'); f.advanceDay(); assert.equal((await next.tick(f.project)).status, 'pending'); assert.equal(f.counts().sends, 2);
});
test('wrong chain, identity and shared treasury operator fail closed', async t => {
  const f = fixture(t); f.setChain(31337); await assert.rejects(f.keeper.tick(f.project), /Operation failed/); f.setChain(1); f.setInvalid(); await assert.rejects(f.keeper.tick(f.project), /Operation failed/); assert.equal(f.counts().signs, 0);
  const shared = fixture(t); shared.markets.read = async () => shared.signer.address; await assert.rejects(shared.keeper.tick(shared.project), /separate signer/); assert.equal(shared.counts().signs, 0);
});
test('receipt mismatch and canonical reorg keep the operator blocked', async t => {
  const f = fixture(t); await f.keeper.tick(f.project); f.setReceipt(); f.setFinal();
  f.mutateTransaction(tx => ({ ...tx, to: protocol })); await assert.rejects(f.keeper.recover(), /exact saved transaction/);
  f.mutateTransaction(null); f.mutateReceipt(r => ({ ...r, blockHash: `0x${'c'.repeat(64)}` })); assert.equal((await f.keeper.recover()).recovery, 'awaiting-canonical-finality');
  assert.equal(f.keeper.snapshot().pending.status, 'pending'); assert.equal(f.counts().sends, 1);
});
test('final reverted receipt is recorded with spent gas; never treated as delivered', async t => {
  const f = fixture(t); await f.keeper.tick(f.project); f.setReceipt(); f.setFinal(); f.mutateReceipt(r => ({ ...r, status: 'reverted' }));
  const result = await f.keeper.recover(); assert.equal(result.status, 'reverted'); assert.equal(result.actualGasWei, '160000'); assert.equal(f.keeper.snapshot().pending, null);
});
test('malformed journal or changed operator never silently resets the nonce ledger', async t => {
  const f = fixture(t); await f.keeper.tick(f.project);
  assert.throws(() => new FeeKeeper({ ...f.config, signer: { ...f.signer, address: owner } }), /different operator/);
  const state = JSON.parse(readFileSync(f.file, 'utf8')); state.entries[0].privateKey = 'forbidden'; writeFileSync(f.file, JSON.stringify(state)); assert.throws(f.restart, /Invalid public operation journal/);
});
test('operator loader requires explicit arm and separate public identity; never exports key or sends', async () => {
  const secret = generatePrivateKey(), account = privateKeyToAccount(secret);
  const base = { VEYL_FEE_KEEPER_ENABLED: 'true', VEYL_FEE_OPERATOR_ADDRESS: account.address, VEYL_FEE_OPERATOR_PRIVATE_KEY: secret };
  assert.throws(() => loadFeeOperator({ env: { ...base } }), /not explicitly armed/);
  assert.throws(() => loadFeeOperator({ env: { ...base, VEYL_FEE_OPERATOR_ARM: FEE_OPERATOR_ARM }, forbiddenAddresses: [account.address] }), /separate public/);
  const env = { ...base, VEYL_FEE_OPERATOR_ARM: FEE_OPERATOR_ARM }, signer = loadFeeOperator({ env });
  assert.equal(env.VEYL_FEE_OPERATOR_PRIVATE_KEY, undefined); assert.deepEqual(Object.keys(signer), ['address', 'signTransaction']);
  const request = { type: 'eip1559', chainId: 1, to: hook, data: encodeFunctionData({ abi, functionName: 'flushFees' }), value: 0n, nonce: 0, gas: 100000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n };
  assert.equal(parseTransaction(await signer.signTransaction(request)).to.toLowerCase(), hook);
  for (const change of [{ chainId: 31337 }, { value: 1n }, { data: '0x' }, { accessList: [] }]) await assert.rejects(signer.signTransaction({ ...request, ...change }), /non-maintenance/);
  const payout = { ...request, to: router, data: encodeFunctionData({ abi, functionName: 'distribute', args: [treasury] }) }; assert.equal(parseTransaction(await signer.signTransaction(payout)).to, router);
});

test('VEYL collection uses quote-unit threshold while converted beneficiary claims pay ETH', async t => {
  const f = fixture(t, { minQuoteRevenue: '10' }), original = f.markets.validateMarket.bind(f.markets);
  f.markets.validateMarket = async () => ({ ...await original(), quoteAsset: '0x6666666666666666666666666666666666666666' });
  f.setRevenue(100n);
  const entry = await f.keeper.tick(f.project);
  assert.equal(entry.action, 'flush'); assert.equal(entry.revenueAsset, '0x6666666666666666666666666666666666666666');
  assert.equal(entry.revenueWei, '100', 'stored base units belong to revenueAsset, never compare them with ETH gas');
  const disabled = fixture(t), read = disabled.markets.validateMarket.bind(disabled.markets);
  disabled.markets.validateMarket = async () => ({ ...await read(), quoteAsset: entry.revenueAsset });
  assert.equal((await disabled.keeper.tick(disabled.project)).status, 'quote-harvest-disabled'); assert.equal(disabled.counts().signs, 0);
  disabled.claims[treasury] = 10n ** 16n;
  const payout = await disabled.keeper.tick(disabled.project);
  assert.equal(payout.action, 'distribute'); assert.equal(payout.beneficiary, treasury);
  assert.equal(payout.revenueAsset, '0x0000000000000000000000000000000000000000');
});
