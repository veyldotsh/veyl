import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { VeylChainClient } from '../public/chain-client.js';

test('a wallet with no agents can open the platform market without an owner project', () => {
  const elements = new Map(), mounted = [], history = [];
  const element = id => { if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', classList: { toggle() {} }, insertAdjacentHTML() {}, addEventListener() {} }); return elements.get(id); };
  const context = vm.createContext({
    document: { getElementById: element, querySelectorAll: () => [], addEventListener() {} },
    crypto: webcrypto, URLSearchParams, matchMedia: () => ({ matches: false }), setInterval() {}, setTimeout() {},
    history: { replaceState: (_a, _b, path) => history.push(path) },
    mainnetPanel: null, mainnetPanelGeneration: 0, socialPanel: null, socialPanelGeneration: 0,
    runwayPanel: null, runwayPanelGeneration: 0, developerPanel: null, developerPanelGeneration: 0,
    loadMainnetPanel: project => mounted.push(project),
  });
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').replace(/\ninit\(\);\r?\n/, '\n');
  vm.runInContext(source, context);
  vm.runInContext(`state = { hosted: true, mode: 'zkapi', projects: [], jobs: [], wallet: '0x1111111111111111111111111111111111111111', capabilities: {transactionsEnabled: true} }; view = 'home'; render();`, context);
  assert.match(element('content').innerHTML, /data-view="platform"/);
  assert.match(element('content').innerHTML, /Trade &amp;|Trade & view fees/);
  vm.runInContext(`view = 'platform'; render();`, context);
  assert.equal(mounted.length, 1); assert.equal(mounted[0].id, 'platform-market');
  assert.match(element('content').innerHTML, /id="mainnet-panel"/);
  assert.equal(history.at(-1), '/app#view=platform');
  assert.equal(element('page-title').textContent, 'VEYL market');
});

test('platform quotes and recovery use the dedicated wallet-scoped route without changing agent routes', async () => {
  const requests = [], wallet = new EventTarget();
  Object.assign(wallet, { account: '0x1111111111111111111111111111111111111111', ensure: async () => {} });
  const client = new VeylChainClient({ wallet, api: async (path, body) => { requests.push({path,body}); return {}; }, storage: null });
  await client.capabilities('platform-market'); await client.status('platform-market');
  await client.prepare('platform-market', 'quote', { side: 'buy', amount: '0.001' });
  assert.deepEqual(requests.map(r => r.path), ['/api/platform-market/capabilities', '/api/platform-market/status', '/api/platform-market/quote']);
  assert.equal(requests[2].body.account, wallet.account);
  assert.equal(client.path('ordinary-agent', 'verify'), '/api/projects/ordinary-agent/mainnet/verify');
  assert.equal(client.path('platform-market', 'verify'), '/api/platform-market/verify');
});
