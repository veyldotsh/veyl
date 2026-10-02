import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import { decodeFunctionData, isAddress, keccak256, parseTransaction, recoverTransactionAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { TREASURY_RUNWAY_ABI } from './runway.mjs';
import { PublicJournal } from './public-journal.mjs';
import { Problem } from './agent.mjs';

export const TREASURY_OPERATOR_ARM = 'I AUTHORIZE BOUNDED VEYL TREASURY REFILLS ON ETHEREUM';
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const uint = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < 2n ** 256n;
const hash = value => /^0x[\da-f]{64}$/i.test(value || '');
const copy = value => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v));
const terminal = entry => ['confirmed', 'reverted'].includes(entry.status);
const positive = (v, name) => { if (!uint(String(v || '')) || BigInt(v) <= 0n) throw new Problem(`Configure a positive treasury ${name}.`, 503); return BigInt(v); };
function pay(data) { try { const decoded = decodeFunctionData({ abi: TREASURY_RUNWAY_ABI, data }); if (decoded.functionName !== 'pay' || data.length !== 202) throw new Error(); return decoded.args; } catch { throw new Problem('Treasury operator signs only exact pay expenses.', 403); } }

/** Loads a dedicated sign-only account only after two explicit operator gates.
 * Caller must forbid the fee operator and all owner/deployer/platform addresses. */
export function loadTreasuryOperator({ env = process.env, forbiddenAddresses = [], forbiddenDirectories = [process.cwd()] } = {}) {
  if (env.VEYL_AUTOMATIC_RUNWAY_ENABLED !== 'true') { delete env.VEYL_TREASURY_OPERATOR_PRIVATE_KEY; return null; }
  if (env.VEYL_TREASURY_OPERATOR_ARM !== TREASURY_OPERATOR_ARM) throw new Problem('Treasury operator is not explicitly armed.', 503);
  const expected = env.VEYL_TREASURY_OPERATOR_ADDRESS;
  if (!isAddress(expected || '') || /^0x0{40}$/i.test(expected) || forbiddenAddresses.some(a => same(a, expected))) throw new Problem('Use a separate public treasury operator address.', 503);
  const keyFile = env.VEYL_TREASURY_OPERATOR_KEY_FILE, secret = env.VEYL_TREASURY_OPERATOR_PRIVATE_KEY;
  if (Boolean(keyFile) === Boolean(secret)) throw new Problem('Configure exactly one operator-only treasury key source.', 503);
  let key, bytes;
  try {
    if (keyFile) {
      if (process.platform !== 'linux' || !isAbsolute(keyFile)) throw new Error();
      const file = resolve(keyFile);
      if (forbiddenDirectories.filter(Boolean).some(dir => { const p = relative(resolve(dir), file); return p === '' || (!p.startsWith('..') && !isAbsolute(p)); })) throw new Error();
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { const stat = fstatSync(fd); if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || stat.size > 128) throw new Error(); bytes = readFileSync(fd); key = bytes.toString('utf8').trim(); }
      finally { closeSync(fd); }
    } else { key = secret; delete env.VEYL_TREASURY_OPERATOR_PRIVATE_KEY; }
    if (!/^0x[\da-f]{64}$/i.test(key || '')) throw new Error();
    const account = privateKeyToAccount(key); if (!same(account.address, expected)) throw new Error();
    return Object.freeze({ address: account.address, async signTransaction(tx) {
      const allowed = ['type', 'chainId', 'to', 'data', 'value', 'nonce', 'gas', 'maxFeePerGas', 'maxPriorityFeePerGas'];
      if (Object.keys(tx).some(k => !allowed.includes(k)) || tx.chainId !== 1 || tx.type !== 'eip1559' || !isAddress(tx.to || '') || tx.value !== 0n) throw new Problem('Treasury signer rejected a non-expense transaction.', 403);
      const [expense, recipient, amount] = pay(tx.data); if (/^0x0{64}$/i.test(expense) || /^0x0{40}$/i.test(recipient) || amount <= 0n) throw new Problem('Invalid treasury expense.', 403);
      return account.signTransaction(tx);
    } });
  } catch { throw new Problem('Treasury operator key source or public address is invalid. No key material was logged.', 503); }
  finally { bytes?.fill(0); key = undefined; }
}

