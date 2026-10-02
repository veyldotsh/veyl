import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, erc20Abi, keccak256, parseEther, zeroAddress, decodeFunctionData, parseAbi }  from 'viem';
import { MainnetMarkets, matchesRuntime, quotePriceX96, ETHEREUM_POOL_MANAGER } from '../src/mainnet.mjs';
import { WalletSession } from '../public/wallet.js';
import { VeylChainClient } from '../public/chain-client.js';
import { tokensPerEthToSqrtPrice } from '../public/mainnet-panel.js';

const address = n => `0x${String(n).repeat(40)}`, hash = n => `0x${String(n).repeat(64)}`;
const account = address(1), other = address(2), router = address(3), token = address(4);
const config = { addresses: { protocolRecipient: other }, trading: { buyFeeBps: 180, sellFeeBps: 180, tickSpacing: 200 } };
const goodInput = { account, treasuryOwner: account, operator: other, dailyLimitEth: '0.01', treasuryEth: '0.05', liquidityEth: '1', liquidityTokens: '100000000', sqrtPriceX96: ((1n << 96n) * 10000n).toString(), tickLower: -887200, tickUpper: 887200 };

test('runtime identity masks only declared immutable slots and rejects opcode changes', () => {
  const artifact = { deployedBytecode: { object: '0x600100006002', immutableReferences: { 1: [{ start: 2, length: 2 }] } } };
  assert.equal(matchesRuntime('0x6001ffff6002', artifact), true);
  assert.equal(matchesRuntime('0x6001ffff6003', artifact), false);
  assert.equal(matchesRuntime('0x6001ffff', artifact), false);
  assert.equal(matchesRuntime('0x6001ffff6002', { deployedBytecode: { ...artifact.deployedBytecode, immutableReferences: { 1: [{ start: 1, length: 99 }] } } }), false);
  const meta = digest => `a2646970667358221220${digest.repeat(64)}64736f6c634300081a0033`;
  const canonical = { deployedBytecode: { object: `0x6000fe${meta('a')}` } };
  assert.equal(matchesRuntime(`0x6000fe${meta('b')}`, canonical), true);
  assert.equal(matchesRuntime(`0x6001fe${meta('b')}`, canonical), false);
  assert.equal(matchesRuntime(`0x6000fe${meta('b').replace('081a', '081b')}`, canonical), false);
});

test('mainnet module rejects another chain and a changed pinned canonical PoolManager', async () => {
  const chain = new MainnetMarkets({ client: { getChainId: async () => 8453 }, config });
  await assert.rejects(chain.checkChain(), /chain ID 1/);
  const wrong = new MainnetMarkets({ client: { getChainId: async () => 1, getCode: async () => '0x6000' }, config: { ...config, deployments: { poolManagerCodeHash: hash(1) } } });
  await assert.rejects(wrong.checkChain(), /pinned/);
  const absent = new MainnetMarkets({ client: { getChainId: async () => 1, getCode: async () => undefined }, config });
  await assert.rejects(absent.checkChain(), /absent/);
  assert.throws(() => new MainnetMarkets({ origin: 'http://public-rpc.example', config }), /HTTPS/);
  assert.throws(() => new MainnetMarkets({ origin: 'https://user:pass@rpc.example', config }), /HTTPS/);
});

test('production seed terms never fall back to demonstration liquidity or allocation', () => {
  const service = new MainnetMarkets({ config, client: {} }), project = { id: 'user-id', name: 'Veyl', symbol: 'VEYL' };
  assert.throws(() => service.launchConfig(project, { account }, 1n), /treasury owner/);
  for (const mutation of [{ liquidityEth: undefined }, { liquidityTokens: '1000000001' }, { tickLower: -887201 }, { sqrtPriceX96: '1' }, { operator: address(0) }, { slippageBps: 501 }]) assert.throws(() => service.launchConfig(project, { ...goodInput, ...mutation }, 1n));
  const result = service.launchConfig(project, goodInput, 100n);
  assert.equal(result.config.buyFeeBps, 180); assert.equal(result.config.sellFeeBps, 180);
  assert.equal(result.config.maxQuote, parseEther('1')); assert.equal(result.config.maxToken, parseEther('100000000'));
  assert.equal(result.config.deadline, 1000n); assert.equal(result.config.lpFeePips, 0);
  assert.equal(result.config.launchProtection, false);
});

