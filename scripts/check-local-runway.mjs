import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, encodeAbiParameters, getCreate2Address, http, keccak256, parseEther, stringToHex, toHex, zeroAddress } from 'viem';
import { mainnet } from 'viem/chains';
import { TreasuryRunway } from '../src/runway.mjs';

// A fresh disposable Anvil process uses chain ID 1 solely to exercise mainnet
// transaction preparation. This script never accepts a remote RPC or signer key.
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.env.VEYL_RUNWAY_TEST_PORT || 18547);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid disposable test port.');
const anvil = process.env.ANVIL_BINARY || (process.platform === 'win32' ? join(homedir(), '.foundry', 'bin', 'anvil.exe') : 'anvil');
const child = spawn(anvil, ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '1', '--silent'], { windowsHide: true, stdio: 'ignore' });
let spawnError; child.on('error', error => { spawnError = error; });
const transport = http(`http://127.0.0.1:${port}`, { retryCount: 0, fetchOptions: { redirect: 'error' } });
const client = createPublicClient({ chain: mainnet, transport }), wallet = createWalletClient({ chain: mainnet, transport });
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (spawnError || child.exitCode !== null) throw new Error('Disposable Anvil failed to start.');
    try { ready = (await client.request({ method: 'web3_clientVersion' })).toLowerCase().includes('anvil'); if (ready) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready || await client.getChainId() !== 1) throw new Error('Expected a fresh local Anvil with synthetic chain ID 1.');
  // A pre-existing listener must not be mistaken for the child just started.
  await new Promise(resolve => setTimeout(resolve, 300));
  if (child.exitCode !== null || spawnError) throw new Error('Test port is already occupied.');
  const [owner, platform] = await wallet.getAddresses();
  const artifact = name => JSON.parse(readFileSync(resolve(root, `contracts/out/${name === 'AgentTreasury' ? 'AgentKit' : name === 'RevenueRouter' ? 'Funding' : name}.sol/${name}.json`), 'utf8'));
  const receipt = async hash => { const result = await client.waitForTransactionReceipt({ hash }); assert.equal(result.status, 'success'); return result; };
  const deploy = async (name, args) => (await receipt(await wallet.deployContract({ account: owner, abi: artifact(name).abi, bytecode: artifact(name).bytecode.object, args }))).contractAddress;
  const read = (address, name, functionName, args = []) => client.readContract({ address, abi: artifact(name).abi, functionName, args });
  const write = async (address, name, functionName, args = [], value = 0n) => receipt(await wallet.writeContract({ account: owner, address, abi: artifact(name).abi, functionName, args, value }));
  const manager = await deploy('PoolManager', [owner]), deployedQuoter = await deploy('VeylQuoter', [manager]), projectBuilder = await deploy('VeylProjectBuilder', [manager]), marketBuilder = await deploy('VeylMarketBuilder', [manager]), liquidityBuilder = await deploy('VeylLiquidityBuilder', [manager]), factory = await deploy('VeylMarketFactory', [manager, platform, deployedQuoter, zeroAddress, zeroAddress, projectBuilder, marketBuilder, liquidityBuilder]);
  const config = { salt: keccak256(stringToHex('local-fee-funded-runway')), name: 'Fee runway fixture', symbol: 'FEERUN', treasuryOwner: owner, operator: owner, dailyLimit: parseEther('0.01'), treasuryEth: 0n,
    buyFeeBps: 180, sellFeeBps: 180, lpFeePips: 0, tickSpacing: 200, sqrtPriceX96: 10000n * (1n << 96n), tickLower: -887200, tickUpper: 887200, liquidity: 10n ** 22n,
    maxToken: parseEther('100000000'), maxQuote: parseEther('1'), minToken: parseEther('99000000'), minQuote: parseEther('0.99'), deadline: (await client.getBlock()).timestamp + 3600n, launchProtection: false };
  const [marketId, , hookHash] = await read(factory, 'VeylMarketFactory', 'predictLaunch', [owner, config, toHex(0n, { size: 32 })]);
  const deployer = await read(factory, 'VeylMarketFactory', 'marketDeployer'); let hookSalt;
  for (let i = 0; i < 1_000_000; i++) {
    const salt = toHex(BigInt(i), { size: 32 }), effective = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [marketId, salt]));
    if ((BigInt(getCreate2Address({ from: deployer, salt: effective, bytecodeHash: hookHash })) & 0x3fffn) === 0x20ccn) { hookSalt = salt; break; }
  }
  assert.ok(hookSalt, 'a valid hook address must be mined');
  await write(factory, 'VeylMarketFactory', 'launch', [config, hookSalt], config.maxQuote);
  const market = await read(factory, 'VeylMarketFactory', 'getMarket', [marketId]);
  const quoter = await read(factory, 'VeylMarketFactory', 'quoter');
  const treasury = market.treasury, fundingAddress = '0x0000000000000000000000000000000000001234';
  assert.equal(await client.getBalance({ address: treasury }), 0n, 'the operating treasury starts empty');
  const input = parseEther('0.1'), priceLimit = 4295128740n;
  const quote = (await client.simulateContract({ address: quoter, abi: artifact('VeylQuoter').abi, functionName: 'quoteExactInput', args: [market.hook, true, input, priceLimit] })).result;
  await write(market.swapRouter, 'VeylSwapRouter', 'buy', [input, quote.amountOut * 9950n / 10000n, priceLimit, (await client.getBlock()).timestamp + 120n], input);
  const fees = await read(market.hook, 'VeylFeeHook', 'pendingFees'); assert.equal(fees, input * 180n / 10000n);
  await write(market.hook, 'VeylFeeHook', 'flushFees');
  assert.equal(await read(market.revenueRouter, 'RevenueRouter', 'claimable', [treasury]), fees * 7000n / 10000n);
  assert.equal(await read(market.revenueRouter, 'RevenueRouter', 'claimable', [owner]), fees * 2000n / 10000n);
  assert.equal(await read(market.revenueRouter, 'RevenueRouter', 'claimable', [platform]), fees - fees * 7000n / 10000n - fees * 2000n / 10000n);
  for (const recipient of [treasury, owner, platform]) await write(market.revenueRouter, 'RevenueRouter', 'distribute', [recipient]);
  assert.equal(await client.getBalance({ address: treasury }), fees * 7000n / 10000n, 'the only treasury inflow is actual swap fees');
  const beforeTreasury = await client.getBalance({ address: treasury }), beforeFunding = await client.getBalance({ address: fundingAddress });
  const intents = [], calls = [], amountWei = '1120000000000000';
  const funding = {
    capabilities: () => ({ daemonOrigin: 'http://127.0.0.1:19999', approvalEnabled: true }),
    inspect: async () => ({ funding: { address: fundingAddress, phase: 'ready' } }),
    snapshot: () => ({ intents, operations: [] }),
    quote: async ({ idempotencyKey, amountGwei }) => { const q = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', idempotencyKey, address: fundingAddress, amountGwei, status: 'quoted', approvalAttempted: false, quote: { id: 'synthetic-deposit-quote', recommended_top_up_wei: amountWei, required_total_wei: '1012000000000000', balance_wei: '0' }, approvalDigest: 'synthetic-reviewed-digest' }; intents.push(q); return structuredClone(q); },
    refresh: async () => { calls.push('refresh'); intents[0].quote.balance_wei = String(await client.getBalance({ address: fundingAddress })); return structuredClone(intents[0]); },
    approve: async () => { calls.push('approve'); intents[0].status = 'active'; intents[0].approvalAttempted = true; return structuredClone(intents[0]); }
  };
  const signer = { account: { address: owner }, sendTransaction: request => wallet.sendTransaction({ ...request, account: owner }) };
  const file = join(mkdtempSync(join(tmpdir(), 'veyl-real-treasury-')), 'runway.json');
  const runway = new TreasuryRunway({ file, funding, client, signer, enableAutomatic: true, isIdle: () => true });
  await runway.configure({ projectId: 'local-real-treasury', treasury, owner, operator: owner, depositGwei: '1000000', lowWaterGwei: '1000', maxTopUpWei: amountWei, dailyTopUpWei: amountWei, automatic: true });
  const plan = await runway.prepare({ projectId: 'local-real-treasury', idempotencyKey: 'local-real-refill-1' });
  assert.equal(plan.calls.length, 2);
  await client.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ account: owner, to: treasury, data: plan.calls[0].data }) });
  const pending = await runway.execute({ projectId: 'local-real-treasury', refillId: plan.id });
  await client.waitForTransactionReceipt({ hash: pending.transactionHash });
  // Advance the disposable chain past Anvil's emulated finality horizon.
  await client.request({ method: 'anvil_mine', params: ['0x80', '0xc'] });
  await runway.confirm({ projectId: 'local-real-treasury', refillId: plan.id, transactionHash: pending.transactionHash });
  assert.equal(await client.getBalance({ address: fundingAddress }) - beforeFunding, BigInt(amountWei));
  assert.equal(beforeTreasury - await client.getBalance({ address: treasury }), BigInt(amountWei));
  const nonce = await client.getTransactionCount({ address: owner });
  await assert.rejects(runway.execute({ projectId: 'local-real-treasury', refillId: plan.id }), /cannot be replayed/);
  assert.equal(await client.getTransactionCount({ address: owner }), nonce);
  assert.equal((await runway.activate({ projectId: 'local-real-treasury', refillId: plan.id })).status, 'active');
  assert.deepEqual(calls, ['refresh', 'approve']);
  assert.ok(await client.getBalance({ address: treasury }) > 0n, 'bounded funding leaves surplus swap fees in the treasury');
  const repeated = new TreasuryRunway({ file, funding, client, signer, enableAutomatic: true, isIdle: () => true });
  await assert.rejects(repeated.prepare({ projectId: 'local-real-treasury', idempotencyKey: 'local-real-refill-2' }), /daily|budget|cap|active/i);
  assert.equal(await client.getTransactionCount({ address: owner }), nonce);
  console.log(JSON.stringify({ result: 'passed', environment: 'disposable local Anvil, synthetic chain ID 1', realContracts: ['PoolManager', 'VeylMarketFactory', 'VeylFeeHook', 'VeylSwapRouter', 'RevenueRouter', 'AgentTreasury'], mocked: ['zkAPI daemon funding response'], checks: ['actual 1.8% swap fee', '70/20/10 claims', 'empty treasury funded only by collected swap fees', 'owner recipient permission', 'operator exact bounded pay', 'real canonical Expense receipt', 'exact balance deltas and retained surplus', 'no duplicate transaction', 'deposit approval after confirmed transfer', 'restart retains daily refill cap'], collectedFeeWei: String(fees), treasuryShareWei: String(beforeTreasury), boundedRefillWei: amountWei, realNetworkTransactions: 0 }));
} finally { child.kill(); }
