import { createHash, randomUUID } from 'node:crypto';
import { getAddress } from 'viem';
import { Problem } from './agent.mjs';
import { PublicJournal } from './public-journal.mjs';

const KINDS = new Set(['withdrawal', 'return']);
const PHASES = new Set(['ready', 'no_note', 'waiting_settlement', 'waiting_funds', 'quoted', 'withdrawal_pending', 'return_pending', 'confirming', 'complete', 'reverted', 'recovery_required']);
const STATES = new Set(['quoting', 'quote_unknown', 'quoted', 'approving', 'approval_unknown', 'pending', 'resuming', 'resume_unknown', 'complete', 'reverted', 'recovery_required']);
const FEES = ['principal_wei', 'balance_wei', 'expected_fee_wei', 'required_fee_wei', 'fee_reserve_wei', 'fee_buffer_wei', 'required_total_wei', 'recommended_total_wei', 'shortfall_wei', 'recommended_top_up_wei', 'max_fee_per_gas', 'max_priority_fee_per_gas'];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = value => structuredClone(value);
const bad = () => { throw new Problem('Invalid or changed zkAPI recovery response. Preserve the daemon recovery files.', 502); };
function uint(value) { if (!Number.isSafeInteger(value) || value < 0) bad(); return value; }
function wei(value, positive = false) { if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value) || BigInt(value) >= 2n ** 256n || (positive && value === '0')) bad(); return value; }
function addr(value) { try { const a = getAddress(value); if (/^0x0{40}$/.test(a)) bad(); return a.toLowerCase(); } catch { bad(); } }
function tx(value) { if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) bad(); return value.toLowerCase(); }
function requestData(value) {
  if (!value || !KINDS.has(value.kind) || typeof value.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value.idempotencyKey)) throw new Problem('Specify withdrawal or return and a unique idempotency key.');
  const out = { kind: value.kind, idempotencyKey: value.idempotencyKey, destination: addr(value.destination) };
  if (value.kind === 'withdrawal') {
    out.noteId = uint(value.noteId); if (out.noteId > 0xffffffff) throw new Problem('Invalid selected private note ID.');
    if (value.retryTransactionHash) out.retryTransactionHash = tx(value.retryTransactionHash);
  } else out.amountWei = wei(value.amountWei, true); // Never infer or authorize a sweep.
  return out;
}
function quoteData(raw, intent, network) {
  const req = intent.request;
  if (!raw || raw.kind !== req.kind || raw.chain_id !== 1 || raw.deployment_id !== network.deploymentId || addr(raw.contract_address) !== network.vault ||
      addr(raw.address) !== intent.address || !/^[0-9a-f]{64}$/.test(raw.id || '') || addr(raw.destination) !== req.destination || raw.input_micro_usd || raw.commitment || raw.fee_policy !== 'low') bad();
  const q = { id: raw.id, kind: raw.kind, address: intent.address, chain_id: 1, contract_address: network.vault, deployment_id: network.deploymentId,
    amount: uint(raw.amount), destination: req.destination };
  if (req.kind === 'withdrawal') {
    q.note_id = uint(raw.note_id ?? 0); q.binding = tx(raw.binding);
    if (q.note_id !== req.noteId || raw.principal_wei !== '0') bad();
    if (req.retryTransactionHash) { q.retry_hash = tx(raw.retry_hash); if (q.retry_hash !== req.retryTransactionHash) bad(); }
    else if (raw.retry_hash) bad();
  } else if (q.amount !== 0 || raw.note_id || raw.binding || raw.retry_hash || raw.principal_wei !== req.amountWei) bad();
  for (const key of FEES) q[key] = wei(raw[key]);
  q.estimated_gas = uint(raw.estimated_gas); q.gas_limit = uint(raw.gas_limit); q.nonce = uint(raw.nonce); q.expires_at = uint(raw.expires_at); q.fee_policy = 'low';
  const n = key => BigInt(q[key]), diff = (a, b) => a > b ? a - b : 0n;
  if (!q.estimated_gas || q.gas_limit < q.estimated_gas || !q.expires_at || !n('max_fee_per_gas') || !n('required_fee_wei') || n('max_priority_fee_per_gas') > n('max_fee_per_gas') ||
      n('fee_reserve_wei') !== BigInt(q.gas_limit) * n('max_fee_per_gas') || n('required_fee_wei') > n('fee_reserve_wei') ||
      n('fee_buffer_wei') !== n('fee_reserve_wei') - n('required_fee_wei') || n('required_total_wei') !== n('principal_wei') + n('required_fee_wei') ||
      n('recommended_total_wei') !== n('principal_wei') + n('fee_reserve_wei') || n('shortfall_wei') !== diff(n('required_total_wei'), n('balance_wei')) ||
      n('recommended_top_up_wei') !== diff(n('recommended_total_wei'), n('balance_wei'))) bad();
  return q;
}
function statusData(raw, kind, network) {
  if (!raw || raw.chain_id !== 1 || !PHASES.has(raw.phase)) bad();
  const status = { kind, address: addr(raw.address), chainId: 1, phase: raw.phase, balanceWei: wei(raw.eth_balance) };
  if (kind === 'withdrawal') {
    if (raw.deployment_id !== network.deploymentId || raw.billing_asset !== 'native_eth' || raw.billing_unit !== 'gwei' || raw.native_asset_wei_per_unit !== '1000000000' || raw.token_address !== '' || raw.token_decimals !== 9) bad();
    status.noteId = uint(raw.note_id ?? 0); status.privateBalanceGwei = String(uint(raw.private_balance)); status.amountGwei = String(uint(raw.amount));
  }
  if (raw.destination) status.destination = addr(raw.destination);
  if (raw.amount_wei) status.amountWei = wei(raw.amount_wei);
  if (raw.transaction_hash) status.transactionHash = tx(raw.transaction_hash);
  if (raw.actual_fee_wei) status.actualFeeWei = wei(raw.actual_fee_wei);
  return status;
}