test('only the exact reviewed Veyl preset forces launch protection and never invents seed allocations', () => {
  const reviewed = { ...config, project: { name: 'Veyl', symbol: 'VEYL' }, trading: { ...config.trading, launchProtection: true } };
  const service = new MainnetMarkets({ config: reviewed, client: {} }), project = { id: 'main-veyl', name: 'Veyl', symbol: 'VEYL' };
  assert.equal(service.capabilities(project).launchProtection, true);
  assert.equal(service.capabilities({ name: 'My Veyl agent', symbol: 'VEYL2' }).launchProtection, false);
  assert.equal(service.capabilities({ name: 'Veyl agent', symbol: 'VEYL' }).launchProtection, false);
  assert.throws(() => service.launchConfig(project, goodInput, 1n), /980 million/);
  const compatible = { ...goodInput, liquidityTokens: '980000000' };
  assert.equal(service.launchConfig(project, compatible, 1n).config.launchProtection, true);
  assert.equal(service.launchConfig(project, compatible, 1n).config.maxToken, parseEther('980000000'));
  assert.throws(() => service.launchConfig(project, { ...compatible, launchProtection: false }, 1n), /policy/);
  for (const flag of [undefined, false]) {
    const bad = new MainnetMarkets({ config: { ...reviewed, trading: { ...reviewed.trading, launchProtection: flag } }, client: {} });
    assert.throws(() => bad.launchConfig(project, compatible, 1n), /requires/);
  }
});

test('protected launch rejects actual liquidity refunds that would leave the creator over 2%', async () => {
  const service = new MainnetMarkets({ config: { ...config, project: { name: 'Veyl', symbol: 'VEYL' }, trading: { ...config.trading, launchProtection: true } }, client: { getBlock: async () => ({ timestamp: 1n }) } });
  service.infrastructure = async () => ({ quoter: router, quoteAsset: zeroAddress });
  service.read = async (_a, _n, fn) => fn === 'predictLaunch' ? [hash(1), { token, quoteAsset: zeroAddress }, hash(2)] : [10n ** 20n, parseEther('1'), parseEther('979999999.999999999999999999')];
  const project = { id: 'main-veyl', name: 'Veyl', symbol: 'VEYL' }; let saved = 0;
  await assert.rejects(service.prepareLaunch(project, { ...goodInput, liquidityTokens: '1000000000' }, () => saved++), /Actual seeded liquidity/);
  assert.equal(saved, 0); assert.equal(project.mainnetPlan, undefined);
});

test('first-ten-block trade checks reject oversized transfers and accumulating a wallet over 2%', async () => {
  let active = true, balance = parseEther('19000000');
  const service = new MainnetMarkets({ config, client: { readContract: async () => balance } });
  service.read = async () => active;
  const market = { token, launchProtection: true };
  await service.checkLaunchTrade(market, account, 'buy', 1n, parseEther('1000000'));
  await assert.rejects(service.checkLaunchTrade(market, account, 'buy', 1n, parseEther('1000000.000000000000000001')), /wallet limit/);
  await assert.rejects(service.checkLaunchTrade(market, account, 'sell', parseEther('20000000.000000000000000001'), 1n), /each token transfer/);
  await service.checkLaunchTrade(market, account, 'sell', parseEther('20000000'), 1n);
  active = false; await service.checkLaunchTrade(market, account, 'buy', 1n, parseEther('50000000'));
});

