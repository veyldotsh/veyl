import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { mountResearchPanel, checkedResearchSnapshot, researchSourceUrl, researchCharges } from '../public/research-panel.js';

const project = { id: 'project-one', status: 'active', model: 'model-one' };
const url = 'https://ethereum.org/roadmap';
const watch = { id: 'watch-one', name: 'Protocol updates', brief: 'Describe material changes.', sources: [url], enabled: false, cadenceMinutes: 1440, reviewerModel: null, lastCheckedAt: '2026-10-02T08:00:00Z' };
const fixture = () => ({ watchlists: [structuredClone(watch)], sourceHosts: ['ethereum.org', 'github.com'], checks: [{ id: 'check-one', watchId: watch.id, status: 'baseline', startedAt: '2026-10-02T08:00:00Z', sources: [{ url, status: 'baseline', fetchedAt: '2026-10-02T08:00:01Z', afterExcerpt: 'Captured <script>text</script>.' }], report: { status: 'none' }, review: { status: 'none' } }] });
class Region {
  innerHTML = ''; textContent = ''; fieldset = {}; select = { value: '', innerHTML: '' }; hint = {};
  querySelector(selector) { if (selector === 'fieldset') return this.fieldset; if (selector === '[name="reviewerModel"]') return this.select; if (selector === '[data-research-model-hint]') return this.hint; if (selector === 'input') return { focus() {} }; return null; }
  querySelectorAll() { return []; }
}
class Element extends Region {
  handlers = new Map(); regions = new Map();
  contains(node) { return node?.owned !== false; }
  addEventListener(name, fn) { this.handlers.set(name, fn); }
  removeEventListener(name) { this.handlers.delete(name); }
  querySelector(selector) { if (!this.regions.has(selector)) this.regions.set(selector, new Region()); return this.regions.get(selector); }
  html() { return this.innerHTML + [...this.regions.values()].map(region => region.innerHTML).join(''); }
  click(action, id = watch.id) { return this.handlers.get('click')({ target: { closest: () => ({ dataset: { research: action, watch: id } }) } }); }
}
function setup(api, options = {}) {
  const element = new Element(), calls = []; let poll;
  const panel = mountResearchPanel(element, { project, api: async (path, body) => { calls.push({ path, body }); return api ? api(path, body) : path.endsWith('/models') ? [{ id: 'model-one' }, { id: 'model-two', oa_request_limit_micro_usd: 2_000_000 }] : fixture(); }, setTimer: fn => { poll = fn; return 1; }, clearTimer() {}, ...options });
  return { element, panel, calls, poll: () => poll() };
}
async function ready(f) { await Promise.all([f.panel.ready, f.panel.modelReady]); }
async function submit(element, values) {
  const old = globalThis.FormData;
  globalThis.FormData = class { get(key) { return values[key] ?? null; } };
  try { await element.handlers.get('submit')({ target: { matches: () => true }, preventDefault() {} }); }
  finally { globalThis.FormData = old; }
}

test('research shows observed captures safely and never starts inference during refresh', async () => {
  const f = setup(); await ready(f);
  assert.match(f.element.html(), /Baseline saved/); assert.match(f.element.html(), /No model call needed/);
  assert.match(f.element.html(), /Captured &lt;script&gt;text/); assert.doesNotMatch(f.element.html(), /<script>text/);
  assert.match(f.element.html(), /https:\/\/ethereum.org\/roadmap/);
  assert.match(f.element.html(), /No second-model review/); assert.doesNotMatch(f.element.html(), /name="enabled" checked/);
  await f.panel.refresh(); assert.equal(f.calls.filter(call => call.body).length, 0); f.panel.destroy();
});

