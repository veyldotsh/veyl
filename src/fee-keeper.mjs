import { randomUUID } from 'node:crypto';
import { encodeFunctionData, getAddress, isAddress, keccak256, parseTransaction, recoverTransactionAddress } from 'viem';
import { PublicJournal } from './public-journal.mjs';
import { Problem } from './agent.mjs';

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const numeric = value => typeof value === 'string' && /^\d{1,78}$/.test(value);
const terminal = entry => ['confirmed', 'reverted'].includes(entry.status);
const states = new Set(['reserved', 'signed', 'broadcasting', 'pending', 'send_unknown', 'confirmed', 'reverted']);
const hash = value => /^0x[\da-f]{64}$/i.test(value || '');
const clone = value => JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item));
const positive = (value, label) => { if (!numeric(String(value || '')) || BigInt(value) <= 0n) throw new Problem(`Set a positive ${label} before enabling the fee keeper.`, 503); return BigInt(value); };
function validate(state) {
  if (state?.version !== 1 || !Array.isArray(state.entries) || state.entries.length > 2000 || (state.operator !== null && !isAddress(state.operator || ''))) throw new Error();
  if (Object.keys(state).some(k => !['version', 'operator', 'entries'].includes(k))) throw new Error();
  const ids = new Set();
  for (const e of state.entries) {
    const keys = ['id', 'projectId', 'marketId', 'action', 'beneficiary', 'revenueWei', 'revenueAsset', 'status', 'createdAt', 'day', 'transaction', 'reservedGasWei', 'transactionHash', 'blockNumber', 'blockHash', 'actualGasWei', 'confirmedAt'];
    if (Object.keys(e).some(k => !keys.includes(k)) || ids.has(e.id) || typeof e.id !== 'string' || typeof e.projectId !== 'string' || !hash(e.marketId) || !['flush', 'distribute'].includes(e.action) || !states.has(e.status) || !Number.isSafeInteger(e.createdAt) || e.day !== Math.floor(e.createdAt / 86400000) || !numeric(e.revenueWei) || !numeric(e.reservedGasWei) || (e.beneficiary !== null && !isAddress(e.beneficiary || ''))) throw new Error();
    ids.add(e.id);
    if (e.revenueAsset !== undefined && !isAddress(e.revenueAsset)) throw new Error();
    const t = e.transaction;
    if (!t || Object.keys(t).sort().join(',') !== 'chainId,data,from,gas,maxFeePerGas,maxPriorityFeePerGas,nonce,to,type,value' || t.type !== 'eip1559' || t.chainId !== 1 || !same(t.from, state.operator) || !isAddress(t.to || '') || !/^0x[\da-f]*$/i.test(t.data || '') || t.value !== '0' || !Number.isSafeInteger(t.nonce) || t.nonce < 0 || ![t.gas, t.maxFeePerGas, t.maxPriorityFeePerGas].every(numeric) || BigInt(t.gas) * BigInt(t.maxFeePerGas) !== BigInt(e.reservedGasWei)) throw new Error();
    if (e.transactionHash && !hash(e.transactionHash)) throw new Error();
    if (e.status !== 'reserved' && !hash(e.transactionHash)) throw new Error();
    if (terminal(e) && (!hash(e.blockHash) || !numeric(e.blockNumber) || !numeric(e.actualGasWei))) throw new Error();
  }
  if (state.entries.filter(e => !terminal(e)).length > 1) throw new Error();
}

/** One dedicated signer, one durable global nonce ledger. Each tick attempts at
 * most one permissionless action. A missing/uncertain receipt never causes a
 * resubmission, replacement or fresh nonce; worst-case gas stays reserved. */
