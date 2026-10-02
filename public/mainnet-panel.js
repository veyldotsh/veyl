import { VeylChainClient } from './chain-client.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = value => value ? `${value.slice(0, 8)}…${value.slice(-6)}` : '-';
const amount = value => Number(value || 0).toLocaleString('en-US', { maximumSignificantDigits: 8 });
const exactEth = value => { const wei = BigInt(value), fraction = (wei % (10n ** 18n)).toString().padStart(18, '0').replace(/0+$/, ''); return `${wei / (10n ** 18n)}${fraction ? '.' + fraction : ''}`; };
const integerSqrt = n => { if (n < 2n) return n; let a = n, b = (a + 1n) / 2n; while (b < a) { a = b; b = (a + n / a) / 2n; } return a; };

/** Exact integer conversion, avoiding floating-point launch-price rounding. */
export function tokensPerEthToSqrtPrice(value) {
  if (typeof value !== 'string' || !/^\d{1,18}(\.\d{1,18})?$/.test(value)) throw new Error('Enter a positive tokens-per-ETH price with at most 18 decimals.');
  const [whole, decimals = ''] = value.split('.'), units = BigInt(whole + decimals.padEnd(18, '0'));
  if (!units) throw new Error('Starting price must be positive.');
  return integerSqrt((units << 192n) / (10n ** 18n)).toString();
}

/** Mount into a single Market tab. The app owns auth and project selection.
 * Returns {refresh,destroy,client}; root must destroy before replacing the tab. */
