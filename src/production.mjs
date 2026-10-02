import { createServer } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress } from 'viem';
import { Problem } from './agent.mjs';
import { WalletAuth, sessionCookie } from './auth.mjs';
import { GatewayVerifier } from './gateway-auth.mjs';
import { SealedState, encryptedCodec, stateKey } from './encrypted-state.mjs';
import { Store } from './store.mjs';
import { Kit } from './kit.mjs';
import { ZkApiProvider } from './provider.mjs';
import { fundingFromEnv } from './funding.mjs';
import { MainnetMarkets } from './mainnet.mjs';
import { RuntimeProvisioner } from './runtime-provision.mjs';
import { TreasuryRunway } from './runway.mjs';
import { SocialService } from './social.mjs';
import { AgentTools } from './agent-tools.mjs';
import { GlobalScheduler } from './scheduler.mjs';
import { ResourceBudget } from './resource-budget.mjs';
import { NoteExpiryGuard } from './note-expiry.mjs';
import { FeeKeeper } from './fee-keeper.mjs';
import { loadFeeOperator } from './fee-operator.mjs';
import { TreasuryOperator, loadTreasuryOperator } from './treasury-operator.mjs';
import { ConversionKeeper } from './conversion-keeper.mjs';
import { loadConversionOperator } from './conversion-operator.mjs';
import { DeveloperKeys } from './developer-auth.mjs';
import { developerRequest } from './developer-api.mjs';
import { configuredPlatformMarket } from './platform-market.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
class UnconfiguredProvider {
  mode = 'zkapi';
  async models() { return []; }
  async complete() { throw new Problem('This project needs its own funded zkAPI runtime before it can execute.', 503); }
}
export class TenantRegistry {
  constructor({ directory, key, mainnet, feeKeeper = null, treasuryOperator = null, conversionKeeper = null, fundingSettings = {}, maxTenants = 100, maxLoadedTenants = 8, now = () => new Date(), runtimeFactory, runtimeSettings = {}, socialSettings = {}, schedulerSettings = {}, resourceSettings = {} } = {}) {
    this.directory = resolve(directory); this.key = key; this.mainnet = mainnet; this.maxTenants = maxTenants; this.now = now; this.kits = new Map(); this.runtimes = new Map(); this.tickRunning = false;
    this.runtimeFactory = runtimeFactory; this.socialSettings = socialSettings; this.socials = new Map(); mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.developerKeys = new DeveloperKeys({ file: resolve(this.directory, 'developer-keys.sealed.json'), key, now: () => +this.now() });
    this.feeKeeper = feeKeeper; this.lastFeeTick = 0;
    this.treasuryOperator = treasuryOperator; this.lastRunwayTick = 0;
    this.conversionKeeper = conversionKeeper; this.lastConversionTick = 0;
    this.lastAccountingTick = 0;
    this.financeContext = new AsyncLocalStorage(); this.financeOwners = new Map();
    // Startup capabilities are immutable for this registry. A saved daemon
    // profile is an identity binding, never authority to enable transactions.
    this.approvalEnabled = fundingSettings.transactionsEnabled === true && fundingSettings.approvalEnabled === true;
    this.maintenance = new SealedState(resolve(this.directory, 'maintenance.sealed.json'), key, 'maintenance-cursors', { version: 1, feeOwner: null, runwayOwner: null, conversionOwner: null, accountingOwner: null });
    if (this.maintenance.data.conversionOwner === undefined) this.maintenance.data.conversionOwner = null;
    if (this.maintenance.data.accountingOwner === undefined) this.maintenance.data.accountingOwner = null;
    if (this.maintenance.data.version !== 1 || ['feeOwner', 'runwayOwner', 'conversionOwner', 'accountingOwner'].some(field => this.maintenance.data[field] !== null && !/^0x[a-f0-9]{40}$/.test(this.maintenance.data[field] || ''))) throw new Error('Invalid maintenance cursor state.');
    this.maxLoadedTenants = maxLoadedTenants; this.pins = new Map(); this.backgroundOwners = new Map(); this.tenantTouches = new Map(); this.scanIndex = 0;
    if (![maxTenants, maxLoadedTenants].every(n => Number.isSafeInteger(n) && n > 0) || maxLoadedTenants > maxTenants) throw new Error('Invalid tenant capacity.');
    this.owners = new Set(readdirSync(this.directory, { withFileTypes: true }).filter(e => e.isDirectory() && /^0x[a-f0-9]{40}$/.test(e.name)).map(e => e.name));
    this.resources = new ResourceBudget({ directory: this.directory, ...resourceSettings });
    this.configuration = new SealedState(resolve(this.directory, 'runtimes.sealed.json'), key, 'runtime-configuration', { version: 1, projects: [] });
    this.reloadConfiguration();
    this.provisioner = new RuntimeProvisioner({ directory: this.directory, configuration: this.configuration.data, save: () => this.configuration.save(), ...runtimeSettings });
    this.provisioner.canStop = async entry => {
      const lease = this.pin(entry.owner), kit = lease.kit;
      try {
      if (kit.operations.has(entry.projectId) || kit.store.data.jobs.some(job => job.projectId === entry.projectId && job.status === 'running')) return false;
      const runtime = this.runtimes.get(`${entry.owner.toLowerCase()}:${entry.projectId}`); if (!runtime) return false;
      try {
        const info = await runtime.rawFunding.inspect();
        if (!['ready', 'waiting_funds', 'active'].includes(info.funding.phase)) return false;
        const withdrawal = await runtime.rawFunding.inspectOperation('withdrawal');
        if (!['no_note', 'ready', 'complete'].includes(withdrawal.phase)) return false;
        const returned = await runtime.rawFunding.inspectOperation('return');
        const journal = runtime.rawFunding.snapshot();
        return !kit.operations.has(entry.projectId) && !kit.store.data.jobs.some(job => job.projectId === entry.projectId && job.status === 'running') && ['ready', 'quoted', 'complete'].includes(returned.phase) && journal.persistence === 'healthy' && journal.intents.every(i => ['quoted', 'active', 'abandoned'].includes(i.status)) && journal.operations.every(i => ['quoted', 'complete', 'reverted'].includes(i.status));
      } catch { return false; }
      } finally { lease.release(); }
    };
    this.provisioner.onStopped = entry => this.runtimes.delete(`${entry.owner.toLowerCase()}:${entry.projectId}`);
    this.queueState = new SealedState(resolve(this.directory, 'scheduler.sealed.json'), key, 'global-scheduler', { version: 1, sequence: 0, lastOwner: null, entries: [] });
    const finishJob = (entry, reason) => {
      const kit = this.get(entry.owner), job = kit.store.data.jobs.find(j => j.id === entry.jobId && j.projectId === entry.projectId);
      if (!job) throw new Problem('Scheduled job state is missing; preserve the queue.', 503);
      if (['queued', 'running'].includes(job.status)) {
        job.status = 'interrupted'; job.error = reason;
        job.storageReservationBytes = 0;
        for (const step of job.steps) if (step.status === 'running') step.status = 'uncertain';
        kit.store.save();
      }
    };
    this.scheduler = new GlobalScheduler({ state: this.queueState.data, save: () => this.queueState.save(), now: () => +this.now(), ...schedulerSettings,
      run: async (entry, { signal }) => {
        let kit;
        // Dispatch is durable before this callback. An unloaded tenant may keep
        // its untouched queued job only for this exact in-memory active entry.
        // This context never survives a restart or applies to API/cache loads.
        this.dispatchBeingLoaded = entry;
        try { kit = this.get(entry.owner); } catch (error) { if (error.dispatchDeferred) return { deferred: true }; throw error; }
        finally { this.dispatchBeingLoaded = null; }
        const project = kit.project(entry.projectId), job = kit.store.data.jobs.find(j => j.id === entry.jobId);
        if (!job || job.projectId !== entry.projectId || job.reservation !== entry.reservation) throw new Problem('Queued job accounting does not match its admission.', 503);
        const pause = () => { project.status = 'paused'; kit.store.save(); };
        signal.addEventListener('abort', pause, { once: true });
        try { return await kit.runQueued(entry.jobId); } finally { signal.removeEventListener('abort', pause); }
      },
      onUncertain: entry => finishJob(entry, 'Worker dispatch was interrupted. Budget stays reserved; no automatic retry.'),
      onCancel: entry => finishJob(entry, 'Cancelled before dispatch. Existing reservations remain held.')
    });
    // Tenant ledgers are loaded on demand. The background scan visits persisted
    // owners in bounded batches so schedules survive without retaining all data.
  }
  reloadConfiguration() {
    const latest = new SealedState(this.configuration.file, this.key, 'runtime-configuration', { version: 1, projects: [] });
    if (latest.data.version !== 1 || !Array.isArray(latest.data.projects)) throw new Error('Invalid runtime configuration.');
    const seen = new Set(), daemons = new Set();
    for (const entry of latest.data.projects) {
      const owner = getAddress(entry.owner).toLowerCase(), id = `${owner}:${entry.projectId}`;
      if (!/^[a-f0-9-]{36}$/.test(entry.projectId) || seen.has(id) || daemons.has(entry.origin) || typeof entry.origin !== 'string' || typeof entry.key !== 'string' || entry.key.length < 32 || typeof entry.managementToken !== 'string' || entry.managementToken.length < 32 || entry.key === entry.managementToken) throw new Error('Each project requires one exclusive zkAPI daemon origin and distinct private credentials.');
      // Constructor validates that this is a local daemon and prevents SSRF.
      new ZkApiProvider({ base: entry.origin, key: entry.key });
      seen.add(id); daemons.add(entry.origin);
    }
    this.configuration = latest;
    if (this.provisioner) this.provisioner.configuration = latest.data;
  }
  async provision(owner, project) {
    const kit = this.get(owner);
    const ownerKey = owner.toLowerCase(); this.backgroundOwners.set(ownerKey, (this.backgroundOwners.get(ownerKey) || 0) + 1);
    try {
      if (project.runtimeProvision?.state !== 'ready') { project.runtimeProvision = { state: 'provisioning', updatedAt: this.now().toISOString() }; kit.store.save(); }
      await this.provisioner.provision(owner, project.id);
      const runtime = this.runtime(owner, project.id), models = await runtime.provider.models();
      if (!models.length) throw new Problem('The daemon returned no available models.', 503);
      if (project.model === 'pending') project.model = models[0].id;
      project.runtimeProvision = { state: 'ready', updatedAt: this.now().toISOString(), funded: false }; kit.store.save();
      return runtime;
    } catch (error) {
      project.runtimeProvision = { state: 'blocked', updatedAt: this.now().toISOString(), error: error instanceof Problem ? error.message : 'Runtime provisioning failed; saved state was preserved.' };
      kit.store.save(); throw error;
    } finally { this.backgroundOwners.set(ownerKey, this.backgroundOwners.get(ownerKey) - 1); }
  }
  async prepareProject(owner, project) {
    this.resources.assertCapacity();
    const kit = this.get(owner);
    const ownerKey = owner.toLowerCase(); this.backgroundOwners.set(ownerKey, (this.backgroundOwners.get(ownerKey) || 0) + 1);
    try {
      await this.provisioner.prepare(owner, project.id);
      project.runtimeProvision = { state: 'prepared', updatedAt: this.now().toISOString(), funded: false }; kit.store.save();
    } catch (error) { project.runtimeProvision = { state: 'blocked', updatedAt: this.now().toISOString(), error: error instanceof Problem ? error.message : 'Runtime profile could not be prepared.' }; kit.store.save(); throw error; }
    finally { this.backgroundOwners.set(ownerKey, this.backgroundOwners.get(ownerKey) - 1); }
  }
  async catalog(owner, projectId) {
    if (this.modelCatalog && Date.now() - this.modelCatalog.at < 60000) return structuredClone(this.modelCatalog.models);
    try {
      if (!this.configuration.data.projects.some(p => p.owner.toLowerCase() === owner.toLowerCase() && p.projectId === projectId)) await this.prepareProject(owner, this.get(owner).project(projectId));
      const models = await this.runtime(owner, projectId).provider.models();
      this.modelCatalog = { at: Date.now(), models }; return structuredClone(models);
    } catch (error) { if (this.modelCatalog && Date.now() - this.modelCatalog.at < 900000) return structuredClone(this.modelCatalog.models); throw error; }
  }
  async inferenceAdmission(owner, projectId) {
    try {
      return await this.financialOperation(owner, projectId, () => this.provisioner.withRuntime(owner, projectId, async () => {
        const runtime = this.runtime(owner, projectId);
        try { runtime.noteExpiry = await runtime.noteExpiryGuard.assertCanInfer(); return runtime.noteExpiry; }
        catch (error) { if (error.noteExpiry) runtime.noteExpiry = error.noteExpiry; throw error; }
      }), 'inference-admission');
    } catch (error) {
      if (error?.dispatchDeferred === true) error.admissionDeferred = true;
      throw error;
    }
  }
  async executionProvider(owner, projectId) {
    this.resources.assertCapacity();
    const kit = this.get(owner);
    if (kit.operations.has(projectId)) { const error = new Problem('Project funding or maintenance is in progress. Execution remains queued.', 409); error.dispatchDeferred = true; throw error; }
    kit.operations.add(projectId); let lease, released = false;
    const release = () => { if (!released) { released = true; lease?.release(); kit.operations.delete(projectId); } };
    try {
      if (!this.configuration.data.projects.some(p => p.owner.toLowerCase() === owner.toLowerCase() && p.projectId === projectId)) await this.prepareProject(owner, kit.project(projectId));
      lease = await this.provisioner.acquire(owner, projectId);
      const runtime = this.runtime(owner, projectId), raw = runtime.rawProvider;
      const checkReady = async () => {
        this.resources.assertCapacity();
        try { runtime.noteExpiry = await runtime.noteExpiryGuard.assertCanInfer(); }
        catch (error) { if (error.noteExpiry) runtime.noteExpiry = error.noteExpiry; throw error; }
      };
      return { mode: raw.mode, models: raw.models.bind(raw), accountingIdentity: () => raw.accountingIdentity(), callSettlement: callId => raw.callSettlement(callId),
        prepareComplete: async () => {
          // Trusted local gate, while this lease and finance exclusion remain
          // held. A one-use callback permits durable call recording after the
          // guard and before raw dispatch, without a second pre-send failure.
          await checkReady(); let used = false;
          return (input, accountingContext) => {
            if (used) throw new Problem('This locally admitted model call was already attempted.', 409);
            used = true; return raw.complete(input, accountingContext);
          };
        }, complete: async (input, accountingContext) => {
        await checkReady();
        return raw.complete(input, accountingContext);
      }, release };
    } catch (error) { release(); throw error; }
  }
  async financialOperation(owner, projectId, operation, purpose = 'owner') {
    const lease = this.pin(owner), kit = lease.kit;
    try { kit.project(projectId); } catch (error) { lease.release(); throw error; }
    if (kit.operations.has(projectId) || kit.store.data.jobs.some(job => job.projectId === projectId && job.status === 'running')) { lease.release(); throw new Problem('Wait for the project task or funding operation to finish.', 409); }
    const id = `${owner.toLowerCase()}:${projectId}`, token = Object.freeze({ id, purpose });
    kit.operations.add(projectId); this.financeOwners.set(id, token);
    try { return await this.financeContext.run(token, operation); }
    finally { this.financeOwners.delete(id); kit.operations.delete(projectId); lease.release(); }
  }
  async fundingSnapshot(owner, projectId) {
    const runtime = await this.ready(owner, projectId), kit = this.get(owner);
    if (kit.operations.has(projectId)) return { ...runtime.funding.snapshot(), noteExpiry: runtime.noteExpiry || { status: 'unknown', canInfer: false, message: 'A project operation is active. Its latest verified note expiry is not yet available.' } };
    return this.financialOperation(owner, projectId, () => this.provisioner.withRuntime(owner, projectId, async () => {
      runtime.noteExpiry = await runtime.noteExpiryGuard.inspect(); return { ...runtime.funding.snapshot(), noteExpiry: runtime.noteExpiry };
    }));
  }
  feeStatus(projectId) {
    const status = this.feeKeeper?.snapshot() || { enabled: false, chainId: 1, operator: null, persistence: 'healthy', policy: null, pending: null, entries: [] };
    return { ...status, pending: status.pending?.projectId === projectId ? status.pending : null, entries: status.entries.filter(entry => entry.projectId === projectId) };
  }
  conversionStatus(projectId) {
    const status = this.conversionKeeper?.snapshot() || { enabled: false, chainId: 1, operator: null, persistence: 'healthy', policy: null, pending: null, entries: [] };
    return { ...status, pending: status.pending?.projectId === projectId ? status.pending : null, entries: status.entries.filter(entry => entry.projectId === projectId) };
  }
  async tickConversions(owner, kit) {
    if (!this.conversionKeeper?.enabled || +this.now() - this.lastConversionTick < 30000 || !this.claimMaintenanceOwner('conversionOwner', owner)) return;
    const project = kit.store.data.projects.filter(p => p.mainnet && !kit.operations.has(p.id) && !kit.store.data.jobs.some(j => j.projectId === p.id && ['queued', 'running'].includes(j.status)))
      .sort((a, b) => (+new Date(a.conversionMaintenance?.checkedAt || 0) - +new Date(b.conversionMaintenance?.checkedAt || 0)) || a.id.localeCompare(b.id))[0];
    if (!project) return; this.lastConversionTick = +this.now();
    try {
      const result = await this.financialOperation(owner, project.id, () => { this.resources.assertCapacity(); return this.conversionKeeper.tick(project); }, 'fee-conversion');
      project.conversionMaintenance = result.projectId && result.projectId !== project.id
        ? { checkedAt: this.now().toISOString(), status: 'operator-busy' }
        : { checkedAt: this.now().toISOString(), status: result.status || 'checked', ...(result.transactionHash ? { transactionHash: result.transactionHash } : {}) };
    } catch (error) { project.conversionMaintenance = { checkedAt: this.now().toISOString(), status: 'blocked', error: error instanceof Problem ? error.message : 'Fee conversion stopped; inspect its saved journal.' }; }
    kit.store.save();
  }
  async tickFees(owner, kit) {
    if (!this.feeKeeper?.enabled || +this.now() - this.lastFeeTick < 30000) return;
    if (!this.claimMaintenanceOwner('feeOwner', owner)) return;
    const project = kit.store.data.projects.filter(p => p.mainnet && !kit.operations.has(p.id) && !kit.store.data.jobs.some(j => j.projectId === p.id && ['queued', 'running'].includes(j.status)) && (!p.feeMaintenance?.checkedAt || +this.now() - +new Date(p.feeMaintenance.checkedAt) >= 30000))
      .sort((a, b) => (+new Date(a.feeMaintenance?.checkedAt || 0) - +new Date(b.feeMaintenance?.checkedAt || 0)) || a.id.localeCompare(b.id))[0];
    if (!project) return; this.lastFeeTick = +this.now();
    try {
      const result = await this.financialOperation(owner, project.id, async () => { this.resources.assertCapacity(); return this.feeKeeper.tick(project); });
      project.feeMaintenance = result.projectId && result.projectId !== project.id
        ? { checkedAt: this.now().toISOString(), status: 'operator-busy' }
        : { checkedAt: this.now().toISOString(), status: result.status || 'checked', ...(result.transactionHash ? { transactionHash: result.transactionHash } : {}) };
    } catch (error) { project.feeMaintenance = { checkedAt: this.now().toISOString(), status: 'blocked', error: error instanceof Problem ? error.message : 'Fee maintenance failed; inspect its saved journal.' }; }
    kit.store.save();
  }
  claimMaintenanceOwner(field, owner) {
    const owners = [...this.owners].sort(), previous = this.maintenance.data[field];
    const next = owners.find(address => previous === null || address > previous) || owners[0];
    if (owner.toLowerCase() !== next) return false;
    this.maintenance.data[field] = next; this.maintenance.save(); return true;
  }
  runwayIdle(owner, projectId) {
    const id = `${owner.toLowerCase()}:${projectId}`, context = this.financeContext.getStore(), kit = this.get(owner);
    return !!context && context.purpose === 'automatic-runway' && context.id === id && this.financeOwners.get(id) === context && kit.store.healthy && kit.project(projectId).runwayAutomation?.automatic === true && kit.operations.has(projectId) && !kit.running && !kit.store.data.jobs.some(job => job.projectId === projectId && ['queued', 'running'].includes(job.status));
  }
  pauseRunway(owner, projectId) {
    const kit = this.get(owner), project = kit.project(projectId); kit.store.assertHealthy();
    const previous = project.runwayAutomation || {};
    project.runwayAutomation = { ...previous, automatic: false, revision: (previous.revision || 0) + 1, pausedAt: this.now().toISOString() }; kit.store.save();
    return { automatic: false, operationInProgress: kit.operations.has(projectId), cancellation: 'new-authorizations-only', message: 'New automatic authorizations are paused. Already submitted or signed transactions cannot be cancelled by this control.' };
  }
  async tickRunways(owner, kit) {
    if (!this.approvalEnabled || !this.treasuryOperator?.enabled || +this.now() - this.lastRunwayTick < 30000 || !this.claimMaintenanceOwner('runwayOwner', owner)) return;
    const project = kit.store.data.projects.filter(p => p.mainnet && p.runwayAutomation?.automatic === true && !kit.running && !kit.operations.has(p.id) && !kit.store.data.jobs.some(j => j.projectId === p.id && ['queued', 'running'].includes(j.status)))
      .sort((a, b) => (+new Date(a.runwayMaintenance?.checkedAt || 0) - +new Date(b.runwayMaintenance?.checkedAt || 0)) || a.id.localeCompare(b.id))[0];
    if (!project) return; this.lastRunwayTick = +this.now();
    try {
      const result = await this.financialOperation(owner, project.id, () => this.provisioner.withRuntime(owner, project.id, async () => {
        this.resources.assertCapacity();
        // Recovery is read-only. A finalized receipt must free the operator's
        // shared nonce before another bounded payment can be signed.
        await this.treasuryOperator.recover();
        return this.runtime(owner, project.id).runway.tick(project.id);
      }), 'automatic-runway');
      project.runwayMaintenance = { checkedAt: this.now().toISOString(), status: result.status || 'checked' };
    } catch (error) { project.runwayMaintenance = { checkedAt: this.now().toISOString(), status: 'blocked', error: error instanceof Problem ? error.message : 'Automatic funding stopped; inspect its saved recovery state.' }; }
    kit.store.save();
  }
  async tickAccounting(owner, kit) {
    const now = +this.now();
    if (now - this.lastAccountingTick < 60000 || kit.running || !this.claimMaintenanceOwner('accountingOwner', owner)) return;
    const project = kit.store.data.projects.filter(p => !kit.operations.has(p.id)
      && !kit.store.data.jobs.some(job => job.projectId === p.id && job.status === 'running')
      && (!p.accountingMaintenance?.checkedAt || now - +new Date(p.accountingMaintenance.checkedAt) >= 60000)
      && kit.pendingAccounting(p.id) > 0)
      .sort((a, b) => (+new Date(a.accountingMaintenance?.checkedAt || 0) - +new Date(b.accountingMaintenance?.checkedAt || 0)) || a.id.localeCompare(b.id))[0];
    if (!project) return;
    // A single bounded recovery batch per minute. This reads saved receipts,
    // including interrupted jobs, and never retries an inference request.
    this.lastAccountingTick = now;
    try {
      const result = await this.financialOperation(owner, project.id, () => this.provisioner.withRuntime(owner, project.id, async () => {
        this.resources.assertCapacity();
        return kit.reconcileCalls(project.id, this.runtime(owner, project.id).rawProvider, { limit: 8 });
      }), 'accounting-reconciliation');
      project.accountingMaintenance = { checkedAt: this.now().toISOString(), status: result.pending ? 'pending' : 'settled', checked: result.checked, settled: result.settled, pending: result.pending };
    } catch { project.accountingMaintenance = { checkedAt: this.now().toISOString(), status: 'blocked', error: 'Charge reconciliation is unavailable. Unresolved reservations remain held.' }; }
    kit.store.save();
  }
  async ready(owner, projectId) {
    const project = this.get(owner).project(projectId);
    if (!this.provisioner.children.has(projectId)) return this.provision(owner, project);
    return this.runtime(owner, projectId);
  }
  social(owner, projectId) {
    this.get(owner).project(projectId);
    const id = `${getAddress(owner).toLowerCase()}:${projectId}`;
    if (!this.socials.has(id)) {
      if (this.socials.size >= 8) { const idle = [...this.socials].find(([, service]) => service.canEvict?.()); if (!idle) throw new Problem('Social connection workers are busy.', 503); this.socials.delete(idle[0]); }
      this.socials.set(id, new SocialService({ file: resolve(this.directory, owner.toLowerCase(), projectId, 'social.sealed.json'), key: this.key, owner, projectId, ...this.socialSettings }));
    }
    return this.socials.get(id);
  }
  runtime(owner, projectId) {
    const id = `${getAddress(owner).toLowerCase()}:${projectId}`;
    const entry = this.configuration.data.projects.find(p => `${p.owner.toLowerCase()}:${p.projectId}` === id);
    if (!entry) throw new Problem('This project needs a dedicated zkAPI runtime. Its work and spending remain disabled until provisioned.', 503);
    const cached = this.runtimes.get(id);
    if (cached) return cached;
    const directory = resolve(this.directory, owner.toLowerCase(), projectId); mkdirSync(directory, { recursive: true, mode: 0o700 });
    const rawProvider = new ZkApiProvider({ base: entry.origin, key: entry.key });
    const rawFunding = fundingFromEnv({ file: resolve(directory, 'funding-intents.json'), localMode: true,
      authorizeApproval: () => { if (this.financeContext.getStore()?.purpose === 'automatic-runway' && !this.runwayIdle(owner, projectId)) throw new Problem('Automatic funding was paused before daemon authorization.', 409); },
      env: { ZKAPI_ORIGIN: entry.origin, ZKAPI_LOCAL_KEY: entry.key, ZKAPI_MANAGEMENT_TOKEN: entry.managementToken, VEYL_ENABLE_ZKAPI_APPROVAL: this.approvalEnabled ? 'true' : 'false' } });
    const wrap = (target, pure = []) => new Proxy(target, { get: (object, property) => typeof object[property] !== 'function' ? object[property] : pure.includes(property) ? object[property].bind(object) : (...args) => this.provisioner.withRuntime(owner, projectId, () => object[property](...args)) });
    const provider = wrap(rawProvider), funding = wrap(rawFunding, ['snapshot', 'capabilities']);
    const signer = this.treasuryOperator?.enabled && this.approvalEnabled ? {
      account: { address: this.treasuryOperator.signer.address },
      sendTransaction: request => this.treasuryOperator.forProject({ project: this.get(owner).project(projectId), funding: rawFunding, getRunway: () => { const state = runtime.runway.snapshot(); return { ...state, policy: state.policy ? { ...state.policy, automatic: state.policy.automatic && this.runwayIdle(owner, projectId) } : null }; } }).sendTransaction(request)
    } : null;
    const runtime = this.runtimeFactory ? this.runtimeFactory({ owner, projectId, directory, entry, provider, funding, mainnet: this.mainnet }) : { provider, funding,
      runway: new TreasuryRunway({ file: resolve(directory, 'runway.json'), funding, client: this.mainnet.client, signer, enableAutomatic: !!signer,
        now: () => +this.now(), isIdle: () => this.runwayIdle(owner, projectId), inspectNote: () => runtime.noteExpiryGuard.inspect({ forWithdrawal: true }) }) };
    runtime.rawProvider = rawProvider; runtime.rawFunding = rawFunding;
    runtime.noteExpiryGuard = new NoteExpiryGuard({ funding: rawFunding, client: this.mainnet.client, now: () => +this.now() });
    this.runtimes.set(id, runtime); return runtime;
  }
  get(owner) {
    owner = getAddress(owner).toLowerCase(); this.tenantTouches.set(owner, +this.now()); if (this.kits.has(owner)) return this.kits.get(owner);
    if (!this.owners.has(owner) && this.owners.size >= this.maxTenants) throw new Problem('Runtime account capacity has been reached.', 503);
    if (this.kits.size >= this.maxLoadedTenants) {
      const idle = [...this.kits].filter(([address, kit]) => kit.store.healthy && !this.pins.get(address) && !this.backgroundOwners.get(address) && !kit.running && !kit.operations.size).sort(([a], [b]) => (this.tenantTouches.get(a) || 0) - (this.tenantTouches.get(b) || 0));
      if (!idle.length) { const error = new Problem('Runtime memory slots are temporarily busy.', 503); error.dispatchDeferred = true; throw error; }
      this.kits.delete(idle[0][0]);
    }
    const store = new Store(resolve(this.directory, owner, 'kit.sealed.json'), 'zkapi', encryptedCodec(this.key, `tenant:${owner}`), { preserveQueued: job => {
      if (this.scheduler.canRestore(owner, job.projectId, job.id, job.reservation)) return true;
      const dispatch = this.dispatchBeingLoaded, active = dispatch && this.scheduler.active.get(dispatch.id)?.entry;
      return this.scheduler.healthy && active?.status === 'running' && dispatch.owner === owner && dispatch.projectId === job.projectId && dispatch.jobId === job.id && dispatch.reservation === job.reservation && active.owner === owner && active.projectId === job.projectId && active.jobId === job.id && active.reservation === job.reservation;
    } });
    const provider = new UnconfiguredProvider();
    const chain = { status: async () => ({ available: true, chainId: 1, mode: 'wallet', transactions: 'user-signed', account: getAddress(owner) }) };
    const kit = new Kit({ store, provider, chain, now: this.now, providerForProject: p => this.executionProvider(owner, p.id), providerCatalogForProject: p => this.catalog(owner, p.id),
      fundingForProject: async p => (await this.ready(owner, p.id)).funding, beforeAdmission: p => this.inferenceAdmission(owner, p.id), agentTools: new AgentTools({ client: this.mainnet?.client }), prepareSocialDraft: (project, input) => this.social(owner, project.id).draft(input) });
    kit.queue = { assertCapacity: () => { this.resources.assertCapacity(); return this.scheduler.assertCapacity(owner); }, enqueue: input => { const entry = this.scheduler.enqueue({ owner, ...input }); setImmediate(() => this.scheduler.tick().catch(() => {})); return entry; } };
    // Hooks are explicit rather than selecting a daemon from untrusted request data.
    kit.providerForProject = p => this.executionProvider(owner, p.id);
    this.kits.set(owner, kit); this.owners.add(owner); return kit;
  }
  pin(owner) { const kit = this.get(owner), key = owner.toLowerCase(); this.pins.set(key, (this.pins.get(key) || 0) + 1); let released = false; return { kit, release: () => { if (!released) { released = true; this.pins.set(key, this.pins.get(key) - 1); } } }; }
  health() { return { healthy: this.configuration.healthy && this.maintenance.healthy && this.scheduler.healthy && this.developerKeys.store.healthy && this.feeKeeper?.journal?.healthy !== false && this.treasuryOperator?.journal?.healthy !== false && this.conversionKeeper?.journal?.healthy !== false && [...this.kits.values()].every(k => k.store.healthy), tenants: this.kits.size, executing: [...this.kits.values()].filter(k => k.running).length }; }
  async tick() {
    if (this.tickRunning) return; this.tickRunning = true;
    try {
      const owners = [...this.owners], selected = [];
      for (let n = 0; n < Math.min(5, owners.length); n++) { const owner = owners[this.scanIndex++ % owners.length]; try { selected.push(this.pin(owner)); } catch {} }
      for (const lease of selected) { const kit = lease.kit;
      try {
        await kit.tick();
        await this.tickFees(owners.find(owner => this.kits.get(owner) === kit), kit);
        await this.tickConversions(owners.find(owner => this.kits.get(owner) === kit), kit);
        await this.tickRunways(owners.find(owner => this.kits.get(owner) === kit), kit);
        await this.tickAccounting(owners.find(owner => this.kits.get(owner) === kit), kit);
        if (!kit.store.data.workerHeartbeat || +this.now() - +new Date(kit.store.data.workerHeartbeat.checkedAt) >= 30_000) {
          const checkedAt = this.now().toISOString(); kit.store.data.workerHeartbeat = { checkedAt, status: 'online' };
          for (const project of kit.store.data.projects) project.runtimeHeartbeat = { checkedAt, worker: 'online', daemon: this.provisioner.children.has(project.id) ? 'running' : 'stopped', executing: kit.running && kit.store.data.jobs.some(j => j.projectId === project.id && j.status === 'running') };
          kit.store.save();
        }
      } catch { /* Persistence failures remain visible in health and block writes. */ }
      finally { lease.release(); }
    } await this.scheduler.tick(); if (!this.lastPoolCheck || +this.now() - this.lastPoolCheck > 10000) { this.lastPoolCheck = +this.now(); await this.provisioner.evictIdle(); } }
    finally { this.tickRunning = false; }
  }
}