function validate(state) {
  if (!state || Object.keys(state).sort().join() !== 'entries,operator,version' || state.version !== 1 || (state.operator !== null && !isAddress(state.operator || '')) || !Array.isArray(state.entries) || state.entries.length > 2000) throw new Error();
  const ids = new Set(), expenses = new Set();
  for (const e of state.entries) {
    const keys = ['id', 'projectId', 'refillId', 'expenseId', 'recipient', 'amountWei', 'createdAt', 'day', 'status', 'transaction', 'reservedGasWei', 'transactionHash', 'blockNumber', 'blockHash', 'actualGasWei', 'confirmedAt'];
    if (Object.keys(e).some(k => !keys.includes(k)) || ids.has(e.id) || expenses.has(e.expenseId) || typeof e.id !== 'string' || typeof e.projectId !== 'string' || typeof e.refillId !== 'string' || !hash(e.expenseId) || !isAddress(e.recipient || '') || !uint(e.amountWei) || !uint(e.reservedGasWei) || !Number.isSafeInteger(e.createdAt) || e.day !== Math.floor(e.createdAt / 86400000) || !['reserved', 'signed', 'broadcasting', 'pending', 'send_unknown', 'confirmed', 'reverted'].includes(e.status)) throw new Error();
    const t = e.transaction;
    if (!t || Object.keys(t).sort().join() !== 'chainId,data,from,gas,maxFeePerGas,maxPriorityFeePerGas,nonce,to,type,value' || t.chainId !== 1 || t.type !== 'eip1559' || !same(t.from, state.operator) || !isAddress(t.to || '') || t.value !== '0' || !Number.isSafeInteger(t.nonce) || t.nonce < 0 || ![t.gas, t.maxFeePerGas, t.maxPriorityFeePerGas].every(uint) || BigInt(t.gas) * BigInt(t.maxFeePerGas) !== BigInt(e.reservedGasWei)) throw new Error();
    const [expense, recipient, amount] = pay(t.data); if (!same(expense, e.expenseId) || !same(recipient, e.recipient) || amount !== BigInt(e.amountWei)) throw new Error();
    if (e.transactionHash && !hash(e.transactionHash)) throw new Error(); if (e.status !== 'reserved' && !hash(e.transactionHash)) throw new Error();
    if (terminal(e) && (!uint(e.blockNumber) || !hash(e.blockHash) || !uint(e.actualGasWei))) throw new Error();
    ids.add(e.id); expenses.add(e.expenseId);
  }
  if (state.entries.filter(e => !terminal(e)).length > 1) throw new Error();
}

/** Shared nonce/gas envelope for owner-opted-in automatic treasury payments.
 * Each project adapter is bound to its immutable project, daemon and runway.
 * No free-form transaction endpoint exists. Returned hashes identify attempts,
 * including uncertain RPC acceptance; only canonical final receipts prove payment. */