export class FeeKeeper {
  constructor({ file, markets, signer = null, enabled = false, dailyGasLimitWei, maxFeePerGasWei, maxPriorityFeePerGasWei, maxGasPerTransaction, minRevenueWei, minQuoteRevenue, now = () => Date.now() } = {}) {
    this.markets = markets; this.client = markets?.client; this.signer = signer; this.enabled = enabled === true; this.now = now;
    this.journal = new PublicJournal(file, { version: 1, operator: signer?.address || null, entries: [] }, validate);
    if (this.enabled) {
      if (!isAddress(signer?.address || '') || typeof signer.signTransaction !== 'function' || !markets?.validateMarket || !this.client) throw new Problem('A dedicated fee signer and verified Ethereum markets are required.', 503);
      if (this.journal.state.operator && !same(this.journal.state.operator, signer.address)) throw new Problem('Fee journal belongs to a different operator. Preserve it for recovery.', 503);
      this.policy = { dailyGasLimitWei: positive(dailyGasLimitWei, 'daily fee-keeper gas budget'), maxFeePerGasWei: positive(maxFeePerGasWei, 'gas price ceiling'), maxPriorityFeePerGasWei: positive(maxPriorityFeePerGasWei, 'priority price ceiling'), maxGasPerTransaction: positive(maxGasPerTransaction, 'transaction gas ceiling'), minRevenueWei: positive(minRevenueWei, 'minimum harvest amount') };
      this.policy.minQuoteRevenue = minQuoteRevenue === undefined ? null : positive(minQuoteRevenue, 'minimum VEYL harvest amount');
      if (this.policy.maxPriorityFeePerGasWei > this.policy.maxFeePerGasWei) throw new Problem('Priority fee ceiling exceeds the total gas price ceiling.', 503);
    }
  }
  snapshot() {
    const state = this.journal.snapshot(), day = Math.floor(this.now() / 86400000);
    return { enabled: this.enabled, chainId: 1, operator: state.operator, persistence: this.journal.healthy ? 'healthy' : 'blocked', policy: clone(this.policy || null),
      dayReservedGasWei: state.entries.filter(e => e.day === day).reduce((sum, e) => sum + BigInt(e.reservedGasWei), 0n).toString(),
      pending: state.entries.find(e => !terminal(e)) || null, entries: state.entries.slice(-20) };
  }
  async tick(project) {
    return this.journal.exclusive(async () => {
      const pending = this.journal.state.entries.find(e => !terminal(e));
      if (pending) return this.#recover(pending);
      if (!this.enabled) return { status: 'disabled' };
      if (this.journal.state.entries.length >= 2000) throw new Problem('Fee journal reached its retained history limit. Preserve and archive it before continuing.', 503);
      if (!project?.id || !project.mainnet) return { status: 'unconfigured' };
      const market = await this.markets.validateMarket(project), address = getAddress(this.signer.address);
      const quoted = typeof market.quoteAsset === 'string' && !/^0x0{40}$/i.test(market.quoteAsset);
      const routerType = quoted ? 'QuoteRevenueRouter' : 'RevenueRouter', minimum = quoted ? this.policy.minQuoteRevenue : this.policy.minRevenueWei;
      const nativeAsset = '0x0000000000000000000000000000000000000000';
      const roles = await Promise.all(['owner', 'operator'].map(name => this.markets.read(market.treasury, 'AgentTreasury', name)));
      if ([...roles, market.creator, market.protocol, this.markets.config?.addresses?.deployer].some(role => same(role, address))) throw new Problem('Fee maintenance requires a separate signer from treasury, creator and platform roles.', 503);
      const choices = [];
      const pendingFees = await this.markets.read(market.hook, 'VeylFeeHook', 'pendingFees');
      if (minimum && pendingFees >= minimum) choices.push({ action: 'flush', to: market.hook, data: encodeFunctionData({ abi: this.markets.artifact('VeylFeeHook').abi, functionName: 'flushFees' }), revenueWei: pendingFees, revenueAsset: quoted ? market.quoteAsset : nativeAsset, beneficiary: null });
      // Fixed payout destinations are read from the verified factory/router, never input.
      for (const beneficiary of [...new Set([market.treasury, market.creator, market.protocol].map(a => a.toLowerCase()))]) {
        const amount = await this.markets.read(market.revenueRouter, routerType, 'claimable', [beneficiary]);
        if (amount >= this.policy.minRevenueWei) choices.push({ action: 'distribute', to: market.revenueRouter, data: encodeFunctionData({ abi: this.markets.artifact(routerType).abi, functionName: 'distribute', args: [beneficiary] }), revenueWei: amount, revenueAsset: nativeAsset, beneficiary });
      }
      if (!choices.length) return { status: quoted && !minimum ? 'quote-harvest-disabled' : 'idle' };
      // Prefer delivered revenue, but a dust claim or rejecting beneficiary must
      // not prevent another fixed, independently checked action from proceeding.
      choices.sort((a, b) => Number(b.action === 'distribute') - Number(a.action === 'distribute'));
      const [block, balance, latest, pendingNonce, price] = await Promise.all([
        this.client.getBlock(), this.client.getBalance({ address }), this.client.getTransactionCount({ address, blockTag: 'latest' }),
        this.client.getTransactionCount({ address, blockTag: 'pending' }), this.client.estimateFeesPerGas({ type: 'eip1559' })
      ]);
      if (latest !== pendingNonce) return { status: 'operator-busy' };
      const priority = price.maxPriorityFeePerGas, fee = price.maxFeePerGas;
      if (typeof fee !== 'bigint' || typeof priority !== 'bigint' || fee > this.policy.maxFeePerGasWei || priority > this.policy.maxPriorityFeePerGasWei || priority > fee || fee <= 0n || priority < 0n || typeof block.baseFeePerGas !== 'bigint' || fee < block.baseFeePerGas + priority) return { status: 'gas-price-limited' };
      const createdAt = this.now(), day = Math.floor(createdAt / 86400000);
      const used = this.journal.state.entries.filter(e => e.day === day).reduce((sum, e) => sum + BigInt(e.reservedGasWei), 0n);
      let action, gas, reserved, skipped = 'no-callable-action';
      for (const candidate of choices) {
        let estimated;
        try { estimated = await this.client.estimateGas({ account: address, to: candidate.to, data: candidate.data, value: 0n }); }
        catch { skipped = 'no-callable-action'; continue; }
        if (typeof estimated !== 'bigint' || estimated <= 0n) { skipped = 'no-callable-action'; continue; }
        const candidateGas = (estimated * 120n + 99n) / 100n, candidateReserved = candidateGas * fee;
        if (candidateGas > this.policy.maxGasPerTransaction) { skipped = 'transaction-gas-limited'; continue; }
        if (used + candidateReserved > this.policy.dailyGasLimitWei) { skipped = 'daily-gas-limited'; continue; }
        if (balance < candidateReserved) { skipped = 'operator-unfunded'; continue; }
        // ERC20 harvests use the explicit quote-unit threshold and gas budget.
        // Never compare a VEYL quantity with an ETH-denominated gas cost.
        if (candidate.revenueAsset === nativeAsset && candidate.revenueWei <= candidateReserved) { skipped = 'uneconomic'; continue; }
        action = candidate; gas = candidateGas; reserved = candidateReserved; break;
      }
      if (!action) return { status: skipped };
      const transaction = { type: 'eip1559', chainId: 1, from: address, to: action.to, data: action.data, value: 0n, nonce: latest, gas, maxFeePerGas: fee, maxPriorityFeePerGas: priority };
      const entry = clone({ id: randomUUID(), projectId: project.id, marketId: market.id, action: action.action, beneficiary: action.beneficiary, revenueWei: action.revenueWei, revenueAsset: action.revenueAsset, status: 'reserved', createdAt, day, transaction, reservedGasWei: reserved });
      this.journal.state.operator = address; this.journal.state.entries.push(entry); this.journal.save();
      const { from, ...request } = transaction;
      let serialized;
      try {
        serialized = await this.signer.signTransaction(request);
        const decoded = parseTransaction(serialized), recovered = await recoverTransactionAddress({ serializedTransaction: serialized });
        if (!same(recovered, address) || !same(decoded.to, request.to) || !same(decoded.data, request.data) || decoded.type !== 'eip1559' || decoded.chainId !== 1 || decoded.nonce !== latest || (decoded.value || 0n) !== 0n || decoded.gas !== gas || decoded.maxFeePerGas !== fee || decoded.maxPriorityFeePerGas !== priority || decoded.accessList?.length) throw new Error();
      } catch { throw new Problem('Fee signing outcome requires inspection. Its reserved nonce and gas cannot be automatically retried.', 503); }
      entry.transactionHash = keccak256(serialized); entry.status = 'signed'; this.journal.save();
      entry.status = 'broadcasting'; this.journal.save();
      try {
        const submitted = await this.client.sendRawTransaction({ serializedTransaction: serialized });
        if (!same(submitted, entry.transactionHash)) throw new Error();
        entry.status = 'pending'; this.journal.save();
      } catch {
        entry.status = 'send_unknown'; this.journal.save();
        throw new Problem('Fee submission is uncertain. Recover the saved transaction hash; it will never be replayed.', 503);
      }
      return clone(entry);
    });
  }
  async recover() {
    return this.journal.exclusive(async () => { const pending = this.journal.state.entries.find(e => !terminal(e)); return pending ? this.#recover(pending) : { status: 'idle' }; });
  }
  async #recover(entry) {
    if (!entry.transactionHash) return { ...clone(entry), recovery: 'operator-inspection-required-no-replay' };
    await this.markets.checkChain();
    let receipt;
    try { receipt = await this.client.getTransactionReceipt({ hash: entry.transactionHash }); }
    catch { return { ...clone(entry), recovery: 'receipt-unavailable-no-replay' }; }
    const [transaction, canonical, finalized] = await Promise.all([
      this.client.getTransaction({ hash: entry.transactionHash }), this.client.getBlock({ blockNumber: receipt.blockNumber }), this.client.getBlock({ blockTag: 'finalized' })
    ]);
    const t = entry.transaction;
    if (!same(receipt.transactionHash, entry.transactionHash) || !same(transaction.from, t.from) || !same(transaction.to, t.to) || !same(transaction.input, t.data) || transaction.value !== 0n || transaction.nonce !== t.nonce || transaction.chainId !== 1 || transaction.gas !== BigInt(t.gas) || transaction.maxFeePerGas !== BigInt(t.maxFeePerGas) || transaction.maxPriorityFeePerGas !== BigInt(t.maxPriorityFeePerGas)) throw new Problem('Fee receipt does not match its exact saved transaction. Keeper remains blocked.', 503);
    if (!same(canonical.hash, receipt.blockHash) || finalized.number < receipt.blockNumber) return { ...clone(entry), recovery: 'awaiting-canonical-finality' };
    if (!['success', 'reverted'].includes(receipt.status) || receipt.gasUsed > BigInt(t.gas) || receipt.effectiveGasPrice > BigInt(t.maxFeePerGas)) throw new Problem('Unexpected fee receipt accounting. Keeper remains blocked.', 503);
    entry.status = receipt.status === 'success' ? 'confirmed' : 'reverted'; entry.blockNumber = receipt.blockNumber.toString(); entry.blockHash = receipt.blockHash;
    entry.actualGasWei = (receipt.gasUsed * receipt.effectiveGasPrice).toString(); entry.confirmedAt = this.now(); this.journal.save();
    return clone(entry);
  }
}