export function createProductionApp({ auth, registry, gateway, origin, mainnet, transactionsEnabled = false, platformMarket = configuredPlatformMarket(mainnet) }) {
  const rates = new Map();
  const rateLimit = address => {
    const now = Date.now();
    if (rates.size >= 10000) for (const [key, value] of rates) if (value.until <= now) rates.delete(key);
    let rate = rates.get(address.toLowerCase());
    if (!rate || rate.until <= now) { if (!rate && rates.size >= 10000) throw new Problem('API rate limiter is temporarily busy.', 503); rate = { until: now + 60000, count: 0 }; rates.set(address.toLowerCase(), rate); }
    if (++rate.count > 180) throw new Problem('Too many requests. Try again shortly.', 429);
  };
  return createServer(async (req, res) => {
    let tenantLease; const requestId = randomUUID();
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Request-Id', requestId);
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? String(v) : v)); };
    try {
      if (req.method === 'GET' && req.url === '/healthz') return json(registry.health().healthy ? 200 : 503, { status: registry.health().healthy ? 'ok' : 'blocked', service: 'veyl-runtime' });
      if (!['GET', 'POST'].includes(req.method)) throw new Problem('Method not allowed.', 405);
      const chunks = []; let length = 0;
      for await (const chunk of req) { length += chunk.length; if (length > 40_000) throw new Problem('Request too large.', 413); chunks.push(chunk); }
      const raw = Buffer.concat(chunks);
      gateway.verify({ method: req.method, path: req.url, headers: req.headers, body: raw });
      const url = new URL(req.url, origin), path = url.pathname, parts = path.split('/').filter(Boolean), cookie = req.headers.cookie || '', client = req.headers['x-veyl-client'] || 'unknown';
      const developerPath = path.startsWith('/api/developer/v1/'), bearer = req.headers.authorization !== undefined;
      if (bearer && (!developerPath || req.headers.origin || cookie)) throw new Problem('Developer credentials are allowed only on server-to-server developer endpoints.', 403);
      if (req.headers.origin && req.headers.origin !== origin) throw new Problem('Same-origin access required.', 403);
      if (req.method === 'POST' && ((!developerPath && req.headers.origin !== origin) || req.headers['content-type'] !== 'application/json')) throw new Problem('Invalid session request.', 403);
      let body = {};
      if (req.method === 'POST') { try { body = JSON.parse(raw); } catch { throw new Problem('Invalid JSON.'); } if (!body || Array.isArray(body) || typeof body !== 'object') throw new Problem('Expected a JSON object.'); }
      if (developerPath) {
        const identity = registry.developerKeys.authenticate(req.headers.authorization, client); rateLimit(identity.address);
        tenantLease = registry.pin(identity.address);
        const result = await developerRequest({ identity, method: req.method, url, body, registry, kit: tenantLease.kit });
        return json(result.status, result.body);
      }
      if (path === '/api/market' && req.method === 'GET') {
        if (url.search) throw new Problem('The public market endpoint does not accept parameters.', 400);
        rateLimit('public-market:' + client);
        return json(200, await platformMarket.publicSnapshot(transactionsEnabled));
      }
      if (path === '/api/session' && req.method === 'GET') {
        const session = auth.session(cookie);
        return json(200, { mode: 'production', authenticated: !!session, ...(session ? { address: session.address, csrf: session.csrf } : {}) });
      }
      if (path === '/api/auth/challenge' && req.method === 'POST') return json(200, auth.challenge(body, client));
      if (path === '/api/auth/verify' && req.method === 'POST') {
        const session = await auth.authenticate(body, client); res.setHeader('Set-Cookie', sessionCookie(session.token));
        return json(200, { address: session.address, csrf: session.csrf, expiresAt: session.expiresAt });
      }
      const session = auth.require(cookie, req.method === 'POST' ? (req.headers['x-agent-csrf'] || '') : undefined);
      if (path === '/api/auth/logout' && req.method === 'POST') { auth.logout(cookie, req.headers['x-agent-csrf']); res.setHeader('Set-Cookie', sessionCookie('', 0)); return json(200, { loggedOut: true }); }
      rateLimit(session.address);
      tenantLease = registry.pin(session.address); const kit = tenantLease.kit, checkpoint = () => kit.store.save();
      if (parts[0] === 'api' && parts[1] === 'platform-market') {
        if (url.search || parts.length !== 3) throw new Problem('Platform market endpoint not found.', 404);
        if (req.method === 'GET' && parts[2] === 'status') return json(200, await platformMarket.status(kit, session.address));
        if (req.method === 'GET' && parts[2] === 'capabilities') return json(200, { ...platformMarket.capabilities(), transactionsEnabled });
        if (req.method === 'POST' && ['quote', 'swap', 'maintenance', 'verify'].includes(parts[2])) return json(200, await platformMarket.execute(kit, session.address, parts[2], body, transactionsEnabled));
        throw new Problem('Platform market endpoint not found.', 404);
      }
      if (path === '/api/state' && req.method === 'GET') {
        const state = kit.snapshot();
        return json(200, { ...state, hosted: true, wallet: session.address, csrf: session.csrf, queue: registry.scheduler.snapshot(session.address), workerHeartbeat: kit.store.data.workerHeartbeat || null, capabilities: { ...state.capabilities, token: 'ethereum-user-signed', pools: 'ethereum-uniswap-v4', inference: 'per-project-zkapi', publishing: false, transactionsEnabled }, runtimeProjects: kit.store.data.projects.map(p => ({ projectId: p.id, state: p.runtimeProvision?.state || 'not-provisioned', running: registry.provisioner.children.has(p.id), configured: registry.configuration.data.projects.some(c => c.owner.toLowerCase() === session.address.toLowerCase() && c.projectId === p.id) })) });
      }
      if (path === '/api/chain' && req.method === 'GET') return json(200, await kit.chain.status());
      if (path === '/api/mainnet/capabilities' && req.method === 'GET') return json(200, { ...mainnet.capabilities(), transactionsEnabled });
      if (path === '/api/models' && req.method === 'GET') {
        const configured = kit.store.data.projects.find(p => registry.configuration.data.projects.some(c => c.owner.toLowerCase() === session.address.toLowerCase() && c.projectId === p.id));
        return json(200, configured ? await registry.catalog(session.address, configured.id) : []);
      }
      if (path === '/api/funding' && req.method === 'GET') return json(200, { credentialsConfigured: false, approvalEnabled: false, perProject: true, intents: [] });
      if (path === '/api/projects' && req.method === 'POST') {
        registry.resources.assertCapacity();
        if (kit.store.data.projects.length >= 50) throw new Problem('This account has reached its project limit.', 409);
        const project = kit.create({ ...body, model: body.model || 'pending' });
        // Provisioning has no funding or signing step and survives browser closure.
        registry.prepareProject(session.address, project).catch(() => {});
        return json(201, project);
      }
      if (parts[0] === 'api' && parts[1] === 'artifacts' && parts.length === 3 && req.method === 'GET') {
        const artifact = kit.store.data.projects.flatMap(p => p.artifacts).find(a => a.id === parts[2]); if (!artifact) throw new Problem('Artifact not found.', 404);
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="deliverable-${artifact.id}.md"` }); return res.end(`# ${artifact.title}\n\n${artifact.content}\n`);
      }
      if (parts[0] === 'api' && parts[1] === 'projects' && parts.length >= 4) {
        const project = kit.project(parts[2]);
        if (parts[3] === 'developer-keys') {
          if (parts.length === 4 && req.method === 'GET') return json(200, { keys: registry.developerKeys.list(session.address, project.id) });
          if (parts.length === 4 && req.method === 'POST') { registry.resources.assertCapacity(); return json(201, registry.developerKeys.issue(session.address, project.id, body)); }
          if (parts.length === 6 && parts[5] === 'revoke' && req.method === 'POST') return json(200, registry.developerKeys.revoke(session.address, project.id, parts[4]));
          throw new Problem('Developer-key endpoint not found.', 404);
        }
        if (parts[3] === 'keeper' && parts.length === 4 && req.method === 'GET') return json(200, registry.feeStatus(project.id));
        if (parts[3] === 'conversion-keeper' && parts.length === 4 && req.method === 'GET') return json(200, registry.conversionStatus(project.id));
        if (parts[3] === 'jobs' && parts.length === 6 && parts[5] === 'cancel' && req.method === 'POST') {
          if (!kit.store.data.jobs.some(j => j.id === parts[4] && j.projectId === project.id)) throw new Problem('Job not found.', 404);
          return json(200, await registry.scheduler.cancel(session.address, parts[4]));
        }
        if (parts[3] === 'mainnet') {
          if (req.method === 'GET' && parts.length === 4) return json(200, await mainnet.status(project, session.address));
          if (req.method === 'GET' && parts.length === 5 && parts[4] === 'status') return json(200, await mainnet.status(project, session.address));
          if (req.method === 'GET' && parts.length === 5 && parts[4] === 'capabilities') return json(200, { ...mainnet.capabilities(project), transactionsEnabled });
          if (req.method === 'POST' && parts.length === 5) {
            kit.store.assertHealthy();
            if (kit.operations.has(project.id)) throw new Problem('A project operation is already running.', 409);
            kit.operations.add(project.id);
            try {
              const input = { ...body, account: session.address };
              const method = { factory: 'prepareFactory', launch: 'prepareLaunch', adopt: 'adoptMainnet', quote: 'quote', swap: 'prepareSwap', maintenance: 'prepareMaintenance', verify: 'verify' }[parts[4]];
              if (!method) throw new Problem('Not found.', 404);
              return json(200, await mainnet[method](project, input, checkpoint));
            } finally { kit.operations.delete(project.id); }
          }
        }
        if (parts[3] === 'models' && parts.length === 4 && req.method === 'GET') return json(200, await registry.catalog(session.address, project.id));
        if (parts[3] === 'runtime' && parts.length === 5 && parts[4] === 'provision' && req.method === 'POST') { await registry.provision(session.address, project); return json(200, project.runtimeProvision); }
        if (parts[3] === 'social') {
          const social = registry.social(session.address, project.id);
          if (req.method === 'GET' && parts.length === 4) return json(200, social.snapshot());
          if (req.method === 'POST' && parts.length === 5) {
            kit.store.assertHealthy();
            const method = { 'x-app': 'configureXApp', 'x-begin': 'beginX', 'x-complete': 'completeX', telegram: 'connectTelegram', disconnect: 'disconnect', draft: 'draft', publish: 'publish', cancel: 'cancel' }[parts[4]];
            if (!method) throw new Problem('Not found.', 404);
            if (parts[4] === 'draft') registry.resources.assertCapacity();
            return json(200, await social[method](body));
          }
        }
        if (parts[3] === 'runway') {
          if (req.method === 'POST' && parts.length === 5 && parts[4] === 'pause') return json(200, registry.pauseRunway(session.address, project.id));
          const runtime = await registry.ready(session.address, project.id);
          if (req.method === 'GET' && parts.length === 4) return json(200, { ...runtime.runway.snapshot(), scheduling: project.runwayAutomation || { automatic: false }, capabilities: { automaticAvailable: transactionsEnabled && registry.approvalEnabled && registry.treasuryOperator?.enabled === true, operator: registry.treasuryOperator?.signer?.address || null }, maintenance: project.runwayMaintenance || null });
          if (req.method === 'POST' && parts.length === 5) {
            return await registry.financialOperation(session.address, project.id, async () => {
            kit.store.assertHealthy(); const input = { ...body, projectId: project.id };
            if (parts[4] === 'configure') {
              const revision = project.runwayAutomation?.revision || 0;
              const market = await mainnet.status(project, session.address);
              if (!market.launched || market.owner.toLowerCase() !== session.address.toLowerCase()) throw new Problem('Verify a market treasury owned by this wallet before configuring runway.', 409);
              if (body.automatic !== undefined && typeof body.automatic !== 'boolean') throw new Problem('Automatic funding must be an explicit boolean.');
              if (body.closeBeforeExpiry !== undefined && typeof body.closeBeforeExpiry !== 'boolean') throw new Problem('Expiry closure must be an explicit boolean.');
              if (body.automatic === true && !(transactionsEnabled && registry.approvalEnabled && registry.treasuryOperator?.enabled && market.operator.toLowerCase() === registry.treasuryOperator.signer.address.toLowerCase())) throw new Problem('Automatic funding requires all worker permissions and its separate treasury operator to match the onchain operator.', 409);
              const configured = await runtime.runway.configure({ ...input, treasury: market.market.treasury, owner: market.owner, operator: market.operator, automatic: body.automatic === true, closeBeforeExpiry: body.closeBeforeExpiry === true });
              if ((project.runwayAutomation?.revision || 0) !== revision) throw new Problem('Automatic funding was paused while this configuration was being prepared. Review the policy again to re-enable it.', 409);
              project.runwayAutomation = { automatic: configured.policy.automatic, closeBeforeExpiry: configured.policy.closeBeforeExpiry === true, revision: revision + 1 }; checkpoint();
              return json(200, configured);
            }
            const method = { prepare: 'prepare', confirm: 'confirm', recover: 'recover', sync: 'sync', 'recovery-fee': 'prepareRecoveryFee', 'abandon-unsigned': 'abandonUnsigned' }[parts[4]];
            if (!method) throw new Problem('Not found.', 404);
            return json(200, await runtime.runway[method](input));
            });
          }
        }
        if (parts[3] === 'funding') {
          if (req.method === 'POST' && ['approve', 'resume', 'operation-approve', 'operation-resume'].includes(parts[4]) && !(transactionsEnabled && registry.approvalEnabled)) throw new Problem('zkAPI funding requires both mainnet transactions and daemon approval to be enabled by the worker.', 403);
          const runtime = await registry.ready(session.address, project.id);
          if (req.method === 'GET' && parts.length === 4) return json(200, await registry.fundingSnapshot(session.address, project.id));
          if (req.method === 'POST' && parts.length === 5) {
            return await registry.financialOperation(session.address, project.id, async () => {
            kit.store.assertHealthy();
            if (parts[4] === 'inspect') return json(200, await runtime.funding.inspect());
            if (parts[4] === 'quote') return json(200, await runtime.funding.quote(body));
            if (parts[4] === 'refresh') return json(200, await runtime.funding.refresh(body.intentId));
            if (parts[4] === 'recover') return json(200, await runtime.funding.recover(body.intentId));
            if (parts[4] === 'operation-inspect') return json(200, await runtime.funding.inspectOperation(body.kind));
            if (parts[4] === 'operation-quote') {
              const allowed = [session.address, project.mainnet?.treasury].filter(Boolean).map(a => a.toLowerCase());
              if (typeof body.destination !== 'string' || !allowed.includes(body.destination.toLowerCase())) throw new Problem('Recovery funds must return to this wallet or its project treasury.', 403);
              return json(200, await runtime.funding.quoteOperation(body));
            }
            if (parts[4] === 'operation-refresh') return json(200, await runtime.funding.refreshOperation(body.intentId));
            if (parts[4] === 'operation-recover') return json(200, await runtime.funding.recoverOperation(body.intentId));
            if (['approve', 'resume', 'operation-approve', 'operation-resume'].includes(parts[4])) {
              if (!(transactionsEnabled && registry.approvalEnabled)) throw new Problem('zkAPI funding requires both mainnet transactions and daemon approval to be enabled by the worker.', 403);
              const method = { approve: 'approve', resume: 'resume', 'operation-approve': 'approveOperation', 'operation-resume': 'resumeOperation' }[parts[4]];
              return json(200, await runtime.funding[method](body));
            }
            throw new Problem('Not found.', 404);
            });
          }
        }
        if (parts.length === 4 && req.method === 'POST') {
          switch (parts[3]) {
            case 'pause': return json(200, kit.pause(project.id));
            case 'notes': return json(200, kit.note(project.id, body.content));
            case 'sources': return json(200, await kit.source(project.id, body.url));
            case 'schedule': return json(200, kit.schedule(project.id, body));
            case 'settings': return json(200, await kit.settings(project.id, body));
            case 'jobs': if (kit.operations.has(project.id)) throw new Problem('Wait for project funding or maintenance before submitting work.', 409); return json(202, await kit.submit(project.id, body));
          }
        }
      }
      throw new Problem('Not found.', 404);
    } catch (error) { const status = error instanceof Problem ? error.status : 500; json(status, { error: error instanceof Problem ? error.message : 'Runtime operation failed. Preserve recovery state before retrying.', code: error instanceof Problem && /^[A-Z_]{1,64}$/.test(error.code || '') ? error.code : ({ 400: 'INVALID_REQUEST', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 429: 'RATE_LIMITED', 503: 'SERVICE_UNAVAILABLE', 507: 'STORAGE_FULL' }[status] || 'INTERNAL_ERROR'), requestId }); }
    finally { tenantLease?.release(); }
  });
}

