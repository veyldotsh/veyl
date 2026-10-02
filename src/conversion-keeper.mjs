import { randomUUID } from 'node:crypto';
import { encodeFunctionData, getAddress, isAddress, keccak256, parseTransaction, recoverTransactionAddress } from 'viem';
import { PublicJournal } from './public-journal.mjs';
import { Problem } from './agent.mjs';
import { CONVERSION_ABI } from './conversion-operator.mjs';

const LIMIT = 1461446703485210103287273052203988822378723970341n;
const zero = /^0x0{40}$/i;
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const numeric = value => typeof value === 'string' && /^\d{1,78}$/.test(value);
const hash = value => /^0x[\da-f]{64}$/i.test(value || '');
const terminal = entry => ['confirmed', 'reverted'].includes(entry.status);
const clone = value => JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item));
const positive = (value, label) => { if (!numeric(String(value || '')) || BigInt(value) <= 0n) throw new Problem(`Set a positive ${label} before enabling conversion.`, 503); return BigInt(value); };
const policyOf = value => Array.isArray(value) ? { executor: value[0], maxQuotePerConversion: value[1], maxQuotePerDay: value[2], minEthPerVeylX18: value[3], enabled: value[4] } : value;
function validate(state) {
  if (state?.version !== 1 || !Array.isArray(state.entries) || state.entries.length > 2000 || (state.operator !== null && !isAddress(state.operator || '')) || Object.keys(state).some(k => !['version', 'operator', 'entries'].includes(k))) throw new Error();
  const ids = new Set(), statuses = ['reserved', 'signed', 'broadcasting', 'pending', 'send_unknown', 'confirmed', 'reverted'];
  for (const e of state.entries) {
    const keys = ['id', 'projectId', 'marketId', 'quoteAsset', 'quoteAmount', 'expectedEth', 'minEthOut', 'status', 'createdAt', 'day', 'transaction', 'reservedGasWei', 'transactionHash', 'blockNumber', 'blockHash', 'actualGasWei', 'confirmedAt'];
    if (Object.keys(e).some(k => !keys.includes(k)) || ids.has(e.id) || typeof e.id !== 'string' || typeof e.projectId !== 'string' || !hash(e.marketId) || !isAddress(e.quoteAsset || '') || zero.test(e.quoteAsset) || !statuses.includes(e.status) || !Number.isSafeInteger(e.createdAt) || e.day !== Math.floor(e.createdAt / 86400000) || ![e.quoteAmount, e.expectedEth, e.minEthOut, e.reservedGasWei].every(numeric)) throw new Error();
    ids.add(e.id);
    const tx = e.transaction;
    if (!tx || Object.keys(tx).sort().join(',') !== 'chainId,data,from,gas,maxFeePerGas,maxPriorityFeePerGas,nonce,to,type,value' || tx.type !== 'eip1559' || tx.chainId !== 1 || !same(tx.from, state.operator) || !isAddress(tx.to || '') || !/^0x[\da-f]{264}$/i.test(tx.data || '') || tx.value !== '0' || !Number.isSafeInteger(tx.nonce) || tx.nonce < 0 || ![tx.gas, tx.maxFeePerGas, tx.maxPriorityFeePerGas].every(numeric) || BigInt(tx.gas) * BigInt(tx.maxFeePerGas) !== BigInt(e.reservedGasWei)) throw new Error();
    if (e.transactionHash && !hash(e.transactionHash)) throw new Error();
    if (e.status !== 'reserved' && !hash(e.transactionHash)) throw new Error();
    if (terminal(e) && (!hash(e.blockHash) || !numeric(e.blockNumber) || !numeric(e.actualGasWei))) throw new Error();
  }
  if (state.entries.filter(e => !terminal(e)).length > 1) throw new Error();
}

/** Dedicated global nonce/gas ledger for owner-enabled all-fee conversions.
 * Unknown signing/submission is retained without retries or nonce replacement.
 * Confirmation reports an exact successful conversion call, not inference cost. */