test('factory preparation requires a confirmed chain-bound quoter before building the second deployment', async () => {
  const service = new MainnetMarkets({ config, client: { estimateGas: async () => 1000000n } });
  service.checkChain = async () => {}; service.identity = async () => {};
  service.artifact = name => ({ abi: [{ type: 'constructor', inputs: (name !== 'VeylMarketFactory' ? ['manager'] : ['manager', 'protocol', 'quoter', 'quoteAsset', 'conversion', 'projectBuilder', 'marketBuilder', 'liquidityBuilder']).map(name => ({ name, type: 'address' })), stateMutability: 'nonpayable' }], bytecode: { object: '0x6000' } });
  service.read = async () => ETHEREUM_POOL_MANAGER;
  const project = {}; const first = await service.prepareFactory(project, { account }, () => {});
  assert.equal(first.kind, 'quoter'); assert.equal(first.deploymentStep, 1);
  assert.equal((await service.prepareFactory(project, { account }, () => {})).id, first.id);
  first.status = 'confirmed'; project.mainnetInfrastructure = { quoter: router };
  for (const [index, field] of ['projectBuilder', 'marketBuilder', 'liquidityBuilder'].entries()) { const next = await service.prepareFactory(project, { account }, () => {}); assert.equal(next.deploymentStep, index + 2); next.status = 'confirmed'; project.mainnetInfrastructure[field] = address(index + 5); }
  const second = await service.prepareFactory(project, { account }, () => {});
  assert.equal(second.kind, 'factory'); assert.equal(second.quoter, router); assert.equal(second.deploymentStep, 5);
  second.status = 'failed'; service.read = async () => other;
  await assert.rejects(service.prepareFactory(project, { account }, () => {}), /another PoolManager/);
});

function swapFixture({ allowance = 0n, quoteAccount = account, expiry = 105000, clock = 100000, simulationExpires = false } = {}) {
  const calls = [], q = { id: 'quote-1', side: 'sell', account: quoteAccount, poolId: hash(5), amountIn: '1000', minOut: '900', priceLimit: '4295128740', expiresAt: expiry, expectedOutput: '0.000000000000001', minimumOutput: '0.0000000000000009' };
  let time = clock, saves = 0;
  const service = new MainnetMarkets({ config, now: () => time, client: {
    readContract: async r => { calls.push(r); return allowance; },
    getBlock: async () => ({ timestamp: 100n }),
    estimateGas: async () => { if (simulationExpires) time = expiry; return 90000n; }
  } });
  service.validateMarket = async () => ({ swapRouter: router, token, poolId: hash(5) });
  return { service, project: { mainnetQuotes: [q] }, q, calls, checkpoint: () => saves++, saves: () => saves };
}

test('mainnet sell prepares only an exact token approval then requires a fresh wallet action', async () => {
  const f = swapFixture();
  const intent = await f.service.prepareSwap(f.project, { account, quoteId: 'quote-1' }, f.checkpoint);
  assert.equal(intent.kind, 'approve'); assert.equal(intent.transaction.to, token);
  assert.equal(intent.transaction.value, '0x0'); assert.equal(intent.transaction.chainId, '0x1');
  assert.equal(intent.transaction.data, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [router, 1000n] }));
  assert.equal(f.q.intentId, undefined); assert.equal(f.saves(), 1);
  assert.equal(f.service.wallet, undefined);
});

test('mainnet quote account, expiry, and estimation expiry prevent swap preparation', async () => {
  for (const settings of [{ quoteAccount: other }, { clock: 105001 }, { allowance: 1000n, simulationExpires: true }]) {
    const f = swapFixture(settings);
    await assert.rejects(f.service.prepareSwap(f.project, { account, quoteId: 'quote-1' }, f.checkpoint), e => e.status === 409);
    assert.equal(f.q.intentId, undefined);
    assert.ok(!f.project.mainnetIntents || f.project.mainnetIntents.every(i => i.status === 'expired'));
  }
});