export function configuredFeeKeeper({ directory, mainnet, env = process.env }) {
  const enabled = env.VEYL_FEE_KEEPER_ENABLED === 'true';
  if (enabled && env.VEYL_ENABLE_MAINNET_TRANSACTIONS !== 'true') throw new Problem('Mainnet transactions must be explicitly enabled before arming fee maintenance.', 503);
  const signer = loadFeeOperator({ env, forbiddenAddresses: Object.values(mainnet.config?.addresses || {}).filter(Boolean), forbiddenDirectories: [root, directory] });
  return new FeeKeeper({ file: resolve(directory, 'fee-keeper.json'), markets: mainnet, signer, enabled,
    dailyGasLimitWei: env.VEYL_FEE_DAILY_GAS_LIMIT_WEI, maxFeePerGasWei: env.VEYL_FEE_MAX_FEE_PER_GAS_WEI,
    maxPriorityFeePerGasWei: env.VEYL_FEE_MAX_PRIORITY_FEE_PER_GAS_WEI, maxGasPerTransaction: env.VEYL_FEE_MAX_GAS_PER_TRANSACTION,
    minRevenueWei: env.VEYL_FEE_MIN_REVENUE_WEI, minQuoteRevenue: env.VEYL_FEE_MIN_QUOTE_REVENUE });
}