test('watch creation sends explicit cadence and optional different reviewer under a stable idempotency key', async () => {
  const f = setup(); await ready(f);
  await submit(f.element, { name: 'Watch', brief: 'Check the evidence.', sources: url, cadenceMinutes: '360', reviewerModel: 'model-two', enabled: 'on' });
  const call = f.calls.find(call => call.body); assert.equal(call.path, '/api/projects/project-one/watches');
  assert.deepEqual({ ...call.body, requestKey: undefined }, { name: 'Watch', brief: 'Check the evidence.', sources: [url], enabled: true, cadenceMinutes: 360, reviewerModel: 'model-two', requestKey: undefined });
  assert.match(call.body.requestKey, /^[0-9a-f-]{36}$/); assert.match(f.element.html(), /additional budget reservation/); f.panel.destroy();
});

test('unsupported URLs and the same reviewer model are refused before any mutation', async () => {
  const f = setup(); await ready(f);
  for (const bad of ['javascript:alert(1)', 'http://ethereum.org', 'https://ethereum.org@evil.example/', 'https://127.0.0.1/', 'https://ethereum.org:8443/']) assert.throws(() => researchSourceUrl(bad, ['ethereum.org']));
  await submit(f.element, { name: 'Watch', brief: 'Review.', sources: 'https://evil.example', cadenceMinutes: '60' });
  await submit(f.element, { name: 'Watch', brief: 'Review.', sources: url, cadenceMinutes: '60', reviewerModel: project.model });
  assert.equal(f.calls.filter(call => call.body).length, 0); assert.match(f.element.html(), /different reviewer/); f.panel.destroy();
});

test('uncertain check has no automatic replay and an explicit retry reuses its saved key', async () => {
  let tries = 0;
  const f = setup(async (path, body) => { if (body) { if (++tries === 1) throw Error('Request outcome unknown.'); return fixture().checks[0]; } return path.endsWith('/models') ? [] : fixture(); }); await ready(f);
  await f.element.click('check'); assert.equal(tries, 1); assert.match(f.element.html(), /No automatic retry was sent/);
  await f.panel.refresh(); f.poll(); assert.equal(tries, 1);
  await f.element.click('check'); const writes = f.calls.filter(call => call.body);
  assert.equal(writes.length, 2); assert.equal(writes[0].body.requestKey, writes[1].body.requestKey); f.panel.destroy();
});

test('history refresh preserves a partly edited watch form and ignores destroyed responses', async () => {
  const f = setup(); await ready(f); const editor = f.element.querySelector('[data-research-editor]');
  editor.innerHTML = 'Unsaved user input'; await f.panel.refresh(); assert.equal(editor.innerHTML, 'Unsaved user input'); f.panel.destroy();
  let resolveRead;
  const late = setup(path => path.endsWith('/models') ? [] : new Promise(resolve => { resolveRead = resolve; }));
  late.panel.destroy(); late.element.innerHTML = 'Another project'; resolveRead(fixture()); await late.panel.ready;
  assert.equal(late.element.innerHTML, 'Another project'); assert.equal(late.element.handlers.size, 0);
});

test('settled ETH is exact and pending budget is separate from actual charges', () => {
  const job = { reservation: 1_000_001, steps: [{ callAccounting: { status: 'settled', chargeWei: '1000000001', valuationMicroUsd: 1 }, additionalCalls: [{ callAccounting: { status: 'pending' } }] }] };
  assert.deepEqual(researchCharges(job), { label: '0.000000001000000001 ETH settled', text: '$0.000001 verified budget value · $1.00 reserved. Unresolved caps stay held; these are not additional charges.' });
  assert.equal(researchCharges(job, true).label, 'Simulated usage');
  assert.equal(researchCharges({ ...job, reservation: 0 }).label, 'Usage unavailable');
});

