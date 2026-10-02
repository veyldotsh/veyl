import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// Read-only HTTP audit of the actual local pages and their linked assets.
const base = 'http://127.0.0.1:4318';
const pages = ['/', '/app', '/docs', '/brand'];
const responses = new Map();
async function read(path) {
  if (responses.has(path)) return responses.get(path);
  const response = await fetch(base + path, { redirect: 'error', signal: AbortSignal.timeout(8000) });
  assert.equal(response.status, 200, `GET ${path}`);
  const type = response.headers.get('content-type') || '';
  const body = /text|svg|javascript/.test(type) ? await response.text() : await response.arrayBuffer();
  const result = { type, body }; responses.set(path, result); return result;
}
const references = [];
for (const path of pages) {
  const { body, type } = await read(path);
  assert.match(type, /text\/html/);
  const ids = [...body.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length, `Unique element IDs on ${path}`);
  assert.match(body, /<title>[^<]+<\/title>/);
  assert.match(body, /name="viewport"/);
  for (const match of body.matchAll(/\b(?:href|src)="([^"]+)"/g)) references.push({ from: path, value: match[1] });
}
for (let i = 0; i < references.length; i++) {
  const { from, value } = references[i];
  const url = new URL(value.replaceAll('&amp;', '&'), base + from);
  if (url.origin !== base) continue;
  const { body, type } = await read(url.pathname);
  if (url.hash) assert.ok(typeof body === 'string' && body.includes(`id="${url.hash.slice(1)}"`), `Anchor ${value} from ${from}`);
  if (type.startsWith('text/css')) {
    for (const match of body.matchAll(/url\(['"]?([^'"\)]+)['"]?\)/g)) {
      const asset = new URL(match[1], base + url.pathname);
      if (asset.origin === base && !responses.has(asset.pathname)) references.push({ from: url.pathname, value: asset.pathname });
    }
  }
}
const report = { at: new Date().toISOString(), base, pages, resourcesChecked: responses.size, internalReferencesChecked: references.length, passed: true };
mkdirSync(resolve('output'), { recursive: true });
writeFileSync(resolve('output/web-http-check.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