export function configuredConversionKeeper({ directory, mainnet, feeKeeper, treasuryOperator, env = process.env }) {
  const enabled = env.VEYL_CONVERSION_KEEPER_ENABLED === 'true';
  if (enabled && env.VEYL_ENABLE_MAINNET_TRANSACTIONS !== 'true') throw new Problem('Mainnet transactions must be explicitly enabled before arming fee conversion.', 503);
  const forbiddenAddresses = [...Object.values(mainnet.config?.addresses || {}).filter(Boolean), feeKeeper?.signer?.address, treasuryOperator?.signer?.address].filter(Boolean);
  const signer = loadConversionOperator({ env, forbiddenAddresses, forbiddenDirectories: [root, directory] });
  return new ConversionKeeper({ file: resolve(directory, 'conversion-keeper.json'), markets: mainnet, signer, enabled,
    dailyGasLimitWei: env.VEYL_CONVERSION_DAILY_GAS_LIMIT_WEI, maxFeePerGasWei: env.VEYL_CONVERSION_MAX_FEE_PER_GAS_WEI,
    maxPriorityFeePerGasWei: env.VEYL_CONVERSION_MAX_PRIORITY_FEE_PER_GAS_WEI, maxGasPerTransaction: env.VEYL_CONVERSION_MAX_GAS_PER_TRANSACTION,
    minQuoteAmount: env.VEYL_CONVERSION_MIN_QUOTE_AMOUNT, slippageBps: env.VEYL_CONVERSION_SLIPPAGE_BPS === undefined ? undefined : Number(env.VEYL_CONVERSION_SLIPPAGE_BPS) });
}