function verifyFixture({ mutation = {}, receiptMutation = {}, head = 11n, canonical = hash(8) } = {}) {
  const intent = { id: 'i', kind: 'approve', status: 'prepared', account, chainId: 1, transaction: { from: account, to: token, value: '0x0', data: '0xabcd' } };
  let saves = 0;
  const service = new MainnetMarkets({ config, client: {
    getChainId: async () => 1, getCode: async () => '0x6000',
    getTransaction: async () => ({ from: account, to: token, value: 0n, input: '0xabcd', chainId: 1, ...mutation }),
    getTransactionReceipt: async () => ({ transactionHash: hash(7), status: 'success', blockNumber: 10n, blockHash: hash(8), logs: [], ...receiptMutation }),
    getBlock: async () => ({ hash: canonical }), getBlockNumber: async () => head
  } });
  return { service, project: { mainnetIntents: [intent] }, intent, checkpoint: () => saves++, saves: () => saves };
}

test('receipt import binds exact calldata, sender, recipient, value, chain, and canonical block', async () => {
  for (const mutation of [{ from: other }, { to: router }, { input: '0xabce' }, { value: 1n }, { chainId: 8453 }]) {
    const f = verifyFixture({ mutation });
    await assert.rejects(f.service.verify(f.project, { intentId: 'i', transactionHash: hash(7) }, f.checkpoint), /exact recorded/);
    assert.equal(f.saves(), 0);
  }
  const forked = verifyFixture({ canonical: hash(9) });
  await assert.rejects(forked.service.verify(forked.project, { intentId: 'i', transactionHash: hash(7) }, forked.checkpoint), /canonical/);
  const mismatch = verifyFixture({ receiptMutation: { transactionHash: hash(9) } });
  await assert.rejects(mismatch.service.verify(mismatch.project, { intentId: 'i', transactionHash: hash(7) }, mismatch.checkpoint), /hash/);
});

test('receipt import waits for confirmations, rejects reverts, and does not trust wallet-reported success', async () => {
  const waiting = verifyFixture({ head: 10n });
  const pending = await waiting.service.verify(waiting.project, { intentId: 'i', transactionHash: hash(7) }, waiting.checkpoint);
  assert.equal(pending.status, 'submitted'); assert.equal(pending.awaitingConfirmations, true);
  const reverted = verifyFixture({ receiptMutation: { status: 'reverted' } });
  await assert.rejects(reverted.service.verify(reverted.project, { intentId: 'i', transactionHash: hash(7) }, reverted.checkpoint), /reverted/);
  assert.equal(reverted.intent.status, 'failed');
  const complete = verifyFixture();
  assert.equal((await complete.service.verify(complete.project, { intentId: 'i', transactionHash: hash(7) }, complete.checkpoint)).status, 'confirmed');
  await assert.rejects(complete.service.verify(complete.project, { intentId: 'i', transactionHash: hash(6) }, complete.checkpoint), /already/);
});

function walletFixture({ chain = '0x1', walletAccount = account } = {}) {
  const calls = [];
  const wallet = new WalletSession({ provider: { request: async request => {
    calls.push(request);
    if (request.method === 'eth_accounts' || request.method === 'eth_requestAccounts') return [walletAccount];
    if (request.method === 'eth_chainId') return chain;
    if (request.method === 'eth_sendTransaction') return hash(7);
  } }, storage: null });
  const intent = { id: 'i', kind: 'buy', chainId: 1, status: 'prepared', account, expiresAt: Date.now() + 10000,
    transaction: { from: account, to: router, data: '0xabcd', value: '0x1', chainId: '0x1', nonce: '0x12', method: 'arbitrary' } };
  return { wallet, calls, intent };
}

test('wallet writes remain disabled by default and chain/account changes cannot redirect a prepared action', async () => {
  const disabled = walletFixture(); await assert.rejects(disabled.wallet.send(disabled.intent), /disabled/); assert.equal(disabled.calls.length, 0);
  for (const settings of [{ chain: '0x2105' }, { walletAccount: other }]) {
    const f = walletFixture(settings); await assert.rejects(f.wallet.send(f.intent, { enabled: true }));
    assert.equal(f.calls.some(c => c.method === 'eth_sendTransaction'), false);
  }
  const good = walletFixture(); assert.equal(await good.wallet.send(good.intent, { enabled: true }), hash(7));
  const sent = good.calls.find(c => c.method === 'eth_sendTransaction').params[0];
  assert.equal(sent.nonce, undefined); assert.equal(sent.method, undefined); assert.equal(sent.to, router);
});

