import { mkdirSync, readdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { buildDeveloperPackage } from './build-developer-package.mjs';
import { validatePublicDeploymentRecord } from './public-deployment-record.mjs';
const source = resolve('public'), destination = resolve('dist');
const hosted = process.argv.includes('--hosted');
if (process.argv.slice(2).some(arg => arg !== '--hosted')) throw new Error('Unknown website build option.');
// Public copy must match the reviewed prediction artifact. Recomputing CREATE2
// from compiled contracts belongs to contract validation, not a source-only web build.
const prediction = JSON.parse(readFileSync(resolve('config/public-addresses.json'), 'utf8'));
for (const name of ['docs.html']) {
  const html = readFileSync(resolve(source, name), 'utf8');
  validatePublicDeploymentRecord(prediction, html);
}
mkdirSync(destination, { recursive: true });
const allowed = new Set(['.html', '.css', '.js', '.svg', '.png', '.woff2', '.ico', '.txt', '.json']);
for (const item of readdirSync(source, { withFileTypes: true })) {
  if (item.isFile() && allowed.has(extname(item.name))) copyFileSync(resolve(source, item.name), resolve(destination, item.name));
}
if (hosted) {
  const site = resolve(destination, 'site.html');
  const replacements = [
    ['Local demo · simulated inference', 'Wallet sign-in · project-scoped access']
  ];
  let html = readFileSync(site, 'utf8');
  for (const [before, after] of replacements) {
    if (!html.includes(before)) throw new Error('Hosted release copy changed; review the website labels before publishing.');
    html = html.replace(before, after);
  }
  writeFileSync(site, html);
  const app = resolve(destination, 'index.html');
  writeFileSync(resolve(destination, 'app.html'), readFileSync(app, 'utf8').replace('>Local runtime</span>', '>Connecting…</span>').replace('Checking local chain…', 'Connecting to Ethereum workspace…'));
  // Vercel serves an existing index before applying the root rewrite.
  writeFileSync(app, html);
}
const sdk = buildDeveloperPackage(resolve(destination, 'downloads'));
console.log(`Built ${hosted ? 'hosted' : 'local demo'} Veyl site and ${sdk.name}@${sdk.version}. Runtime and private state are excluded.`);
