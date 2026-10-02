// Read-only network checks of a fresh, unfunded zkAPI profile. Run on Linux
// inside a separately bounded transient systemd service; never production state.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
const base = '/home/veyl/veyl';
if (process.platform !== 'linux') throw new Error('This measurement needs Linux /proc and a bounded service.');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const free = port => new Promise(resolve => {
  const server = createServer(); server.once('error', () => resolve(false));
  server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
});
for (const port of [19800, 19801]) if (!await free(port)) throw new Error('Measurement port is occupied; no process was touched.');
const directory = `${base}/data/footprint-${randomUUID()}`;
mkdirSync(directory, { recursive: true, mode: 0o700 });
const secret = () => randomBytes(32).toString('hex'), key = secret();
writeFileSync(`${directory}/config.json`, JSON.stringify({
  listen: '127.0.0.1:19800', api_key: key, require_api_key: true,
  key_reuse_window_seconds: 0, backend: 'zkapi', verifier_url: 'https://verifier2.openanonymity.ai', relay_url: '', concurrency: 1,
  zkapi: { client_url: 'http://127.0.0.1:19801', bridge_token: secret(), network: 'mainnet',
    binary: `${base}/vendor/runtime/bin/zkapi-walletd`,
    proof_setup_dir: `${base}/vendor/runtime/lib/zkapi-clientd/current/share/zkapi-clientd/proof-setup` }
}), { mode: 0o600, flag: 'wx' });
writeFileSync(`${directory}/management-token`, secret() + '\n', { mode: 0o600, flag: 'wx' });
const child = spawn(`${base}/bin/zkapi-clientd-control`, ['--config-dir', directory, 'serve-control'], {
  cwd: directory, shell: false, stdio: 'ignore',
  env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', GOMAXPROCS: '1', RAYON_NUM_THREADS: '1' }
});
let ended = false; child.once('exit', () => { ended = true; }); child.once('error', () => { ended = true; });
function footprint(pid, seen = new Set()) {
  if (seen.has(pid)) return []; seen.add(pid);
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const rss = Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] || 0);
    const pss = Number(/^Pss:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'))?.[1] || 0);
    // Go may spawn its companion from any OS thread, not the main thread.
    const descendants = [...new Set(readdirSync(`/proc/${pid}/task`).flatMap(task => {
      try { return readFileSync(`/proc/${pid}/task/${task}/children`, 'utf8').trim().split(/\s+/).filter(Boolean); } catch { return []; }
    }))];
    return [{ name: /^Name:\s+(.+)/m.exec(status)?.[1], rssMiB: rss / 1024, pssMiB: pss / 1024 }, ...descendants.flatMap(id => footprint(Number(id), seen))];
  } catch { return []; }
}
async function get(path) {
  const response = await fetch(`http://127.0.0.1:19800${path}`, { headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Read-only ${path} returned HTTP ${response.status}.`);
  return response.json();
}
try {
  const deadline = Date.now() + 40000; let health;
  while (!ended && Date.now() < deadline) {
    try { health = await get('/healthz'); if (health.status === 'ok') break; } catch {}
    await delay(300);
  }
  if (health?.status !== 'ok') throw new Error('Unfunded daemon did not become healthy under the measurement limits.');
  const status = await get('/admin/status'); let models, catalogError;
  // HTTP health can precede native companion policy initialization. These are
  // metadata reads only: retrying must never include completions or funding.
  for (let attempt = 0; attempt < 12 && !ended; attempt++) {
    try { models = await get('/v1/models'); break; } catch (error) { catalogError = error; await delay(1000); }
  }
  if (!models) throw catalogError || new Error('Daemon exited before its catalog was ready.');
  if (status.backend !== 'zkapi' || status.network !== 'mainnet' || !Array.isArray(models.data) || !models.data.length) throw new Error('Read-only metadata validation failed.');
  const memory = footprint(process.pid);
  const group = readFileSync('/proc/self/cgroup', 'utf8').trim().split('\n').find(line => line.startsWith('0::'))?.slice(3);
  const groupBytes = name => { try { return Number(readFileSync(`/sys/fs/cgroup${group}/${name}`, 'utf8').trim()); } catch { return null; } };
  const result = { checkedAt: new Date().toISOString(), success: true, directory, backend: status.backend, network: status.network,
    modelCount: models.data.length, exampleModels: models.data.slice(0, 10).map(m => m.id), memory,
    totalPssMiB: memory.reduce((sum, p) => sum + p.pssMiB, 0),
    cgroup: { path: group, currentBytes: groupBytes('memory.current'), peakBytes: groupBytes('memory.peak'), maxBytes: groupBytes('memory.max'), swapBytes: groupBytes('memory.swap.current') },
    scope: 'Idle Node probe plus unfunded client and native companion; no proofs or paid inference. This is not a production worker or peak-memory benchmark.',
    paidInferenceCalls: 0, signedTransactions: 0, broadcasts: 0 };
  writeFileSync(`${directory}/public-measurement.json`, JSON.stringify(result, null, 2), { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify(result));
} finally {
  if (!ended) {
    const stopped = once(child, 'exit').catch(() => {});
    child.kill('SIGTERM');
    await Promise.race([stopped, delay(10000)]);
    if (!ended) { child.kill('SIGKILL'); await Promise.race([stopped, delay(2000)]); }
  }
  for (const port of [19800, 19801]) if (!await free(port)) throw new Error('Measurement child did not release its loopback port; inspect the transient service only.');
}
