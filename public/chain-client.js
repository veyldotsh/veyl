import { WalletSession, isLocalWalletPreflightError } from './wallet.js';

/** Connects the compact market UI to the authenticated unsigned-intent API.
 * A wallet confirmation is required for every transaction, including approval.
 * Pending hashes are retained before any receipt-import request for recovery. */
export class VeylChainClient extends EventTarget {
  constructor({ api, wallet = new WalletSession(), storage = globalThis.localStorage, transactionsEnabled = false } = {}) {
    super(); if (typeof api !== 'function') throw new Error('VeylChainClient requires the CSRF/authenticated API helper.');
    this.api = api; this.wallet = wallet; this.storage = storage; this.transactionsEnabled = transactionsEnabled;
    this.pendingKey = 'veyl:ethereum:pending:v1'; this.busy = false;
    wallet.addEventListener('change', () => this.dispatchEvent(new Event('change')));
  }
  path(projectId, action) { return projectId === 'platform-market' ? `/api/platform-market/${action}` : `/api/projects/${encodeURIComponent(projectId)}/mainnet/${action}`; }
  async capabilities(projectId) { return projectId ? this.api(this.path(projectId, 'capabilities')) : this.api('/api/mainnet/capabilities'); }
  async status(projectId) {
    const account = this.wallet.account;
    return this.api(this.path(projectId, 'status') + (account && projectId !== 'platform-market' ? `?account=${encodeURIComponent(account)}` : ''));
  }
  async prepare(projectId, action, input = {}) {
    if (!this.wallet.account) throw new Error('Connect your wallet first.');
    await this.wallet.ensure(this.wallet.account);
    return this.api(this.path(projectId, action), { ...input, account: this.wallet.account });
  }
  pending() {
    const rows = JSON.parse(this.storage?.getItem(this.pendingKey) || '[]');
    if (!Array.isArray(rows) || rows.length > 1000 || rows.some(r => !r || typeof r.projectId !== 'string' || typeof r.intentId !== 'string' || (r.transactionHash ? !/^0x[\da-f]{64}$/i.test(r.transactionHash) : r.status !== 'sending'))) throw new Error('Browser transaction recovery state is invalid. Preserve it and inspect the wallet before continuing.');
    return rows;
  }
  savePending(rows) {
    try {
      if (!this.storage || rows.length > 1000) throw new Error();
      const encoded = JSON.stringify(rows); this.storage.setItem(this.pendingKey, encoded);
      if (this.storage.getItem(this.pendingKey) !== encoded) throw new Error();
    }
    catch { throw new Error('Browser recovery storage is unavailable. Keep the transaction hash from your wallet and recover it manually.'); }
  }
  async execute(projectId, intent) {
    if (this.busy) throw new Error('A wallet action is already in progress.');
    if (this.pending().some(row => row.intentId === intent.id || (!row.transactionHash && row.account?.toLowerCase() === intent.account?.toLowerCase()))) throw new Error('This action was already submitted or a wallet outcome is unknown. Check its receipt before another transaction.');
    this.busy = true;
    try {
      const pending = { projectId, intentId: intent.id, status: 'sending', account: intent.account, submittedAt: Date.now() };
      // Save the ambiguous state before entering the wallet. A lost response may
      // still have submitted a transaction. Only explicit wallet rejection or a
      // locally branded failure before submission can clear this pending row.
      if (!this.transactionsEnabled) throw new Error('Mainnet transactions are disabled.');
      await this.wallet.ensure(intent.account);
      this.savePending([...this.pending(), pending]);
      let transactionHash;
      try { transactionHash = await this.wallet.send(intent, { enabled: this.transactionsEnabled }); }
      catch (error) { if (error?.code === 4001 || isLocalWalletPreflightError(error)) this.savePending(this.pending().filter(r => r.intentId !== intent.id)); throw error; }
      if (!/^0x[\da-f]{64}$/i.test(transactionHash || '')) throw new Error('Wallet did not return a valid transaction hash. Inspect it and recover the exact receipt before another send.');
      pending.transactionHash = transactionHash; pending.status = 'submitted';
      try { this.savePending(this.pending().map(r => r.intentId === intent.id ? pending : r)); }
      catch { throw new Error(`Transaction submitted but browser storage failed. Preserve ${transactionHash} and import its receipt manually; do not resend.`); }
      this.dispatchEvent(new Event('change'));
      try { return await this.recover(pending); }
      catch (error) { return { status: 'submitted', transactionHash, intentId: intent.id, receiptPending: true, message: error.message }; }
    } finally { this.busy = false; }
  }
  async recover({ projectId, intentId, transactionHash }) {
    if (!/^0x[\da-f]{64}$/i.test(transactionHash || '')) throw new Error('Enter the exact wallet transaction hash for recovery.');
    const result = await this.api(this.path(projectId, 'verify'), { intentId, transactionHash });
    if (result.id !== intentId || result.transactionHash?.toLowerCase() !== transactionHash.toLowerCase()) throw new Error('Receipt confirmation does not match the recorded wallet action.');
    if (result.status === 'confirmed' || result.status === 'failed') this.savePending(this.pending().filter(r => r.intentId !== intentId));
    this.dispatchEvent(new Event('change')); return result;
  }
  explorer(hash) { return /^0x[\da-f]{64}$/i.test(hash || '') ? `https://etherscan.io/tx/${hash}` : null; }
}