export function mountMainnetPanel(element, { project, api, client = new VeylChainClient({ api }), capabilities = {}, notify = () => {}, onChange = () => {} } = {}) {
  let live = true, state = null, policy = capabilities, intent = null, quote = null, error = '', busy = false, launchOpen = false;
  let launchTerms = {};
  const quoteSymbol = () => state?.quoteSymbol || policy.quoteSymbol || 'ETH';
  let trade = { side: 'buy', amount: '', slippageBps: 50 };
  client.transactionsEnabled = capabilities.transactionsEnabled === true;
  const stateChanged = () => { if (live) render(); };
  client.addEventListener('change', stateChanged);
  const addressLink = value => value ? `<a class="text-link" href="https://etherscan.io/address/${esc(value)}" target="_blank" rel="noopener noreferrer">${esc(short(value))} ↗</a>` : '-';
  const row = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
  const button = (task, text, disabled = false, secondary = false, extra = '') => `<button class="button${secondary ? ' secondary' : ''}" data-mainnet="${task}" ${disabled || busy ? 'disabled' : ''} ${extra}>${text}</button>`;
  const field = (label, name, placeholder = '', type = 'text', value = '') => `<label>${label}<input name="${name}" type="${type}" placeholder="${placeholder}" value="${esc(launchTerms[name] ?? value)}" required ${type === 'number' ? 'step="1"' : ''}></label>`;
  function walletBar() {
    const w = client.wallet.state();
    return `<div class="section-title"><div><h2>Ethereum market</h2><p>${w.connected ? `${esc(short(w.account))} · ${w.ethereum ? 'Ethereum mainnet' : 'Switch to Ethereum'}` : 'Connect your wallet to prepare an Ethereum action.'}</p></div><div class="fee-actions">${w.connected ? `${!w.ethereum ? button('switch', 'Switch network', false, true) : ''}${button('refresh', 'Refresh', false, true)}` : button('connect', 'Connect wallet', false, true)}</div></div>`;
  }
  function launchForm() {
    const wallet = client.wallet.account || '', space = policy.tickSpacing || 200, lower = -Math.floor(887272 / space) * space, upper = -lower;
    return `<form data-mainnet-form="launch"><p class="hint">Choose every funding amount. The initial liquidity and its LP fees stay permanently locked; the remaining supply goes to your connected creator wallet.</p><div class="form-row">${field(`${quoteSymbol()} for liquidity`, 'liquidityQuote', `Amount in ${quoteSymbol()}`)}${field('Tokens for liquidity', 'liquidityTokens', 'Up to 1,000,000,000')}</div><div class="form-row">${field(`Starting tokens per ${quoteSymbol()}`, 'tokensPerQuote', 'Explicit starting price')}${field('Initial agent treasury · ETH', 'treasuryEth', '0 is allowed')}</div><div class="form-row">${field('Treasury owner', 'treasuryOwner', 'Public 0x address', 'text', wallet)}${field('Runtime operator', 'operator', 'Public 0x address')}</div><div class="form-row">${field('Daily treasury limit · ETH', 'dailyLimitEth', '0 disables operator spending')}${field('Seed tolerance · basis points', 'slippageBps', '50 = 0.5%', 'number', '50')}</div><details><summary>Liquidity range · full range by default</summary><div class="form-row">${field('Lower tick', 'tickLower', '', 'number', lower)}${field('Upper tick', 'tickUpper', '', 'number', upper)}</div><p class="hint">Ticks must align to ${space}. The chosen starting price must put both assets in the position.</p></details>${policy.launchProtection ? '<p class="hint">Launch protection: maximum 20 million tokens per transfer and per wallet for blocks B through B+9. Standard Uniswap v4 routing remains open. Caps apply to ERC-20 transfers and balances, not claims or wrapped exposure. The creator has no exemption, so at least 980 million tokens must actually enter locked liquidity. Choose and approve compatible seed amounts, price and range; no allocation is selected for you.</p>' : ''}<p class="hint">Fixed supply: 1 billion ${esc(project.symbol)}. Buy / sell fee: ${Number(policy.feeBps?.buy ?? 180) / 100}% / ${Number(policy.feeBps?.sell ?? 180) / 100}%. ETH payouts: 70% agent / 20% creator / 10% platform.${quoteSymbol() === 'VEYL' ? ' All collected VEYL fees convert to ETH first under the owner’s limits.' : ''}</p><button class="button" ${busy || !client.wallet.state().ethereum ? 'disabled' : ''}>Preview exact launch</button></form>`;
  }
  function launchState() {
    const configured = state?.configured || policy.configured;
    return `<section class="panel">${walletBar()}<div class="empty"><b>${configured ? 'Create this agent’s market.' : 'Veyl’s Ethereum contracts are not deployed.'}</b><p>${configured ? 'Preview the seed, token allocation and contract addresses before the wallet asks you to sign.' : (policy.quoteKind === 'veyl' ? 'Agent markets require the reviewed VEYL/ETH market and pinned VEYL address first.' : 'The deployment bundle is ready to simulate and review. No contract address is presented as live.')}</p>${configured ? button('open-launch', launchOpen ? 'Hide launch terms' : 'Set launch terms', !client.wallet.state().ethereum, true) : button('factory', `Prepare infrastructure · step ${policy.infrastructureStep || 1} of 5`, !client.wallet.state().ethereum, true)}</div>${launchOpen && configured ? launchForm() : ''}</section>`;
  }
  function tradePanel() {
    return `<section class="panel trade-panel"><div class="section-title"><div><h2>Trade ${esc(project.symbol)}</h2><p>Quoted against the actual Ethereum pool.</p>${state.launchLimits?.enabled ? `<p class="hint">${state.launchLimits.active ? 'Launch limits active: 20 million tokens per ERC-20 transfer and wallet. Standard v4 routing remains open.' : 'The ten-block launch limit has ended.'} Limits end at block ${esc(state.launchLimits.endsAtBlock)}. Contract checks apply when mined.</p>` : ''}</div><span class="badge">ETHEREUM</span></div><form data-mainnet-form="quote"><div class="form-row"><label>Side<select name="side"><option value="buy" ${trade.side === 'buy' ? 'selected' : ''}>Buy ${esc(project.symbol)}</option><option value="sell" ${trade.side === 'sell' ? 'selected' : ''}>Sell ${esc(project.symbol)}</option></select></label><label>Amount in<input name="amount" inputmode="decimal" placeholder="${trade.side === 'buy' ? esc(quoteSymbol()) : esc(project.symbol)}" value="${esc(trade.amount)}" required></label></div><label>Slippage tolerance<select name="slippageBps"><option value="50">0.5%</option><option value="100">1%</option><option value="200">2%</option></select></label><button class="button" ${busy || !client.wallet.state().ethereum ? 'disabled' : ''}>Get live quote</button></form>${quote ? `<div class="quote-card"><span class="label">Estimated received</span><strong>${amount(quote.expectedOutput)} ${quote.side === 'buy' ? esc(project.symbol) : esc(quoteSymbol())}</strong><dl>${row('Minimum after fees', `${amount(quote.minimumOutput)} ${quote.side === 'buy' ? esc(project.symbol) : esc(quoteSymbol())}`)}${row('Hook fee', `${amount(quote.feeQuote ?? quote.feeEth)} ${esc(quoteSymbol())}`)}${row('Valid until', esc(new Date(quote.expiresAt).toLocaleTimeString()))}</dl>${button('prepare-swap', quote.side === 'sell' ? 'Review approval / sale' : quoteSymbol() === 'VEYL' ? 'Review approval / purchase' : 'Review purchase', quote.expiresAt <= Date.now())}</div>` : ''}</section>`;
  }
  function poolPanel() {
    const market = state.market;
    return `<section class="panel">${walletBar()}<dl class="market-metrics">${row('Your ETH', `${amount(state.ethBalance)} ETH`)}${row(`Your ${esc(project.symbol)}`, amount(state.tokenBalance))}${quoteSymbol() === 'VEYL' ? row('Your VEYL', amount(state.quoteBalance)) : ''}${row('Buy / sell fee', `${Number(state.buyFeeBps) / 100}% / ${Number(state.sellFeeBps) / 100}%`)}${row('Agent treasury', `${amount(state.treasuryBalance)} ETH`)}${row('Pending hook fees', `${amount(state.pendingFees)} ${esc(quoteSymbol())}`)}${row('Liquidity custody', 'Permanently locked')}</dl><div class="fee-actions">${button('flush', 'Collect pool fees', !Number(state.pendingFees), true)}${button('show-fund', 'Top up treasury', false, true)}</div><form data-mainnet-form="fund" hidden><div class="form-row">${field('Treasury deposit · ETH', 'amount', 'Amount in ETH')}<button class="button secondary">Review deposit</button></div></form><details><summary>Fee shares & contract addresses</summary><dl class="market-metrics">${row('Token', addressLink(market.token))}${row('Treasury', addressLink(market.treasury))}${row('Hook', addressLink(market.hook))}${row('Liquidity vault', addressLink(market.liquidityVault))}${row('Swap router', addressLink(market.swapRouter))}</dl>${(state.claims || []).map(c => `<div class="trade-row"><span>${esc(short(c.address))}</span><span>${amount(c.amountEth)} ETH</span>${button('distribute', 'Deliver share', !Number(c.amountEth), true, `data-beneficiary="${esc(c.address)}"`)}</div>`).join('')}<p class="hint">Anyone can deliver a share. Each payment goes to its fixed recipient.</p></details>${conversionPanel()}${state.trades?.length ? `<details><summary>Recent confirmed trades</summary>${state.trades.slice(0, 5).map(t => `<div class="trade-row"><b>${esc(t.side)}</b><span>${amount(t.amountIn)} → ${amount(t.amountOut)}</span><a class="text-link" target="_blank" rel="noopener noreferrer" href="${client.explorer(t.hash)}">Receipt ↗</a></div>`).join('')}</details>` : ''}</section>`;
  }
  function conversionPanel() {
    const c = state?.conversion; if (!c) return '';
    const owner = client.wallet.account?.toLowerCase() === state.owner?.toLowerCase();
    return `<details><summary>VEYL fees to ETH · ${amount(c.pendingVeyl)} VEYL pending</summary><p class="hint">All collected VEYL fees convert through the verified VEYL/ETH pool. Actual ETH proceeds are credited 70% to the agent treasury, 20% to the creator and 10% to the platform. Deliver each ETH share above. Limits and the price floor can delay conversion; no payout is guaranteed.</p><dl class="market-metrics">${row('Conversion policy', c.policy.enabled ? 'Enabled' : 'Disabled')}${row('Converted today', amount(c.spentTodayVeyl) + ' VEYL')}${row('Daily maximum', exactEth(c.policy.maxQuotePerDay) + ' VEYL')}${row('Minimum ETH per VEYL', exactEth(c.policy.minEthPerVeylX18))}</dl><form data-mainnet-form="conversion"><div class="form-row">${field('VEYL amount', 'amount', 'Exact fee amount to convert')}${field('Slippage · basis points', 'slippageBps', '50 = 0.5%', 'number', '50')}</div><button class="button secondary" ${busy || !c.policy.enabled ? 'disabled' : ''}>Quote and review conversion</button></form>${owner ? `<details><summary>Owner conversion limits</summary><form data-mainnet-form="conversion-policy">${field('Executor', 'executor', 'Approved public operator address')}<div class="form-row">${field('Maximum VEYL per conversion', 'maxVeylPerConversion')}${field('Maximum VEYL per day', 'maxVeylPerDay')}</div>${field('Minimum ETH per VEYL', 'minEthPerVeyl', 'Your explicit price floor')}<button class="button secondary" ${busy ? 'disabled' : ''}>Review enabling policy</button></form>${button('disable-conversion', 'Review disabling conversion', !c.policy.enabled, true)}<p class="hint">The price floor is your limit, not an independent oracle. Automatic execution additionally requires an armed, capped server operator.</p></details>` : ''}</details>`;
  }

  function reviewPanel() {
    if (!intent) return '';
    const tx = intent.transaction, sendable = client.transactionsEnabled && policy.transactionsEnabled === true && intent.status === 'prepared' && intent.expiresAt > Date.now();
    const eth = exactEth(tx.value);
    return `<section class="panel quote-card" aria-live="polite"><div class="section-title"><div><h2>Review ${esc(intent.kind)}</h2><p>${intent.status === 'confirmed' ? 'Confirmed on Ethereum.' : 'Prepared transaction · your wallet is the signer.'}</p></div><span class="badge">${esc(intent.status)}</span></div><dl class="market-metrics">${row('From', addressLink(tx.from))}${row('To', tx.to ? addressLink(tx.to) : 'New verified infrastructure')}${row('ETH sent', `${eth} ETH`)}${row('Network', 'Ethereum · chain 1')}${intent.minimumOutput ? row('Minimum received', esc(intent.minimumOutput)) : ''}${intent.approvalAsset ? row('Exact allowance', `${exactEth(intent.amount)} ${esc(intent.approvalAssetSymbol)}`) + row('Approved spender', addressLink(intent.spender)) : ''}${intent.conversionPolicy ? row('Conversion policy', esc(JSON.stringify(intent.conversionPolicy))) : ''}${intent.kind === 'convert-fees' ? row('Payout split after conversion', '70% agent / 20% creator / 10% platform in ETH') : ''}${intent.deploymentStep ? row('Deployment step', `${intent.deploymentStep} of ${intent.deploymentSteps}`) : ''}${intent.launchProtection ? row('Launch limits', '2% per transfer / wallet · first 10 blocks') : ''}${intent.allocation ? row('Liquidity seed', `${esc(intent.allocation.liquidityQuote ?? intent.allocation.liquidityEth)} ${esc(intent.allocation.quoteSymbol || 'ETH')} + ${amount(intent.allocation.liquidityTokens)} ${esc(project.symbol)}`) + row('Creator allocation', `${amount(intent.allocation.creatorTokens)} ${esc(project.symbol)}`) + row('Agent treasury', `${esc(intent.allocation.treasuryEth)} ETH`) : ''}</dl>${intent.transactionHash ? `<p><a class="text-link" href="${client.explorer(intent.transactionHash)}" target="_blank" rel="noopener noreferrer">View transaction ↗</a></p>` : ''}<details><summary>Exact calldata & identity</summary><p class="address">Intent: ${esc(intent.id)}<br>Digest: ${esc(intent.digest)}</p><textarea readonly rows="4" aria-label="Unsigned transaction JSON">${esc(JSON.stringify(tx, null, 2))}</textarea></details><div class="fee-actions">${button('send', 'Review in wallet', !sendable)}${button('download', 'Download unsigned transaction', false, true)}</div>${!client.transactionsEnabled ? '<p class="hint">Mainnet signing is disabled for this release. You can inspect and download the exact transaction.</p>' : '<p class="hint">Your wallet calculates gas separately. Check the network, recipient and amount before confirming.</p>'}</section>`;
  }
  function recoverPanel() {
    let pending;
    try { pending = client.pending().filter(p => p.projectId === project.id); }
    catch (error) { return `<section class="panel"><p role="alert">${esc(error.message)}</p></section>`; }
    const serverRows = (state?.intents || []).filter(i => i.transactionHash && i.status === 'submitted' && !pending.some(p => p.intentId === i.id)).map(i => ({ projectId: project.id, intentId: i.id, transactionHash: i.transactionHash }));
    const rows = [...pending, ...serverRows];
    return `<details class="panel"><summary>Recover a wallet transaction${rows.length ? ` · ${rows.length} pending` : ''}</summary>${rows.map(p => p.transactionHash ? `<div class="trade-row"><a class="text-link" href="${client.explorer(p.transactionHash)}" target="_blank" rel="noopener noreferrer">${esc(short(p.transactionHash))} ↗</a>${button('recover', 'Check receipt', false, true, `data-intent="${esc(p.intentId)}" data-hash="${esc(p.transactionHash)}"`)}</div>` : `<p class="hint">Wallet outcome unknown for intent <code>${esc(p.intentId)}</code>. Inspect your wallet and import its exact transaction hash below. Sending again is blocked.</p>`).join('')}<form data-mainnet-form="recover"><div class="form-row">${field('Prepared intent ID', 'intentId')}${field('Transaction hash', 'transactionHash', '0x…')}</div><button class="button secondary">Verify & import receipt</button></form><p class="hint">Recovery checks the sender, destination, calldata, value and confirmed canonical receipt before importing the action.</p></details>`;
  }
  function render() {
    if (!live) return;
    element.innerHTML = `${error ? `<p class="storage-alert" role="alert">${esc(error)}</p>` : ''}${state?.launched ? `<div class="market-grid">${tradePanel()}${poolPanel()}</div>` : launchState()}${reviewPanel()}${recoverPanel()}`;
  }
  async function refresh() {
    try { [state, policy] = await Promise.all([client.status(project.id), client.capabilities(project.id)]); client.transactionsEnabled = capabilities.transactionsEnabled === true && policy.transactionsEnabled === true; error = ''; }
    catch (e) { error = e.message; } render(); return state;
  }
  async function act(fn) {
    if (busy) return; busy = true; error = ''; render();
    try { await fn(); } catch (e) { error = e.message; notify(e.message); } finally { busy = false; render(); }
  }
  const click = async event => {
    const target = event.target.closest('[data-mainnet]'); if (!target || !element.contains(target) || target.disabled) return;
    const task = target.dataset.mainnet;
    if (task === 'show-fund') { element.querySelector('[data-mainnet-form="fund"]').hidden = false; return; }
    await act(async () => {
      if (task === 'connect') { await client.wallet.connect(); await refresh(); }
      if (task === 'switch') { await client.wallet.switchEthereum(); await refresh(); }
      if (task === 'refresh') await refresh();
      if (task === 'open-launch') launchOpen = !launchOpen;
      if (task === 'factory') intent = await client.prepare(project.id, 'factory');
      if (task === 'prepare-swap') intent = await client.prepare(project.id, 'swap', { quoteId: quote.id });
      if (task === 'disable-conversion') intent = await client.prepare(project.id, 'maintenance', { action: 'configure-conversion', enabled: false });
      if (task === 'flush' || task === 'distribute') intent = await client.prepare(project.id, 'maintenance', { action: task, ...(target.dataset.beneficiary ? { beneficiary: target.dataset.beneficiary } : {}) });
      if (task === 'send') { const result = await client.execute(project.id, intent); intent = { ...intent, ...result }; notify(result.status === 'confirmed' ? 'Transaction confirmed.' : 'Transaction submitted. Its receipt is saved for recovery.'); await refresh(); onChange(); }
      if (task === 'recover') { const result = await client.recover({ projectId: project.id, intentId: target.dataset.intent, transactionHash: target.dataset.hash }); notify(result.status === 'confirmed' ? 'Transaction verified.' : 'Waiting for confirmation.'); await refresh(); onChange(); }
      if (task === 'download') { const blob = new Blob([JSON.stringify(intent, null, 2)], { type: 'application/json' }), url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = `veyl-${intent.kind}-${intent.id}.json`; anchor.click(); URL.revokeObjectURL(url); }
    });
  };
  const submit = async event => {
    const form = event.target.closest('[data-mainnet-form]'); if (!form || !element.contains(form)) return;
    event.preventDefault(); const values = Object.fromEntries(new FormData(form));
    await act(async () => {
      if (form.dataset.mainnetForm === 'launch') { launchTerms = values; intent = await client.prepare(project.id, 'launch', { ...values, tickLower: Number(values.tickLower), tickUpper: Number(values.tickUpper), slippageBps: Number(values.slippageBps) }); }
      if (form.dataset.mainnetForm === 'conversion-policy') intent = await client.prepare(project.id, 'maintenance', { ...values, action: 'configure-conversion', enabled: true });
      if (form.dataset.mainnetForm === 'conversion') intent = await client.prepare(project.id, 'maintenance', { ...values, action: 'convert-fees', slippageBps: Number(values.slippageBps) });
      if (form.dataset.mainnetForm === 'quote') { trade = { ...values, slippageBps: Number(values.slippageBps) }; quote = await client.prepare(project.id, 'quote', trade); intent = null; }
      if (form.dataset.mainnetForm === 'fund') intent = await client.prepare(project.id, 'maintenance', { action: 'fund', amount: values.amount });
      if (form.dataset.mainnetForm === 'recover') { const result = await client.recover({ projectId: project.id, ...values }); notify(result.status === 'confirmed' ? 'Transaction verified.' : 'Waiting for confirmation.'); await refresh(); onChange(); }
    });
  };
  element.addEventListener('click', click); element.addEventListener('submit', submit); render(); void refresh();
  return { client, refresh, destroy() { live = false; element.removeEventListener('click', click); element.removeEventListener('submit', submit); client.removeEventListener('change', stateChanged); } };
}
