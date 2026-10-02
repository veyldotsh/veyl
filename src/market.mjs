import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { encodeAbiParameters, erc20Abi, formatEther, getCreate2Address, keccak256, parseEther, parseEventLogs, stringToHex, toHex, zeroAddress } from 'viem';
import { Problem } from './agent.mjs';

const bigintFields = ['dailyLimit', 'treasuryEth', 'sqrtPriceX96', 'liquidity', 'maxToken', 'maxQuote', 'minToken', 'minQuote', 'deadline'];
const serial = value => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v));
const decodedConfig = config => ({ ...config, ...Object.fromEntries(bigintFields.map(k => [k, BigInt(config[k])])) });
const limits = { buy: 4295128740n, sell: 1461446703485210103287273052203988822378723970341n };
const empty = address => address === zeroAddress;

// The HTTP server exposes only this local rehearsal driver. It has no signer,
// provider override or broadcast path for a public chain.
export class LocalMarkets {
  constructor(chain, { now = () => Date.now() } = {}) { this.chain = chain; this.now = now; }
  artifact(name) { return JSON.parse(readFileSync(fileURLToPath(new URL(`../contracts/out/${name}.sol/${name}.json`, import.meta.url)), 'utf8')); }
  read(address, name, functionName, args = []) { return this.chain.client.readContract({ address, abi: this.artifact(name).abi, functionName, args }); }
  async deployContract(name, args) {
    const artifact = this.artifact(name);
    const hash = await this.chain.wallet.deployContract({ account: this.chain.account, abi: artifact.abi, bytecode: artifact.bytecode.object, args });
    const receipt = await this.receipt(hash);
    if (!receipt.contractAddress) throw new Problem('Local contract address was not returned.', 502);
    return receipt.contractAddress;
  }
  async receipt(hash) {
    const receipt = await this.chain.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Problem('Local chain transaction reverted. Inspect the recorded transaction before retrying.', 409);
    return receipt;
  }
  launch(project, checkpoint) { return this.chain.exclusive(async () => {
    await this.chain.check();
    if (project.chain?.hook) { await this.status(project); return project.chain; }
    if (project.chain) throw new Problem('This workspace has an earlier token. Create a new agent to launch a market without replacing its existing assets.', 409);
    if (!project.marketPlan) {
      project.marketPlan = { account: this.chain.account, platform: this.chain.platformAccount };
      checkpoint();
    }
    const plan = project.marketPlan;
    if (plan.account.toLowerCase() !== this.chain.account.toLowerCase() || plan.platform.toLowerCase() !== this.chain.platformAccount.toLowerCase()) throw new Problem('Development accounts changed. Restore the recorded local chain.', 409);
    for (const [field, name, args] of [['manager', 'PoolManager', [this.chain.account]], ['quoter', 'VeylQuoter', () => [plan.manager]], ['projectBuilder', 'VeylProjectBuilder', () => [plan.manager]], ['marketBuilder', 'VeylMarketBuilder', () => [plan.manager]], ['liquidityBuilder', 'VeylLiquidityBuilder', () => [plan.manager]], ['factory', 'VeylMarketFactory', () => [plan.manager, plan.platform, plan.quoter, zeroAddress, zeroAddress, plan.projectBuilder, plan.marketBuilder, plan.liquidityBuilder]]]) {
      if (plan[field] && !(await this.chain.client.getCode({ address: plan[field] }))) throw new Problem('Local chain was reset. Preserve this launch record and start a new workspace.', 409);
      if (!plan[field]) { plan[field] = await this.deployContract(name, typeof args === 'function' ? args() : args); checkpoint(); }
    }
    if (!plan.config) {
      // Explicit demonstration economics: 100M tokens + 1 development ETH in a
      // full-range position; remaining 900M tokens go to the local creator.
      plan.config = serial({ salt: keccak256(stringToHex(project.id)), name: project.name, symbol: project.symbol,
        treasuryOwner: plan.account, operator: plan.account, dailyLimit: parseEther('0.01'), treasuryEth: parseEther('0.05'),
        buyFeeBps: 300, sellFeeBps: 300, lpFeePips: 0, tickSpacing: 200, sqrtPriceX96: 10000n * (1n << 96n),
        tickLower: -887200, tickUpper: 887200, liquidity: 10n ** 22n,
        maxToken: parseEther('100000000'), maxQuote: parseEther('1'), minToken: parseEther('99000000'), minQuote: parseEther('0.99'), deadline: 0n, launchProtection: false });
      checkpoint();
    }
    let config = decodedConfig(plan.config);
    if (!plan.hookSalt) {
      const [id, , hash] = await this.read(plan.factory, 'VeylMarketFactory', 'predictLaunch', [plan.account, config, toHex(0n, { size: 32 })]);
      const deployer = await this.read(plan.factory, 'VeylMarketFactory', 'marketDeployer');
      for (let i = 0; i < 1_000_000; i++) {
        const salt = toHex(BigInt(i), { size: 32 });
        const effective = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [id, salt]));
        const candidate = getCreate2Address({ from: deployer, salt: effective, bytecodeHash: hash });
        if ((BigInt(candidate) & 0x3fffn) === 0x20ccn) { plan.id = id; plan.hookSalt = salt; break; }
        if (i % 1000 === 0) await new Promise(resolve => setImmediate(resolve));
      }
      if (!plan.hookSalt) throw new Problem('Hook address search exhausted. No market transaction was sent.', 409);
      checkpoint();
    }
    let market = await this.read(plan.factory, 'VeylMarketFactory', 'getMarket', [plan.id]);
    if (empty(market.token)) {
      if (plan.launchHash) await this.receipt(plan.launchHash);
      else {
        config.deadline = (await this.chain.client.getBlock()).timestamp + 900n;
        plan.config.deadline = config.deadline.toString(); checkpoint();
        const simulation = await this.chain.client.simulateContract({ account: plan.account, address: plan.factory, abi: this.artifact('VeylMarketFactory').abi, functionName: 'launch', args: [config, plan.hookSalt], value: config.treasuryEth + config.maxQuote });
        plan.launchHash = await this.chain.wallet.writeContract(simulation.request); checkpoint();
        await this.receipt(plan.launchHash);
      }
      market = await this.read(plan.factory, 'VeylMarketFactory', 'getMarket', [plan.id]);
    }
    if (empty(market.token)) throw new Problem('Recorded launch did not create a market.', 409);
    const quoter = await this.read(plan.factory, 'VeylMarketFactory', 'quoter');
    return serial({ ...market, owner: market.treasuryOwner, platform: plan.platform, manager: plan.manager, factory: plan.factory, quoter,
      hash: plan.launchHash, chainId: 31337, type: 'local-anvil', pool: 'uniswap-v4', supply: '1000000000', buyFeeBps: config.buyFeeBps, sellFeeBps: config.sellFeeBps, lpFeePips: config.lpFeePips });
  }); }
  async status(project) {
    const market = project.chain;
    if (!market?.hook) return { configured: false, legacy: Boolean(market) };
    await this.chain.check();
    if (!(await this.chain.client.getCode({ address: market.hook }))) throw new Problem('Local market is absent. Restore the recorded Anvil chain.', 409);
    const [[sqrtPriceX96, tick, liquidity], pendingFees, tokenBalance, ethBalance, lockedLiquidity] = await Promise.all([
      this.read(market.quoter, 'VeylQuoter', 'getPoolState', [market.hook]), this.read(market.hook, 'VeylFeeHook', 'pendingFees'),
      this.chain.client.readContract({ address: market.token, abi: erc20Abi, functionName: 'balanceOf', args: [this.chain.account] }),
      this.chain.client.getBalance({ address: this.chain.account }), this.read(market.liquidityVault, 'VeylLiquidityVault', 'lockedLiquidity')
    ]);
    return serial({ configured: true, account: this.chain.account, poolId: market.poolId, sqrtPriceX96, tick, liquidity, lockedLiquidity,
      tokenBalance: formatEther(tokenBalance), ethBalance: formatEther(ethBalance), pendingFees: formatEther(pendingFees), buyFeeBps: market.buyFeeBps, sellFeeBps: market.sellFeeBps, lpFeePips: market.lpFeePips,
      priceEth: 2 ** 192 / Number(sqrtPriceX96) ** 2, trades: (project.marketTrades || []).slice(-8).reverse() });
  }
  async quote(project, input, checkpoint) {
    await this.status(project);
    if (!project.chain?.hook) throw new Problem('Launch a market first.', 409);
    if (!['buy', 'sell'].includes(input.side) || typeof input.amount !== 'string' || !/^\d{1,12}(\.\d{1,18})?$/.test(input.amount)) throw new Problem('Choose buy or sell and a positive decimal amount.');
    const amount = parseEther(input.amount), slippage = input.slippageBps ?? 50;
    if (amount <= 0n || !Number.isSafeInteger(slippage) || slippage < 1 || slippage > 500) throw new Problem('Amount must be positive; slippage must be 0.01–5%.');
    const result = await this.chain.client.simulateContract({ address: project.chain.quoter, abi: this.artifact('VeylQuoter').abi, functionName: 'quoteExactInput', args: [project.chain.hook, input.side === 'buy', amount, limits[input.side]] });
    const q = result.result, minimum = q.amountOut * BigInt(10000 - slippage) / 10000n;
    if (q.amountIn !== amount || minimum <= 0n) throw new Problem('The pool cannot fill this input within the selected limits.', 409);
    const quote = serial({ id: randomUUID(), side: input.side, amountIn: amount, amountOut: q.amountOut, minOut: minimum, hookFee: q.hookFee, slippageBps: slippage,
      amount: input.amount, expectedOutput: formatEther(q.amountOut), minimumOutput: formatEther(minimum), feeEth: formatEther(q.hookFee), priceLimit: limits[input.side],
      account: this.chain.account, poolId: project.chain.poolId, createdAt: this.now(), expiresAt: this.now() + 120000, status: 'quoted' });
    // Retain submitted quotes as a durable no-retry ledger across restarts.
    project.marketQuotes = [...(project.marketQuotes || []).filter(q => q.status !== 'quoted' || q.expiresAt > this.now()), quote];
    checkpoint(); return quote;
  }
  swap(project, input, checkpoint) { return this.chain.exclusive(async () => {
    await this.status(project);
    const quote = project.marketQuotes?.find(q => q.id === input.quoteId);
    if (!quote || quote.poolId !== project.chain.poolId || quote.account.toLowerCase() !== this.chain.account.toLowerCase()) throw new Problem('Unknown quote.', 409);
    if (quote.status === 'completed') return quote;
    if (quote.status === 'submitted' || quote.hash) {
      if (!quote.hash) throw new Problem('Submission outcome is uncertain. Inspect the local chain; do not repeat this quote.', 409);
      return this.finishSwap(project, quote, checkpoint);
    }
    if (quote.expiresAt <= this.now()) throw new Problem('Quote expired. Request a fresh quote.', 409);
    const amount = BigInt(quote.amountIn), minOut = BigInt(quote.minOut), priceLimit = BigInt(quote.priceLimit);
    if (quote.side === 'sell') {
      const hash = await this.chain.wallet.writeContract({ account: this.chain.account, address: project.chain.token, abi: erc20Abi, functionName: 'approve', args: [project.chain.swapRouter, amount] });
      await this.receipt(hash);
    }
    const block = await this.chain.client.getBlock();
    const remaining = Math.floor((quote.expiresAt - this.now()) / 1000);
    if (remaining < 1) throw new Problem('Quote expired during preparation. Request a fresh quote.', 409);
    const deadline = block.timestamp + BigInt(remaining);
    const request = { account: this.chain.account, address: project.chain.swapRouter, abi: this.artifact('VeylSwapRouter').abi,
      functionName: quote.side, args: [amount, minOut, priceLimit, deadline], value: quote.side === 'buy' ? amount : 0n };
    const simulation = await this.chain.client.simulateContract(request);
    if (quote.expiresAt <= this.now()) throw new Problem('Quote expired during simulation. Request a fresh quote.', 409);
    quote.status = 'submitted'; checkpoint();
    quote.hash = await this.chain.wallet.writeContract(simulation.request); checkpoint();
    return this.finishSwap(project, quote, checkpoint);
  }); }
  async finishSwap(project, quote, checkpoint) {
    const receipt = await this.receipt(quote.hash);
    const event = parseEventLogs({ abi: this.artifact('VeylSwapRouter').abi, logs: receipt.logs.filter(l => l.address.toLowerCase() === project.chain.swapRouter.toLowerCase()), eventName: 'Swapped' })[0];
    if (!event || event.args.caller.toLowerCase() !== quote.account.toLowerCase() || event.args.isBuy !== (quote.side === 'buy') || event.args.amountIn > BigInt(quote.amountIn) || (quote.side === 'buy' && event.args.amountIn !== BigInt(quote.amountIn)) || event.args.amountOut < BigInt(quote.minOut)) throw new Problem('Trade receipt could not be reconciled.', 409);
    quote.status = 'completed'; quote.actualInput = formatEther(event.args.amountIn); quote.actualOutput = formatEther(event.args.amountOut);
    project.marketTrades ||= [];
    if (!project.marketTrades.some(t => t.hash === quote.hash)) project.marketTrades.push({ hash: quote.hash, side: quote.side, amountIn: quote.actualInput, amountOut: quote.actualOutput, at: new Date(this.now()).toISOString() });
    checkpoint(); return quote;
  }
  async harvest(project) {
    const flushed = await this.chain.exclusive(async () => {
      await this.status(project);
      if (!project.chain?.hook) throw new Problem('Launch a market first.', 409);
      const pending = await this.read(project.chain.hook, 'VeylFeeHook', 'pendingFees');
      if (pending === 0n) return { hash: null, amount: '0' };
      const hash = await this.chain.wallet.writeContract({ account: this.chain.account, address: project.chain.hook, abi: this.artifact('VeylFeeHook').abi, functionName: 'flushFees' });
      await this.receipt(hash); return { hash, amount: formatEther(pending) };
    });
    return { ...flushed, distribution: await this.chain.distributeRevenue(project) };
  }
}
