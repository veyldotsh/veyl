import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Problem } from './agent.mjs';
import { Store } from './store.mjs';
import { Kit } from './kit.mjs';
import { LocalChain } from './chain.mjs';
import { LocalMarkets } from './market.mjs';
import { fundingFromEnv } from './funding.mjs';
import { DemoProvider, ZkApiProvider } from './provider.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function createApp(kit) {
  const csrf = randomBytes(32).toString('hex');
  return createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${req.socket.localPort}`;
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    try {
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') throw new Problem('Local same-origin access required.', 403);
      const url = new URL(req.url, origin), parts = url.pathname.split('/').filter(Boolean);
      if (req.method === 'GET' && url.pathname === '/api/session') return json(200, { mode: 'local', authenticated: true });
      if (req.method === 'GET' && url.pathname === '/api/state') return json(200, { ...kit.snapshot(), csrf });
      if (req.method === 'GET' && url.pathname === '/api/models') return json(200, await kit.provider.models());
      if (req.method === 'GET' && url.pathname === '/api/chain') return json(200, await kit.chain.status());
      if (req.method === 'GET' && url.pathname === '/api/funding') return json(200, kit.funding?.snapshot() || { credentialsConfigured: false, approvalEnabled: false, intents: [] });
      if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'projects' && parts.length === 4 && parts[3] === 'balance') return json(200, { eth: await kit.chain.balance(kit.project(parts[2])) });
      if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'projects' && parts.length === 4 && parts[3] === 'revenue') return json(200, await kit.chain.revenueStatus(kit.project(parts[2])));
      if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'projects' && parts.length === 4 && parts[3] === 'market') return json(200, kit.markets ? await kit.markets.status(kit.project(parts[2])) : { configured: false });
      if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'artifacts' && parts.length === 3) {
        const artifact = kit.store.data.projects.flatMap(p => p.artifacts).find(a => a.id === parts[2]);
        if (!artifact) throw new Problem('Artifact not found.', 404);
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="deliverable-${artifact.id}.md"` });
        return res.end(`# ${artifact.title}\n\nMode: ${artifact.mode}\n\n${artifact.content}\n`);
      }
      if (req.method === 'POST' && parts[0] === 'api') {
        if (req.headers['x-agent-csrf'] !== csrf || req.headers['content-type'] !== 'application/json') throw new Problem('Invalid local request.', 403);
        const chunks = []; let length = 0;
        for await (const chunk of req) { length += chunk.length; if (length > 40_000) throw new Problem('Request too large.', 413); chunks.push(chunk); }
        let body; try { body = JSON.parse(Buffer.concat(chunks)); } catch { throw new Problem('Invalid JSON.'); }
        if (!body || Array.isArray(body) || typeof body !== 'object') throw new Problem('Expected a JSON object.');
        if (parts[1] === 'funding' && parts.length === 3) {
          if (!kit.funding) throw new Problem('zkAPI funding is not configured.', 503);
          kit.store.assertHealthy();
          switch (parts[2]) {
            case 'inspect': return json(200, await kit.funding.inspect());
            case 'quote': return json(200, await kit.funding.quote(body));
            case 'refresh': return json(200, await kit.funding.refresh(body.intentId));
            case 'approve': return json(200, await kit.funding.approve(body));
            case 'recover': return json(200, await kit.funding.recover(body.intentId));
            case 'resume': return json(200, await kit.funding.resume(body));
          }
        }
        if (url.pathname === '/api/projects') return json(201, kit.create(body));
        if (parts[1] === 'projects' && parts.length === 4) {
          const id = parts[2];
          switch (parts[3]) {
            case 'market-launch': return json(200, await kit.market(id, 'launch', body));
            case 'market-quote': return json(200, await kit.market(id, 'quote', body));
            case 'market-swap': return json(200, await kit.market(id, 'swap', body));
            case 'market-harvest': return json(200, await kit.market(id, 'harvest', body));
            case 'deploy': return json(200, await kit.deploy(id));
            case 'fund': return json(200, await kit.fund(id));
            case 'revenue': return json(200, await kit.revenue(id));
            case 'distribute': return json(200, await kit.revenue(id, true));
            case 'pause': return json(200, kit.pause(id));
            case 'settings': return json(200, kit.settings(id, body));
            case 'notes': return json(200, kit.note(id, body.content));
            case 'sources': return json(200, await kit.source(id, body.url));
            case 'schedule': return json(200, kit.schedule(id, body));
            case 'jobs': return json(202, await kit.submit(id, body));
          }
        }
      }
      const assets = { '/': ['site.html', 'text/html'], '/app': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/site.js': ['site.js', 'text/javascript'], '/site.css': ['site.css', 'text/css'], '/fonts.css': ['fonts.css', 'text/css'], '/field.svg': ['field.svg', 'image/svg+xml'], '/docs': ['docs.html', 'text/html'], '/docs.css': ['docs.css', 'text/css'], '/brand': ['brand.html', 'text/html'], '/logo.svg': ['logo.svg', 'image/svg+xml'], '/logo-light.svg': ['logo-light.svg', 'image/svg+xml'], '/logo-mono.svg': ['logo-mono.svg', 'image/svg+xml'] };
      assets['/developers'] = ['developers.html', 'text/html'];
      assets['/oauth/x'] = ['oauth-callback.html', 'text/html'];
      for (const file of ['site.html', 'index.html', 'docs.html', 'developers.html', 'brand.html', 'oauth-callback.html']) assets[`/${file}`] = [file, 'text/html'];
      assets['/developer-panel.css'] = ['developer-panel.css', 'text/css'];
      assets['/docs.js'] = ['docs.js', 'text/javascript'];
      assets['/panels.js'] = ['panels.js', 'text/javascript'];
      for (const file of ['session.js', 'wallet.js', 'chain-client.js', 'mainnet-panel.js', 'social-panel.js', 'runway-panel.js', 'developer-panel.js', 'oauth-callback.js']) assets[`/${file}`] = [file, 'text/javascript'];
      assets['/oauth-callback.css'] = ['oauth-callback.css', 'text/css'];
      assets['/social-panel.css'] = ['social-panel.css', 'text/css'];
      assets['/runway-panel.css'] = ['runway-panel.css', 'text/css'];
      assets['/brand.css'] = ['brand.css', 'text/css'];
      for (const file of ['veyl-wordmark.svg', 'veyl-wordmark-light.svg', 'veyl-avatar.svg', 'veyl-lockup.svg', 'veyl-lockup-light.svg']) assets[`/${file}`] = [file, 'image/svg+xml'];
      for (const file of ['veyl-avatar.png', 'veyl-logo.png', 'veyl-logo-light.png', 'veyl-x-banner.png']) assets[`/${file}`] = [file, 'image/png'];
      if (req.method === 'GET' && assets[url.pathname]) { const [file, type] = assets[url.pathname]; res.writeHead(200, { 'Content-Type': type + (type === 'image/png' ? '' : '; charset=utf-8') }); return res.end(readFileSync(resolve(root, 'public', file))); }
      json(404, { error: 'Not found.' });
    } catch (error) { json(error instanceof Problem ? error.status : 500, { error: error instanceof Problem ? error.message : 'Operation failed. Check the local runtime and preserve recovery state before retrying.' }); }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.env.AGENT_MODE || 'demo';
  if (!['demo', 'zkapi'].includes(mode)) throw new Error('AGENT_MODE must be demo or zkapi.');
  if (mode === 'zkapi' && process.env.ALLOW_PAID_INFERENCE !== 'yes') throw new Error('Real inference is disabled. Explicitly configure ALLOW_PAID_INFERENCE=yes after approving funding.');
  const folder = resolve(process.env.AGENT_DATA_DIR || resolve(root, 'data', mode)); mkdirSync(folder, { recursive: true });
  const lock = resolve(folder, 'process.lock');
  try { writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); } catch { throw new Error(`State is locked. Confirm the recorded process has stopped before removing ${lock}.`); }
  process.on('exit', () => { try { unlinkSync(lock); } catch {} });
  const provider = mode === 'demo' ? new DemoProvider() : new ZkApiProvider({ base: process.env.ZKAPI_ORIGIN, key: process.env.ZKAPI_LOCAL_KEY });
  const store = new Store(resolve(folder, 'kit.json'), mode);
  const chain = new LocalChain(process.env.ANVIL_ORIGIN);
  const markets = new LocalMarkets(chain);
  const funding = fundingFromEnv({ file: resolve(folder, 'funding-intents.json'), localMode: true });
  const kit = new Kit({ store, provider, chain, markets, funding });
  const server = createApp(kit); server.requestTimeout = 30_000;
  const timer = setInterval(() => kit.tick().catch(() => {}), 10_000);
  server.listen(Number(process.env.PORT || 4318), '127.0.0.1', () => console.log(`Veyl (${mode}): http://127.0.0.1:${server.address().port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { clearInterval(timer); server.close(() => process.exit(0)); });
}
