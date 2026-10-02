import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Problem } from './agent.mjs';
import { ZkApiProvider, ZKAPI_SOURCE_REVISION } from './provider.mjs';
import { FundingOperations } from './funding-operations.mjs';

// Public deployment identity from the pinned daemon package. This is not a
// claim about a locally installed binary or independent cryptographic review.
export const ZKAPI_MAINNET = Object.freeze({
  chainId: 1,
  deploymentId: 'zkapi-native-eth-mainnet-note-bound-v1-fresh-20260930',
  vault: '0x4386fdbda35d995beb3bf8625118ec5982ec81fe',
  weiPerUnit: '1000000000',
  sourceRevision: ZKAPI_SOURCE_REVISION
});
const MAX_AMOUNT = 1_000_000_000_000n;
const UINT256 = (1n << 256n) - 1n;
const STATES = new Set(['quoting', 'quoted', 'quote_unknown', 'approving', 'approval_unknown', 'pending', 'active', 'recovery_required', 'resuming', 'resume_unknown', 'abandoned']);
const PHASES = new Set(['ready', 'waiting_funds', 'deposit_pending', 'confirming', 'active', 'reverted', 'legacy_recovery', 'withdrawal_pending', 'return_pending', 'recovery_required']);
const QUOTE_WEI = ['principal_wei', 'balance_wei', 'expected_fee_wei', 'required_fee_wei', 'fee_reserve_wei', 'fee_buffer_wei', 'required_total_wei', 'recommended_total_wei', 'shortfall_wei', 'recommended_top_up_wei', 'max_fee_per_gas', 'max_priority_fee_per_gas'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = value => structuredClone(value);
const fail = () => { throw new Problem('Invalid or mismatched zkAPI funding response. Preserve daemon recovery files.', 502); };
const onlyKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
function integer(value, { positive = false, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0) || value > max) fail();
  return value;
}
function decimal(value, { positive = false, max = UINT256 } = {}) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value)) fail();
  const parsed = BigInt(value);
  if (parsed > max || (positive && parsed === 0n)) fail();
  return value;
}
function address(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/.test(value)) fail();
  return value.toLowerCase();
}
function txHash(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) fail();
  return value.toLowerCase();
}
function quoteData(raw, amountGwei, expectedAddress) {
  if (!raw || raw.kind !== 'deposit' || raw.chain_id !== 1 || raw.deployment_id !== ZKAPI_MAINNET.deploymentId ||
      address(raw.contract_address) !== ZKAPI_MAINNET.vault || address(raw.address) !== expectedAddress ||
      !/^[0-9a-f]{64}$/.test(raw.id || '') || String(integer(raw.amount, { positive: true, max: Number(MAX_AMOUNT) })) !== amountGwei ||
      raw.input_micro_usd || raw.destination || raw.note_id || raw.binding || raw.retry_hash || raw.fee_policy !== 'low' ||
      typeof raw.commitment !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(raw.commitment)) fail();
  const q = { id: raw.id, kind: 'deposit', address: expectedAddress, chain_id: 1, contract_address: ZKAPI_MAINNET.vault,
    deployment_id: ZKAPI_MAINNET.deploymentId, amount: raw.amount };
  for (const key of QUOTE_WEI) q[key] = decimal(raw[key]);
  q.estimated_gas = integer(raw.estimated_gas, { positive: true });
  q.gas_limit = integer(raw.gas_limit, { positive: true });
  q.nonce = integer(raw.nonce);
  q.expires_at = integer(raw.expires_at, { positive: true });
  q.fee_policy = 'low'; q.commitment = raw.commitment.toLowerCase();
  const n = key => BigInt(q[key]);
  const difference = (a, b) => a > b ? a - b : 0n;
  if (n('principal_wei') !== BigInt(amountGwei) * 1_000_000_000n || q.gas_limit < q.estimated_gas || n('max_fee_per_gas') === 0n || n('required_fee_wei') === 0n ||
      n('fee_reserve_wei') !== BigInt(q.gas_limit) * n('max_fee_per_gas') ||
      n('max_priority_fee_per_gas') > n('max_fee_per_gas') ||
      n('required_fee_wei') > n('fee_reserve_wei') ||
      n('fee_buffer_wei') !== n('fee_reserve_wei') - n('required_fee_wei') ||
      n('required_total_wei') !== n('principal_wei') + n('required_fee_wei') ||
      n('recommended_total_wei') !== n('principal_wei') + n('fee_reserve_wei') ||
      n('shortfall_wei') !== difference(n('required_total_wei'), n('balance_wei')) ||
      n('recommended_top_up_wei') !== difference(n('recommended_total_wei'), n('balance_wei'))) fail();
  return q;
}
function statusData(raw, expectedAddress, expectedAmount) {
  if (!raw || raw.chain_id !== 1 || raw.deployment_id !== ZKAPI_MAINNET.deploymentId || raw.billing_asset !== 'native_eth' ||
      raw.billing_unit !== 'gwei' || raw.native_asset_wei_per_unit !== ZKAPI_MAINNET.weiPerUnit || raw.token_address !== '' ||
      raw.token_decimals !== 9 || !PHASES.has(raw.phase)) fail();
  const value = { address: address(raw.address), chainId: 1, deploymentId: ZKAPI_MAINNET.deploymentId,
    phase: raw.phase, balanceWei: decimal(raw.eth_balance), amountGwei: String(integer(raw.amount ?? 0)) };
  if ((expectedAddress && value.address !== expectedAddress) ||
      (expectedAmount && value.amountGwei !== expectedAmount)) fail();
  if (raw.transaction_hash) value.transactionHash = txHash(raw.transaction_hash);
  if (raw.actual_fee_wei) value.actualFeeWei = decimal(raw.actual_fee_wei);
  if (raw.deposit_stage) {
    if (!['pending', 'fee_wait', 'finalizing', 'failed_finalizing', 'activating', 'active'].includes(raw.deposit_stage)) fail();
    value.depositStage = raw.deposit_stage;
  }
  // Never copy arbitrary upstream messages or extra fields to the browser/journal.
  return value;
}