test('changed evidence links real stages, blocked admission and escaped report findings', async () => {
  const data = fixture(); const check = data.checks[0]; check.status = 'changed'; check.sources[0].status = 'changed'; check.sources[0].beforeExcerpt = 'Old evidence.';
  check.report = { status: 'completed', jobId: 'job-one', job: { id: 'job-one', status: 'completed', model: project.model, at: check.startedAt, reservation: 2_000_000, steps: [{ role: 'Researcher', status: 'completed', toolActivity: [{ name: 'read_source', status: 'completed', at: check.startedAt }] }] }, artifact: { id: 'artifact-one', content: 'Finding <img src=x onerror=alert(1)>', mode: 'zkapi' } };
  check.review = { status: 'blocked', error: 'Daily budget exhausted.' };
  const f = setup(path => path.endsWith('/models') ? [] : data); await ready(f);
  assert.match(f.element.html(), /Compare captured excerpts/); assert.match(f.element.html(), /Old evidence/); assert.match(f.element.html(), /Job job-one/);
  assert.match(f.element.html(), /Read source · completed/); assert.match(f.element.html(), /Daily budget exhausted/); assert.match(f.element.html(), /data-tab="runtime"/);
  assert.match(f.element.html(), /href="\/api\/artifacts\/artifact-one"/); assert.match(f.element.html(), /Finding &lt;img/); assert.doesNotMatch(f.element.html(), /<img src=x/); f.panel.destroy();
});

test('malformed history and unrelated watch checks fail closed', () => {
  const data = fixture(); data.checks[0].watchId = 'different-project-watch'; assert.throws(() => checkedResearchSnapshot(data));
  const invalid = fixture(); invalid.watchlists[0].sources = ['https://evil.example']; assert.throws(() => checkedResearchSnapshot(invalid));
});

test('enabled watches poll after idle checks without overlapping reads or losing editor state', async () => {
  const data = fixture(); data.watchlists[0].enabled = true;
  let resolveRead, delayed = false;
  const f = setup(path => path.endsWith('/models') ? [] : delayed ? new Promise(resolve => { resolveRead = resolve; }) : data);
  await ready(f); const editor = f.element.querySelector('[data-research-editor]'); editor.innerHTML = 'Unsaved watch edits';
  delayed = true; const first = f.poll(); f.poll();
  assert.equal(f.calls.filter(call => call.path.endsWith('/research')).length, 2);
  resolveRead(data); await first; assert.equal(editor.innerHTML, 'Unsaved watch edits');
  f.panel.destroy(); f.poll(); assert.equal(f.calls.filter(call => call.path.endsWith('/research')).length, 2);
});

test('Research bookmark survives reload and global polling excludes its editor', async () => {
  const elements = new Map();
  const context = vm.createContext({ document: { getElementById(id) { if (!elements.has(id)) elements.set(id, { addEventListener() {}, style: {} }); return elements.get(id); }, addEventListener() {}, querySelectorAll: () => [] }, crypto: webcrypto, setInterval() {}, sessionBootstrap: async () => false, location: { hash: '#view=project&id=agent-one&tab=research', search: '' }, URLSearchParams, Intl });
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'); vm.runInContext(source, context);
  await vm.runInContext(`sessionBootstrap = async () => true; state = { templates: {} }; refresh = async () => {}; api = async path => path === '/api/models' ? [] : {}; render = () => { observed = { view, selected, tab }; }; init();`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.observed)), { view: 'project', selected: 'agent-one', tab: 'research' });
  assert.match(source, /\['connections', 'developer', 'research', 'runtime', 'deliverables'\]\.includes\(tab\)/); assert.match(source, /form\.hasAttribute\('data-research-form'\)/);
});

test('all pages start dark before scripts and old light preferences cannot add a theme switch', () => {
  const context = vm.createContext({ document: { documentElement: { dataset: { theme: 'light' } } }, localStorage: { getItem() { throw Error('Storage should not be read'); } } });
  vm.runInContext(readFileSync(new URL('../public/theme.js', import.meta.url), 'utf8'), context); assert.equal(context.document.documentElement.dataset.theme, 'dark');
  for (const name of ['site', 'index', 'market', 'docs', 'developers', 'brand', 'oauth-callback']) assert.match(readFileSync(new URL(`../public/${name}.html`, import.meta.url), 'utf8'), /<html lang="en" data-theme="dark">/);
  assert.doesNotMatch(readFileSync(new URL('../public/theme.js', import.meta.url), 'utf8'), /createElement|addEventListener|localStorage/);
});
