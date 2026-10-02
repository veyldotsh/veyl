import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { randomUUID } from 'node:crypto';

const published = JSON.parse(readFileSync(new URL('../config/public-addresses.json', import.meta.url), 'utf8'));
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function app() {
  const element = { addEventListener() {}, style: {} };
  const context = createContext({ document: { getElementById: () => element, addEventListener() {}, querySelectorAll: () => [] }, crypto: { randomUUID }, setInterval() {}, sessionBootstrap: async () => false, matchMedia: () => ({ matches: false }), Intl });
  runInContext(source, context);
  context.fixture = { hosted: true, mode: 'zkapi', jobs: [], projects: [
    { id: 'platform', name: 'Veyl', symbol: 'VEYL', mainnet: { token: published.token.address }, status: 'paused', policy: { total: 1 }, committed: 0 },
    { id: 'agent', name: 'Research', symbol: 'RES', purpose: 'Research briefs.', template: 'research', status: 'active', policy: { total: 25000000 }, committed: 0, artifacts: [] }
  ] };
  runInContext('state = fixture;', context);
  return context;
}

test('the canonical platform token opens its market without agent runtime or social setup', () => {
  const context = app();
  const html = runInContext("selected = 'platform'; tab = 'connections'; renderProject();", context);
  assert.match(html, /Platform token · Ethereum · VEYL\/ETH/);
  assert.match(html, /id="mainnet-panel"/);
  assert.doesNotMatch(html, /data-action="pause"|id="social-panel"|id="task-form"|data-tab="runtime"/);
  assert.equal(runInContext('tab', context), 'market');
  // Naming an ordinary project VEYL must not grant it platform identity.
  runInContext("state.projects[1].name = 'Veyl'; state.projects[1].symbol = 'VEYL'; selected = 'agent'; tab = 'connections';", context);
  const ordinary = runInContext('renderProject();', context);
  assert.match(ordinary, /id="social-panel"/);
  assert.doesNotMatch(ordinary, /Platform token · Ethereum/);
});

test('workspace lists the platform market separately and counts only agents', () => {
  const html = runInContext('renderHome();', app());
  assert.match(html, /PLATFORM TOKEN/);
  assert.match(html, /Manage VEYL market/);
  assert.match(html, /Your agents<\/span><strong>01<\/strong>/);
  assert.match(html, /1 ready agents/);
  assert.match(html, /\$RES · Solo agent/);
  assert.doesNotMatch(html, /\$VEYL · Solo agent/);
});
