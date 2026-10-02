import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, parseEther, encodeAbiParameters, keccak256, stringToHex, formatEther } from 'viem';
import { foundry } from 'viem/chains';
import { Problem } from './agent.mjs';
import { FEE_ALLOCATION } from './economics.mjs';

export class LocalChain {
  constructor(origin = 'http://127.0.0.1:8547') {
    const url = new URL(origin);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('Only a loopback development chain is supported.');
    // Enforce the loopback boundary on every request, including wallet RPC reads.
    const transport = http(origin, { retryCount: 0, timeout: 5000, fetchOptions: { redirect: 'error' } });
    this.client = createPublicClient({ chain: foundry, transport });
    this.wallet = createWalletClient({ chain: foundry, transport });
    this.origin = origin; this.factory = null; this.queue = Promise.resolve();
  }
  async check() {
    if (await this.client.getChainId() !== 31337) throw new Problem('Only Anvil chain 31337 is permitted.', 409);
    if (!(await this.client.request({ method: 'web3_clientVersion' })).toLowerCase().includes('anvil')) throw new Problem('Expected a local Anvil node.', 409);
    [this.account, this.platformAccount] = await this.wallet.getAddresses();
    if (!this.account || !this.platformAccount) throw new Problem('Two development accounts are required for creator and platform roles.', 409);
  }
  artifact(name) { const file = name === 'RevenueRouter' ? 'Funding.sol' : 'AgentKit.sol'; return JSON.parse(readFileSync(fileURLToPath(new URL(`../contracts/out/${file}/${name}.json`, import.meta.url)), 'utf8')); }
  async status() {
    try { await this.check(); return { ready: true, chainId: 31337, name: 'Local Anvil', factory: this.factory, note: 'Development ETH only. Local v4 market launches are available.' }; }
    catch { return { ready: false, chainId: 31337, name: 'Local Anvil', note: 'Start the local development chain to launch a token, market and treasury.' }; }
  }
  exclusive(fn) { const work = this.queue.then(fn); this.queue = work.catch(() => {}); return work; }
  launch(project) { return this.exclusive(async () => {
    await this.check(); const contract = this.artifact('AgentFactory');
    if (!this.factory || !(await this.client.getCode({ address: this.factory }))) {
      const hash = await this.wallet.deployContract({ account: this.account, abi: contract.abi, bytecode: contract.bytecode.object, args: [this.platformAccount] });
      const receipt = await this.client.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Problem('Local factory deployment failed.', 502);
      this.factory = receipt.contractAddress;
    }
    const salt = keccak256(stringToHex(project.id));
    const id = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [this.account, salt]));
    const existing = await this.client.readContract({ address: this.factory, abi: contract.abi, functionName: 'projects', args: [id] });
    let hash = null;
    if (/^0x0+$/.test(existing[0])) {
      hash = await this.wallet.writeContract({ account: this.account, address: this.factory, abi: contract.abi, functionName: 'launch',
        args: [salt, project.name, project.symbol, this.account, parseEther('0.01')], value: parseEther('0.05') });
      const receipt = await this.client.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Problem('Local project launch reverted.', 502);
    }
    const [token, treasury, owner, revenueRouter] = await this.client.readContract({ address: this.factory, abi: contract.abi, functionName: 'projects', args: [id] });
    return { chainId: 31337, token, treasury, owner, revenueRouter, platform: this.platformAccount, factory: this.factory, hash, supply: '1000000000', pool: 'not-created', type: 'local-anvil' };
  }); }
  async balance(project) { if (!project.chain) return null; await this.check(); if (!(await this.client.getCode({ address: project.chain.treasury }))) throw new Problem('Local chain was reset. Treasury is no longer deployed.', 409); return formatEther(await this.client.getBalance({ address: project.chain.treasury })); }
  fund(project) { return this.exclusive(async () => { await this.balance(project); const hash = await this.wallet.sendTransaction({ account: this.account, to: project.chain.treasury, value: parseEther('0.01') }); const receipt = await this.client.waitForTransactionReceipt({ hash }); if (receipt.status !== 'success') throw new Problem('Development funding failed.', 502); return { hash, amount: '0.01' }; }); }
  async revenueStatus(project) {
    if (!project.chain?.revenueRouter) return { configured: false, allocation: FEE_ALLOCATION };
    await this.balance(project);
    const address = project.chain.revenueRouter, abi = this.artifact('RevenueRouter').abi;
    if (!(await this.client.getCode({ address }))) throw new Problem('Local fee router is missing. Preserve the project record and check the development chain.', 409);
    const read = (functionName, args = []) => this.client.readContract({ address, abi, functionName, args });
    const [treasury, creator, platform, treasuryBps, creatorBps, protocolBps] = await Promise.all(['treasury', 'creator', 'protocol', 'treasuryBps', 'creatorBps', 'protocolBps'].map(name => read(name)));
    if (treasury.toLowerCase() !== project.chain.treasury.toLowerCase() || creator.toLowerCase() !== project.chain.owner.toLowerCase() || platform.toLowerCase() !== project.chain.platform?.toLowerCase() || Number(treasuryBps) !== 7000 || Number(creatorBps) !== 2000 || Number(protocolBps) !== 1000) throw new Problem('Fee router does not match the project and approved allocation.', 409);
    const amounts = await Promise.all([treasury, creator, platform].map(to => read('claimable', [to])));
    return { configured: true, router: address, allocation: { treasuryBps: Number(treasuryBps), creatorBps: Number(creatorBps), protocolBps: Number(protocolBps) }, recipients: { treasury, creator, platform }, claimable: Object.fromEntries(['treasury', 'creator', 'platform'].map((role, i) => [role, formatEther(amounts[i])])) };
  }
  testRevenue(project, checkpoint) { return this.exclusive(async () => {
    await this.balance(project);
    if (!project.chain?.treasury) throw new Problem('Deploy the local token first.');
    if (!project.chain.revenueRouter) {
      const contract = this.artifact('RevenueRouter');
      const hash = await this.wallet.deployContract({ account: this.account, abi: contract.abi, bytecode: contract.bytecode.object, args: [project.chain.treasury, project.chain.owner, this.platformAccount] });
      const receipt = await this.client.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success' || !receipt.contractAddress) throw new Problem('Local fee router deployment failed.', 502);
      project.chain.revenueRouter = receipt.contractAddress; project.chain.platform = this.platformAccount;
      checkpoint(); // Save the router before sending its first test receipt.
    }
    await this.revenueStatus(project);
    const hash = await this.wallet.sendTransaction({ account: this.account, to: project.chain.revenueRouter, value: parseEther('0.01') });
    const receipt = await this.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Problem('Local test receipt failed.', 502);
    return { hash, amount: '0.01', ...await this.revenueStatus(project) };
  }); }
  distributeRevenue(project) { return this.exclusive(async () => {
    const status = await this.revenueStatus(project);
    if (!status.configured) throw new Problem('No fee router exists for this local project.');
    const hashes = [], abi = this.artifact('RevenueRouter').abi;
    for (const role of ['treasury', 'creator', 'platform']) {
      if (parseEther(status.claimable[role]) === 0n) continue;
      const hash = await this.wallet.writeContract({ account: this.account, address: status.router, abi, functionName: 'distribute', args: [status.recipients[role]] });
      const receipt = await this.client.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Problem('A fee share was not delivered. Already delivered shares remain delivered; read current claimable amounts before retrying.', 502);
      hashes.push(hash);
    }
    return { hashes, ...await this.revenueStatus(project) };
  }); }
}
