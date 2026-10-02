const TOKEN = '0x2eab833d244352d4a7f8dc93285b1776f01954cb';
const POSITION_MANAGER = '0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e';
const DEAD = '0x000000000000000000000000000000000000dead';
const ETH = 10n ** 18n;
const roleNames = { treasury: 'Operating treasury', creator: 'Creator', protocol: 'Platform' };
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const fail = () => { throw new Error('The Ethereum market snapshot could not be verified.'); };
const address = value => typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value) && !/^0x0{40}$/i.test(value) ? value : fail();
const uint = value => typeof value === 'string' && /^(0|[1-9]\d{0,77})$/.test(value) && BigInt(value) < 2n ** 256n ? value : fail();
function ethUnits(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,59})(\.\d{1,18})?$/.test(value)) fail();
  const [whole, fraction = ''] = value.split('.');
  const result = BigInt(whole) * ETH + BigInt(fraction.padEnd(18, '0'));
  if (result >= 2n ** 256n) fail();
  return result;
}
const decimal = units => `${units / ETH}${units % ETH ? '.' + String(units % ETH).padStart(18, '0').replace(/0+$/, '') : ''}`;
function amount(value) {
  const units = ethUnits(value), exact = decimal(units);
  const [whole, fraction = ''] = exact.split('.');
  const short = units > 0n && units < 10n ** 10n ? '<0.00000001' : whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction ? '.' + fraction.slice(0, 8).replace(/0+$/, '') : '');
  return `<span title="${esc(exact)} ETH">${esc(short.replace(/\.$/, ''))}</span>`;
}
const shortAddress = value => value.slice(0, 6) + '…' + value.slice(-4);
function explorer(value, label = shortAddress(value), type = 'address') {
  if (type === 'address') address(value); else if (!/^0x[\da-f]{64}$/i.test(value)) fail();
  return `<a href="https://etherscan.io/${type}/${value}" target="_blank" rel="noreferrer">${esc(label)} ↗</a>`;
}

/** Select public fields only. Backend errors and provider-supplied URLs never enter HTML. */
export function validateMarketSnapshot(input) {
  if (!input || input.chainId !== 1 || input.launched !== true || !same(input.token, TOKEN) || input.symbol !== 'VEYL' || input.quoteSymbol !== 'ETH' || typeof input.transactionsEnabled !== 'boolean') fail();
  const result = { chainId: 1, blockNumber: uint(input.blockNumber), token: address(input.token), transactionsEnabled: input.transactionsEnabled };
  for (const field of ['factory', 'hook', 'revenueRouter', 'treasury', 'swapRouter', 'creator', 'protocol']) result[field] = address(input[field]);
  if (typeof input.poolId !== 'string' || !/^0x[\da-f]{64}$/i.test(input.poolId)) fail();
  result.poolId = input.poolId;
  if (typeof input.checkedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(input.checkedAt) || !Number.isFinite(Date.parse(input.checkedAt))) fail();
  result.checkedAt = input.checkedAt;
  for (const field of ['pendingFeesEth', 'routerBalanceEth', 'treasuryBalanceEth']) { ethUnits(input[field]); result[field] = input[field]; }
  for (const [field, maximum] of [['buyFeeBps', 10000], ['sellFeeBps', 10000], ['lpFeePips', 1000000]]) {
    if (!Number.isInteger(input[field]) || input[field] < 0 || input[field] > maximum) fail();
    result[field] = input[field];
  }
  if (typeof input.collection?.automatic !== 'boolean' || !Array.isArray(input.claims) || input.claims.length < 1 || input.claims.length > 3) fail();
  result.automatic = input.collection.automatic;
  const seen = new Set(), seenRoles = new Set();
  result.claims = input.claims.map(claim => {
    const recipient = address(claim?.address); ethUnits(claim?.amountEth);
    if (seen.has(recipient.toLowerCase()) || !Array.isArray(claim.roles) || !claim.roles.length || claim.roles.length > 3) fail();
    seen.add(recipient.toLowerCase());
    const roles = claim.roles.map(role => {
      if (!Object.hasOwn(roleNames, role) || seenRoles.has(role) || !same(result[role], recipient)) fail();
      seenRoles.add(role); return role;
    });
    return { address: recipient, amountEth: claim.amountEth, roles };
  });
  if (seenRoles.size !== 3) fail();
  const claimUnits = result.claims.reduce((sum, claim) => sum + ethUnits(claim.amountEth), 0n);
  result.claimableEth = decimal(claimUnits);
  if (typeof input.priceQuote !== 'number' || !Number.isFinite(input.priceQuote) || input.priceQuote < 1e-80 || input.priceQuote > 1e30) fail();
  result.priceQuote = input.priceQuote;
  result.liquidity = uint(input.liquidity);
  if (!Number.isInteger(input.tick) || input.tick < -887272 || input.tick > 887272) fail();
  result.tick = input.tick;
  const p = input.position;
  if (!p || !same(p.positionManager, POSITION_MANAGER) || typeof p.burned !== 'boolean' || typeof p.sentToDead !== 'boolean') fail();
  result.position = { positionManager: address(p.positionManager), positionId: uint(p.positionId), seededTokens: uint(p.seededTokens), owner: p.owner === null ? null : address(p.owner), currentLiquidity: uint(p.currentLiquidity), burned: p.burned, sentToDead: p.sentToDead };
  if (result.position.positionId === '0' || p.burned !== (p.owner === null) || p.sentToDead !== same(p.owner, DEAD) || p.burned && p.currentLiquidity !== '0') fail();
  return result;
}

