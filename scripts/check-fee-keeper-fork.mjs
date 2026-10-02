import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, http, parseEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import { MainnetMarkets, ETHEREUM_POOL_MANAGER } from '../src/mainnet.mjs';
import { FeeKeeper } from '../src/fee-keeper.mjs';
import { TreasuryRunway } from '../src/runway.mjs';
import { Store } from '../src/store.mjs';
import { Kit } from '../src/kit.mjs';

// Real bytecode, a dedicated disposable loopback fork, development ETH only.
// zkAPI and LLM below are explicitly fixtures; this is NOT funded zkAPI acceptance.
const origin = 'http://127.0.0.1:18561', rpc = 'https://ethereum-rpc.publicnode.com';
const forkBlock = await createPublicClient({ transport: http(rpc, { retryCount: 0, fetchOptions: { redirect: 'error' } }) }).getBlockNumber();
const executable = process.platform === 'win32' ? resolve(process.env.USERPROFILE, '.foundry/bin/anvil.exe') : 'anvil';
const child = spawn(executable, ['--host', '127.0.0.1', '--port', '18561', '--chain-id', '1', '--fork-url', rpc, '--fork-block-number', String(forkBlock), '--quiet'], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
const client = createPublicClient({ chain: mainnet, transport: http(origin, { retryCount: 0, timeout: 120000 }) }), wallet = createWalletClient({ chain: mainnet, transport: http(origin, { retryCount: 0, timeout: 120000 }) });
let exited = false; child.on('exit', () => { exited = true; });
const output = resolve('output/fee-keeper-fork', String(Date.now())); mkdirSync(output, { recursive: true });
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (exited) throw new Error('Disposable Anvil process exited.');
    try { if (/anvil/i.test(await client.request({ method: 'web3_clientVersion' }))) { ready = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  assert.ok(ready); assert.equal(new URL(origin).hostname, '127.0.0.1'); assert.equal(await client.getChainId(), 1); assert.equal(await client.getBlockNumber(), forkBlock);
  const [faucet] = await wallet.getAddresses();
  // Fresh actors avoid Foundry's pre-funded fork-account balance overlay.
  const ownerAccount = privateKeyToAccount(generatePrivateKey()), owner = ownerAccount.address;
  const protocol = privateKeyToAccount(generatePrivateKey()).address, daemon = privateKeyToAccount(generatePrivateKey()).address;
  const ownerWallet = createWalletClient({ account: ownerAccount, chain: mainnet, transport: http(origin, { retryCount: 0, timeout: 120000 }) });
  const seed = await wallet.sendTransaction({ account: faucet, to: owner, value: parseEther('3') }); await client.waitForTransactionReceipt({ hash: seed });
  const markets = new MainnetMarkets({ origin, client, config: { addresses: { protocolRecipient: protocol }, trading: { buyFeeBps: 180, sellFeeBps: 180, tickSpacing: 200 } } });
  const project = { id: 'fee-keeper-fixture', name: 'Veyl Fee Fixture', symbol: 'VFEES' }, save = () => writeFileSync(resolve(output, 'project.json'), JSON.stringify(project));
  async function localSend(request) {
    assert.ok(/anvil/i.test(await client.request({ method: 'web3_clientVersion' }))); assert.equal(await client.getChainId(), 1);
    const hash = await ownerWallet.sendTransaction(request); await client.waitForTransactionReceipt({ hash }); return hash;
  }
  async function execute(intent) {
    const tx = intent.transaction, hash = await localSend({ ...(tx.to ? { to: tx.to } : {}), data: tx.data, value: BigInt(tx.value), ...(tx.gas ? { gas: BigInt(tx.gas) } : {}) });
    await client.request({ method: 'anvil_mine', params: [1] }); assert.equal((await markets.verify(project, { intentId: intent.id, transactionHash: hash }, save)).status, 'confirmed');
    return hash;
  }
  console.log('Launching disposable verified contracts and generating real swap fees.');
  for (let step = 0; step < 5; step++) await execute(await markets.prepareFactory(project, { account: owner }, save));
  await execute(await markets.prepareLaunch(project, { account: owner, treasuryOwner: owner, operator: owner, dailyLimitEth: '0.01', treasuryEth: '0', liquidityEth: '1', liquidityTokens: '100000000', sqrtPriceX96: ((1n << 96n) * 10000n).toString(), tickLower: -887200, tickUpper: 887200, slippageBps: 50 }, save));
  const quote = await markets.quote(project, { account: owner, side: 'buy', amount: '0.05', slippageBps: 50 }, save);
  await execute(await markets.prepareSwap(project, { account: owner, quoteId: quote.id }, save));
  const revenue = await markets.read(project.mainnet.hook, 'VeylFeeHook', 'pendingFees'); assert.equal(revenue, parseEther('0.05') * 180n / 10000n);
  const feeAccount = privateKeyToAccount(generatePrivateKey()); await localSend({ to: feeAccount.address, value: parseEther('0.1') });
  const keeperConfig = { file: resolve(output, 'keeper.json'), markets, signer: { address: feeAccount.address, signTransaction: tx => feeAccount.signTransaction(tx) }, enabled: true, dailyGasLimitWei: parseEther('0.02').toString(), maxFeePerGasWei: '100000000000', maxPriorityFeePerGasWei: '10000000000', maxGasPerTransaction: '500000', minRevenueWei: '1' };
  let keeper = new FeeKeeper(keeperConfig);
  const beforeBlock = await client.getBlock({ blockTag: 'latest' });
  const beforeProtocol = await client.getBalance({ address: protocol, blockNumber: beforeBlock.number }), beforeOwner = await client.getBalance({ address: owner, blockNumber: beforeBlock.number });
  for (let i = 0; i < 4; i++) {
    const entry = await keeper.tick(project); assert.equal(entry.status, 'pending');
    await client.waitForTransactionReceipt({ hash: entry.transactionHash }); await client.request({ method: 'anvil_mine', params: [65] });
    keeper = new FeeKeeper(keeperConfig); assert.equal((await keeper.recover()).status, 'confirmed');
  }
  assert.equal((await keeper.tick(project)).status, 'idle');
  const treasuryShare = revenue * 7000n / 10000n, creatorShare = revenue * 2000n / 10000n, platformShare = revenue - treasuryShare - creatorShare;
  const afterBlock = await client.getBlock({ blockTag: 'latest' });
  assert.equal(await client.getBalance({ address: project.mainnet.treasury, blockNumber: afterBlock.number }), treasuryShare);
  assert.equal(await client.getBalance({ address: owner, blockNumber: afterBlock.number }) - beforeOwner, creatorShare);
  assert.equal(await client.getBalance({ address: protocol, blockNumber: afterBlock.number }) - beforeProtocol, platformShare);
  assert.equal(await markets.read(project.mainnet.hook, 'VeylFeeHook', 'pendingFees'), 0n);
  console.log('70/20/10 delivered by the keeper; testing capped treasury payment and fixture runner.');
  const amountWei = '10000000000000', intents = []; let phase = 'ready';
  const funding = {
    capabilities: () => ({ daemonOrigin: 'http://127.0.0.1:18787', approvalEnabled: true }),
    inspect: async () => ({ funding: { address: daemon, phase } }), snapshot: () => ({ intents }),
    quote: async ({ amountGwei, idempotencyKey }) => { const intent = { id: randomUUID(), idempotencyKey, address: daemon, amountGwei, status: 'quoted', approvalAttempted: false, approvalDigest: 'fixture-review', quote: { id: 'fixture-quote', recommended_top_up_wei: amountWei, required_total_wei: amountWei, balance_wei: amountWei } }; intents.push(intent); return structuredClone(intent); },
    refresh: async id => structuredClone(intents.find(i => i.id === id)),
    approve: async ({ intentId }) => { const item = intents.find(i => i.id === intentId); item.status = 'active'; item.approvalAttempted = true; phase = 'active'; return structuredClone(item); },
    recover: async id => structuredClone(intents.find(i => i.id === id))
  };
  const runway = new TreasuryRunway({ file: resolve(output, 'runway.json'), funding, client, signer: { account: { address: owner }, sendTransaction: ({ to, data, value }) => localSend({ to, data, value }) }, enableAutomatic: true, isIdle: () => true });
  await runway.configure({ projectId: project.id, treasury: project.mainnet.treasury, owner, operator: owner, depositGwei: '5000', lowWaterGwei: '0', maxTopUpWei: amountWei, dailyTopUpWei: amountWei, automatic: true });
  let plan;
  try { plan = await runway.prepare({ projectId: project.id, idempotencyKey: 'fixture-refill-0001' }); }
  catch (error) { writeFileSync(resolve(output, 'runway-diagnostic.json'), JSON.stringify(runway.snapshot(), null, 2)); throw error; }
  await localSend({ to: plan.calls[0].to, data: plan.calls[0].data, value: 0n });
  const beforeDaemon = await client.getBalance({ address: daemon }), payment = await runway.execute({ projectId: project.id, refillId: plan.id });
  await client.request({ method: 'anvil_mine', params: [65] });
  assert.equal((await runway.confirm({ projectId: project.id, refillId: plan.id, transactionHash: payment.transactionHash })).status, 'funded');
  assert.equal(await client.getBalance({ address: daemon }) - beforeDaemon, BigInt(amountWei));
  assert.equal(await client.getBalance({ address: project.mainnet.treasury }), treasuryShare - BigInt(amountWei));
  assert.equal((await runway.activate({ projectId: project.id, refillId: plan.id })).status, 'active');
  let calls = 0;
  const provider = { mode: 'zkapi', models: async () => [{ id: 'fixture/model', oa_request_limit_micro_usd: 500000 }], complete: async () => { assert.equal(phase, 'active'); calls++; return { answer: 'Fixture deliverable after fee-funded runway activation.', verification: 'fixture-not-live-inference' }; } };
  const kit = new Kit({ store: new Store(resolve(output, 'kit.json'), 'zkapi'), provider });
  const agent = kit.create({ requestKey: randomUUID(), name: 'Fee-funded fixture', symbol: 'FIX', purpose: 'Verify the connected funding flow.', template: 'research', swarm: false, model: 'fixture/model', total: 2000000, daily: 1000000, request: 500000 });
  const job = await kit.submit(agent.id, { requestKey: randomUUID(), prompt: 'Produce a fixture deliverable.' }); await kit.execution;
  assert.equal(job.status, 'completed'); assert.equal(calls, 1); assert.equal(agent.committed, 500000);
  const result = { checkedAt: new Date().toISOString(), passed: true, forkBlock: String(forkBlock), canonicalPoolManager: ETHEREUM_POOL_MANAGER, chainId: 1, externalBroadcasts: 0, realFundsSpent: 0, feeWei: String(revenue), treasuryShareWei: String(treasuryShare), creatorShareWei: String(creatorShare), protocolShareWei: String(platformShare), boundedRefillWei: amountWei, keeperTransactions: keeper.snapshot().entries.length, runnerFixtureCalls: calls, liveZkapiPaidCalls: 0, scope: 'real local-fork swaps, keeper, allocation, treasury payment; simulated zkAPI activation and model response' };
  writeFileSync(resolve(output, 'report.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} finally { child.kill(); }
