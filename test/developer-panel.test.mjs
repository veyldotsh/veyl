import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mountDeveloperPanel } from '../public/developer-panel.js';
const token = 'veyl_sk_' + 'c'.repeat(64);
function element() {
  const handlers = new Map();
  return { innerHTML: '', contains: () => true, addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener: name => handlers.delete(name), handlers };
}
const key = { id: 'key-1', name: 'Test integration', scopes: ['read'], createdAt: Date.now(), expiresAt: Date.now() + 86400000 };
test('developer local demo never calls token APIs and explains hosted access', () => {
  const el = element(); let calls = 0;
  const panel = mountDeveloperPanel(el, { project: { id: 'p' }, hosted: false, api: () => { calls++; } });
  assert.match(el.innerHTML, /does not issue credentials/); assert.equal(calls, 0); panel.destroy();
});
test('developer token list defaults to read-only, escapes metadata and offers only owner revoke controls', async () => {
  const el = element(), calls = [];
  const panel = mountDeveloperPanel(el, { project: { id: 'project-1' }, hosted: true, api: async (...args) => { calls.push(args); return { keys: [{ ...key, name: '<script>bad</script>' }] }; } });
  await panel.refresh();
  assert.match(el.innerHTML, /value="read" checked/); assert.doesNotMatch(el.innerHTML, /value="jobs" checked/);
  assert.match(el.innerHTML, /consume funded inference allowance/); assert.doesNotMatch(el.innerHTML, /<script>bad/);
  const button = { dataset: { developer: 'revoke', key: key.id }, disabled: false };
  await el.handlers.get('click')({ target: { closest: () => button } });
  assert.ok(calls.some(([path, body]) => path === '/api/projects/project-1/developer-keys/key-1/revoke' && body)); panel.destroy();
});
test('one-time token exists only in mounted memory, clears on dismissal and cannot survive unmount', async () => {
  const oldFormData = globalThis.FormData;
  globalThis.FormData = class { constructor(form) { this.values = form.values; } get(k) { return this.values[k]; } getAll(k) { return this.values[k]; } };
  try {
    const el = element(); let issued = 0;
    const panel = mountDeveloperPanel(el, { project: { id: 'project-1' }, hosted: true, api: async (_path, body) => body ? (issued++, { token, key }) : { keys: [key] } });
    await panel.refresh();
    const form = { matches: () => true, values: { name: 'My script', scope: ['read'], expiresInDays: '30' } };
    await el.handlers.get('submit')({ target: form, preventDefault() {} });
    assert.equal(issued, 1); assert.match(el.innerHTML, new RegExp(token)); assert.match(el.innerHTML, /type="password" readonly/);
    await el.handlers.get('submit')({ target: form, preventDefault() {} }); assert.equal(issued, 1, 'unsaved one-time token cannot be overwritten');
    await el.handlers.get('click')({ target: { closest: () => ({ dataset: { developer: 'dismiss' } }) } }); assert.ok(!el.innerHTML.includes(token));
    panel.destroy(); assert.equal(el.innerHTML, ''); assert.equal(el.handlers.size, 0);
  } finally { globalThis.FormData = oldFormData; }
});
test('late issuance response cannot display a secret after navigating away', async () => {
  const oldFormData = globalThis.FormData;
  globalThis.FormData = class { get(k) { return { name: 'Script', expiresInDays: '30' }[k]; } getAll() { return ['read']; } };
  try {
    const el = element(); let finish;
    const panel = mountDeveloperPanel(el, { project: { id: 'p' }, hosted: true, api: async (_path, body) => body ? new Promise(resolve => { finish = resolve; }) : { keys: [] } });
    await panel.refresh();
    const action = el.handlers.get('submit')({ target: { matches: () => true }, preventDefault() {} }); panel.destroy(); finish({ token, key }); await action;
    assert.equal(el.innerHTML, '');
  } finally { globalThis.FormData = oldFormData; }
});
test('developer UI never persists a token and source wiring provides isolated cleanup and static assets', () => {
  const ui = readFileSync(new URL('../public/developer-panel.js', import.meta.url), 'utf8');
  assert.doesNotMatch(ui, /localStorage|sessionStorage|console\.|document\.cookie/);
  assert.equal((ui.match(/clipboard\.writeText/g) || []).length, 1); assert.match(ui, /action === 'copy'/);
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'); assert.match(app, /developerPanel\?\.destroy/); assert.match(app, /data-developer-form/);
  const server = readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8'); assert.match(server, /developer-panel\.js/); assert.match(server, /developer-panel\.css/); assert.match(server, /developers\.html/);
});