test('browser keeps submitted transaction hash when API receipt verification is unavailable', async () => {
  const f = walletFixture(), saved = new Map(), storage = { getItem: k => saved.get(k), setItem: (k, v) => saved.set(k, v) };
  const client = new VeylChainClient({ wallet: f.wallet, storage, transactionsEnabled: true, api: async () => { throw new Error('Still mining'); } });
  const result = await client.execute('project-a', f.intent);
  assert.equal(result.status, 'submitted'); assert.equal(result.receiptPending, true);
  assert.equal(client.pending()[0].transactionHash, hash(7));
  await assert.rejects(client.execute('project-a', f.intent), /already submitted/);
  assert.equal(f.calls.filter(c => c.method === 'eth_sendTransaction').length, 1);
});

test('mainnet public capabilities do not claim deployment or private inference', () => {
  const c = new MainnetMarkets({ config, client: {} }).capabilities();
  assert.equal(c.configured, false); assert.equal(c.broadcasting, false); assert.equal(c.poolManager, ETHEREUM_POOL_MANAGER);
  assert.equal(c.launchType, 'direct-uniswap-v4'); assert.equal(c.walletTransactions, 'unsigned');
});

test('launch price conversion uses exact integers and rejects missing or imprecise prices', () => {
  assert.equal(tokensPerEthToSqrtPrice('100000000'), ((1n << 96n) * 10000n).toString());
  assert.equal(tokensPerEthToSqrtPrice('1'), (1n << 96n).toString());
  for (const value of ['', '0', '1e8', '-1', '1.1234567890123456789']) assert.throws(() => tokensPerEthToSqrtPrice(value));
  const irrational = BigInt(tokensPerEthToSqrtPrice('2'));
  assert.ok(irrational * irrational <= 2n << 192n); assert.ok((irrational + 1n) ** 2n > 2n << 192n);
});

test('unknown wallet responses persist before submission and cannot replay after remount or under a new intent', async () => {
 const f=walletFixture(), data=new Map(), storage={getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v)};let sends=0;
 const original=f.wallet.provider.request;
 f.wallet.provider.request=async req=>{if(req.method==='eth_sendTransaction'){sends++;const rows=JSON.parse(storage.getItem('veyl:ethereum:pending:v1'));assert.equal(rows[0].status,'sending');assert.equal(rows[0].intentId,f.intent.id);throw Error('Wallet response lost');}return original(req);};
 const client=new VeylChainClient({wallet:f.wallet,storage,transactionsEnabled:true,api:async()=>{throw Error('unused');}});
 await assert.rejects(client.execute('p',f.intent),/lost/);assert.equal(client.pending()[0].transactionHash,undefined);
 const restored=new VeylChainClient({wallet:f.wallet,storage,transactionsEnabled:true,api:async()=>({id:f.intent.id,status:'confirmed',transactionHash:hash(7)})});
 await assert.rejects(restored.execute('p',f.intent),/already submitted/);await assert.rejects(restored.execute('p',{...f.intent,id:'another-intent'}),/unknown/);assert.equal(sends,1);
 await restored.recover({projectId:'p',intentId:f.intent.id,transactionHash:hash(7)});assert.equal(restored.pending().length,0);
});

test('explicit wallet rejection clears pre-send state but unavailable or corrupt storage never opens the wallet', async () => {
 const f=walletFixture(),data=new Map(),storage={getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v)},original=f.wallet.provider.request;let sends=0;
 f.wallet.provider.request=async req=>{if(req.method==='eth_sendTransaction'){sends++;throw Object.assign(Error('Rejected'),{code:4001});}return original(req);};
 const c=new VeylChainClient({wallet:f.wallet,storage,transactionsEnabled:true,api:async()=>{}});await assert.rejects(c.execute('p',f.intent),/Rejected/);assert.equal(c.pending().length,0);
 storage.setItem(c.pendingKey,'corrupt');await assert.rejects(c.execute('p',f.intent));assert.equal(sends,1);
 const unavailable=new VeylChainClient({wallet:f.wallet,storage:null,transactionsEnabled:true,api:async()=>{}});await assert.rejects(unavailable.execute('p',f.intent),/storage/);assert.equal(sends,1);
});

