import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createApp } from '../src/server.mjs';

test('fresh local server serves every current public file and page alias from its explicit allowlist', async t => {
  const server = createApp({});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const file of readdirSync(new URL('../public/', import.meta.url), { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => entry.name)) {
    const response = await fetch(origin + '/' + file);
    assert.equal(response.status, 200, file);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), readFileSync(new URL('../public/' + file, import.meta.url)), file);
  }
  for (const path of ['/', '/app', '/docs', '/developers', '/brand', '/oauth/x']) {
    const response = await fetch(origin + path); assert.equal(response.status, 200, path); assert.match(response.headers.get('content-type'), /^text\/html/);
  }
  for (const path of ['/package.json', '/src/server.mjs', '/%2e%2e/package.json', '/..%2fsrc/server.mjs', '/public/../../runtime.env', '/nonexistent.svg']) {
    assert.equal((await fetch(origin + path)).status, 404, path);
  }
  assert.equal((await fetch(origin + '/logo.svg', { method: 'POST' })).status, 404);
});
