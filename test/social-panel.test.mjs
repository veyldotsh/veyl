import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mountSocialPanel, checkedSocialSnapshot, checkedXAuthorization } from '../public/social-panel.js';
import { createApp } from '../src/server.mjs';

class Element {
  innerHTML = ''; isConnected = true; handlers = new Map();
  addEventListener(name, fn) { this.handlers.set(name, fn); }
  removeEventListener(name, fn) { if (this.handlers.get(name) === fn) this.handlers.delete(name); }
  contains(node) { return node?.owned !== false; }
  querySelectorAll() { return []; }
  fire(name, target) { this.handlers.get(name)?.({ target, preventDefault() {}, stopPropagation() {} }); }
}
const project = { id: randomUUID(), name: 'Project <script>untrusted</script>' }, now = 1_790_858_000_000;
function fixture({ publishingEnabled = true } = {}) {
  const connectionId = randomUUID();
  return { projectId: project.id, xConfigured: true, publishingEnabled, accounts: { x: { connectionId, channel: 'x', id: '12345', username: 'test_account', status: 'connected' }, telegram: null }, outbox: [{ id: randomUUID(), channel: 'x', status: 'draft', approvalDigest: 'a'.repeat(64), createdAt: now, expiresAt: now + 60_000, preview: { projectId: project.id, channel: 'x', connectionId, accountId: '12345', username: 'test_account', text: '<img src=x onerror="attack()"> & exact text', madeWithAi: true } }] };
}
function control(action, properties = {}) { const node = { dataset: { social: action, ...properties }, disabled: false, closest: selector => selector === '[data-social]' ? node : null }; return node; }
function checkbox(item, checked = true) { return { dataset: { socialReview: item.id }, checked, matches: selector => selector === '[data-social-review]' }; }
async function settled(panel) { for (let i = 0; i < 100; i++) { if (!panel.isBusy()) return; await new Promise(resolve => setImmediate(resolve)); } throw new Error('Panel did not settle.'); }
function form(kind, values) { const node = { dataset: { socialForm: kind }, elements: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }])), closest: selector => selector === '[data-social-form]' ? node : null }; return node; }

test('local Connections panel makes no account API requests or credential form', async () => {
  const element = new Element(); let requested = false;
  const panel = mountSocialPanel(element, { project, api: async () => { requested = true; } }); await panel.ready;
  assert.equal(requested, false); assert.match(element.innerHTML, /local demo does not accept credentials/); assert.doesNotMatch(element.innerHTML, /type="password"|data-social="publish"/); panel.destroy(); assert.equal(element.handlers.size, 0);
});

test('server-supplied text is escaped and no result-provided URL can become a link', async () => {
  const snapshot = fixture(), item = snapshot.outbox[0]; item.result = { id: '123', url: 'javascript:attack()' }; const element = new Element();
  const panel = mountSocialPanel(element, { project, hosted: true, api: async () => snapshot, now: () => now }); await panel.ready;
  element.fire('click', control('review', { intent: item.id }));
  assert.match(element.innerHTML, /&lt;img src=x onerror=&quot;attack\(\)&quot;&gt;/); assert.match(element.innerHTML, /Project &lt;script&gt;/); assert.doesNotMatch(element.innerHTML, /<img src=x|javascript:attack|<script>untrusted/); assert.match(element.innerHTML, /AI-assisted draft: yes/); assert.match(element.innerHTML, /maxlength="4096"/); assert.doesNotMatch(element.innerHTML, /AI content label/); panel.destroy();
});

test('publishing requires backend enablement and exact reviewed digest', async () => {
  for (const publishingEnabled of [false, true]) {
    const snapshot = fixture({ publishingEnabled }), item = snapshot.outbox[0], posts = [], element = new Element();
    const api = async (path, body) => { if (body) { posts.push({ path, body: structuredClone(body) }); snapshot.outbox[0].status = 'published'; } return snapshot; };
    const panel = mountSocialPanel(element, { project, hosted: true, api, now: () => now }); await panel.ready;
    element.fire('click', control('review', { intent: item.id }));
    element.fire('click', control('publish', { intent: item.id })); await settled(panel); assert.equal(posts.length, 0);
    element.fire('change', checkbox(item));
    if (!publishingEnabled) assert.match(element.innerHTML, /data-social="publish" disabled/);
    element.fire('click', control('publish', { intent: item.id })); await settled(panel);
    assert.equal(posts.length, publishingEnabled ? 1 : 0);
    if (publishingEnabled) { assert.deepEqual(posts[0].body, { intentId: item.id, approvalDigest: item.approvalDigest }); assert.equal(posts[0].path, `/api/projects/${project.id}/social/publish`); assert.match(element.innerHTML, /Published/); }
    panel.destroy();
  }
});