export function fundingActivation(env = process.env) {
  return Object.freeze({ transactionsEnabled: env.VEYL_ENABLE_MAINNET_TRANSACTIONS === 'true', approvalEnabled: env.VEYL_ENABLE_ZKAPI_APPROVAL === 'true' });
}

export function configuredTreasuryOperator({ directory, mainnet, feeKeeper, env = process.env }) {
  const enabled = env.VEYL_AUTOMATIC_RUNWAY_ENABLED === 'true', activation = fundingActivation(env);
  if (enabled && !(activation.transactionsEnabled && activation.approvalEnabled)) throw new Problem('Mainnet transactions and zkAPI approval must both be explicitly enabled before automatic treasury funding.', 503);
  const forbiddenAddresses = [...Object.entries(mainnet.config?.addresses || {}).filter(([role, address]) => role !== 'operator' && address).map(([, address]) => address), feeKeeper?.signer?.address].filter(Boolean);
  const signer = loadTreasuryOperator({ env, forbiddenAddresses, forbiddenDirectories: [root, directory] });
  return new TreasuryOperator({ file: resolve(directory, 'treasury-operator.json'), markets: mainnet, signer, enabled, forbiddenAddresses,
    dailyGasLimitWei: env.VEYL_TREASURY_DAILY_GAS_LIMIT_WEI, maxFeePerGasWei: env.VEYL_TREASURY_MAX_FEE_PER_GAS_WEI,
    maxPriorityFeePerGasWei: env.VEYL_TREASURY_MAX_PRIORITY_FEE_PER_GAS_WEI, maxGasPerTransaction: env.VEYL_TREASURY_MAX_GAS_PER_TRANSACTION });
}