export class TreasuryOperator {
  constructor({ file, markets, signer = null, enabled = false, forbiddenAddresses = [], dailyGasLimitWei, maxFeePerGasWei, maxPriorityFeePerGasWei, maxGasPerTransaction, now = Date.now } = {}) {
    this.markets = markets; this.client = markets?.client; this.signer = signer; this.enabled = enabled === true; this.now = now; this.forbiddenAddresses = forbiddenAddresses;
    this.journal = new PublicJournal(file, { version: 1, operator: signer?.address || null, entries: [] }, validate);
    if (this.enabled) {
      if (!isAddress(signer?.address || '') || typeof signer.signTransaction !== 'function' || !markets?.validateMarket || forbiddenAddresses.some(a => same(a, signer.address))) throw new Problem('A separate treasury signer and verified markets are required.', 503);
      if (this.journal.state.operator && !same(this.journal.state.operator, signer.address)) throw new Problem('Treasury operator journal belongs to another signer.', 503);
      this.policy = { dailyGasLimitWei: positive(dailyGasLimitWei, 'daily gas budget'), maxFeePerGasWei: positive(maxFeePerGasWei, 'gas price ceiling'), maxPriorityFeePerGasWei: positive(maxPriorityFeePerGasWei, 'priority fee ceiling'), maxGasPerTransaction: positive(maxGasPerTransaction, 'transaction gas ceiling') };
      if (this.policy.maxPriorityFeePerGasWei > this.policy.maxFeePerGasWei) throw new Problem('Treasury priority fee exceeds total fee ceiling.', 503);
    }
  }
  snapshot() { const state = this.journal.snapshot(), day = Math.floor(this.now() / 86400000); return { enabled: this.enabled, operator: state.operator, persistence: this.journal.healthy ? 'healthy' : 'blocked', policy: copy(this.policy || null), dayReservedGasWei: state.entries.filter(e => e.day === day).reduce((s, e) => s + BigInt(e.reservedGasWei), 0n).toString(), pending: state.entries.find(e => !terminal(e)) || null, entries: state.entries.slice(-20) }; }
  forProject({ project, funding, getRunway }) {
    if (!project?.id || !funding || typeof getRunway !== 'function') throw new Problem('Treasury signer requires a bound project, daemon and runway.', 503);
    return { account: { address: this.signer?.address }, sendTransaction: request => this.#send({ project, funding, getRunway, request }) };
  }
  async #send({ project, funding, getRunway, request }) {
    let safeBeforeReservation = true;
    try { return await this.journal.exclusive(async () => {
      if (!this.enabled || !this.signer) throw new Problem('Automatic treasury signing is disabled.', 403);
      if (Object.keys(request).some(k => !['chain', 'account', 'to', 'data', 'value'].includes(k)) || request.chain?.id !== 1 || !same(request.account?.address, this.signer.address) || request.value !== 0n) throw new Problem('Only the exact runway transaction is accepted.', 403);
      const [expenseId, recipient, amount] = pay(request.data);
      if (this.journal.state.entries.some(e => same(e.expenseId, expenseId))) safeBeforeReservation = false;
      const state = getRunway(), p = state?.policy;
      if (!p?.automatic || p.projectId !== project.id || !same(p.operator, this.signer.address) || !same(p.treasury, request.to) || state.persistence !== 'healthy' || !same(state.fundingAddress, recipient) || !funding.capabilities().approvalEnabled) throw new Problem('Owner policy, daemon approval and healthy runway are required.', 403);
      const item = state.refills?.find(i => same(i.expenseId, expenseId));
      if (!item || item.status !== 'sending' || !same(item.fundingAddress, recipient) || !uint(item.amountWei) || BigInt(item.amountWei) !== amount || !item.calls?.some(c => same(c.from, this.signer.address) && same(c.to, request.to) && same(c.data, request.data) && c.value === '0x0' && c.chainId === '0x1')) throw new Problem('Payment differs from its exact saved refill.', 403);
      const previous = this.journal.state.entries.find(e => same(e.expenseId, expenseId));
      if (previous) {
        safeBeforeReservation = false;
        if (previous.projectId !== project.id || previous.refillId !== item.id || !same(previous.transaction.to, request.to) || !same(previous.transaction.data, request.data)) throw new Problem('Expense identity conflicts with its saved transaction.', 409);
        if (previous.transactionHash) return previous.transactionHash;
        throw new Problem('Uncertain treasury signing cannot be replayed. Preserve its reserved nonce.', 503);
      }
      const pending = this.journal.state.entries.find(e => !terminal(e)); if (pending) { await this.#recover(pending); if (!terminal(pending)) throw new Problem('Another treasury transaction awaits final recovery.', 409); }
      if (this.journal.state.entries.length >= 2000) throw new Problem('Treasury operator history is full. Preserve and archive before continuing.', 503);
      const market = await this.markets.validateMarket(project);
      if (!same(market.treasury, p.treasury) || [p.owner, market.creator, market.protocol, this.markets.config?.addresses?.deployer, ...this.forbiddenAddresses].some(a => same(a, this.signer.address))) throw new Problem('Treasury signer must be separate from owners, platform and fee operator.', 403);
      const block = await this.client.getBlock(), day = block.timestamp / 86400n, read = (functionName, args = []) => this.client.readContract({ address: p.treasury, abi: TREASURY_RUNWAY_ABI, functionName, args, blockNumber: block.number });
      const [owner, operator, limit, spent, allowed, paid, treasuryBalance, daemon] = await Promise.all([read('owner'), read('operator'), read('dailyLimit'), read('spentOnDay', [day]), read('allowedRecipient', [recipient]), read('paid', [expenseId]), this.client.getBalance({ address: p.treasury, blockNumber: block.number }), funding.inspect()]);
      if (!same(owner, p.owner) || !same(operator, p.operator) || !allowed || paid || !same(daemon.funding?.address, recipient)) throw new Problem('Treasury or daemon authorization changed; no payment signed.', 409);
      if (![p.maxTopUpWei, p.dailyTopUpWei].every(uint)) throw new Problem('Invalid saved refill limits.', 409);
      const held = state.refills.filter(i => i.id !== item.id && i.budgetDay === String(day) && i.status !== 'reverted').reduce((s, i) => s + BigInt(i.amountWei || '0'), 0n);
      if (amount <= 0n || amount > treasuryBalance || amount > BigInt(p.maxTopUpWei) || held + amount > BigInt(p.dailyTopUpWei) || spent + amount > limit) throw new Problem('Treasury refill exceeds a saved or onchain limit.', 409);
      const address = this.signer.address;
      const [latest, next, price, balance, estimated] = await Promise.all([this.client.getTransactionCount({ address, blockTag: 'latest' }), this.client.getTransactionCount({ address, blockTag: 'pending' }), this.client.estimateFeesPerGas({ type: 'eip1559' }), this.client.getBalance({ address }), this.client.estimateGas({ account: address, to: request.to, data: request.data, value: 0n })]);
      if (latest !== next) throw new Problem('Treasury operator has an unrelated pending transaction.', 409);
      const gas = (estimated * 120n + 99n) / 100n, fee = price.maxFeePerGas, priority = price.maxPriorityFeePerGas;
      if (estimated <= 0n || gas > this.policy.maxGasPerTransaction || typeof fee !== 'bigint' || typeof priority !== 'bigint' || fee <= 0n || priority < 0n || priority > fee || fee > this.policy.maxFeePerGasWei || priority > this.policy.maxPriorityFeePerGasWei || typeof block.baseFeePerGas !== 'bigint' || fee < block.baseFeePerGas + priority) throw new Problem('Treasury transaction exceeds its gas or price ceiling.', 409);
      const reserved = gas * fee, createdAt = this.now(), budgetDay = Math.floor(createdAt / 86400000), heldGas = this.journal.state.entries.filter(e => e.day === budgetDay).reduce((s, e) => s + BigInt(e.reservedGasWei), 0n);
      if (heldGas + reserved > this.policy.dailyGasLimitWei || balance < reserved) throw new Problem('Treasury operator daily gas budget or ETH balance is insufficient.', 409);
      // RPC preparation can await for seconds. A local owner pause or changed
      // authorization during that interval must win before the first signature.
      const current = getRunway(), currentItem = current?.refills?.find(i => i.id === item.id);
      if (current?.persistence !== 'healthy' || !current.policy?.automatic || JSON.stringify(current.policy) !== JSON.stringify(p) || JSON.stringify(currentItem) !== JSON.stringify(item) || !same(current.fundingAddress, recipient) || !funding.capabilities().approvalEnabled) throw new Problem('Automatic treasury authorization changed during preparation. No transaction was signed.', 409);
      const transaction = { type: 'eip1559', chainId: 1, from: address, to: request.to, data: request.data, value: 0n, nonce: latest, gas, maxFeePerGas: fee, maxPriorityFeePerGas: priority };
      const entry = copy({ id: randomUUID(), projectId: project.id, refillId: item.id, expenseId, recipient, amountWei: amount, createdAt, day: budgetDay, status: 'reserved', transaction, reservedGasWei: reserved });
      safeBeforeReservation = false;
      this.journal.state.operator = address; this.journal.state.entries.push(entry); this.journal.save();
      let serialized;
      try {
        const { from, ...tx } = transaction; serialized = await this.signer.signTransaction(tx);
        const decoded = parseTransaction(serialized), recovered = await recoverTransactionAddress({ serializedTransaction: serialized });
        if (!same(recovered, address) || decoded.type !== 'eip1559' || decoded.chainId !== 1 || !same(decoded.to, transaction.to) || !same(decoded.data, transaction.data) || (decoded.value || 0n) !== 0n || decoded.nonce !== latest || decoded.gas !== gas || decoded.maxFeePerGas !== fee || decoded.maxPriorityFeePerGas !== priority || decoded.accessList?.length) throw new Error();
      } catch { throw new Problem('Uncertain treasury signing cannot be retried automatically.', 503); }
      entry.transactionHash = keccak256(serialized); entry.status = 'signed'; this.journal.save(); entry.status = 'broadcasting'; this.journal.save();
      try { const submitted = await this.client.sendRawTransaction({ serializedTransaction: serialized }); if (!same(submitted, entry.transactionHash)) throw new Error(); entry.status = 'pending'; }
      catch { entry.status = 'send_unknown'; }
      // The returned precomputed hash does not assert RPC acceptance. Runway must
      // inspect its final receipt, never resend; the global nonce remains blocked.
      this.journal.save(); return entry.transactionHash;
    }); } catch (error) {
      // Only this known sign-only adapter may attest that the current expense
      // never reached reservation/signing. Runway can then retain `prepared`.
      // Any persisted attempt or persistence failure remains non-retryable.
      if (safeBeforeReservation && this.journal.healthy) error.treasuryNoSigningAttempted = true;
      throw error;
    }
  }
  async recover() { return this.journal.exclusive(async () => { const pending = this.journal.state.entries.find(e => !terminal(e)); return pending ? this.#recover(pending) : { status: 'idle' }; }); }
  async #recover(entry) {
    if (!entry.transactionHash) return { ...copy(entry), recovery: 'operator-inspection-required-no-replay' };
    await this.markets.checkChain(); let receipt;
    try { receipt = await this.client.getTransactionReceipt({ hash: entry.transactionHash }); } catch { return { ...copy(entry), recovery: 'receipt-unavailable-no-replay' }; }
    const [tx, canonical, finalized] = await Promise.all([this.client.getTransaction({ hash: entry.transactionHash }), this.client.getBlock({ blockNumber: receipt.blockNumber }), this.client.getBlock({ blockTag: 'finalized' })]), t = entry.transaction;
    if (!same(receipt.transactionHash, entry.transactionHash) || !same(tx.from, t.from) || !same(tx.to, t.to) || !same(tx.input, t.data) || tx.value !== 0n || tx.chainId !== 1 || tx.nonce !== t.nonce || tx.gas !== BigInt(t.gas) || tx.maxFeePerGas !== BigInt(t.maxFeePerGas) || tx.maxPriorityFeePerGas !== BigInt(t.maxPriorityFeePerGas)) throw new Problem('Treasury receipt differs from the exact saved expense.', 503);
    if (!same(canonical.hash, receipt.blockHash) || finalized.number < receipt.blockNumber) return { ...copy(entry), recovery: 'awaiting-canonical-finality' };
    if (!['success', 'reverted'].includes(receipt.status) || receipt.gasUsed > BigInt(t.gas) || receipt.effectiveGasPrice > BigInt(t.maxFeePerGas)) throw new Problem('Unexpected treasury receipt accounting.', 503);
    entry.status = receipt.status === 'success' ? 'confirmed' : 'reverted'; entry.actualGasWei = String(receipt.gasUsed * receipt.effectiveGasPrice); entry.blockNumber = String(receipt.blockNumber); entry.blockHash = receipt.blockHash; entry.confirmedAt = this.now(); this.journal.save(); return copy(entry);
  }
}
