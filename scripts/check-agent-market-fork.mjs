import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, http, parseEther, zeroAddress } from 'viem';
import { mainnet } from 'viem/chains';
import { MainnetMarkets, ETHEREUM_POOL_MANAGER } from '../src/mainnet.mjs';

// Never accepts a remote signer or transaction endpoint. Public RPC is read-only;
// every write below targets this newly spawned, disposable loopback Anvil.
if (process.argv.length > 2) throw Error('This isolated rehearsal accepts no arguments.');
const rpc = 'https://ethereum-rpc.publicnode.com', port = 18569, origin = `http://127.0.0.1:${port}`;
const forkBlock = Number(await createPublicClient({ transport: http(rpc, { retryCount: 0 }) }).getBlockNumber());
const binary = process.platform === 'win32' ? resolve(process.env.USERPROFILE, '.foundry/bin/anvil.exe') : 'anvil';
const child = spawn(binary, ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '1', '--fork-url', rpc, '--fork-block-number', String(forkBlock), '--quiet'], { windowsHide: true, stdio: 'ignore' });
const client = createPublicClient({ chain: mainnet, transport: http(origin, { retryCount: 0, timeout: 120000 }) });
const wallet = createWalletClient({ chain: mainnet, transport: http(origin, { retryCount: 0, timeout: 120000 }) });
const output = resolve('output/agent-veyl-wallet-fork'); mkdirSync(output, { recursive: true });
const projects = [], transactions = [];
const checkpoint = () => writeFileSync(resolve(output, 'projects.json'), JSON.stringify(projects, null, 2));
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw Error('Dedicated Anvil exited.');
    try { ready = /anvil/i.test(await client.request({ method: 'web3_clientVersion' })); if (ready) break; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  assert.ok(ready); await new Promise(r => setTimeout(r, 300)); assert.equal(child.exitCode, null);
  assert.equal(await client.getChainId(), 1); assert.equal(await client.getBlockNumber(), BigInt(forkBlock));
  const [account, protocol] = await wallet.getAddresses();
  const config = { project: { name: 'Veyl', symbol: 'VEYL' }, addresses: { protocolRecipient: protocol }, trading: { buyFeeBps: 180, sellFeeBps: 180, tickSpacing: 200, launchProtection: true } };
  async function execute(service, project, intent) {
    assert.equal(intent.chainId, 1); assert.equal(intent.account.toLowerCase(), account.toLowerCase());
    assert.ok(/anvil/i.test(await client.request({ method: 'web3_clientVersion' })));
    const tx = intent.transaction;
    const transactionHash = await wallet.sendTransaction({ account, ...(tx.to ? { to: tx.to } : {}), data: tx.data, value: BigInt(tx.value), ...(tx.gas ? { gas: BigInt(tx.gas) } : {}) });
    assert.equal((await client.waitForTransactionReceipt({ hash: transactionHash })).status, 'success');
    await client.request({ method: 'anvil_mine', params: [1] });
    const result = await service.verify(project, { intentId: intent.id, transactionHash }, checkpoint);
    assert.equal(result.status, 'confirmed'); transactions.push({ project: project.id, kind: intent.kind, hash: transactionHash }); return result;
  }
  async function infrastructure(service, project) {
    for (let i = 0; !service.capabilities(project).configured && i < 5; i++) await execute(service, project, await service.prepareFactory(project, { account }, checkpoint));
    assert.equal(service.capabilities(project).configured, true);
  }
  async function launch(service, project, terms) {
    const input = { account, treasuryOwner: account, operator: account, dailyLimitEth: '0.01', treasuryEth: '0.05', tickLower: -887200, tickUpper: 887200, slippageBps: 50, ...terms };
    let intent = await service.prepareLaunch(project, input, checkpoint);
    if (intent.kind === 'approve') { assert.equal(intent.approvalAssetSymbol, 'VEYL'); await execute(service, project, intent); intent = await service.prepareLaunch(project, input, checkpoint); }
    assert.equal(intent.kind, 'launch'); await execute(service, project, intent); return intent;
  }
  async function trade(service, project, side, amount) {
    let quote = await service.quote(project, { account, side, amount, slippageBps: 50 }, checkpoint);
    let intent = await service.prepareSwap(project, { account, quoteId: quote.id }, checkpoint);
    if (intent.kind === 'approve') { await execute(service, project, intent); quote = await service.quote(project, { account, side, amount, slippageBps: 50 }, checkpoint); intent = await service.prepareSwap(project, { account, quoteId: quote.id }, checkpoint); }
    await execute(service, project, intent); return quote;
  }
  const mainProject = { id: 'dual-main-veyl', name: 'Veyl', symbol: 'VEYL' }; projects.push(mainProject);
  const mainMarkets = new MainnetMarkets({ origin, client, config });
  console.log('Deploying and verifying native VEYL/ETH market on disposable Ethereum fork.');
  await infrastructure(mainMarkets, mainProject);
  await launch(mainMarkets, mainProject, { liquidityQuote: '11', liquidityTokens: '1000000000', tokensPerQuote: '100000000' });
  assert.equal(mainProject.mainnet.quoteAsset, zeroAddress);
  await client.request({ method: 'anvil_mine', params: [10] });
  await trade(mainMarkets, mainProject, 'buy', '0.03');
  const agentConfig = { ...config, agentMarkets: { mainMarketFactory: mainProject.mainnet.factory, quoteAsset: mainProject.mainnet.token, conversionSwapRouter: mainProject.mainnet.swapRouter, marketFactory: null } };
  const markets = new MainnetMarkets({ origin, client, config: agentConfig });
  const project = { id: 'dual-agent-veyl', name: 'Rehearsal agent', symbol: 'VAGENT' }; projects.push(project);
  console.log('Deploying agent/VEYL market with finite liquidity and trading approvals.');
  await infrastructure(markets, project);
  const launchIntent = await launch(markets, project, { liquidityQuote: '1000000', liquidityTokens: '100000000', tokensPerQuote: '100' });
  assert.equal(launchIntent.transaction.value, '0xb1a2bc2ec50000'); // treasury ETH only, never VEYL-denominated msg.value
  assert.equal(project.mainnet.quoteAsset.toLowerCase(), mainProject.mainnet.token.toLowerCase());
  await trade(markets, project, 'buy', '1000'); await trade(markets, project, 'sell', '1000');
  let status = await markets.status(project, account); assert.equal(status.quoteSymbol, 'VEYL'); assert.equal(status.trades.length, 2);
  const pending = parseEther(status.pendingFees); assert.ok(pending > 0n);
  await execute(markets, project, await markets.prepareMaintenance(project, { account, action: 'flush' }, checkpoint));
  status = await markets.status(project, account);
  assert.equal(BigInt(status.conversion.pendingQuote), pending); assert.ok(status.claims.every(c => c.amountEth === '0'));
  assert.equal(status.treasuryBalance, '0.05');
  console.log('Converting all collected VEYL fees and verifying exact 70/20/10 ETH payouts.');
  await execute(markets, project, await markets.prepareMaintenance(project, { account, action: 'configure-conversion', enabled: true, executor: account, maxVeylPerConversion: '1000', maxVeylPerDay: '1000', minEthPerVeyl: '0.0000000001' }, checkpoint));
  const conversion = await execute(markets, project, await markets.prepareMaintenance(project, { account, action: 'convert-fees', amount: status.conversion.pendingVeyl, slippageBps: 50 }, checkpoint));
  const ethReceived = parseEther(conversion.actualOutput); status = await markets.status(project, account);
  const claim = a => parseEther(status.claims.find(c => c.address.toLowerCase() === a.toLowerCase()).amountEth);
  assert.equal(status.conversion.pendingQuote, '0'); assert.equal(claim(project.mainnet.treasury), ethReceived * 7000n / 10000n);
  assert.equal(claim(account), ethReceived * 2000n / 10000n); assert.equal(claim(protocol), ethReceived - claim(account) - claim(project.mainnet.treasury));
  for (const beneficiary of [project.mainnet.treasury, account, protocol]) await execute(markets, project, await markets.prepareMaintenance(project, { account, action: 'distribute', beneficiary }, checkpoint));
  status = await markets.status(project, account); assert.ok(status.claims.every(c => c.amountEth === '0'));
  assert.equal(parseEther(status.treasuryBalance), parseEther('0.05') + ethReceived * 7000n / 10000n);
  assert.ok(parseEther((await mainMarkets.status(mainProject, account)).pendingFees) > 0n, 'conversion trades accrue native main-pool fees');
  const report = { checkedAt: new Date().toISOString(), passed: true, forkBlock, canonicalPoolManager: ETHEREUM_POOL_MANAGER, externalBroadcasts: 0, realFundsSpent: 0, paidInferenceCalls: 0, agentTokenIsCurrency0: launchIntent.tokenIsCurrency0, collectedVeylWei: pending.toString(), convertedEthWei: ethReceived.toString(), payouts: 'all fees convert first, then exact ETH 70/20/10', transactions };
  writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { child.kill(); }