/** Wraps the pinned daemon's existing withdrawal/return transaction lifecycle.
 * The daemon owns proofs and private wallet state. This class persists exact
 * public authorizations and never invents a receipt from model JSON. */
export class FundingOperations {
  #journal; #network; #request; #requireApproval; #lock; #now; #authorizeApproval;
  constructor({ file, network, request, requireApproval, lock, now, authorizeApproval = () => {} }) {
    this.#authorizeApproval = authorizeApproval;
    this.#network = network; this.#request = request; this.#requireApproval = requireApproval; this.#lock = lock; this.#now = now;
    this.#journal = new PublicJournal(file, { version: 1, deploymentId: network.deploymentId, intents: [] }, saved => {
      if (!saved || Object.keys(saved).sort().join() !== 'deploymentId,intents,version' || saved.version !== 1 || saved.deploymentId !== network.deploymentId || !Array.isArray(saved.intents) || saved.intents.length > 1000) throw new Error();
      const ids = new Set(), keys = new Set();
      for (const item of saved.intents) {
        if (Object.keys(item).some(k => !['id', 'request', 'createdAt', 'status', 'approvalAttempted', 'address', 'quote', 'approvalDigest', 'transactionHash', 'observed'].includes(k)) || !/^[0-9a-f-]{36}$/.test(item.id) || ids.has(item.id) || !STATES.has(item.status) || typeof item.approvalAttempted !== 'boolean') throw new Error();
        uint(item.createdAt); const checked = requestData(item.request); if (JSON.stringify(checked) !== JSON.stringify(item.request) || keys.has(checked.idempotencyKey)) throw new Error();
        if (item.address) addr(item.address);
        if (item.quote && (JSON.stringify(quoteData(item.quote, item, network)) !== JSON.stringify(item.quote) || digest(item.quote) !== item.approvalDigest)) throw new Error();
        if (item.approvalAttempted && !item.quote) throw new Error();
        if (item.transactionHash) tx(item.transactionHash);
        if (['pending', 'complete', 'reverted', 'resuming', 'resume_unknown'].includes(item.status) && (!item.approvalAttempted || !item.transactionHash)) throw new Error();
        if (item.observed) {
          if (Object.keys(item.observed).some(k => !['kind', 'address', 'chainId', 'phase', 'balanceWei', 'noteId', 'privateBalanceGwei', 'amountGwei', 'destination', 'amountWei', 'transactionHash', 'actualFeeWei'].includes(k)) || item.observed.kind !== checked.kind || item.observed.chainId !== 1 || !PHASES.has(item.observed.phase) || addr(item.observed.address) !== item.address) throw new Error();
          wei(item.observed.balanceWei); if (item.observed.transactionHash) tx(item.observed.transactionHash);
        }
        ids.add(item.id); keys.add(checked.idempotencyKey);
      }
    });
    for (const item of this.#journal.state.intents) {
      if (item.status === 'quoting') item.status = 'quote_unknown';
      if (item.status === 'approving') item.status = 'approval_unknown';
      if (item.status === 'resuming') item.status = 'resume_unknown';
    }
  }
  #public(item) { return { ...copy(item), quoteExpired: item.quote ? item.quote.expires_at <= this.#now() : false }; }
  snapshot() { return { persistence: this.#journal.healthy ? 'healthy' : 'blocked', operations: this.#journal.state.intents.map(item => this.#public(item)) }; }
  unresolved() { return this.#journal.state.intents.some(item => !['complete', 'reverted'].includes(item.status)); }
  #exclusive(fn) { return this.#lock(() => this.#journal.exclusive(fn)); }
  #find(id) { const item = this.#journal.state.intents.find(i => i.id === id); if (!item) throw new Problem('Recovery operation not found.', 404); return item; }
  async #inspect(kind) { if (!KINDS.has(kind)) throw new Problem('Unsupported recovery operation.'); return statusData(await this.#request('/admin/' + kind), kind, this.#network); }
  inspect(kind) { return this.#exclusive(() => this.#inspect(kind)); }
  quote(input) {
    const req = requestData(input);
    return this.#exclusive(async () => {
      const old = this.#journal.state.intents.find(item => item.request.idempotencyKey === req.idempotencyKey);
      if (old) { if (JSON.stringify(req) !== JSON.stringify(old.request)) throw new Problem('Idempotency key belongs to another recovery operation.', 409); return this.#public(old); }
      if (this.unresolved() || this.#journal.state.intents.length >= 1000) throw new Problem('Recover the current operation before preparing another.', 409);
      const item = { id: randomUUID(), request: req, createdAt: this.#now(), status: 'quoting', approvalAttempted: false };
      this.#journal.state.intents.push(item); this.#journal.save(); return this.#makeQuote(item);
    });
  }
  refresh(id) { return this.#exclusive(async () => { const item = this.#find(id); if (item.approvalAttempted) throw new Problem('Approval may exist; recover it first.', 409); item.status = 'quoting'; this.#journal.save(); return this.#makeQuote(item); }); }
  async #makeQuote(item) {
    try {
      const status = await this.#inspect(item.request.kind);
      if (item.address && item.address !== status.address) bad();
      if (item.request.kind === 'withdrawal' && status.noteId !== item.request.noteId) throw new Problem('Selected private note changed.', 409);
      item.address = status.address; this.#journal.save();
      const body = item.request.kind === 'return' ? { destination: item.request.destination, amount_wei: item.request.amountWei } :
        { destination: item.request.destination, note_id: item.request.noteId, ...(item.request.retryTransactionHash ? { retry_transaction_hash: item.request.retryTransactionHash } : {}) };
      const quote = quoteData(await this.#request('/admin/' + item.request.kind + '/quote', body), item, this.#network);
      if (quote.expires_at <= this.#now()) throw new Problem('Recovery quote expired; refresh and review it.', 409);
      item.quote = quote; item.approvalDigest = digest(quote); item.status = 'quoted'; this.#journal.save(); return this.#public(item);
    } catch (error) { item.status = 'quote_unknown'; if (this.#journal.healthy) this.#journal.save(); throw error; }
  }
  #match(item, status) {
    if (status.address !== item.address || status.destination !== item.request.destination ||
        (item.request.kind === 'withdrawal' && (status.noteId !== item.request.noteId || status.amountGwei !== String(item.quote.amount))) ||
        (item.request.kind === 'return' && status.amountWei !== item.request.amountWei)) bad();
  }
  #accept(item, status) {
    this.#match(item, status);
    if (!status.transactionHash || (item.transactionHash && status.transactionHash !== item.transactionHash) || !['withdrawal_pending', 'return_pending', 'confirming', 'complete', 'reverted'].includes(status.phase)) bad();
    item.transactionHash = status.transactionHash; item.observed = status;
    item.status = ['complete', 'reverted'].includes(status.phase) ? status.phase : 'pending';
  }
  approve({ intentId, quoteId, approvalDigest } = {}) {
    this.#requireApproval();
    return this.#exclusive(async () => {
      const item = this.#find(intentId);
      if (!item.quote || item.quote.id !== quoteId || item.approvalDigest !== approvalDigest) throw new Problem('Approval differs from the exact recovery quote.', 409);
      if (item.approvalAttempted) return this.#public(item);
      if (item.status !== 'quoted' || item.quote.expires_at <= this.#now()) throw new Problem('Recovery quote expired; review a fresh quote.', 409);
      const q = quoteData(await this.#request('/admin/' + item.request.kind + '/quote'), item, this.#network);
      if (digest(q) !== approvalDigest || q.expires_at <= this.#now()) throw new Problem('Saved recovery quote changed.', 409);
      const status = await this.#inspect(item.request.kind); this.#match(item, status);
      const oldRevertedTransaction = item.request.retryTransactionHash && status.transactionHash === item.request.retryTransactionHash;
      if ((status.transactionHash && !oldRevertedTransaction) || !['quoted', 'waiting_funds'].includes(status.phase) || BigInt(status.balanceWei) < BigInt(q.required_total_wei)) throw new Problem('Recovery operation is not ready or lacks its network fee.', 409);
      this.#authorizeApproval();
      item.status = 'approving'; item.approvalAttempted = true; this.#journal.save();
      try { this.#accept(item, statusData(await this.#request('/admin/' + item.request.kind + '/approve', { quote_id: quoteId }), item.request.kind, this.#network)); this.#journal.save(); return this.#public(item); }
      catch (error) { item.status = 'approval_unknown'; if (this.#journal.healthy) this.#journal.save(); throw error; }
    });
  }
  recover(id) {
    return this.#exclusive(async () => {
      const item = this.#find(id), status = await this.#inspect(item.request.kind);
      if (item.address && status.address !== item.address) bad();
      if (!item.approvalAttempted) {
        const raw = await this.#request('/admin/' + item.request.kind + '/quote');
        if (raw) { item.address = status.address; item.quote = quoteData(raw, item, this.#network); item.approvalDigest = digest(item.quote); item.status = 'quoted'; }
      } else if (item.transactionHash && status.transactionHash === item.transactionHash) this.#accept(item, status);
      else { if (item.transactionHash && status.transactionHash) bad(); item.status = 'recovery_required'; item.observed = status; }
      this.#journal.save(); return this.#public(item);
    });
  }
  resume({ intentId, transactionHash } = {}) {
    this.#requireApproval();
    return this.#exclusive(async () => {
      const item = this.#find(intentId);
      if (!item.approvalAttempted || !item.transactionHash || tx(transactionHash) !== item.transactionHash || !['pending', 'resume_unknown'].includes(item.status)) throw new Problem('Resume requires the exact saved recovery transaction.', 409);
      const before = await this.#inspect(item.request.kind); this.#match(item, before);
      if (before.transactionHash !== item.transactionHash) bad();
      if (['complete', 'reverted'].includes(before.phase)) { this.#accept(item, before); this.#journal.save(); return this.#public(item); }
      this.#authorizeApproval();
      item.status = 'resuming'; this.#journal.save();
      const body = item.request.kind === 'return' ? {} : { destination: item.request.destination, note_id: item.request.noteId };
      try { this.#accept(item, statusData(await this.#request('/admin/' + item.request.kind, body), item.request.kind, this.#network)); this.#journal.save(); return this.#public(item); }
      catch (error) { item.status = 'resume_unknown'; if (this.#journal.healthy) this.#journal.save(); throw error; }
    });
  }
}
