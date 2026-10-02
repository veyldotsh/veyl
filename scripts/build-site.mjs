import { mkdirSync, readdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { buildDeveloperPackage } from './build-developer-package.mjs';
const source = resolve('public'), destination = resolve('dist');
const hosted = process.argv.includes('--hosted');
if (process.argv.slice(2).some(arg => arg !== '--hosted')) throw new Error('Unknown website build option.');
mkdirSync(destination, { recursive: true });
const allowed = new Set(['.html', '.css', '.js', '.svg', '.png', '.woff2', '.ico', '.txt', '.json']);
for (const item of readdirSync(source, { withFileTypes: true })) {
  if (item.isFile() && allowed.has(extname(item.name))) copyFileSync(resolve(source, item.name), resolve(destination, item.name));
}
if (hosted) {
  const site = resolve(destination, 'site.html');
  const replacements = [
    ['Explore the local preview.', 'Explore the prelaunch workspace.'],
    ['Local preview · simulated inference · no wallet needed', 'Prelaunch workspace · wallet sign-in · mainnet launch pending'],
    ['Local v4 swaps fund the treasury. Mainnet is not deployed.', 'Ethereum markets and paid inference remain gated pending launch acceptance.'],
    ['The local preview also launches a token, trading pool, locked liquidity and operating treasury on Anvil using development ETH.', 'Creating a workspace does not deploy a token or spend funds. Market deployment requires a separate wallet transaction after launch is enabled.'],
    ['This preview runs real v4 contracts locally.', 'The contracts have been rehearsed locally against Ethereum pool infrastructure.'],
    ['LOCAL PREVIEW · MAINNET NOT DEPLOYED', 'PRELAUNCH · MAINNET NOT DEPLOYED']
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
console.log(`Built ${hosted ? 'hosted prelaunch' : 'local preview'} Veyl site and ${sdk.name}@${sdk.version}. Runtime and private state are excluded.`);
