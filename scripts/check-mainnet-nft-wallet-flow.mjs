import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, http, parseEther, getAddress, erc721Abi } from 'viem';
import { mainnet } from 'viem/chains';
import { MainnetMarkets, ETHEREUM_POOL_MANAGER } from '../src/mainnet.mjs';

// A self-contained rehearsal, never a mainnet runner. This creates its own
// loopback Anvil fork and uses only that process's unlocked disposable accounts.
const port = 18562, origin = `http://127.0.0.1:${port}`;
const protectedLaunch = true;
if (process.argv.length > 2) throw new Error('This local NFT rehearsal takes no arguments.');
// Publicnode's unauthenticated endpoint restricts older archive blocks. Resolve
// a recent block once, then pin this entire rehearsal to that recorded block.
const forkBlock = Number(await createPublicClient({ transport: http('https://ethereum-rpc.publicnode.com', { retryCount: 0, fetchOptions: { redirect: 'error' } }) }).getBlockNumber());
const executable = process.platform === 'win32' ? resolve(process.env.USERPROFILE, '.foundry/bin/anvil.exe') : 'anvil';
const child = spawn(executable, ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '1', '--fork-url', 'https://ethereum-rpc.publicnode.com', '--fork-block-number', String(forkBlock), '--quiet'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
const client = createPublicClient({ chain: mainnet, transport: http(origin, { retryCount: 0, timeout: 120000 }) });
const wallet = createWalletClient({ chain: mainnet, transport: http(origin, { retryCount: 0, timeout: 120000 }) });
let exited = false, startupError = ''; child.on('exit', () => { exited = true; });
child.stderr.on('data', chunk => { startupError = (startupError + chunk.toString()).slice(-3000).replace(/0x[0-9a-f]{64}/gi, '[redacted hex]'); });
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (exited) throw new Error(`Dedicated Anvil fork exited before startup: ${startupError}`);
    try { if (/anvil/i.test(await client.request({ method: 'web3_clientVersion' }))) { ready = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  assert.ok(ready, 'dedicated local fork must start');
  assert.equal(new URL(origin).hostname, '127.0.0.1'); assert.equal(await client.getChainId(), 1);
  assert.equal(await client.getBlockNumber(), BigInt(forkBlock));
  const fresh = () => getAddress('0x' + randomBytes(20).toString('hex'));
  const account = fresh(), protocol = fresh(), trader = fresh();
  for (const address of [account, trader]) {
    await client.request({ method: 'anvil_impersonateAccount', params: [address] });
    await client.request({ method: 'anvil_setBalance', params: [address, '0x56bc75e2d63100000'] });
  }
  const config = JSON.parse(readFileSync(new URL('../config/mainnet.json', import.meta.url)));
  config.addresses.deployer = account; config.addresses.owner = account; config.addresses.protocolRecipient = protocol; config.mainTokenLaunch.recipient = account;
  const service = new MainnetMarkets({ origin, client, config });
  const project = { id: 'fork-main-nft-flow', name: 'Veyl', symbol: 'VEYL' };
  const output = resolve('output/mainnet-nft-wallet-fork'); mkdirSync(output, { recursive: true });
  const checkpoint = () => writeFileSync(resolve(output, 'project.json'), JSON.stringify(project, null, 2));
  const submitted = [];
  async function execute(intent) {
    assert.equal(intent.chainId, 1); assert.ok([account, trader].some(a => a.toLowerCase() === intent.transaction.from.toLowerCase()));
    assert.ok(/anvil/i.test(await client.request({ method: 'web3_clientVersion' })));
    const tx = intent.transaction;
    const transactionHash = await wallet.sendTransaction({ account: intent.transaction.from, ...(tx.to ? { to: tx.to } : {}), data: tx.data, value: BigInt(tx.value), ...(tx.gas ? { gas: BigInt(tx.gas) } : {}) });
    await client.waitForTransactionReceipt({ hash: transactionHash });
    await client.request({ method: 'anvil_mine', params: [1] });
    const result = await service.verify(project, { intentId: intent.id, transactionHash }, checkpoint);
    assert.equal(result.status, 'confirmed'); submitted.push({ kind: intent.kind, hash: transactionHash });
    return result;
  }
  console.log('Preparing and validating the factory on the dedicated Ethereum fork.');
  for (let step = 0; step < 5; step++) await execute(await service.prepareFactory(project, { account }, checkpoint));
  const launch = await service.prepareLaunch(project, { account, treasuryOwner: account, operator: account, dailyLimitEth: '0.01', treasuryEth: '0.05' }, checkpoint);
  assert.equal(launch.allocation.totalTokens, '1000000000'); assert.equal(launch.allocation.permanentlyLocked, false);
  assert.equal(launch.allocation.liquidityEth, '0'); assert.equal(launch.allocation.liquidityTokens, '980000000.000000000000012538');
  assert.equal(launch.allocation.creatorTokens, '19999999.999999999999987462');
  console.log('Launching the market with explicit rehearsal-only liquidity terms.');
  await execute(launch);
  let status = await service.status(project, account); assert.equal(status.launched, true); assert.equal(status.buyFeeBps, 180); assert.equal(status.treasuryBalance, '0.05');
  assert.equal(status.launchLimits.enabled, protectedLaunch);
  assert.equal(status.position.owner.toLowerCase(), account.toLowerCase()); assert.ok(BigInt(status.position.currentLiquidity) > 0n);
  if (protectedLaunch) {
    assert.equal(status.launchLimits.active, true);
    assert.ok(parseEther(launch.allocation.creatorTokens) <= parseEther('20000000'));
    await assert.rejects(service.quote(project, { account: trader, side: 'buy', amount: '0.3', slippageBps: 50 }, checkpoint), /each token transfer/);
  }
  const buy = await service.quote(project, { account: trader, side: 'buy', amount: '0.01', slippageBps: 50 }, checkpoint);
  await execute(await service.prepareSwap(project, { account: trader, quoteId: buy.id }, checkpoint));
  let sell = await service.quote(project, { account: trader, side: 'sell', amount: '10000', slippageBps: 50 }, checkpoint);
  const approval = await service.prepareSwap(project, { account: trader, quoteId: sell.id }, checkpoint); assert.equal(approval.kind, 'approve'); await execute(approval);
  sell = await service.quote(project, { account: trader, side: 'sell', amount: '10000', slippageBps: 50 }, checkpoint);
  await execute(await service.prepareSwap(project, { account: trader, quoteId: sell.id }, checkpoint));
  status = await service.status(project, account); const pendingFees = parseEther(status.pendingFees); assert.ok(pendingFees > 0n);
  await execute(await service.prepareMaintenance(project, { account, action: 'flush' }, checkpoint));
  status = await service.status(project, account); assert.equal(status.pendingFees, '0');
  const amountFor = a => parseEther(status.claims.find(c => c.address.toLowerCase() === a.toLowerCase()).amountEth);
  assert.equal(amountFor(project.mainnet.treasury), pendingFees * 7000n / 10000n);
  assert.equal(amountFor(account), pendingFees * 2000n / 10000n);
  assert.equal(amountFor(protocol), pendingFees - pendingFees * 7000n / 10000n - pendingFees * 2000n / 10000n);
  for (const beneficiary of [project.mainnet.treasury, account, protocol]) await execute(await service.prepareMaintenance(project, { account, action: 'distribute', beneficiary }, checkpoint));
  const after = await service.status(project, account);
  assert.equal(parseEther(after.treasuryBalance), parseEther('0.05') + pendingFees * 7000n / 10000n);
  assert.ok(after.claims.every(c => c.amountEth === '0')); assert.equal(after.trades.length, 2);
  await assert.rejects(service.prepareMaintenance(project, { account, action: 'distribute', beneficiary: account }, checkpoint));
  const nftHash = await wallet.writeContract({ account, address: after.position.positionManager, abi: erc721Abi, functionName: 'transferFrom', args: [account, '0x000000000000000000000000000000000000dEaD', BigInt(after.position.positionId)] });
  await client.waitForTransactionReceipt({ hash: nftHash });
  const moved = await service.status(project, account); assert.equal(moved.position.sentToDead, true); assert.equal(moved.position.currentLiquidity, after.position.currentLiquidity);
  const result = { checkedAt: new Date().toISOString(), mode: 'disposable-local-ethereum-fork', forkBlock, chainId: 1, canonicalPoolManager: ETHEREUM_POOL_MANAGER,
    externalBroadcasts: 0, realFundsSpent: 0, launchProtection: protectedLaunch, rehearsalAllocationsOnly: true, mainTokenAllocation: launch.allocation, position: moved.position, workflow: 'unsigned quoter and three helper deployments -> factory deployment -> market launch -> buy -> finite approval -> sell -> hook flush -> 70/20/10 claims -> owner NFT transfer to dead address',
    transactions: submitted, feeCollectedWei: pendingFees.toString(), treasuryWei: parseEther(after.treasuryBalance).toString(), receiptConfirmations: 2, passed: true };
  writeFileSync(resolve(output, 'report.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} finally { child.kill(); }
