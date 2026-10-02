import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeEventTopics, parseAbi } from 'viem';
import { LocalMarkets } from '../src/market.mjs';

const account = `0x${'1'.repeat(40)}`, router = `0x${'2'.repeat(40)}`, token = `0x${'3'.repeat(40)}`;
const transaction = `0x${'a'.repeat(64)}`, approvalHash = `0x${'b'.repeat(64)}`;
const abi = parseAbi([
  'event Swapped(address indexed caller, bool indexed isBuy, uint256 amountIn, uint256 amountOut)',
  'function buy(uint256 quoteAmountIn, uint256 minTokensOut, uint160 sqrtPriceLimitX96, uint256 deadline) payable returns (uint256 tokensOut)',
  'function sell(uint256 tokenAmountIn, uint256 minEthOut, uint160 sqrtPriceLimitX96, uint256 deadline) payable returns (uint256 tokensSpent, uint256 ethOut)'
]);
function log({ caller = account, isBuy = true, amountIn = 1000n, amountOut = 950n, emitter = router } = {}) {
  return { address: emitter, topics: encodeEventTopics({ abi, eventName: 'Swapped', args: { caller, isBuy } }),
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [amountIn, amountOut]) };
}
function fixture({ side = 'buy', approvalExpires = false, simulationExpires = false, events } = {}) {
  let clock = 100000, saves = 0;
  const calls = [], quote = { id: 'quote-1', side, account, poolId: 'pool-1', status: 'quoted',
    amountIn: '1000', minOut: '900', priceLimit: '4295128740', expiresAt: 105000 };
  const project = { chain: { hook: `0x${'4'.repeat(40)}`, token, swapRouter: router, poolId: 'pool-1' }, marketQuotes: [quote] };
  const chain = { account, exclusive: fn => fn(), client: {
    getBlock: async () => ({ timestamp: 100n }),
    simulateContract: async request => { calls.push(['simulate', request.functionName]); if (simulationExpires) clock = quote.expiresAt; return { request }; },
    waitForTransactionReceipt: async ({ hash }) => {
      calls.push(['receipt', hash]); if (hash === approvalHash && approvalExpires) clock = quote.expiresAt + 1000;
      return { status: 'success', logs: hash === approvalHash ? [] : events || [log({ isBuy: side === 'buy' })] };
    }
  }, wallet: { writeContract: async request => { calls.push(['write', request.functionName]); return request.functionName === 'approve' ? approvalHash : transaction; } } };
  const market = new LocalMarkets(chain, { now: () => clock });
  // Narrow fixture boundaries: deployment/chain-status validation is tested separately.
  // Swap preparation and receipt reconciliation below run the production methods.
  market.status = async () => ({ configured: true }); market.artifact = () => ({ abi });
  return { market, project, quote, calls, checkpoint: () => { saves++; }, saves: () => saves, setClock: value => { clock = value; } };
}

test('market quote that expires while approval mines cannot simulate or submit a swap', async () => {
  const f = fixture({ side: 'sell', approvalExpires: true });
  await assert.rejects(f.market.swap(f.project, { quoteId: f.quote.id }, f.checkpoint), e => e.status === 409 && /expired/.test(e.message));
  assert.deepEqual(f.calls.filter(c => c[0] === 'write'), [['write', 'approve']]);
  assert.equal(f.calls.some(c => c[0] === 'simulate'), false);
  assert.equal(f.quote.status, 'quoted'); assert.equal(f.quote.hash, undefined); assert.equal(f.saves(), 0);
});

test('market quote that expires during simulation is never submitted or marked spent', async () => {
  const f = fixture({ simulationExpires: true });
  await assert.rejects(f.market.swap(f.project, { quoteId: f.quote.id }, f.checkpoint), e => e.status === 409 && /simulation/.test(e.message));
  assert.deepEqual(f.calls, [['simulate', 'buy']]);
  assert.equal(f.quote.status, 'quoted'); assert.equal(f.quote.hash, undefined); assert.equal(f.saves(), 0);
});

test('market receipt must bind caller, side, consumed input, minimum output and router', async () => {
  for (const mutation of [
    { caller: `0x${'5'.repeat(40)}` }, { isBuy: false }, { amountIn: 1001n },
    { amountIn: 999n }, { amountOut: 899n }, { emitter: `0x${'6'.repeat(40)}` }
  ]) {
    const f = fixture({ events: [log(mutation)] }); f.quote.status = 'submitted'; f.quote.hash = transaction;
    await assert.rejects(f.market.finishSwap(f.project, f.quote, f.checkpoint), e => e.status === 409 && /reconciled/.test(e.message));
    assert.equal(f.quote.status, 'submitted'); assert.equal(f.project.marketTrades, undefined); assert.equal(f.saves(), 0);
  }
});

test('market receipt accepts a partial sell within bounds and records it only once', async () => {
  const f = fixture({ side: 'sell', events: [log({ isBuy: false, amountIn: 999n, amountOut: 901n })] });
  f.quote.status = 'submitted'; f.quote.hash = transaction;
  const result = await f.market.finishSwap(f.project, f.quote, f.checkpoint);
  assert.equal(result.status, 'completed'); assert.equal(result.actualInput, '0.000000000000000999');
  assert.equal(result.actualOutput, '0.000000000000000901');
  await f.market.finishSwap(f.project, f.quote, f.checkpoint);
  assert.equal(f.project.marketTrades.length, 1);
});

test('uncertain market submission cannot be repeated and known receipts recover without another write', async () => {
  const f = fixture(); f.quote.status = 'submitted';
  await assert.rejects(f.market.swap(f.project, { quoteId: f.quote.id }, f.checkpoint), e => e.status === 409 && /uncertain/.test(e.message));
  assert.deepEqual(f.calls, []);
  f.quote.hash = transaction; f.setClock(f.quote.expiresAt + 1);
  assert.equal((await f.market.swap(f.project, { quoteId: f.quote.id }, f.checkpoint)).status, 'completed');
  assert.equal(f.calls.some(c => c[0] === 'write'), false);
  assert.equal(f.project.marketTrades.length, 1);
});