/** Server-only mainnet funding control plane. Quotes cannot sign. Approval and
 * resume can sign/broadcast and require an authenticated exact-intent action or
 * a separately armed, bounded owner policy. This class schedules neither.
 * Credentials and private note/wallet state are never persisted or returned.
 */
export class ZkApiFunding {
  #provider; #managementToken; #file; #now; #localMode; #allowApproval; #busy = false; #healthy = true; #state; #diskHash = null; #operations; #authorizeApproval;
  constructor({ file, base = 'http://127.0.0.1:8787', key = '', managementToken = '', localMode = false, allowApproval = false, authorizeApproval = () => {}, chainClient = null, fetcher = fetch, now = Date.now } = {}) {
    if (typeof authorizeApproval !== 'function') throw new Problem('Invalid synchronous funding authorization callback.');
    this.#authorizeApproval = () => { if (authorizeApproval()?.then) throw new Problem('Funding authorization must be synchronous.', 409); };
    this.#provider = new ZkApiProvider({ base, key, fetcher });
    this.#managementToken = managementToken;
    this.#localMode = localMode === true; this.#allowApproval = allowApproval === true; this.#now = now;
    if (typeof file !== 'string' || !file) throw new Problem('A separate funding intent journal is required.');
    this.#file = resolve(file);
    this.#state = { version: 1, sourceRevision: ZKAPI_SOURCE_REVISION, daemonOrigin: this.#provider.base, intents: [] };
    if (existsSync(this.#file)) {
      try {
        const fd = openSync(this.#file, 'r');
        let saved;
        try { if (fstatSync(fd).size > 2_000_000) throw new Error(); const raw = readFileSync(fd, 'utf8'); this.#diskHash = hash(raw); saved = JSON.parse(raw); }
        finally { closeSync(fd); }
        if (!onlyKeys(saved, ['version', 'sourceRevision', 'daemonOrigin', 'intents']) || saved.version !== 1 || saved.sourceRevision !== ZKAPI_SOURCE_REVISION || saved.daemonOrigin !== this.#provider.base || !Array.isArray(saved.intents) || saved.intents.length > 1000) throw new Error();
        const ids = new Set(), keys = new Set();
        for (const intent of saved.intents) {
          if (!onlyKeys(intent, ['id', 'idempotencyKey', 'amountGwei', 'createdAt', 'status', 'approvalAttempted', 'address', 'quote', 'approvalDigest', 'transactionHash', 'observed', 'abandonedAt']) ||
              typeof intent.id !== 'string' || !/^[0-9a-f-]{36}$/.test(intent.id) || ids.has(intent.id) ||
              typeof intent.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(intent.idempotencyKey) || keys.has(intent.idempotencyKey) ||
              !STATES.has(intent.status) || typeof intent.approvalAttempted !== 'boolean') throw new Error();
          decimal(intent.amountGwei, { positive: true, max: MAX_AMOUNT }); integer(intent.createdAt, { positive: true });
          if (intent.address) address(intent.address);
          if (intent.quote) {
            const checked = quoteData(intent.quote, intent.amountGwei, intent.address);
            if (hash(checked) !== intent.approvalDigest || JSON.stringify(checked) !== JSON.stringify(intent.quote)) throw new Error();
          } else if (intent.approvalAttempted || intent.status === 'quoted') throw new Error();
          if (intent.transactionHash) txHash(intent.transactionHash);
          if (intent.status === 'abandoned') { if (intent.approvalAttempted || intent.transactionHash || intent.observed) throw new Error(); integer(intent.abandonedAt, { positive: true }); }
          else if (intent.abandonedAt !== undefined) throw new Error();
          if (intent.approvalAttempted && ['quoting', 'quoted', 'quote_unknown'].includes(intent.status)) throw new Error();
          if (['approving', 'approval_unknown', 'pending', 'active', 'recovery_required', 'resuming', 'resume_unknown'].includes(intent.status) && !intent.approvalAttempted) throw new Error();
          if (['pending', 'active', 'resuming', 'resume_unknown'].includes(intent.status) && !intent.transactionHash) throw new Error();
          if (intent.observed) {
            const observed = intent.observed;
            if (!onlyKeys(observed, ['address', 'chainId', 'deploymentId', 'phase', 'balanceWei', 'amountGwei', 'transactionHash', 'actualFeeWei', 'depositStage']) || !intent.approvalAttempted || observed.chainId !== 1 || observed.deploymentId !== ZKAPI_MAINNET.deploymentId || address(observed.address) !== intent.address || observed.amountGwei !== intent.amountGwei || !PHASES.has(observed.phase)) throw new Error();
            decimal(observed.balanceWei); if (observed.transactionHash) txHash(observed.transactionHash); if (observed.actualFeeWei) decimal(observed.actualFeeWei);
          }
          if (intent.status === 'approving') intent.status = 'approval_unknown';
          if (intent.status === 'resuming') intent.status = 'resume_unknown';
          if (intent.status === 'quoting') intent.status = 'quote_unknown';
          ids.add(intent.id); keys.add(intent.idempotencyKey);
        }
        this.#state = saved;
      } catch { throw new Problem('Funding intent journal is invalid. Preserve it and recover the daemon before changing funding configuration.', 503); }
    }
    this.#operations = new FundingOperations({ file: this.#file + '.operations', network: ZKAPI_MAINNET,
      request: (path, body) => this.#request(path, body), requireApproval: () => this.#require({ approval: true }),
      observe: path => this.#request(path, undefined, true), otherUnresolved: () => this.#state.intents.some(item => !['active', 'abandoned'].includes(item.status)),
      chainState: chainClient ? async address => {
        try {
          const chainId = await chainClient.getChainId();
          if (chainId !== 1) throw new Error();
          const [latestNonce, pendingNonce] = await Promise.all(['latest', 'pending'].map(blockTag => chainClient.getTransactionCount({ address, blockTag })));
          return { chainId, address, latestNonce, pendingNonce };
        } catch { throw new Problem('Cannot independently verify the funding nonce on Ethereum. Preserve the attempted approval.', 503); }
      } : undefined,
      lock: fn => this.#locked(fn), now: this.#now, authorizeApproval: this.#authorizeApproval });
  }
  capabilities() {
    const credentialsConfigured = typeof this.#provider.key === 'string' && this.#provider.key.length >= 32 &&
      typeof this.#managementToken === 'string' && this.#managementToken.length >= 32 && this.#managementToken !== this.#provider.key;
    return { sourceRevision: ZKAPI_SOURCE_REVISION, network: 'mainnet', chainId: 1, localMode: this.#localMode,
      credentialsConfigured, approvalEnabled: this.#localMode && this.#allowApproval && credentialsConfigured,
      persistence: this.#healthy ? 'healthy' : 'blocked', perJobSignedSettlementAvailable: false,
      daemonOrigin: this.#provider.base, accounting: 'conservative-request-ceilings', privateNoteRefill: 'close-then-deposit' };
  }
  snapshot() { const operations = this.#operations.snapshot(); return { ...this.capabilities(), intents: this.#state.intents.map(intent => this.#public(intent)), operations: operations.operations,
    persistence: this.#healthy && operations.persistence === 'healthy' ? 'healthy' : 'blocked' }; }
  inspectOperation(kind) { return this.#operations.inspect(kind); }
  quoteOperation(input) { return this.#operations.quote(input); }
  refreshOperation(id) { return this.#operations.refresh(id); }
  approveOperation(input) { return this.#operations.approve(input); }
  recoverOperation(id) { return this.#operations.recover(id); }
  retireExpiredOperation(input) { return this.#operations.retireExpired(input); }
  resumeOperation(input) { return this.#operations.resume(input); }
  #public(intent) { return { ...copy(intent), quoteExpired: intent.quote ? intent.quote.expires_at <= this.#now() : false }; }
  #require({ approval = false } = {}) {
    if (!this.#healthy || this.#operations?.snapshot().persistence === 'blocked') throw new Problem('Funding journal persistence failed. Restart only after restoring it; no further action is allowed.', 503);
    const capabilities = this.capabilities();
    if (!capabilities.localMode || !capabilities.credentialsConfigured) throw new Problem('Funding management requires local mode and separate server-side daemon credentials.', 503);
    if (approval && !capabilities.approvalEnabled) throw new Problem('Funding approval and transaction replay are disabled by server configuration.', 403);
  }
  async #locked(operation) {
    this.#require();
    if (this.#busy) throw new Problem('Another funding operation is in progress.', 409);
    this.#busy = true;
    let lock;
    try {
      mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 });
      try { lock = openSync(`${this.#file}.lock`, 'wx', 0o600); }
      catch { throw new Problem('The funding journal is locked by another operation. After a crash, inspect recovery before removing a stale lock.', 409); }
      let diskHash = null;
      if (existsSync(this.#file)) {
        const fd = openSync(this.#file, 'r');
        try { const stat = fstatSync(fd); if (!stat.isFile() || stat.size > 2_000_000) throw new Error(); diskHash = hash(readFileSync(fd, 'utf8')); }
        finally { closeSync(fd); }
      }
      if (diskHash !== this.#diskHash) { this.#healthy = false; throw new Problem('Funding journal changed in another process. Restart from the saved state before further actions.', 503); }
      return await operation();
    } catch (error) {
      if (error instanceof Problem) throw error;
      this.#healthy = false;
      throw new Problem('Funding journal cannot be read safely. Further funding actions are blocked.', 503);
    } finally {
      this.#busy = false;
      if (lock !== undefined) {
        try { closeSync(lock); unlinkSync(`${this.#file}.lock`); }
        catch { this.#healthy = false; throw new Problem('Funding journal lock could not be released. Inspect recovery before further actions.', 503); }
      }
    }
  }
  #save() {
    const temp = `${this.#file}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 });
      const serialized = JSON.stringify(this.#state), fd = openSync(temp, 'wx', 0o600);
      try { writeFileSync(fd, serialized); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, this.#file);
      if (process.platform !== 'win32') { const dir = openSync(dirname(this.#file), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); } }
      this.#diskHash = hash(serialized);
    } catch {
      this.#healthy = false;
      try { unlinkSync(temp); } catch {}
      throw new Problem('Cannot durably save the funding intent. Further funding actions are blocked.', 503);
    }
  }
  #find(id) { const intent = this.#state.intents.find(item => item.id === id); if (!intent) throw new Problem('Funding intent not found.', 404); return intent; }
  async #request(path, body, observation = false) {
    this.#require();
    const allowed = new Set(['/admin/funding/address', '/admin/funding/quote', '/admin/funding/approve', '/admin/funding/deposit',
      '/admin/withdrawal', '/admin/withdrawal/quote', '/admin/withdrawal/approve', '/admin/return', '/admin/return/quote', '/admin/return/approve']);
    if (!allowed.has(path)) throw new Problem('Unsupported funding endpoint.');
    try {
      const response = await this.#provider.fetcher(this.#provider.base + path, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.#provider.key}`, 'X-OA-Management-Token': this.#managementToken },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(body === undefined ? 15_000 : 180_000)
      });
      if (!response.ok) { await response.body?.cancel(); throw new Problem(`zkAPI funding returned HTTP ${response.status}. Preserve the intent and inspect recovery; no automatic retry was sent.`, 502); }
      const reader = response.body.getReader(), chunks = []; let size = 0;
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 131_072) { await reader.cancel(); fail(); } chunks.push(value); }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!observation) return data;
      const date = response.headers.get('date'), servedAt = Date.parse(date || '');
      if (body !== undefined || !Number.isSafeInteger(servedAt) || new Date(servedAt).toUTCString() !== date || Math.abs(this.#now() - servedAt) > 30_000 || response.headers.get('cache-control') !== 'no-store') throw new Problem('The authenticated daemon response lacks a fresh no-store clock witness.', 502);
      return { data, servedAt };
    } catch (error) { throw error instanceof Problem ? error : new Problem('Cannot read zkAPI funding response. The result may be uncertain; no automatic retry was sent.', 502); }
  }
  async #inspect() {
    const daemon = await this.#provider.diagnostics({ expectedNetwork: 'mainnet' });
    const funding = statusData(await this.#request('/admin/funding/address'));
    return { ...this.capabilities(), daemon, funding, evidence: 'Authenticated daemon-reported funding status; not an independent chain or wallet audit.' };
  }
  inspect() { return this.#locked(() => this.#inspect()); }
  quote({ idempotencyKey, amountGwei } = {}) {
    return this.#locked(async () => {
      if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey) || typeof amountGwei !== 'string' || !/^[1-9][0-9]{0,12}$/.test(amountGwei) || BigInt(amountGwei) > MAX_AMOUNT) throw new Problem('Use an idempotency key and a positive integer gwei amount up to 1000000000000.');
      const existing = this.#state.intents.find(item => item.idempotencyKey === idempotencyKey);
      if (existing) {
        if (existing.amountGwei !== amountGwei) throw new Problem('Idempotency key is already bound to a different amount.', 409);
        return this.#public(existing);
      }
      if (this.#state.intents.some(item => !['active', 'abandoned'].includes(item.status)) || this.#operations.unresolved() || this.#state.intents.length >= 1000) throw new Problem('Resolve the saved funding intent before starting another.', 409);
      const intent = { id: randomUUID(), idempotencyKey, amountGwei, createdAt: this.#now(), status: 'quoting', approvalAttempted: false };
      this.#state.intents.push(intent); this.#save();
      return this.#makeQuote(intent);
    });
  }
  refresh(intentId) {
    return this.#locked(async () => {
      const intent = this.#find(intentId);
      if (intent.approvalAttempted || !['quoted', 'quote_unknown'].includes(intent.status)) throw new Problem('A funding approval may already exist. Recover it before preparing another quote.', 409);
      intent.status = 'quoting'; this.#save(); return this.#makeQuote(intent);
    });
  }
  abandonUnsigned(intentId) {
    return this.#locked(async () => {
      const intent = this.#find(intentId);
      if (intent.status === 'abandoned') return this.#public(intent);
      if (!['quoted', 'quote_unknown'].includes(intent.status) || intent.approvalAttempted || intent.transactionHash || intent.observed) throw new Problem('Only a provably unsigned funding quote can be abandoned. Preserve any approval or transaction uncertainty.', 409);
      const { funding } = await this.#inspect();
      if (!['ready', 'waiting_funds'].includes(funding.phase) || funding.transactionHash || (intent.address && funding.address !== intent.address) || this.#operations.unresolved()) throw new Problem('Daemon state does not prove this preparation is unsigned and idle.', 409);
      intent.status = 'abandoned'; intent.abandonedAt = this.#now(); this.#save(); return this.#public(intent);
    });
  }
  async #makeQuote(intent) {
    try {
      const { funding } = await this.#inspect();
      if (!['ready', 'waiting_funds'].includes(funding.phase) || funding.transactionHash ||
          (intent.address && intent.address !== funding.address)) throw new Problem('The daemon has a pending or active operation; recover it before quoting.', 409);
      intent.address = funding.address; this.#save();
      const q = quoteData(await this.#request('/admin/funding/quote', { amount: Number(intent.amountGwei) }), intent.amountGwei, intent.address);
      if (q.expires_at <= this.#now()) throw new Problem('The daemon quote already expired. Refresh it explicitly.', 409);
      intent.quote = q; intent.approvalDigest = hash(q); intent.status = 'quoted'; this.#save(); return this.#public(intent);
    } catch (error) {
      intent.status = 'quote_unknown'; if (this.#healthy) this.#save(); throw error;
    }
  }
  async approve({ intentId, quoteId, approvalDigest } = {}) {
    this.#require({ approval: true });
    return this.#locked(async () => {
      const intent = this.#find(intentId);
      if (!intent.quote || intent.quote.id !== quoteId || intent.approvalDigest !== approvalDigest) throw new Problem('Approval does not match the exact displayed funding quote.', 409);
      if (intent.approvalAttempted) return this.#public(intent); // never replay a signing request
      if (intent.status !== 'quoted' || intent.quote.expires_at <= this.#now()) throw new Problem('Funding quote expired or is not ready. Refresh and review it again.', 409);
      const { funding } = await this.#inspect();
      if (funding.address !== intent.address || funding.amountGwei !== intent.amountGwei || funding.phase !== 'waiting_funds' || funding.transactionHash) throw new Problem('Daemon funding state changed; no approval sent.', 409);
      const saved = quoteData(await this.#request('/admin/funding/quote'), intent.amountGwei, intent.address);
      if (hash(saved) !== approvalDigest || saved.expires_at <= this.#now()) throw new Problem('Daemon quote changed or expired; review a fresh quote.', 409);
      if (BigInt(funding.balanceWei) < BigInt(saved.required_total_wei)) throw new Problem('The funding address lacks the quoted principal and minimum network fee.', 409);
      this.#authorizeApproval();
      intent.status = 'approving'; intent.approvalAttempted = true; this.#save();
      try {
        const status = statusData(await this.#request('/admin/funding/approve', { quote_id: quoteId }), intent.address, intent.amountGwei);
        this.#acceptStatus(intent, status); this.#save(); return this.#public(intent);
      } catch (error) { intent.status = 'approval_unknown'; if (this.#healthy) this.#save(); throw error; }
    });
  }
  #acceptStatus(intent, status) {
    if (intent.transactionHash && status.transactionHash !== intent.transactionHash) fail();
    if (!status.transactionHash || !['deposit_pending', 'confirming', 'active'].includes(status.phase)) fail();
    intent.transactionHash = status.transactionHash; intent.observed = status;
    intent.status = status.phase === 'active' ? 'active' : 'pending';
  }
  recover(intentId) {
    return this.#locked(async () => {
      const intent = this.#find(intentId);
      if (intent.status === 'abandoned') return this.#public(intent);
      const { funding } = await this.#inspect();
      if (intent.address && funding.address !== intent.address) fail();
      if (intent.approvalAttempted) {
        if (funding.amountGwei !== intent.amountGwei) fail();
        if (intent.transactionHash && funding.transactionHash === intent.transactionHash && ['deposit_pending', 'confirming', 'active'].includes(funding.phase)) this.#acceptStatus(intent, funding);
        else {
          // A lost approve response gives no cryptographic quote-to-tx binding.
          // A matching address/amount alone cannot justify adopting another tx.
          if (intent.transactionHash && funding.transactionHash && funding.transactionHash !== intent.transactionHash) fail();
          intent.observed = funding; intent.status = 'recovery_required';
        }
      } else {
        if (!['ready', 'waiting_funds'].includes(funding.phase) || funding.transactionHash) throw new Problem('Recover the daemon operation before quoting again.', 409);
        const raw = await this.#request('/admin/funding/quote');
        if (raw) {
          intent.address = funding.address; intent.quote = quoteData(raw, intent.amountGwei, intent.address);
          intent.approvalDigest = hash(intent.quote); intent.status = 'quoted';
        }
      }
      this.#save(); return this.#public(intent);
    });
  }
  async resume({ intentId, transactionHash } = {}) {
    this.#require({ approval: true });
    return this.#locked(async () => {
      const intent = this.#find(intentId);
      if (!intent.approvalAttempted || !intent.transactionHash || transactionHash !== intent.transactionHash || !['pending', 'resume_unknown'].includes(intent.status)) throw new Problem('Only the exact saved funding transaction can be resumed.', 409);
      const { funding } = await this.#inspect();
      if (funding.address !== intent.address || funding.amountGwei !== intent.amountGwei || funding.transactionHash !== intent.transactionHash) fail();
      if (funding.phase === 'active') { this.#acceptStatus(intent, funding); this.#save(); return this.#public(intent); }
      if (!['deposit_pending', 'confirming'].includes(funding.phase)) throw new Problem('The saved transaction needs manual daemon recovery.', 409);
      this.#authorizeApproval();
      intent.status = 'resuming'; this.#save();
      try {
        // Upstream's native FundAddress path cannot create a new signature
        // without a current quote approval. It can replay only saved tx bytes.
        const status = statusData(await this.#request('/admin/funding/deposit', { amount: Number(intent.amountGwei) }), intent.address, intent.amountGwei);
        this.#acceptStatus(intent, status); this.#save(); return this.#public(intent);
      } catch (error) { intent.status = 'resume_unknown'; if (this.#healthy) this.#save(); throw error; }
    });
  }
}

export function fundingFromEnv({ file, localMode = false, env = process.env, fetcher = fetch, now = Date.now, authorizeApproval, chainClient } = {}) {
  return new ZkApiFunding({ file, localMode, fetcher, now, authorizeApproval, chainClient, base: env.ZKAPI_ORIGIN, key: env.ZKAPI_LOCAL_KEY,
    managementToken: env.ZKAPI_MANAGEMENT_TOKEN, allowApproval: env.VEYL_ENABLE_ZKAPI_APPROVAL === 'true' });
}