test('wallet accepts only named quoter/factory deployments and exact recovery cannot clear another action', async () => {
 const f=walletFixture();delete f.intent.transaction.to;f.intent.kind='quoter';assert.equal(await f.wallet.send(f.intent,{enabled:true}),hash(7));
 f.intent.kind='arbitrary';await assert.rejects(f.wallet.send(f.intent,{enabled:true}),/explicit quoter/);
 const data=new Map(),storage={getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v)};
 const c=new VeylChainClient({wallet:f.wallet,storage,transactionsEnabled:true,api:async()=>({id:'another',status:'confirmed',transactionHash:hash(7)})});c.savePending([{projectId:'p',intentId:'i',status:'sending',account}]);
 await assert.rejects(c.recover({projectId:'p',intentId:'i',transactionHash:hash(7)}),/does not match/);assert.equal(c.pending().length,1);
});

test('market identity binds immutable launch flag, activation and refund destination', async () => {
 const factory=address(5),vault=address(6),hook=address(7),revenue=address(8),quoter=address(9);
 for(const protectedLaunch of [false,true]) {
  const actual={creator:account,treasuryOwner:account,token,treasury:other,revenueRouter:revenue,hook,swapRouter:router,liquidityVault:vault,poolId:hash(5),quoteAsset:zeroAddress};
  const values={quoteAsset:zeroAddress,tokenIsCurrency0:false,launchProtectionEnabled:protectedLaunch,launchFactory:factory,poolManager:ETHEREUM_POOL_MANAGER,activated:protectedLaunch,launchBlock:protectedLaunch?100n:0n,bootstrapVault:protectedLaunch?vault:address(0),tokenRefundRecipient:protectedLaunch?factory:account};
  const service=new MainnetMarkets({config,client:{}});service.infrastructure=async()=>({factory,manager:ETHEREUM_POOL_MANAGER,protocol:other,quoter,quoteAsset:zeroAddress});service.identity=async()=>{};
  service.read=async(addr,name,fn)=>{if(fn==='getMarket')return actual;if(fn==='quoteAsset')return zeroAddress;if(fn==='tokenIsCurrency0')return false;if(fn==='hook')return hook;if(name==='RevenueRouter')return{treasury:other,creator:account,protocol:other}[fn];if(name==='VeylFeeHook')return{token,revenueRouter:revenue,poolManager:ETHEREUM_POOL_MANAGER}[fn];return values[fn];};
  const project={mainnet:{...actual,id:hash(1),factory},mainnetPlan:{config:{launchProtection:protectedLaunch}}};
  assert.equal((await service.validateMarket(project)).launchProtection,protectedLaunch);
  for(const [field,value] of [['launchProtectionEnabled',!protectedLaunch],['launchFactory',other],['poolManager',other],['activated',!protectedLaunch],['tokenRefundRecipient',other]]){const old=values[field];values[field]=value;await assert.rejects(service.validateMarket(project),/bootstrap relationships/);values[field]=old;}
  delete project.mainnetPlan.config.launchProtection;await assert.rejects(service.validateMarket(project),/policy is missing/);
 }
});

test('agent quote policy fails closed before VEYL is pinned and handles both sorted currency orders', async () => {
  const service = new MainnetMarkets({ client: {}, config: { ...config, project: { name: 'Veyl', symbol: 'VEYL' }, agentMarkets: {} } });
  assert.equal(service.capabilities({ name: 'Veyl', symbol: 'VEYL' }).quoteSymbol, 'ETH');
  assert.equal(service.capabilities({ name: 'Research', symbol: 'READ' }).quoteSymbol, 'VEYL');
  await assert.rejects(service.validateQuoteAsset({ name: 'Research', symbol: 'READ' }), /reviewed main VEYL/);
  assert.equal(quotePriceX96('100', false), (1n << 96n) * 10n);
  const inverse = quotePriceX96('100', true);
  assert.ok(inverse * inverse <= (1n << 192n) / 100n);
  assert.ok((inverse + 1n) ** 2n > (1n << 192n) / 100n);
});

