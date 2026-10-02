import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, writeFileSync, existsSync, readFileSync, lstatSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { Problem } from './agent.mjs';
import { ZkApiProvider, ZKAPI_SOURCE_REVISION } from './provider.mjs';

const secret = () => randomBytes(32).toString('hex');
// Reviewed mainnet issuer rotation, ethereum/zkapi 045b444ea1b52538d1b40273c7cb6ed09468a052.
const MAINNET_VERIFIER = 'https://verifier-production-20260917.openanonymity.ai';
const FORMER_MAINNET_VERIFIER = 'https://verifier2.openanonymity.ai';
async function free(port) {
  return new Promise(resolve => { const server = createServer(); server.once('error', () => resolve(false)); server.listen(port, '127.0.0.1', () => server.close(() => resolve(true))); });
}
export class RuntimeProvisioner {
  constructor({ directory, executable, walletBinary, proofSetupDir, manifest, configuration, save, maxRuntimes = 2, maxProfiles = 1000, maxPerOwner = 50, firstPort = 19000, idleMs = 60000, canStop = async () => false, spawnProcess = spawn, portFree = free, checkReady, now = Date.now }) {
    this.directory = resolve(directory); this.executable = executable; this.walletBinary = walletBinary; this.proofSetupDir = proofSetupDir; this.configuration = configuration; this.save = save; this.maxRuntimes = maxRuntimes; this.firstPort = firstPort; this.spawn = spawnProcess; this.portFree = portFree; this.now = now;
    this.checkReady = checkReady || (async entry => {
      const provider = new ZkApiProvider({ base: entry.origin, key: entry.key });
      const report = await provider.diagnostics({ expectedNetwork: 'mainnet' });
      // Wallet inspection and recovery must remain available when the public
      // model catalog is down. Admission and dispatch still fetch live policy.
      await provider.accountingIdentity();
      return report;
    });
    this.children = new Map(); this.operations = new Map(); this.leases = new Map(); this.lastUsed = new Map(); this.tail = Promise.resolve(); this.stopping = false;
    this.maxProfiles = maxProfiles; this.canStop = canStop; this.idleMs = idleMs;
    if (![maxRuntimes, maxProfiles, maxPerOwner, firstPort, idleMs].every(n => Number.isSafeInteger(n) && n > 0) || maxRuntimes > 32 || firstPort + maxProfiles * 2 >= 65535) throw new Error('Invalid runtime pool limits.');
    this.available = [executable, walletBinary, proofSetupDir].every(path => typeof path === 'string' && isAbsolute(path) && existsSync(path));
    this.maxPerOwner = maxPerOwner; this.binaryIdentityVerified = false;
    if (this.available && manifest) {
      const identity = JSON.parse(readFileSync(manifest, 'utf8')), digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
      let reviewed = identity.version === 1 && identity.patch === 'VEYL_UNFUNDED_CONTROL_V1';
      if (identity.version === 2 && identity.patch === 'VEYL_CALL_ACCOUNTING_V1') {
        const sourceLock = new URL('../deployment/native/source-lock.json', import.meta.url), lock = JSON.parse(readFileSync(sourceLock, 'utf8'));
        reviewed = identity.sourceLockSha256 === digest(sourceLock) && identity.companionRevision === lock.companionRevision && identity.protocolRevision === lock.protocolRevision && lock.daemonRevision === ZKAPI_SOURCE_REVISION;
      }
      if (!reviewed || identity.sourceRevision !== ZKAPI_SOURCE_REVISION || identity.clientSha256 !== digest(executable) || identity.walletSha256 !== digest(walletBinary) || identity.proofManifestSha256 !== digest(resolve(proofSetupDir, 'manifest.json'))) throw new Error('Runtime binary identity differs from the installed build manifest.');
      this.binaryIdentityVerified = true;
    }
  }
  status(entry) { const child = entry && this.children.get(entry.projectId); return { configured: !!entry, running: !!child && !child.veylExited, cleanupPending: !!child?.veylExited, available: this.available, binaryIdentityVerified: this.binaryIdentityVerified, reviewedSourceRevision: ZKAPI_SOURCE_REVISION }; }
  #serial(fn) { const task = this.tail.catch(() => {}).then(fn); this.tail = task; return task; }
  prepare(owner, projectId) { return this.#serial(() => this.#provision(owner, projectId, false)); }
  provision(owner, projectId) { return this.withRuntime(owner, projectId, entry => entry); }
  async acquire(owner, projectId) {
    const entry = await this.#serial(async () => {
      const entry = await this.#provision(owner, projectId, true);
      this.leases.set(projectId, (this.leases.get(projectId) || 0) + 1); this.lastUsed.set(projectId, this.now()); return entry;
    });
    let released = false;
    return { entry, release: () => { if (!released) { released = true; this.leases.set(projectId, this.leases.get(projectId) - 1); this.lastUsed.set(projectId, this.now()); } } };
  }
  async withRuntime(owner, projectId, operation) { const lease = await this.acquire(owner, projectId); try { return await operation(lease.entry); } finally { lease.release(); } }
  async #stopProject(projectId) {
    const child = this.children.get(projectId); if (!child) return;
    const groupAlive = () => {
      if (child.veylGroupGone) return false;
      if (process.platform === 'win32' || !Number.isInteger(child.pid)) return !child.veylExited;
      try { process.kill(-child.pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') { child.veylGroupGone = true; return false; } return true; }
    };
    const signal = value => { if (!groupAlive()) return; try { if (process.platform !== 'win32' && Number.isInteger(child.pid)) process.kill(-child.pid, value); else child.kill(value); } catch (error) { if (error.code !== 'ESRCH') throw error; child.veylGroupGone = true; } };
    if (!child.veylExited) await new Promise(resolve => { const timer = setTimeout(() => { signal('SIGKILL'); resolve(); }, 10000); timer.unref?.(); child.once('exit', () => { clearTimeout(timer); resolve(); }); signal('SIGTERM'); });
    // A daemon owns the process group created at spawn. Its companion must
    // finish too; an exited Go parent alone never frees a pool slot.
    signal('SIGTERM');
    const entry = this.configuration.projects.find(e => e.projectId === projectId);
    for (let attempt = 0; attempt < 40; attempt++) {
      if (!groupAlive() && await this.portFree(Number(new URL(entry.origin).port)) && await this.portFree(entry.companionPort)) { this.children.delete(projectId); this.onStopped?.(entry); return; }
      if (attempt === 20) signal('SIGKILL');
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Problem('A stopped daemon still owns its reserved ports. Inspect its saved process before recovery.', 503);
  }
  async #evict(requireSlot) {
    const candidates = [...this.children.keys()].sort((a, b) => (this.lastUsed.get(a) || 0) - (this.lastUsed.get(b) || 0));
    for (const id of candidates) {
      if (this.leases.get(id)) continue;
      if (this.children.get(id).veylExited) { await this.#stopProject(id); if (requireSlot) return true; continue; }
      if (!requireSlot && this.now() - (this.lastUsed.get(id) || 0) < this.idleMs) continue;
      const entry = this.configuration.projects.find(e => e.projectId === id);
      let safe = false; try { safe = await this.canStop(entry); } catch {}
      if (!safe) continue;
      await this.#stopProject(id); if (requireSlot) return true;
    }
    return false;
  }
  evictIdle() { return this.#serial(() => this.#evict(false)); }
  async #provision(owner, projectId, start) {
    if (this.stopping) throw new Problem('Runtime is shutting down.', 503);
    if (!this.available) throw new Problem('The pinned zkAPI daemon binaries are not installed on the worker.', 503);
    if (!/^0x[a-fA-F0-9]{40}$/.test(owner) || !/^[a-f0-9-]{36}$/.test(projectId)) throw new Problem('Invalid runtime owner or project.');
    let entry = this.configuration.projects.find(e => e.owner.toLowerCase() === owner.toLowerCase() && e.projectId === projectId);
    if (entry?.managed === false) { if (start) await this.checkReady(entry); return entry; }
    if (entry && this.children.has(projectId)) { if (this.children.get(projectId).veylExited) await this.#stopProject(projectId); else return entry; }
    if (!entry) {
      if (this.configuration.projects.length >= this.maxProfiles) throw new Problem('All dedicated runtime profiles are allocated. The project was saved; contact the operator to increase capacity.', 503);
      if (this.configuration.projects.filter(p => p.owner.toLowerCase() === owner.toLowerCase()).length >= this.maxPerOwner) throw new Problem('This wallet has reached its dedicated runtime limit. Existing projects remain available.', 503);
      const used = new Set(this.configuration.projects.flatMap(e => [Number(new URL(e.origin).port), e.companionPort]));
      let port;
      for (let candidate = this.firstPort; candidate < this.firstPort + this.maxProfiles * 2; candidate += 2) {
        if (!used.has(candidate) && !used.has(candidate + 1) && await this.portFree(candidate) && await this.portFree(candidate + 1)) { port = candidate; break; }
      }
      if (!port) throw new Problem('No private daemon port is available.', 503);
      entry = { owner, projectId, origin: `http://127.0.0.1:${port}`, companionPort: port + 1, key: secret(), managementToken: secret(), bridgeToken: secret(), managed: true, approvalEnabled: false, sourceRevision: ZKAPI_SOURCE_REVISION };
      this.configuration.projects.push(entry); this.save();
    }
    const configDirectory = resolve(this.directory, owner.toLowerCase(), projectId, 'daemon');
    mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
    if (lstatSync(configDirectory).isSymbolicLink()) throw new Problem('Daemon state directory must not be a symlink.', 503);
    const configFile = resolve(configDirectory, 'config.json'), tokenFile = resolve(configDirectory, 'management-token');
    const configuration = { listen: `127.0.0.1:${new URL(entry.origin).port}`, api_key: entry.key, require_api_key: true, key_reuse_window_seconds: 0, backend: 'zkapi', verifier_url: MAINNET_VERIFIER, relay_url: '', concurrency: 1, zkapi: { client_url: `http://127.0.0.1:${entry.companionPort}`, bridge_token: entry.bridgeToken, network: 'mainnet', binary: this.walletBinary, proof_setup_dir: this.proofSetupDir } };
    if (existsSync(configFile)) {
      if (lstatSync(configFile).isSymbolicLink()) throw new Problem('Saved daemon profile differs from its encrypted registry. Preserve recovery files.', 503);
      const saved = JSON.parse(readFileSync(configFile, 'utf8'));
      // The reviewed Go client migrates this exact former mainnet default in
      // memory. Preserve configuration bytes, credentials and wallet files.
      if (saved.verifier_url === FORMER_MAINNET_VERIFIER) saved.verifier_url = MAINNET_VERIFIER;
      if (JSON.stringify(saved) !== JSON.stringify(configuration)) throw new Problem('Saved daemon profile differs from its encrypted registry. Preserve recovery files.', 503);
    } else writeFileSync(configFile, JSON.stringify(configuration), { mode: 0o600, flag: 'wx' });
    if (existsSync(tokenFile)) {
      if (lstatSync(tokenFile).isSymbolicLink() || readFileSync(tokenFile, 'utf8').trim() !== entry.managementToken) throw new Problem('Saved daemon management credential differs. Preserve recovery files.', 503);
    } else writeFileSync(tokenFile, entry.managementToken + '\n', { mode: 0o600, flag: 'wx' });
    if (!start) return entry;
    if (this.children.size >= this.maxRuntimes && !await this.#evict(true)) {
      const error = new Problem('All daemon slots are busy or settling. This project remains queued with its own saved wallet.', 503); error.dispatchDeferred = true; throw error;
    }
    if (!await this.portFree(Number(new URL(entry.origin).port)) || !await this.portFree(entry.companionPort)) throw new Problem('A reserved daemon port is already occupied. Inspect the previous process before recovery.', 503);
    const child = this.spawn(this.executable, ['--config-dir', configDirectory, 'serve-control'], { cwd: configDirectory, windowsHide: true, shell: false, detached: process.platform !== 'win32', stdio: 'ignore', env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', GOMAXPROCS: '2', RAYON_NUM_THREADS: '2' } });
    this.children.set(projectId, child);
    let failed = false; child.once('error', () => { failed = true; child.veylExited = true; }); child.once('exit', () => { failed = true; child.veylExited = true; });
    const deadline = this.now() + 25_000;
    while (!failed && this.now() < deadline && !this.stopping) {
      try { await this.checkReady(entry); this.lastUsed.set(projectId, this.now()); return entry; } catch { await new Promise(r => setTimeout(r, 250)); }
    }
    await this.#stopProject(projectId);
    throw new Problem('The dedicated daemon did not become ready. Its saved wallet and configuration were preserved.', 503);
  }
  async stop() {
    this.stopping = true;
    await Promise.all([...this.children.keys()].map(id => this.#stopProject(id)));
  }
}
