import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateMarketSnapshot, renderMarketSnapshot, mountPublicMarket } from '../public/market.js';

const address = digit => '0x' + digit.repeat(40);
function snapshot() {
  return { chainId: 1, launched: true, name: 'Veyl', symbol: 'VEYL', quoteSymbol: 'ETH', blockNumber: '26125001', checkedAt: '2026-10-02T12:00:00.000Z', token: '0x2eaB833d244352D4A7f8dC93285B1776F01954cB', factory: address('1'), hook: address('2'), revenueRouter: address('3'), treasury: address('4'), swapRouter: address('5'), creator: address('6'), protocol: address('6'), poolId: '0x' + '7'.repeat(64), pendingFeesEth: '0.0123', routerBalanceEth: '0.1', treasuryBalanceEth: '0.001', claims: [{ address: address('4'), amountEth: '0.07', roles: ['treasury'] }, { address: address('6'), amountEth: '0.03', roles: ['creator', 'protocol'] }], buyFeeBps: 180, sellFeeBps: 180, lpFeePips: 0, collection: { automatic: false }, transactionsEnabled: true, liquidity: '43827373799693085948824', tick: 200311, priceQuote: 0.0000000020000402896, position: { positionManager: '0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e', positionId: '12345', seededTokens: '980000000000000000000012538', owner: address('6'), currentLiquidity: '43827373799693085948824', burned: false, sentToDead: false } };
}
class Element {
  innerHTML = ''; attributes = new Map(); handlers = new Map();
  setAttribute(name, value) { this.attributes.set(name, value); }
  addEventListener(name, callback) { this.handlers.set(name, callback); }
  removeEventListener(name, callback) { if (this.handlers.get(name) === callback) this.handlers.delete(name); }
}
const response = value => ({ ok: true, text: async () => JSON.stringify(value) });
const settle = () => new Promise(resolve => setImmediate(resolve));

test('market shows distinct live fee balances, merged beneficiary roles and current NFT custody', () => {
  const data = snapshot(), validated = validateMarketSnapshot(data), html = renderMarketSnapshot(data);
  assert.equal(validated.claimableEth, '0.1');
  assert.match(html, /Uncollected pool fees/); assert.match(html, /0\.0123/);
  assert.match(html, /Claimable fee shares/); assert.match(html, /0\.1/);
  assert.match(html, /Creator \+ Platform/); assert.match(html, /70 percent operating treasury, 20 percent creator, 10 percent platform/);
  assert.match(html, /Automatic collection is off/); assert.match(html, /do not add them together/);
  assert.match(html, /not reported as permanently locked/); assert.match(html, /1\.8% buy · 1\.8% sell/);
  assert.match(html, /No agent creation is required/);
  data.position.owner = '0x000000000000000000000000000000000000dEaD'; data.position.sentToDead = true;
  assert.match(renderMarketSnapshot(data), /current NFT owner is the dead address/);
  data.position.owner = null; data.position.sentToDead = false; data.position.burned = true; data.position.currentLiquidity = '0';
  assert.match(renderMarketSnapshot(data), /NFT burned/);
  data.transactionsEnabled = false;
  assert.match(renderMarketSnapshot(data), /Wallet transactions are currently disabled/);
});

test('tiny nonzero balances remain visible and exact wei sums do not become rounded zero', () => {
  const data = snapshot(); data.claims[0].amountEth = '0.000000000000000001'; data.claims[1].amountEth = '0.000000000000000002';
  assert.equal(validateMarketSnapshot(data).claimableEth, '0.000000000000000003');
  assert.match(renderMarketSnapshot(data), /title="0\.000000000000000003 ETH">&lt;0\.00000001/);
});

test('market rejects wrong identity, unsafe values, duplicate or misbound recipients and contradictory NFT states', () => {
  for (const edit of [
    data => data.token = address('a'), data => data.chainId = 8453,
    data => data.factory = 'javascript:alert(1)', data => data.poolId = '<img onerror=alert(1)>',
    data => data.pendingFeesEth = '-1', data => data.routerBalanceEth = 'Infinity',
    data => data.priceQuote = Infinity, data => data.claims[1].roles.push('treasury'),
    data => data.claims[0].address = address('a'), data => data.claims.push(data.claims[1]),
    data => data.position.sentToDead = true, data => data.position.burned = true,
    data => data.position.positionManager = address('a')
  ]) { const data = snapshot(); edit(data); assert.throws(() => validateMarketSnapshot(data)); }
  const data = snapshot(); data.name = '<script>alert(1)</script>'; data.explorerUrl = 'javascript:alert(1)'; data.error = 'private upstream failure';
  const html = renderMarketSnapshot(data);
  assert.doesNotMatch(html, /javascript:|<script>|private upstream/);
  for (const [, href] of html.matchAll(/href="([^"]+)"/g)) assert.match(href, /^https:\/\/etherscan\.io\/(?:address\/0x[\da-f]{40}|nft\/0x[\da-f]{40}\/[1-9]\d*)$/i);
});

