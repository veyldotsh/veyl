import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { TenantRegistry, createProductionApp } from '../src/production.mjs';
import { MainnetMarkets } from '../src/mainnet.mjs';
import { WalletAuth } from '../src/auth.mjs';
import { GatewayVerifier } from '../src/gateway-auth.mjs';

const base = '/home/veyl/veyl', smokeRoot = process.env.VEYL_SMOKE_ROOT || base + '/data';
if (![base + '/data', base + '/worker-data/acceptance'].includes(smokeRoot)) throw new Error('Smoke data must remain in the dedicated Veyl acceptance directory.');
const directory = resolve(smokeRoot, 'smoke-' + randomUUID());
mkdirSync(directory, { recursive: true, mode: 0o700 });
const key = randomBytes(32);
// This is a test encryption key, stored owner-only for recovery of the unfunded
// daemon created by this check. No private account signing key is persisted.
writeFileSync(resolve(directory, 'smoke-state-key'), key.toString('hex'), { flag: 'wx', mode: 0o600 });
const owner = privateKeyToAccount(generatePrivateKey()).address;
const mainnetConfig = process.env.VEYL_MAINNET_CONFIG ? JSON.parse(readFileSync(process.env.VEYL_MAINNET_CONFIG, 'utf8')) : {};
const mainnet = new MainnetMarkets({ config: mainnetConfig });
const registry = new TenantRegistry({ directory: resolve(directory, 'tenants'), key, mainnet, runtimeSettings: {
  executable: process.env.VEYL_ZKAPI_CLIENTD || base + '/bin/zkapi-clientd-control',
  walletBinary: process.env.VEYL_ZKAPI_WALLETD || base + '/vendor/runtime/bin/zkapi-walletd',
  proofSetupDir: process.env.VEYL_ZKAPI_PROOF_SETUP || base + '/vendor/runtime/lib/zkapi-clientd/current/share/zkapi-clientd/proof-setup',
  ...(process.env.VEYL_ZKAPI_MANIFEST ? { manifest: process.env.VEYL_ZKAPI_MANIFEST } : {}),
  firstPort: 19800, maxRuntimes: 1
} });
const ports = [];
let app;
function footprint(pid, seen = new Set()) {
  if (seen.has(pid)) return []; seen.add(pid);
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const fields = Object.fromEntries([...status.matchAll(/^(Name|VmRSS|VmHWM):\s+(.+)$/gm)].map(m => [m[1], m[2]]));
    const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
    const children = [...new Set(readdirSync(`/proc/${pid}/task`).flatMap(tid => {
      try { return readFileSync(`/proc/${pid}/task/${tid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number); } catch { return []; }
    }))];
    return [{ pid, name: fields.Name, rssKiB: parseInt(fields.VmRSS || 0), peakRssKiB: parseInt(fields.VmHWM || 0), pssKiB: Number(/^Pss:\s+(\d+)/m.exec(rollup)?.[1] || 0) }, ...children.flatMap(child => footprint(child, seen))];
  } catch { return []; }
}
try {
  const kit = registry.get(owner), project = kit.create({ requestKey: randomUUID(), name: 'Runtime acceptance', symbol: 'QA', purpose: 'Unfunded daemon health check only; do not perform inference or transactions.', template: 'research', swarm: false, model: 'pending', total: 1000000, daily: 1000000, request: 500000 });
  const runtime = await registry.provision(owner, project);
  const entry = registry.configuration.data.projects[0]; ports.push(Number(new URL(entry.origin).port), entry.companionPort);
  const health = await runtime.provider.diagnostics({ expectedNetwork: 'mainnet' }), models = await runtime.provider.models(), funding = await runtime.funding.inspect();
  if (!health.reachable || !models.length || funding.funding.chainId !== 1 || !['ready', 'waiting_funds'].includes(funding.funding.phase)) throw new Error('Unfunded daemon acceptance failed.');
  await registry.tick();
  const auth = new WalletAuth({ origin: 'https://veyl.sh', state: { version: 1, challenges: [], sessions: [] }, save() {} });
  app = createProductionApp({ auth, registry, gateway: new GatewayVerifier({ key: randomBytes(32).toString('hex') }), origin: 'https://veyl.sh', mainnet });
  await new Promise(r => app.listen(0, '127.0.0.1', r));
  const local = `http://127.0.0.1:${app.address().port}`;
  const publicHealth = await fetch(local + '/healthz', { signal: AbortSignal.timeout(5000) });
  const privateRoute = await fetch(local + '/api/state', { signal: AbortSignal.timeout(5000) });
  if (!publicHealth.ok || privateRoute.status !== 403) throw new Error('Production HTTP gateway boundary failed acceptance.');
  const memory = footprint(process.pid);
  console.log(JSON.stringify({ success: true, directory, health: health.reachable, network: health.network, modelCount: models.length, fundingPhase: funding.funding.phase, workerHeartbeat: !!project.runtimeHeartbeat, approvalEnabled: runtime.funding.capabilities().approvalEnabled, gatewayRejectsUnauthenticated: true, memory, totalPssMiB: memory.reduce((n,p) => n + p.pssKiB, 0) / 1024, measurement: 'Unfunded production module, HTTP boundary, native runtime and model catalog only. This does not measure proof-generation or paid-inference peak memory.', paidInferenceCalls: 0, signedTransactions: 0, publicBroadcasts: 0 }));
} finally {
  if (app) await new Promise(r => app.close(r));
  registry.scheduler.stop();
  await registry.provisioner.stop();
  for (const port of ports) {
    const free = await new Promise(r => { const s = createServer(); s.once('error', () => r(false)); s.listen(port, '127.0.0.1', () => s.close(() => r(true))); });
    if (!free) throw new Error(`Smoke child did not release its reserved loopback port ${port}. Inspect only the recorded smoke process; no other service was stopped.`);
  }
}