test('VEYL buys approve the pinned quote token and send zero ETH with four exact buy arguments', async () => {
  const f = swapFixture(); f.q.side = 'buy'; f.q.quoteAsset = other;
  f.service.validateMarket = async () => ({ swapRouter: router, token, poolId: hash(5), quoteAsset: other, quoteKind: 'veyl', quoteSymbol: 'VEYL' });
  const approval = await f.service.prepareSwap(f.project, { account, quoteId: f.q.id }, f.checkpoint);
  assert.equal(approval.transaction.to, other); assert.equal(approval.approvalAssetSymbol, 'VEYL');
  assert.equal(approval.transaction.value, '0x0');
  f.service.client.readContract = async () => 1000n;
  f.service.artifact = () => ({ abi: parseAbi(['function buy(uint256 quoteAmountIn,uint256 minTokensOut,uint160 sqrtPriceLimitX96,uint256 deadline) payable returns(uint256)']) });
  const buy = await f.service.prepareSwap(f.project, { account, quoteId: f.q.id }, f.checkpoint);
  const decoded = decodeFunctionData({ abi: f.service.artifact().abi, data: buy.transaction.data });
  assert.deepEqual(decoded.args, [1000n, 900n, 4295128740n, 105n]); assert.equal(buy.transaction.value, '0x0');
});

test('conversion intents enforce enabled policy, owner caps, exact fill and floor before preparing a wallet request', async () => {
  const market = { quoteKind: 'veyl', quoteAsset: token, revenueRouter: router, treasury: other, quoter: address(5), conversionHook: address(6) };
  const current = { policy: { executor: account, enabled: true, maxQuotePerConversion: '10000000000000000000', maxQuotePerDay: '20000000000000000000', minEthPerVeylX18: '1000000000000000' }, pendingQuote: '10000000000000000000', spentToday: '0' };
  let output = parseEther('0.02'), fill = parseEther('10'), prepared = 0;
  const service = new MainnetMarkets({ config, client: { getBlock: async () => ({ timestamp: 1000n }), simulateContract: async () => ({ result: { amountIn: fill, amountOut: output } }) } });
  service.validateMarket = async () => market; service.conversionStatus = async () => current; service.read = async () => other;
  service.artifact = () => ({ abi: parseAbi(['function convertFees(uint256 amountIn,uint256 minEthOut,uint160 limit,uint256 deadline) returns(uint256)']) });
  service.makeIntent = async (_p, kind, _a, tx, meta) => { prepared++; return { kind, tx, ...meta }; };
  const input = { account, action: 'convert-fees', amount: '10', slippageBps: 50 };
  const result = await service.prepareMaintenance({}, input, () => {});
  assert.equal(result.kind, 'convert-fees'); assert.equal(result.destination, router);
  assert.equal(result.minimumOutputWei, parseEther('0.0199').toString()); assert.equal(prepared, 1);
  for (const mutate of [() => current.policy.enabled = false, () => current.policy.maxQuotePerConversion = '1', () => current.spentToday = parseEther('11').toString()]) {
    const saved = structuredClone(current); mutate(); await assert.rejects(service.prepareMaintenance({}, input, () => {}), /disabled or exceeds/); Object.assign(current, saved);
  }
  output = parseEther('0.009'); await assert.rejects(service.prepareMaintenance({}, input, () => {}), /below the owner floor/);
  output = parseEther('0.02'); fill--; await assert.rejects(service.prepareMaintenance({}, input, () => {}), /cannot fill/);
  await assert.rejects(service.prepareMaintenance({}, { ...input, account: address(9) }, () => {}), /owner or configured/);
  assert.equal(prepared, 1);
});