test('page only fetches the fixed anonymous read endpoint; errors never replace stale balances with fabricated zeros', async t => {
  const element = new Element(), requests = []; let broken = false;
  const panel = mountPublicMarket(element, { fetchImpl: async (path, options) => { requests.push({ path, options }); if (broken) throw new Error('secret provider URL and credential'); return response(snapshot()); } });
  t.after(() => panel.destroy()); await settle();
  assert.equal(requests[0].path, '/api/market'); assert.equal(requests[0].options.method, 'GET'); assert.equal(requests[0].options.credentials, 'omit'); assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.body, undefined); assert.equal(requests[0].options.headers.Authorization, undefined);
  assert.match(element.innerHTML, /Ethereum snapshot/);
  broken = true; await panel.refresh();
  assert.match(element.innerHTML, /last successful snapshot remains below/); assert.match(element.innerHTML, /Last successful read/); assert.match(element.innerHTML, /0\.0123/);
  assert.doesNotMatch(element.innerHTML, /secret provider URL|credential/);
  assert.equal(element.attributes.get('aria-busy'), 'false');
});

test('initial HTTP failure has a safe retry state without fake balances or upstream error HTML', async t => {
  const element = new Element(); let readErrorBody = false;
  const panel = mountPublicMarket(element, { fetchImpl: async () => ({ ok: false, text: async () => { readErrorBody = true; return '<script>bad</script>'; } }) });
  t.after(() => panel.destroy()); await settle();
  assert.equal(readErrorBody, false); assert.match(element.innerHTML, /No live balances are being shown/); assert.match(element.innerHTML, /Try again/);
  assert.doesNotMatch(element.innerHTML, /market-stats|<script>/);
});

test('late responses cannot overwrite a fresh snapshot or mutate a destroyed view', async () => {
  const element = new Element(); let completeFirst, calls = 0;
  const first = new Promise(resolve => { completeFirst = resolve; });
  const panel = mountPublicMarket(element, { fetchImpl: async () => ++calls === 1 ? first : response({ ...snapshot(), blockNumber: '26125002' }) });
  await panel.refresh(); assert.match(element.innerHTML, /26125002/);
  completeFirst(response(snapshot())); await settle(); assert.match(element.innerHTML, /26125002/);
  panel.destroy(); const html = element.innerHTML; await panel.refresh(); assert.equal(element.innerHTML, html); assert.equal(element.handlers.size, 0);
});

test('an unavailable read aborts within its timeout and returns to an actionable retry state', async t => {
  const element = new Element(); let aborted = false;
  const panel = mountPublicMarket(element, { timeoutMs: 5, fetchImpl: (_path, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true })) });
  t.after(() => panel.destroy());
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(aborted, true); assert.equal(element.attributes.get('aria-busy'), 'false'); assert.match(element.innerHTML, /Try again/);
});

test('public market is discoverable across pages and opens the wallet workspace without an agent', () => {
  for (const name of ['site', 'docs', 'developers', 'brand']) assert.match(readFileSync(new URL(`../public/${name}.html`, import.meta.url), 'utf8'), /href="\/market"[^>]*>Market/);
  const html = readFileSync(new URL('../public/market.html', import.meta.url), 'utf8');
  assert.match(html, /href="\/app#view=platform&amp;tab=market">Trade &amp; collect fees/);
  assert.match(html, /type="module" src="\/market.js"/);
  const publicRecord = JSON.parse(readFileSync(new URL('../config/public-addresses.json', import.meta.url), 'utf8'));
  assert.equal(snapshot().token.toLowerCase(), publicRecord.token.address.toLowerCase());
});

test('the shared visual background is local, passive and motion-free on mobile or reduced-motion settings', () => {
  for (const name of ['site', 'docs', 'developers', 'brand', 'market', 'index']) {
    const html = readFileSync(new URL(`../public/${name}.html`, import.meta.url), 'utf8');
    assert.match(html, /<link rel="stylesheet" href="\/ambient.css">/);
  }
  const css = readFileSync(new URL('../public/ambient.css', import.meta.url), 'utf8'), svg = readFileSync(new URL('../public/ambient-fold.svg', import.meta.url), 'utf8');
  assert.match(css, /pointer-events:none/); assert.match(css, /z-index:-1/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)\{body::before\{animation:none;transform:none/);
  assert.match(css, /@media\(max-width:760px\)\{body::before\{[^}]*animation:none/);
  assert.doesNotMatch(css, /\b(?:filter|backdrop-filter|will-change):/);
  assert.doesNotMatch(svg, /<script|<foreignObject|<filter|href=|onload=/i);
  assert.ok(Buffer.byteLength(svg) < 4096);
});
