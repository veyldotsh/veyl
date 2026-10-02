import { randomUUID } from 'node:crypto';
import { decodeEventLog, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, parseAbi, stringToHex } from 'viem';
import { mainnet } from 'viem/chains';
import { Problem } from './agent.mjs';
import { PublicJournal } from './public-journal.mjs';

export const TREASURY_RUNWAY_ABI = parseAbi([
  'function owner() view returns (address)', 'function operator() view returns (address)',
  'function dailyLimit() view returns (uint256)', 'function spentOnDay(uint256) view returns (uint256)',
  'function allowedRecipient(address) view returns (bool)', 'function paid(bytes32) view returns (bool)',
  'function setRecipient(address,bool)', 'function pay(bytes32,address,uint256)',
  'event Expense(bytes32 indexed id,address indexed recipient,uint256 amount)'
]);
const terminal = new Set(['funded', 'active', 'reverted', 'abandoned']);
const phases = new Set(['preparing', 'prepare_unknown', 'prepared', 'sending', 'send_unknown', 'pending', 'funded', 'deposit_pending', 'active', 'reverted', 'recovery_required', 'abandoned']);
const copy = value => structuredClone(value);
const same = (a, b) => a?.toLowerCase() === b?.toLowerCase();
function address(value) { try { const a = getAddress(value); if (/^0x0{40}$/.test(a)) throw new Error(); return a; } catch { throw new Problem('Use a valid nonzero public Ethereum address.'); } }
function uint(value, name, positive = true) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value) || BigInt(value) >= 2n ** 256n || (positive && value === '0')) throw new Problem(`Invalid ${name}; use an exact integer string.`);
  return value;
}
function hash(value) { if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Problem('Invalid transaction hash.'); return value.toLowerCase(); }
function policy(input) {
  if (!input || typeof input.projectId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.projectId)) throw new Problem('Invalid project identifier.');
  const p = { projectId: input.projectId, treasury: address(input.treasury), owner: address(input.owner), operator: address(input.operator),
    depositGwei: uint(input.depositGwei, 'deposit amount'), lowWaterGwei: uint(input.lowWaterGwei ?? '0', 'low-water amount', false),
    maxTopUpWei: uint(input.maxTopUpWei, 'per-refill ceiling'), dailyTopUpWei: uint(input.dailyTopUpWei, 'daily refill ceiling'), automatic: input.automatic === true };
  // Preserve the shape of pre-existing manual policies. Opt-in is never inferred
  // while loading a journal from a previous release.
  if (input.closeBeforeExpiry !== undefined) {
    if (typeof input.closeBeforeExpiry !== 'boolean') throw new Problem('Expiry closure must be an explicit boolean.');
    p.closeBeforeExpiry = input.closeBeforeExpiry;
  }
  if (BigInt(p.depositGwei) > 1_000_000_000_000n || BigInt(p.lowWaterGwei) >= BigInt(p.depositGwei) || BigInt(p.dailyTopUpWei) < BigInt(p.maxTopUpWei)) throw new Problem('Refill limits are inconsistent.');
  return p;
}

/** One daemon and one treasury per project. All amounts are native ETH wei/gwei.
 * Conservative request ceilings live in Kit; private note balances are only
 * daemon status and never treated as independently verified per-job billing.
 * Signing is dependency-injected and disabled unless both the persisted policy
 * and server enable it. This module never reads a signing key. */