test('a lost publication response remains unknown even when status read still says draft', async () => {
  const snapshot = fixture(), item = snapshot.outbox[0], element = new Element(); let posts = 0;
  const panel = mountSocialPanel(element, { project, hosted: true, now: () => now, api: async (path, body) => { if (path.endsWith('/publish')) { posts++; throw new Error('Response lost'); } return snapshot; } }); await panel.ready;
  element.fire('click', control('review', { intent: item.id })); element.fire('change', checkbox(item)); element.fire('click', control('publish', { intent: item.id })); await settled(panel);
  assert.equal(posts, 1); assert.match(element.innerHTML, /Publication may have succeeded/); assert.doesNotMatch(element.innerHTML, /data-social="publish"/);
  element.fire('change', checkbox(item)); element.fire('click', control('publish', { intent: item.id })); await settled(panel); assert.equal(posts, 1); panel.destroy();
});

test('Telegram token and destination fields clear before request and payload clears after attempt', async () => {
  const snapshot = fixture(), element = new Element(); let pending, captured, payload;
  const panel = mountSocialPanel(element, { project, hosted: true, now: () => now, api: async (path, body) => { if (path.endsWith('/telegram')) { payload = body; captured = structuredClone(body); return new Promise(resolve => { pending = resolve; }); } return snapshot; } }); await panel.ready;
  const target = form('telegram', { token: '12345:synthetic-token', chatId: '-10012345' }); element.fire('submit', target);
  assert.equal(target.elements.token.value, ''); assert.equal(target.elements.chatId.value, ''); assert.deepEqual(captured, { token: '12345:synthetic-token', chatId: '-10012345' }); assert.doesNotMatch(element.innerHTML, /synthetic-token/);
  pending({ connected: true }); await settled(panel); assert.equal(payload.token, ''); assert.equal(payload.chatId, ''); panel.destroy();
});

test('destroy ignores stale asynchronous status and authorization responses', async () => {
  let resolveRead; const element = new Element();
  const panel = mountSocialPanel(element, { project, hosted: true, api: () => new Promise(resolve => { resolveRead = resolve; }) });
  panel.destroy(); element.innerHTML = 'Another project'; resolveRead(fixture()); await panel.ready; assert.equal(element.innerHTML, 'Another project'); assert.equal(element.handlers.size, 0);
  const snapshot = fixture(), element2 = new Element(); let resolveBegin, navigated = false;
  const second = mountSocialPanel(element2, { project, hosted: true, api: async (path, body) => body ? new Promise(resolve => { resolveBegin = resolve; }) : snapshot, navigate: () => { navigated = true; } }); await second.ready;
  element2.fire('click', control('x-begin')); second.destroy(); resolveBegin({}); await new Promise(resolve => setImmediate(resolve)); assert.equal(navigated, false);
});

test('X authorization accepts the exact matching PKCE link and refuses external destinations', () => {
  const state = project.id + '.' + 'a'.repeat(43), params = new URLSearchParams({ state, response_type: 'code', code_challenge_method: 'S256', code_challenge: 'fixture' });
  const value = { state, authorizationUrl: 'https://x.com/i/oauth2/authorize?' + params };
  assert.equal(checkedXAuthorization(value, project.id), value.authorizationUrl);
  for (const authorizationUrl of ['javascript:alert(1)', 'https://evil.example/i/oauth2/authorize?' + params, 'https://x.com@evil.example/i/oauth2/authorize?' + params]) assert.throws(() => checkedXAuthorization({ ...value, authorizationUrl }, project.id));
  assert.throws(() => checkedXAuthorization(value, randomUUID()));
});

test('cross-project or tampered preview snapshots fail closed', () => {
  const snapshot = fixture(); assert.throws(() => checkedSocialSnapshot(snapshot, randomUUID()));
  snapshot.outbox[0].approvalDigest = 'not-a-digest'; assert.throws(() => checkedSocialSnapshot(snapshot, project.id));
});

test('the real static server serves Connections assets with same-origin policy', async t => {
  const server = createApp({}); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [path, type] of [['/social-panel.js', 'text/javascript'], ['/social-panel.css', 'text/css'], ['/app', 'text/html']]) {
    const response = await fetch(base + path); assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), new RegExp(type)); assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
    const content = await response.text(); assert.ok(content.length > 100); if (path === '/app') assert.match(content, /href="\/social-panel\.css"/);
  }
});