export function startProduction(env = process.env) {
  const directory = resolve(env.VEYL_DATA_DIR || resolve(root, 'data', 'production')), key = stateKey(env.VEYL_STATE_KEY), origin = env.PUBLIC_ORIGIN || 'https://veyl.sh';
  if (env.BIND_HOST && !['127.0.0.1', '::1'].includes(env.BIND_HOST)) throw new Error('The persistent worker must bind to loopback behind its authenticated gateway.');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (existsSync(resolve(directory, 'RESTORE_REQUIRES_RECONCILIATION'))) throw new Error('Restored wallet state is quarantined. Reconcile all private notes and transactions against the chain before allowing spending.');
  const lock = resolve(directory, 'process.lock');
  try { writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); } catch { throw new Error('Production state is locked. Verify that the previous worker stopped before removing its process lock.'); }
  process.once('exit', () => { try { unlinkSync(lock); } catch {} });
  const authState = new SealedState(resolve(directory, 'auth.sealed.json'), key, 'authentication', { version: 1, challenges: [], sessions: [] });
  const auth = new WalletAuth({ origin, state: authState.data, save: () => authState.save() });
  const configFile = resolve(env.VEYL_MAINNET_CONFIG || resolve(root, 'config', 'mainnet.json'));
  const mainnet = new MainnetMarkets({ config: existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : {}, origin: env.ETHEREUM_RPC_URL });
  const feeKeeper = configuredFeeKeeper({ directory, mainnet, env });
  const treasuryOperator = configuredTreasuryOperator({ directory, mainnet, feeKeeper, env });
  const conversionKeeper = configuredConversionKeeper({ directory, mainnet, feeKeeper, treasuryOperator, env });
  const registry = new TenantRegistry({ directory: resolve(directory, 'tenants'), key, mainnet, feeKeeper, treasuryOperator, conversionKeeper, fundingSettings: fundingActivation(env), maxTenants: Number(env.VEYL_MAX_TENANTS || 100), maxLoadedTenants: Number(env.VEYL_MAX_LOADED_TENANTS || 8), runtimeSettings: {
    executable: env.VEYL_ZKAPI_CLIENTD, walletBinary: env.VEYL_ZKAPI_WALLETD, proofSetupDir: env.VEYL_ZKAPI_PROOF_SETUP,
    manifest: env.VEYL_ZKAPI_MANIFEST, maxRuntimes: Number(env.VEYL_MAX_ACTIVE_RUNTIMES || 1), maxProfiles: Number(env.VEYL_MAX_RUNTIME_PROFILES || 50), maxPerOwner: Number(env.VEYL_RUNTIMES_PER_OWNER || 10), firstPort: Number(env.VEYL_DAEMON_FIRST_PORT || 19000)
  }, socialSettings: { x: { clientId: env.VEYL_X_CLIENT_ID, clientSecret: env.VEYL_X_CLIENT_SECRET, redirectUri: env.VEYL_X_REDIRECT_URI || origin + '/oauth/x' }, allowPublishing: env.VEYL_ENABLE_SOCIAL_PUBLISHING === 'true' }, schedulerSettings: { activeSlots: Number(env.VEYL_ACTIVE_JOBS || 1), maxQueued: Number(env.VEYL_MAX_QUEUED_JOBS || 100), maxPerOwner: Number(env.VEYL_MAX_QUEUED_PER_OWNER || 10) }, resourceSettings: { directory, maxBytes: Number(env.VEYL_MAX_DATA_BYTES || 2147483648), minFreeBytes: Number(env.VEYL_MIN_FREE_BYTES || 536870912) } });
  const gateway = new GatewayVerifier({ key: env.VEYL_GATEWAY_KEY });
  const app = createProductionApp({ auth, registry, gateway, origin, mainnet, transactionsEnabled: env.VEYL_ENABLE_MAINNET_TRANSACTIONS === 'true' }); app.requestTimeout = 55_000; app.headersTimeout = 10_000;
  const timer = setInterval(() => registry.tick().catch(() => {}), 1_000);
  app.listen(Number(env.PORT || 4320), env.BIND_HOST || '127.0.0.1', () => console.log('Veyl production runtime listening. Transaction permissions follow explicit worker configuration.'));
  process.on('SIGHUP', () => { try { registry.reloadConfiguration(); console.log('Runtime configuration reloaded. Restart the worker to replace a cached daemon configuration.'); } catch { console.error('Runtime configuration rejected.'); } });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    clearInterval(timer); app.close(); registry.scheduler.stop();
    await Promise.race([registry.scheduler.drain(), new Promise(r => setTimeout(r, 200_000))]);
    await registry.provisioner.stop(); process.exit(0);
  });
  return { app, registry, auth, timer };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startProduction();