export class ConversionKeeper {
  constructor({ file, markets, signer = null, enabled = false, dailyGasLimitWei, maxFeePerGasWei, maxPriorityFeePerGasWei, maxGasPerTransaction, minQuoteAmount, slippageBps, now = Date.now } = {}) {
    this.markets = markets; this.client = markets?.client; this.signer = signer; this.enabled = enabled === true; this.now = now;
    this.journal = new PublicJournal(file, { version: 1, operator: signer?.address || null, entries: [] }, validate);
    if (this.enabled) {
      if (!isAddress(signer?.address || '') || typeof signer.signTransaction !== 'function' || !markets?.validateMarket || !this.client) throw new Problem('A dedicated conversion signer and verified markets are required.', 503);
      if (this.journal.state.operator && !same(this.journal.state.operator, signer.address)) throw new Problem('Conversion journal belongs to a different operator; preserve it for recovery.', 503);
      if (!Number.isSafeInteger(slippageBps) || slippageBps < 0 || slippageBps > 500) throw new Problem('Configure explicit conversion slippage between 0 and 500 basis points.', 503);
      this.policy = { dailyGasLimitWei: positive(dailyGasLimitWei, 'conversion daily gas budget'), maxFeePerGasWei: positive(maxFeePerGasWei, 'gas price ceiling'), maxPriorityFeePerGasWei: positive(maxPriorityFeePerGasWei, 'priority fee ceiling'), maxGasPerTransaction: positive(maxGasPerTransaction, 'transaction gas ceiling'), minQuoteAmount: positive(minQuoteAmount, 'minimum VEYL conversion amount'), slippageBps };
      if (this.policy.maxPriorityFeePerGasWei > this.policy.maxFeePerGasWei) throw new Problem('Conversion priority fee exceeds the total price ceiling.', 503);
    }
  }
  snapshot() {
    const state = this.journal.snapshot(), day = Math.floor(this.now() / 86400000);
    return { enabled: this.enabled, chainId: 1, operator: state.operator, persistence: this.journal.healthy ? 'healthy' : 'blocked', policy: clone(this.policy || null),
      dayReservedGasWei: state.entries.filter(e => e.day === day).reduce((sum, e) => sum + BigInt(e.reservedGasWei), 0n).toString(), pending: state.entries.find(e => !terminal(e)) || null, entries: state.entries.slice(-20) };
  }
  async state(market, day) {
    const [policy, reserve, spent, owner, operator] = await Promise.all([
      this.markets.read(market.revenueRouter, 'QuoteRevenueRouter', 'conversionPolicy'),
      this.markets.read(market.revenueRouter, 'QuoteRevenueRouter', 'pendingQuote'),
      this.markets.read(market.revenueRouter, 'QuoteRevenueRouter', 'spentOnDay', [day]),
      this.markets.read(market.treasury, 'AgentTreasury', 'owner'), this.markets.read(market.treasury, 'AgentTreasury', 'operator')
    ]);
    return { policy: policyOf(policy), reserve, spent, owner, operator };
  }
  async tick(project) {
    return this.journal.exclusive(async () => {
      const pending = this.journal.state.entries.find(e => !terminal(e));
      if (pending) return this.#recover(pending);
      if (!this.enabled) return { status: 'disabled' };
      if (this.journal.state.entries.length >= 2000) throw new Problem('Conversion journal history is full. Preserve it before continuing.', 503);
      if (!project?.id || !project.mainnet) return { status: 'unconfigured' };
      const market = await this.markets.validateMarket(project), address = getAddress(this.signer.address);
      if (!market.quoteAsset || zero.test(market.quoteAsset)) return { status: 'native-market' };
      if (market.revenueRouterType !== 'QuoteRevenueRouter' || !isAddress(market.conversionSwapRouter || '') || !isAddress(market.conversionHook || '') || !isAddress(market.quoter || '')) throw new Problem('The exact native conversion market has not been verified.', 503);
      const block = await this.client.getBlock(), timestamp = block.timestamp;
      if (typeof timestamp !== 'bigint' || Math.abs(Number(timestamp) - Math.floor(this.now() / 1000)) > 30) return { status: 'stale-chain-time' };
      const chainDay = timestamp / 86400n, state = await this.state(market, chainDay), policy = state.policy;
      if (!policy?.enabled || !same(policy.executor, address)) return { status: 'owner-policy-disabled' };
      if ([state.owner, state.operator, market.creator, market.protocol, this.markets.config?.addresses?.deployer].some(role => same(role, address))) throw new Problem('Conversion requires a separate signer from treasury, creator and platform roles.', 503);
      if (![policy.maxQuotePerConversion, policy.maxQuotePerDay, policy.minEthPerVeylX18].every(v => typeof v === 'bigint' && v > 0n) || typeof state.reserve !== 'bigint' || typeof state.spent !== 'bigint') throw new Problem('Conversion policy is invalid.', 503);
      const remaining = policy.maxQuotePerDay > state.spent ? policy.maxQuotePerDay - state.spent : 0n;
      const amount = [state.reserve, remaining, policy.maxQuotePerConversion].reduce((a, b) => a < b ? a : b);
      if (amount < this.policy.minQuoteAmount) return { status: 'below-conversion-threshold' };
      const { result: quote } = await this.client.simulateContract({ address: market.quoter, abi: this.markets.artifact('VeylQuoter').abi, functionName: 'quoteExactInput', args: [market.conversionHook, false, amount, LIMIT] });
      if (quote?.amountIn !== amount || typeof quote?.amountOut !== 'bigint' || quote.amountOut <= 0n) return { status: 'full-fill-unavailable' };
      const ownerMinimum = (amount * policy.minEthPerVeylX18 + 10n ** 18n - 1n) / 10n ** 18n;
      const quoteMinimum = quote.amountOut * BigInt(10000 - this.policy.slippageBps) / 10000n;
      const minimum = ownerMinimum > quoteMinimum ? ownerMinimum : quoteMinimum;
      if (minimum <= 0n || minimum > quote.amountOut) return { status: 'owner-price-floor' };
      const deadline = timestamp + 120n;
      const data = encodeFunctionData({ abi: CONVERSION_ABI, functionName: 'convertFees', args: [amount, minimum, LIMIT, deadline] });
      const [balance, latest, pendingNonce, price, estimated] = await Promise.all([
        this.client.getBalance({ address }), this.client.getTransactionCount({ address, blockTag: 'latest' }), this.client.getTransactionCount({ address, blockTag: 'pending' }),
        this.client.estimateFeesPerGas({ type: 'eip1559' }), this.client.estimateGas({ account: address, to: market.revenueRouter, data, value: 0n })
      ]);
      if (latest !== pendingNonce) return { status: 'operator-busy' };
      const fee = price.maxFeePerGas, priority = price.maxPriorityFeePerGas;
      if (typeof fee !== 'bigint' || typeof priority !== 'bigint' || fee <= 0n || priority < 0n || priority > fee || fee > this.policy.maxFeePerGasWei || priority > this.policy.maxPriorityFeePerGasWei || typeof block.baseFeePerGas !== 'bigint' || fee < block.baseFeePerGas + priority) return { status: 'gas-price-limited' };
      if (typeof estimated !== 'bigint' || estimated <= 0n) return { status: 'invalid-gas-estimate' };
      const gas = (estimated * 120n + 99n) / 100n, reserved = gas * fee, createdAt = this.now(), day = Math.floor(createdAt / 86400000);
      const used = this.journal.state.entries.filter(e => e.day === day).reduce((sum, e) => sum + BigInt(e.reservedGasWei), 0n);
      if (gas > this.policy.maxGasPerTransaction) return { status: 'transaction-gas-limited' };
      if (used + reserved > this.policy.dailyGasLimitWei) return { status: 'daily-gas-limited' };
      if (balance < reserved) return { status: 'operator-unfunded' };
      if (minimum <= reserved) return { status: 'uneconomic' };
      // Recheck consent after all awaited quote/gas preparation. The contract
      // repeats policy checks when mined; a policy change can only revert it.
      const fresh = await this.state(market, chainDay);
      if (!fresh.policy || JSON.stringify(clone(fresh.policy)) !== JSON.stringify(clone(policy)) || !same(fresh.owner, state.owner) || !same(fresh.operator, state.operator) || fresh.reserve < amount || fresh.spent + amount > policy.maxQuotePerDay) return { status: 'policy-changed' };
      if (this.now() - createdAt > 30000 || BigInt(Math.floor(this.now() / 1000)) >= deadline - 30n) return { status: 'quote-expired' };
      const transaction = { type: 'eip1559', chainId: 1, from: address, to: market.revenueRouter, data, value: 0n, nonce: latest, gas, maxFeePerGas: fee, maxPriorityFeePerGas: priority };
      const entry = clone({ id: randomUUID(), projectId: project.id, marketId: market.id, quoteAsset: market.quoteAsset, quoteAmount: amount, expectedEth: quote.amountOut, minEthOut: minimum, status: 'reserved', createdAt, day, transaction, reservedGasWei: reserved });
      this.journal.state.operator = address; this.journal.state.entries.push(entry); this.journal.save();
      const { from, ...request } = transaction; let serialized;
      try {
        serialized = await this.signer.signTransaction(request);
        const decoded = parseTransaction(serialized), recovered = await recoverTransactionAddress({ serializedTransaction: serialized });
        if (!same(recovered, address) || !same(decoded.to, request.to) || !same(decoded.data, data) || decoded.type !== 'eip1559' || decoded.chainId !== 1 || decoded.nonce !== latest || (decoded.value || 0n) !== 0n || decoded.gas !== gas || decoded.maxFeePerGas !== fee || decoded.maxPriorityFeePerGas !== priority || decoded.accessList?.length) throw new Error();
      } catch { throw new Problem('Conversion signing outcome requires inspection. Its nonce and gas cannot be automatically retried.', 503); }
      entry.transactionHash = keccak256(serialized); entry.status = 'signed'; this.journal.save();
      entry.status = 'broadcasting'; this.journal.save();
      try {
        const submitted = await this.client.sendRawTransaction({ serializedTransaction: serialized });
        if (!same(submitted, entry.transactionHash)) throw new Error();
        entry.status = 'pending'; this.journal.save();
      } catch { entry.status = 'send_unknown'; this.journal.save(); throw new Problem('Conversion submission is uncertain. Recover the saved hash; it will never be replayed.', 503); }
      return clone(entry);
    });
  }
  async recover() { return this.journal.exclusive(async () => { const pending = this.journal.state.entries.find(e => !terminal(e)); return pending ? this.#recover(pending) : { status: 'idle' }; }); }
  async #recover(entry) {
    if (!entry.transactionHash) return { ...clone(entry), recovery: 'operator-inspection-required-no-replay' };
    await this.markets.checkChain(); let receipt;
    try { receipt = await this.client.getTransactionReceipt({ hash: entry.transactionHash }); }
    catch { return { ...clone(entry), recovery: 'receipt-unavailable-no-replay' }; }
    const [transaction, canonical, finalized] = await Promise.all([this.client.getTransaction({ hash: entry.transactionHash }), this.client.getBlock({ blockNumber: receipt.blockNumber }), this.client.getBlock({ blockTag: 'finalized' })]);
    const tx = entry.transaction;
    if (!same(receipt.transactionHash, entry.transactionHash) || !same(transaction.from, tx.from) || !same(transaction.to, tx.to) || !same(transaction.input, tx.data) || transaction.value !== 0n || transaction.nonce !== tx.nonce || transaction.chainId !== 1 || transaction.gas !== BigInt(tx.gas) || transaction.maxFeePerGas !== BigInt(tx.maxFeePerGas) || transaction.maxPriorityFeePerGas !== BigInt(tx.maxPriorityFeePerGas)) throw new Problem('Conversion receipt does not match its exact saved transaction.', 503);
    if (!same(canonical.hash, receipt.blockHash) || finalized.number < receipt.blockNumber) return { ...clone(entry), recovery: 'awaiting-canonical-finality' };
    if (!['success', 'reverted'].includes(receipt.status) || receipt.gasUsed > BigInt(tx.gas) || receipt.effectiveGasPrice > BigInt(tx.maxFeePerGas)) throw new Problem('Unexpected conversion receipt accounting.', 503);
    entry.status = receipt.status === 'success' ? 'confirmed' : 'reverted'; entry.blockNumber = receipt.blockNumber.toString(); entry.blockHash = receipt.blockHash; entry.actualGasWei = (receipt.gasUsed * receipt.effectiveGasPrice).toString(); entry.confirmedAt = this.now(); this.journal.save(); return clone(entry);
  }
}