export function renderMarketSnapshot(snapshot, { busy = false, stale = false } = {}) {
  const market = validateMarketSnapshot(snapshot), p = market.position;
  const checked = new Date(market.checkedAt).toLocaleString('en-GB', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' });
  const price = market.priceQuote.toLocaleString('en-US', { maximumSignificantDigits: 7 });
  const fdv = (market.priceQuote * 1e9).toLocaleString('en-US', { maximumSignificantDigits: 7 });
  const contractRows = [['Token', market.token], ['Pool hook', market.hook], ['Trading router', market.swapRouter], ['Fee router', market.revenueRouter], ['Operating treasury', market.treasury], ['Factory', market.factory]];
  const nftLink = `<a href="https://etherscan.io/nft/${p.positionManager}/${p.positionId}" target="_blank" rel="noreferrer">#${p.positionId} ↗</a>`;
  return `<div class="market-status"><p>${stale ? 'Last successful read' : 'Ethereum snapshot'} · ${esc(checked)} UTC<br>Block ${esc(market.blockNumber)}</p><button class="market-refresh" type="button" data-market-refresh ${busy ? 'disabled' : ''}>${busy ? 'Refreshing…' : 'Refresh balances'}</button></div>
  <div class="market-stats"><article class="market-stat"><h2>Uncollected pool fees</h2><strong>${amount(market.pendingFeesEth)}<small>ETH</small></strong><p>Accrued in the hook. Collection moves these into the fee router.</p></article><article class="market-stat"><h2>Claimable fee shares</h2><strong>${amount(market.claimableEth)}<small>ETH</small></strong><p>Allocated to recipients and ready for delivery from the fee router.</p></article><article class="market-stat"><h2>Operating treasury</h2><strong>${amount(market.treasuryBalanceEth)}<small>ETH</small></strong><p>Current treasury balance, including top-ups and previous fee receipts.</p></article></div>
  <div class="market-body"><section class="market-section"><p class="section-number">WHERE COLLECTED FEES GO</p><h2>Every share, accounted for.</h2><div class="allocation-bar" role="img" aria-label="70 percent operating treasury, 20 percent creator, 10 percent platform"><i></i><i></i><i></i></div><dl class="allocation"><div><dd>70<span>%</span></dd><dt>Operating treasury</dt></div><div><dd>20<span>%</span></dd><dt>Creator</dt></div><div><dd>10<span>%</span></dd><dt>Platform</dt></div></dl><p>This VEYL/ETH pool collects fees in ETH. These percentages divide collected fees, separately from the trading fee rate.</p><div class="market-claims" aria-label="Claimable ETH by recipient">${market.claims.map(claim => `<div class="market-claim"><a href="https://etherscan.io/address/${claim.address}" target="_blank" rel="noreferrer"><strong>${esc(claim.roles.map(role => roleNames[role]).join(' + '))}</strong><small>${esc(shortAddress(claim.address))} ↗</small></a><span class="market-amount">${amount(claim.amountEth)} ETH</span></div>`).join('')}</div><p>${market.automatic ? 'Automatic collection is enabled. Delivery still depends on successful transactions.' : 'Automatic collection is off. Anyone can collect and deliver fees in the wallet workspace; recipients are fixed by the contracts.'}</p></section>
  <section class="market-section"><p class="section-number">THE POOL AT A GLANCE</p><h2>One platform. On Ethereum.</h2><dl class="market-facts"><div><dt>Spot price</dt><dd>≈ ${esc(price)} ETH / VEYL</dd></div><div><dt>Fully diluted value</dt><dd>≈ ${esc(fdv)} ETH</dd></div><div><dt>Trading fees</dt><dd>${market.buyFeeBps / 100}% buy · ${market.sellFeeBps / 100}% sell</dd></div><div><dt>Pool LP fee</dt><dd>${market.lpFeePips / 10000}%</dd></div><div><dt>Fee-router ETH held</dt><dd>${amount(market.routerBalanceEth)} ETH</dd></div><div><dt>Liquidity NFT</dt><dd>${nftLink}</dd></div><div><dt>Current NFT custody</dt><dd>${p.burned ? 'NFT burned' : p.sentToDead ? 'Dead address' : explorer(p.owner)}</dd></div></dl><p>The displayed spot price is not an executable quote. Fully diluted value uses the fixed 1 billion token supply. Router funds include the claimable shares shown here; do not add them together.</p><details><summary>Liquidity &amp; contract details</summary><dl class="market-facts"><div><dt>Position liquidity</dt><dd><code>${p.currentLiquidity}</code></dd></div><div><dt>Active pool liquidity</dt><dd><code>${market.liquidity}</code></dd></div><div><dt>Current tick</dt><dd>${market.tick}</dd></div>${contractRows.map(([label, value]) => `<div><dt>${label}</dt><dd>${explorer(value)}</dd></div>`).join('')}</dl><p class="market-contract">Pool ID: ${market.poolId}</p><p>${p.burned ? 'This liquidity NFT has been burned and holds no liquidity.' : p.sentToDead ? 'The current NFT owner is the dead address. Custody is read from Ethereum on each refresh.' : 'The liquidity NFT is transferable. Its current owner controls this position; it is not reported as permanently locked.'} Active pool liquidity is distinct from the liquidity held by this NFT.</p></details></section></div>
  <p class="market-trading-note">${market.transactionsEnabled ? 'Open the workspace to connect your wallet, request a quote and review each transaction. No agent creation is required.' : 'Live balances are available. Wallet transactions are currently disabled; the workspace shows the current readiness state.'}</p>`;
}

export function mountPublicMarket(element, { fetchImpl = globalThis.fetch, timeoutMs = 12000 } = {}) {
  let snapshot = null, busy = false, error = false, destroyed = false, revision = 0, controller;
  const draw = () => {
    if (destroyed) return;
    element.setAttribute('aria-busy', String(busy));
    const notice = error ? '<div class="market-notice error" role="alert">Market balances could not be refreshed. Try again shortly.' + (snapshot ? ' The last successful snapshot remains below.' : ' No live balances are being shown.') + '</div>' : '';
    element.innerHTML = notice + (snapshot ? renderMarketSnapshot(snapshot, { busy, stale: error }) : `<div class="market-notice" role="status"><p>${busy ? 'Reading Ethereum market…' : 'The market snapshot is temporarily unavailable.'}</p><button class="market-refresh" type="button" data-market-refresh ${busy ? 'disabled' : ''}>${busy ? 'Reading balances…' : 'Try again'}</button></div>`);
  };
  async function refresh() {
    if (destroyed) return;
    const current = ++revision; controller?.abort(); controller = new AbortController();
    const requestController = controller, timeout = setTimeout(() => requestController.abort(), timeoutMs);
    busy = true; draw();
    try {
      const response = await fetchImpl('/api/market', { method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' }, signal: requestController.signal });
      if (!response.ok) fail();
      const body = await response.text();
      if (body.length > 65536) fail();
      const data = JSON.parse(body); validateMarketSnapshot(data);
      if (destroyed || current !== revision) return;
      snapshot = data; error = false;
    } catch {
      if (!destroyed && current === revision) error = true;
    } finally {
      clearTimeout(timeout);
      if (!destroyed && current === revision) { busy = false; draw(); }
    }
  }
  function click(event) { if (event.target.closest?.('[data-market-refresh]') && !busy) { event.preventDefault(); void refresh(); } }
  element.addEventListener('click', click); void refresh();
  return { refresh, destroy() { destroyed = true; revision++; controller?.abort(); element.removeEventListener('click', click); } };
}

if (typeof document !== 'undefined') {
  const element = document.getElementById('market-live');
  if (element) mountPublicMarket(element);
}