export class TreasuryRunway {
  #funding; #client; #signer; #automatic; #journal; #now; #paused; #inspectNote;
  constructor({ file, funding, client, signer = null, enableAutomatic = false, now = Date.now, isIdle = () => false, inspectNote = async () => ({ status: 'unknown' }) } = {}) {
    if (!funding || !client || typeof isIdle !== 'function') throw new Problem('Runway requires a dedicated daemon, public client and idle-state callback.');
    this.#funding = funding; this.#client = client; this.#signer = signer; this.#automatic = enableAutomatic === true; this.#now = now; this.#paused = isIdle;
    if (typeof inspectNote !== 'function') throw new Problem('Runway requires an expiry inspection callback.');
    this.#inspectNote = inspectNote;
    const origin = funding.capabilities().daemonOrigin;
    this.#journal = new PublicJournal(file, { version: 1, chainId: 1, daemonOrigin: origin, policy: null, fundingAddress: null, refills: [], closeIntentId: null }, saved => {
      if (!saved || Object.keys(saved).sort().join() !== 'chainId,closeIntentId,daemonOrigin,fundingAddress,policy,refills,version' || saved.version !== 1 || saved.chainId !== 1 || saved.daemonOrigin !== origin || !Array.isArray(saved.refills) || saved.refills.length > 1000) throw new Error();
      if (saved.policy && JSON.stringify(policy(saved.policy)) !== JSON.stringify(saved.policy)) throw new Error();
      if (saved.fundingAddress) address(saved.fundingAddress);
      if (saved.closeIntentId !== null && !/^[0-9a-f-]{36}$/.test(saved.closeIntentId)) throw new Error();
      const keys = new Set(), ids = new Set();
      for (const item of saved.refills) {
        if (!saved.policy || Object.keys(item).some(k => !['id', 'key', 'createdAt', 'status', 'quoteIntentId', 'fundingAddress', 'amountWei', 'expenseId', 'transactionHash', 'confirmationBlock', 'calls', 'quotedPrincipalGwei', 'budgetDay', 'kind', 'operationId', 'abandonedAt'].includes(k)) || !/^[0-9a-f-]{36}$/.test(item.id) || ids.has(item.id) || !/^[A-Za-z0-9_-]{8,128}$/.test(item.key) || keys.has(item.key) || !phases.has(item.status) || !Number.isSafeInteger(item.createdAt) || item.createdAt <= 0) throw new Error();
        if (item.status === 'abandoned') { if (!Number.isSafeInteger(item.abandonedAt) || item.abandonedAt <= 0 || item.transactionHash || item.expenseId || item.calls?.length || item.confirmationBlock || item.kind) throw new Error(); }
        else if (item.abandonedAt !== undefined) throw new Error();
        if (item.kind && item.kind !== 'recovery-fee') throw new Error();
        if (item.amountWei !== undefined) uint(item.amountWei, 'saved top-up', false);
        if (item.expenseId) hash(item.expenseId); if (item.transactionHash) hash(item.transactionHash);
        if (item.fundingAddress && !same(item.fundingAddress, saved.fundingAddress)) throw new Error();
        if (item.confirmationBlock) uint(item.confirmationBlock, 'confirmation block');
        if (item.quotedPrincipalGwei) uint(item.quotedPrincipalGwei, 'saved principal');
        if (item.budgetDay) uint(item.budgetDay, 'saved budget day', false);
        if (item.calls && (!Array.isArray(item.calls) || item.calls.length > 2 || item.calls.some(call => Object.keys(call).sort().join() !== 'chainId,data,from,to,value' || call.chainId !== '0x1' || call.value !== '0x0' || !same(call.to, saved.policy.treasury) || !/^0x[0-9a-f]+$/i.test(call.data)))) throw new Error();
        keys.add(item.key); ids.add(item.id);
      }
    });
    for (const item of this.#journal.state.refills) { if (item.status === 'sending') item.status = 'send_unknown'; if (item.status === 'preparing') item.status = 'prepare_unknown'; }
  }
  snapshot() { const s = this.#journal.snapshot(); return { ...s, persistence: this.#journal.healthy ? 'healthy' : 'blocked', automaticEnabled: this.#automatic && !!this.#signer && !!s.policy?.automatic,
    accounting: 'conservative-request-ceilings', noteBalanceEvidence: 'authenticated-daemon-status' }; }
  #configured(projectId) { const p = this.#journal.state.policy; if (!p || p.projectId !== projectId) throw new Problem('This project has no dedicated runway policy.', 409); return p; }
  async #chain() { if (await this.#client.getChainId() !== 1) throw new Problem('Runway requires Ethereum mainnet; no transaction prepared.', 409); }
  async #treasury(p) {
    await this.#chain(); const block = await this.#client.getBlock(); const day = block.timestamp / 86400n;
    const read = (functionName, args = []) => this.#client.readContract({ address: p.treasury, abi: TREASURY_RUNWAY_ABI, functionName, args, blockNumber: block.number });
    const [owner, operator, limit, spent, balance, code] = await Promise.all([read('owner'), read('operator'), read('dailyLimit'), read('spentOnDay', [day]), this.#client.getBalance({ address: p.treasury, blockNumber: block.number }), this.#client.getCode({ address: p.treasury, blockNumber: block.number })]);
    if (!same(owner, p.owner) || !same(operator, p.operator) || !code || code === '0x') throw new Problem('Treasury owner, operator or deployed code differs from the runway policy.', 409);
    return { day, limit, spent, balance, block };
  }
  async configure(input) {
    const p = policy(input);
    return this.#journal.exclusive(async () => {
      const old = this.#journal.state.policy;
      if (old && (old.projectId !== p.projectId || !same(old.treasury, p.treasury) || !same(old.owner, p.owner) || !same(old.operator, p.operator))) throw new Problem('A daemon cannot be reassigned to another project or treasury. Provision a separate daemon and journal.', 409);
      const onlyUnsignedPreparation = this.#journal.state.refills.every(item => terminal.has(item.status) || (item.status === 'prepare_unknown' && !item.transactionHash && !item.calls?.length));
      if (this.#journal.state.refills.some(item => !terminal.has(item.status)) && !(onlyUnsignedPreparation && old?.depositGwei === p.depositGwei)) throw new Problem('Recover the pending refill before changing policy.', 409);
      await this.#treasury(p);
      this.#journal.state.policy = p; this.#journal.save(); return this.snapshot();
    });
  }
  #bind(addressValue) {
    const value = address(addressValue), state = this.#journal.state;
    if (state.fundingAddress && !same(state.fundingAddress, value)) throw new Problem('Dedicated daemon funding address changed. Preserve recovery state.', 409);
    state.fundingAddress = value;
  }
  #find(id) { const item = this.#journal.state.refills.find(i => i.id === id); if (!item) throw new Problem('Refill not found.', 404); return item; }
  #withinLimits(p, treasury, amount, item) {
    if (amount > BigInt(p.maxTopUpWei) || amount > treasury.balance || treasury.spent + amount > treasury.limit) throw new Problem('Refill exceeds its per-transfer ceiling, treasury balance or onchain daily limit.', 409);
    const day = String(treasury.day);
    const held = this.#journal.state.refills.filter(i => i.id !== item.id && i.budgetDay === day && i.status !== 'reverted').reduce((n, i) => n + BigInt(i.amountWei || '0'), 0n);
    if (held + amount > BigInt(p.dailyTopUpWei)) throw new Problem('Refill exceeds the policy daily ceiling.', 409);
  }
  async prepare({ projectId, idempotencyKey } = {}) {
    if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) throw new Problem('Use a unique refill idempotency key.');
    return this.#journal.exclusive(async () => {
      const p = this.#configured(projectId), state = this.#journal.state;
      const old = state.refills.find(i => i.key === idempotencyKey); if (old) return copy(old);
      if (state.refills.some(item => !['active', 'reverted', 'abandoned'].includes(item.status)) || state.refills.length >= 1000) throw new Problem('Resolve the existing refill before creating another.', 409);
      const info = await this.#funding.inspect(); this.#bind(info.funding.address);
      if (!['ready', 'waiting_funds'].includes(info.funding.phase)) throw new Problem('Close or recover the current private note before refilling.', 409);
      const item = { id: randomUUID(), key: idempotencyKey, createdAt: this.#now(), status: 'preparing' }; state.refills.push(item); this.#journal.save();
      try {
        const quote = await this.#funding.quote({ idempotencyKey: 'runway-' + item.id, amountGwei: p.depositGwei });
        return await this.#finishPlan(item, quote, p);
      } catch (error) { item.status = 'prepare_unknown'; if (this.#journal.healthy) this.#journal.save(); throw error; }
    });
  }
  async #finishPlan(item, quote, p) {
    if (quote.approvalAttempted || quote.status !== 'quoted' || !quote.quote || quote.amountGwei !== p.depositGwei) throw new Problem('Deposit quote needs recovery before a treasury payment can be prepared.', 409);
    this.#bind(quote.address); item.quoteIntentId = quote.id; item.fundingAddress = this.#journal.state.fundingAddress;
    item.quotedPrincipalGwei = p.depositGwei; item.amountWei = quote.quote.recommended_top_up_wei;
    const amount = BigInt(item.amountWei), treasury = await this.#treasury(p); this.#withinLimits(p, treasury, amount, item);
    item.budgetDay = String(treasury.day);
    item.expenseId = keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }, { type: 'bytes32' }], [1n, p.treasury, keccak256(stringToHex(p.projectId)), keccak256(stringToHex(item.id))]));
    item.calls = [];
    if (amount) {
      const allowed = await this.#client.readContract({ address: p.treasury, abi: TREASURY_RUNWAY_ABI, functionName: 'allowedRecipient', args: [item.fundingAddress] });
      if (!allowed) item.calls.push({ chainId: '0x1', from: p.owner, to: p.treasury, value: '0x0', data: encodeFunctionData({ abi: TREASURY_RUNWAY_ABI, functionName: 'setRecipient', args: [item.fundingAddress, true] }) });
      item.calls.push(this.#payRequest(item, p));
    }
    item.status = amount ? 'prepared' : 'funded'; this.#journal.save(); return copy(item);
  }
  recover({ projectId, refillId } = {}) {
    return this.#journal.exclusive(async () => {
      const p = this.#configured(projectId), item = this.#find(refillId);
      if (item.status !== 'prepare_unknown') return copy(item);
      let quote = this.#funding.snapshot().intents.find(i => i.idempotencyKey === 'runway-' + item.id);
      if (quote) quote = await this.#funding.recover(quote.id);
      else quote = await this.#funding.quote({ idempotencyKey: 'runway-' + item.id, amountGwei: p.depositGwei });
      return this.#finishPlan(item, quote, p);
    });
  }
  abandonUnsigned({ projectId, refillId } = {}) {
    return this.#journal.exclusive(async () => {
      this.#configured(projectId); const item = this.#find(refillId);
      if (item.status === 'abandoned') return copy(item);
      if (item.status !== 'prepare_unknown' || item.transactionHash || item.expenseId || item.calls?.length || item.confirmationBlock || item.kind) throw new Problem('Only failed preparation without a payment plan or signing evidence can be abandoned.', 409);
      const snapshot = this.#funding.snapshot();
      if (snapshot.persistence !== 'healthy') throw new Problem('Funding persistence must be healthy before abandoning preparation.', 503);
      const intent = snapshot.intents.find(i => i.idempotencyKey === 'runway-' + item.id);
      if ((item.quoteIntentId && intent?.id !== item.quoteIntentId) || (intent && (intent.approvalAttempted || intent.transactionHash || !['quoted', 'quote_unknown', 'abandoned'].includes(intent.status)))) throw new Problem('Funding intent contains an unknown approval or payment. Preserve it for recovery.', 409);
      const info = await this.#funding.inspect(); this.#bind(info.funding.address);
      if (!['ready', 'waiting_funds'].includes(info.funding.phase) || info.funding.transactionHash) throw new Problem('The daemon does not prove an unsigned preparation.', 409);
      // The funding record is retired first. If the second journal write fails,
      // repeating this operation is safe and cannot resurrect its old quote.
      if (intent) await this.#funding.abandonUnsigned(intent.id);
      item.status = 'abandoned'; item.abandonedAt = this.#now(); this.#journal.save(); return copy(item);
    });
  }
  prepareRecoveryFee({ projectId, operationId, idempotencyKey } = {}) {
    if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) throw new Problem('Use a unique recovery fee idempotency key.');
    return this.#journal.exclusive(async () => {
      const p = this.#configured(projectId), state = this.#journal.state;
      const existing = state.refills.find(i => i.key === idempotencyKey); if (existing) { if (existing.operationId !== operationId) throw new Problem('Fee key belongs to another operation.', 409); return copy(existing); }
      if (state.refills.some(i => !['active', 'reverted', 'abandoned'].includes(i.status))) throw new Problem('Recover the current refill before preparing withdrawal fees.', 409);
      const op = this.#funding.snapshot().operations.find(i => i.id === operationId);
      if (!op || op.request.kind !== 'withdrawal' || !same(op.request.destination, p.treasury) || op.approvalAttempted || op.status !== 'quoted' || !op.quote || op.quote.expires_at <= this.#now()) throw new Problem('Review a current withdrawal quote returning funds to this treasury.', 409);
      this.#bind(op.address);
      const item = { id: randomUUID(), key: idempotencyKey, kind: 'recovery-fee', operationId, createdAt: this.#now(), status: 'prepared', fundingAddress: state.fundingAddress,
        amountWei: op.quote.recommended_top_up_wei, calls: [] };
      const amount = BigInt(item.amountWei), current = await this.#treasury(p); this.#withinLimits(p, current, amount, item);
      item.budgetDay = String(current.day); item.expenseId = keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }, { type: 'bytes32' }], [1n, p.treasury, keccak256(stringToHex(projectId)), keccak256(stringToHex(item.id))]));
      if (amount) {
        const allowed = await this.#client.readContract({ address: p.treasury, abi: TREASURY_RUNWAY_ABI, functionName: 'allowedRecipient', args: [item.fundingAddress] });
        if (!allowed) item.calls.push({ chainId: '0x1', from: p.owner, to: p.treasury, value: '0x0', data: encodeFunctionData({ abi: TREASURY_RUNWAY_ABI, functionName: 'setRecipient', args: [item.fundingAddress, true] }) });
        item.calls.push(this.#payRequest(item, p));
      } else item.status = 'active';
      state.refills.push(item); this.#journal.save(); return copy(item);
    });
  }
  #payRequest(item, p) { return { chainId: '0x1', from: p.operator, to: p.treasury, value: '0x0', data: encodeFunctionData({ abi: TREASURY_RUNWAY_ABI, functionName: 'pay', args: [item.expenseId, item.fundingAddress, BigInt(item.amountWei)] }) }; }
  async #receipt(item, p, transactionHash) {
    await this.#chain();
    const [receipt, transaction, finalized] = await Promise.all([this.#client.getTransactionReceipt({ hash: transactionHash }), this.#client.getTransaction({ hash: transactionHash }), this.#client.getBlock({ blockTag: 'finalized' })]);
    const expected = this.#payRequest(item, p);
    if (!same(transaction.from, p.operator) || !same(transaction.to, p.treasury) || transaction.input !== expected.data || transaction.value !== 0n || receipt.transactionHash.toLowerCase() !== transactionHash || receipt.blockNumber > finalized.number) throw new Problem('Refill transaction does not match its authorization or is not finalized.', 409);
    const canonical = await this.#client.getBlock({ blockNumber: receipt.blockNumber });
    if (canonical.hash !== receipt.blockHash) throw new Problem('Refill receipt is not canonical.', 409);
    if (receipt.status === 'reverted') { item.status = 'reverted'; item.transactionHash = transactionHash; this.#journal.save(); return copy(item); }
    const events = receipt.logs.filter(log => same(log.address, p.treasury)).flatMap(log => { try { const event = decodeEventLog({ abi: TREASURY_RUNWAY_ABI, data: log.data, topics: log.topics, strict: true }); return event.eventName === 'Expense' ? [event.args] : []; } catch { return []; } });
    if (events.length !== 1 || events[0].id !== item.expenseId || !same(events[0].recipient, item.fundingAddress) || events[0].amount !== BigInt(item.amountWei)) throw new Problem('Finalized receipt lacks the exact authorized treasury expense.', 409);
    item.transactionHash = transactionHash; item.confirmationBlock = String(receipt.blockNumber); item.budgetDay = String(canonical.timestamp / 86400n); item.status = 'funded'; this.#journal.save(); return copy(item);
  }
  confirm({ projectId, refillId, transactionHash } = {}) {
    return this.#journal.exclusive(async () => {
      const p = this.#configured(projectId), item = this.#find(refillId), tx = hash(transactionHash);
      if (item.transactionHash && item.transactionHash !== tx) throw new Problem('Refill is bound to another transaction.', 409);
      if (!['prepared', 'sending', 'send_unknown', 'pending', 'funded'].includes(item.status) || !item.amountWei || item.amountWei === '0') throw new Problem('Refill is not awaiting a treasury payment.', 409);
      return this.#receipt(item, p, tx);
    });
  }
  sync({ projectId, refillId } = {}) {
    return this.#journal.exclusive(async () => {
      this.#configured(projectId); const item = this.#find(refillId);
      if (!['funded', 'deposit_pending', 'active'].includes(item.status)) throw new Problem('Confirm treasury funding before checking the deposit.', 409);
      if (item.kind === 'recovery-fee') { item.status = 'active'; this.#journal.save(); return copy(item); }
      const intent = await this.#funding.recover(item.quoteIntentId);
      if (intent.status === 'active') item.status = 'active';
      else if (intent.status === 'pending') item.status = 'deposit_pending';
      else if (intent.approvalAttempted) item.status = 'recovery_required';
      this.#journal.save(); return { ...copy(item), deposit: intent };
    });
  }
  async execute({ projectId, refillId } = {}) {
    return this.#journal.exclusive(async () => {
      const p = this.#configured(projectId), item = this.#find(refillId);
      this.#requireAuto(p);
      if (item.status === 'pending') return this.#receipt(item, p, item.transactionHash);
      if (item.status !== 'prepared') throw new Problem('Refill cannot be replayed automatically. Inspect its saved state.', 409);
      if (!same(this.#signer.account?.address, p.operator)) throw new Problem('Configured signer differs from the authorized treasury operator.', 409);
      const treasury = await this.#treasury(p); this.#withinLimits(p, treasury, BigInt(item.amountWei), item);
      item.budgetDay = String(treasury.day);
      const [allowed, paid] = await Promise.all(['allowedRecipient', 'paid'].map((fn, i) => this.#client.readContract({ address: p.treasury, abi: TREASURY_RUNWAY_ABI, functionName: fn, args: [i ? item.expenseId : item.fundingAddress] })));
      if (!allowed) throw new Problem('Treasury owner must explicitly allow this dedicated daemon funding address.', 409);
      if (paid) throw new Problem('Expense is already paid. Confirm its existing transaction instead of sending again.', 409);
      const request = this.#payRequest(item, p);
      await this.#client.call({ account: p.operator, to: p.treasury, data: request.data, value: 0n });
      if (!await this.#paused()) throw new Problem('Automatic funding is paused or the project is no longer idle.', 409);
      item.status = 'sending'; this.#journal.save();
      try {
        item.transactionHash = hash(await this.#signer.sendTransaction({ chain: mainnet, account: this.#signer.account, to: p.treasury, data: request.data, value: 0n }));
        item.status = 'pending'; this.#journal.save(); return copy(item);
      } catch (error) {
        if (error?.treasuryNoSigningAttempted === true && this.#journal.healthy) { item.status = 'prepared'; this.#journal.save(); throw error; }
        item.status = 'send_unknown'; if (this.#journal.healthy) this.#journal.save(); throw new Problem('Operator transaction outcome is uncertain. Confirm its exact receipt; no automatic resend is allowed.', 502);
      }
    });
  }
  #requireAuto(p) { if (!this.#automatic || !this.#signer || !p.automatic || !this.#funding.capabilities().approvalEnabled) throw new Problem('Automatic runway requires an explicitly enabled server signer, project policy and daemon approval.', 403); }
  async #activeNote(status, expectedNoteId = status.noteId) {
    const report = await this.#inspectNote(), now = Math.floor(this.#now() / 1000);
    if (report?.source !== 'finalized-vault-with-authenticated-daemon-note' || report.noteState !== 'active' || report.noteId !== expectedNoteId || !same(report.fundingAddress, status.address) || !Number.isSafeInteger(report.checkedAt) || report.checkedAt > now || now - report.checkedAt > 30 || !Number.isSafeInteger(report.expiresAt) || report.expiresAt <= now || !['healthy', 'warning', 'blocked'].includes(report.status)) return null;
    return report;
  }
  async activate({ projectId, refillId } = {}) {
    return this.#journal.exclusive(async () => {
      const p = this.#configured(projectId), item = this.#find(refillId); this.#requireAuto(p);
      if (!['funded', 'deposit_pending'].includes(item.status)) throw new Problem('Confirm treasury funding before activating the private note.', 409);
      if (item.kind === 'recovery-fee') { item.status = 'active'; this.#journal.save(); return copy(item); }
      let intent = this.#funding.snapshot().intents.find(i => i.id === item.quoteIntentId);
      if (!intent) throw new Problem('Saved daemon deposit intent is missing.', 409);
      if (intent.approvalAttempted) {
        intent = await this.#funding.recover(intent.id);
        if (intent.status === 'pending') { if (!await this.#paused()) throw new Problem('Automatic funding is paused.', 409); intent = await this.#funding.resume({ intentId: intent.id, transactionHash: intent.transactionHash }); }
      } else {
        // Mainnet finality outlives the 30-second quote. Refresh fees only after
        // the exact treasury transfer is finalized; do not change its amount.
        intent = await this.#funding.refresh(intent.id);
        if (BigInt(intent.quote.required_total_wei) > BigInt(intent.quote.balance_wei)) throw new Problem('Deposit fee moved beyond the funded amount. Review another bounded top-up; no approval sent.', 409);
        if (!await this.#paused()) throw new Problem('Automatic funding is paused.', 409);
        intent = await this.#funding.approve({ intentId: intent.id, quoteId: intent.quote.id, approvalDigest: intent.approvalDigest });
      }
      if (!['pending', 'active'].includes(intent.status)) throw new Problem('Daemon deposit needs explicit recovery; automatic funding stopped.', 409);
      item.status = intent.status === 'active' ? 'active' : 'deposit_pending'; this.#journal.save(); return copy(item);
    });
  }
  async tick(projectId) {
    const p = this.#configured(projectId); this.#requireAuto(p);
    // Callers must keep a per-project runtime lock around tick + dispatch. No
    // note closure while an inference job can still dispatch or settle.
    if (!await this.#paused()) return { status: 'waiting_idle' };
    // A changed onchain owner/operator or unavailable chain stops automatic
    // daemon approvals as well as treasury payments.
    await this.#treasury(p);
    const latest = this.#journal.state.refills.at(-1);
    if (latest && !['active', 'reverted', 'abandoned'].includes(latest.status)) {
      if (latest.kind === 'recovery-fee' && latest.status === 'prepared') {
        const closing = this.#funding.snapshot().operations.find(i => i.id === latest.operationId);
        const selected = await this.#funding.inspectOperation('withdrawal');
        if (!closing || closing.request?.kind !== 'withdrawal' || !same(closing.request?.destination, p.treasury) || !['ready', 'quoted', 'waiting_funds'].includes(selected.phase) || !await this.#activeNote(selected, closing.request?.noteId)) return { status: 'expiry_unverified', refillId: latest.id };
      }
      if (latest.status === 'prepared' || latest.status === 'pending') return this.execute({ projectId, refillId: latest.id });
      if (latest.status === 'funded' || latest.status === 'deposit_pending') return this.activate({ projectId, refillId: latest.id });
      return { status: 'recovery_required', refillId: latest.id };
    }
    const status = await this.#funding.inspectOperation('withdrawal');
    this.#bind(status.address);
    if (status.phase === 'waiting_settlement') return { status: 'waiting_settlement' };
    let close = this.#journal.state.closeIntentId ? this.#funding.snapshot().operations.find(i => i.id === this.#journal.state.closeIntentId) : null;
    // A previous approval is reconciled read-only even if the note has since
    // closed. Automatic maintenance never retries a withdrawal approval or
    // resubmits its transaction; the owner retains the explicit recovery route.
    if (close?.approvalAttempted) {
      close = await this.#funding.recoverOperation(close.id);
      if (close.status !== 'complete') return { status: close.status === 'pending' ? 'closing_note' : 'recovery_required', closeIntentId: close.id };
      await this.#journal.exclusive(async () => { this.#journal.state.closeIntentId = null; this.#journal.save(); });
      return { status: 'note_closed', closeIntentId: close.id };
    }
    if (this.#journal.state.closeIntentId && !close) return { status: 'recovery_required' };
    let expiry;
    if (status.phase === 'ready' || (close && ['quoted', 'waiting_funds'].includes(status.phase))) {
      expiry = await this.#activeNote(status);
      if (!expiry) return { status: 'expiry_unverified', message: 'Automatic note changes require fresh proof of a still-active, unexpired note.' };
      const expiring = expiry.expiresAt - Math.floor(this.#now() / 1000) <= 7 * 86400;
      if (!close && BigInt(status.privateBalanceGwei) > BigInt(p.lowWaterGwei) && !(p.closeBeforeExpiry === true && expiring)) return { status: expiring ? 'expiry_action_required' : 'adequate', privateBalanceGwei: status.privateBalanceGwei };
    }
    if (status.phase === 'ready' || this.#journal.state.closeIntentId) {
      if (!expiry) return { status: 'expiry_unverified' };
      if (!close) {
        close = await this.#funding.quoteOperation({ kind: 'withdrawal', idempotencyKey: 'runway-close-' + projectId + '-' + status.noteId, destination: p.treasury, noteId: status.noteId });
        await this.#journal.exclusive(async () => { this.#journal.state.closeIntentId = close.id; this.#journal.save(); });
      }
      if (!close) return { status: 'recovery_required' };
      if (!close.approvalAttempted) {
        close = await this.#funding.refreshOperation(close.id);
        // Refresh may perform network I/O. Recheck the selected note just before
        // authorizing either withdrawal gas or the exact withdrawal quote.
        if (!await this.#activeNote(status, close.request?.noteId)) return { status: 'expiry_unverified', closeIntentId: close.id };
        if (close.request?.noteId !== status.noteId || !same(close.request?.destination, p.treasury) || close.request?.kind !== 'withdrawal') return { status: 'recovery_required', closeIntentId: close.id };
        if (!await this.#paused()) return { status: 'waiting_idle' };
        if (BigInt(close.quote.recommended_top_up_wei) > 0n) return this.prepareRecoveryFee({ projectId, operationId: close.id, idempotencyKey: 'recovery-fee-' + close.id + '-' + close.quote.id.slice(0, 16) });
        close = await this.#funding.approveOperation({ intentId: close.id, quoteId: close.quote.id, approvalDigest: close.approvalDigest });
      }
      if (close.status !== 'complete') return { status: close.status === 'pending' ? 'closing_note' : 'recovery_required', closeIntentId: close.id };
      await this.#journal.exclusive(async () => { this.#journal.state.closeIntentId = null; this.#journal.save(); });
    } else if (!['no_note', 'complete'].includes(status.phase)) return { status: 'recovery_required', daemonPhase: status.phase };
    return this.prepare({ projectId, idempotencyKey: 'auto-refill-' + randomUUID() });
  }
}
