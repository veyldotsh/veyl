// EIP-1193 wallet connection. Private keys never enter Veyl's page or server.
export class WalletSession extends EventTarget {
  constructor({ provider = globalThis.ethereum, storage = globalThis.sessionStorage } = {}) {
    super(); this.provider = provider; this.storage = storage; this.account = null; this.chainId = null;
    this.accountsChanged = accounts => { this.account = this.validAccount(accounts?.[0]) ? accounts[0] : null; this.changed(); };
    this.chainChanged = chain => { this.chainId = Number(BigInt(chain)); this.changed(); };
    this.disconnected = () => { this.account = null; this.chainId = null; this.changed(); };
    provider?.on?.('accountsChanged', this.accountsChanged);
    provider?.on?.('chainChanged', this.chainChanged);
    provider?.on?.('disconnect', this.disconnected);
  }
  validAccount(value) { return /^0x[\da-f]{40}$/i.test(value || '') && !/^0x0{40}$/i.test(value); }
  changed() { this.dispatchEvent(new Event('change')); }
  state() { return { available: Boolean(this.provider?.request), connected: Boolean(this.account), account: this.account, chainId: this.chainId, ethereum: this.chainId === 1 }; }
  async connect() {
    if (!this.provider?.request) throw new Error('Install an Ethereum wallet or open Veyl in your wallet browser.');
    const accounts = await this.provider.request({ method: 'eth_requestAccounts' });
    if (!this.validAccount(accounts?.[0])) throw new Error('The wallet did not provide a public Ethereum account.');
    this.account = accounts[0]; this.chainId = Number(BigInt(await this.provider.request({ method: 'eth_chainId' })));
    this.changed(); return this.state();
  }
  async restore() {
    if (!this.provider?.request) return this.state();
    const accounts = await this.provider.request({ method: 'eth_accounts' });
    this.account = this.validAccount(accounts?.[0]) ? accounts[0] : null;
    this.chainId = Number(BigInt(await this.provider.request({ method: 'eth_chainId' }))); this.changed(); return this.state();
  }
  async switchEthereum() {
    if (!this.provider?.request) throw new Error('Connect an Ethereum wallet first.');
    await this.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] });
    return this.restore();
  }
  async disconnect() {
    // Revocation is optional in EIP-1193; clear our state even if the wallet lacks it.
    try { await this.provider?.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] }); } catch {}
    this.disconnected();
  }
  async ensure(account) {
    if (!this.provider?.request) throw new Error('Connect an Ethereum wallet first.');
    const [chain, accounts] = await Promise.all([this.provider.request({ method: 'eth_chainId' }), this.provider.request({ method: 'eth_accounts' })]);
    if (BigInt(chain) !== 1n) throw new Error('Switch your wallet to Ethereum mainnet.');
    if (!this.validAccount(account) || accounts?.[0]?.toLowerCase() !== account.toLowerCase()) throw new Error('The wallet account changed. Reconnect and prepare this action again.');
    this.account = accounts[0]; this.chainId = 1; return this.account;
  }
  async send(intent, { enabled = false } = {}) {
    if (!enabled) throw new Error('Ethereum transactions are disabled until deployment is explicitly enabled.');
    if (!intent || intent.chainId !== 1 || intent.status !== 'prepared' || !intent.transaction || intent.expiresAt <= Date.now()) throw new Error('This transaction is unavailable or expired. Prepare a fresh intent.');
    const tx = intent.transaction;
    if (tx.chainId !== '0x1' || tx.from?.toLowerCase() !== intent.account?.toLowerCase() || !/^0x[\da-f]*$/i.test(tx.data || '') || !/^0x[\da-f]+$/i.test(tx.value || '') || (tx.to && !this.validAccount(tx.to))) throw new Error('The transaction does not match a valid Ethereum intent.');
    if (!tx.to && !['quoter', 'project-builder', 'market-builder', 'liquidity-builder', 'factory'].includes(intent.kind)) throw new Error('Only the explicit quoter, builder or factory deployment can create a contract.');
    await this.ensure(intent.account);
    // Exact fields only: a response can never add arbitrary wallet RPC methods,
    // authorization lists, nonce overrides or a signer/account override.
    const transaction = { from: tx.from, ...(tx.to ? { to: tx.to } : {}), data: tx.data, value: tx.value, chainId: '0x1' };
    if (tx.gas && /^0x[\da-f]+$/i.test(tx.gas)) transaction.gas = tx.gas;
    const hash = await this.provider.request({ method: 'eth_sendTransaction', params: [transaction] });
    if (!/^0x[\da-f]{64}$/i.test(hash || '')) throw new Error('Wallet submission outcome is unknown. Check your wallet before trying again.');
    return hash;
  }
  async signLogin(message) {
    if (typeof message !== 'string' || message.length > 2048 || !message.includes('Sign in to Veyl')) throw new Error('Unexpected sign-in challenge.');
    await this.ensure(this.account);
    const hex = '0x' + Array.from(new TextEncoder().encode(message), b => b.toString(16).padStart(2, '0')).join('');
    return this.provider.request({ method: 'personal_sign', params: [hex, this.account] });
  }
  destroy() {
    this.provider?.removeListener?.('accountsChanged', this.accountsChanged);
    this.provider?.removeListener?.('chainChanged', this.chainChanged);
    this.provider?.removeListener?.('disconnect', this.disconnected);
  }
}
