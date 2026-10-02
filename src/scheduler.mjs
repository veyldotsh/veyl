import { getAddress } from 'viem';
import { Problem } from './agent.mjs';

const TERMINAL = new Set(['completed', 'cancelled', 'uncertain']);
const STATES = new Set(['queued', 'running', ...TERMINAL]);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const clone = value => structuredClone(value);
const integer = (value, min, max, label) => { if (!Number.isSafeInteger(value) || value < min || value > max) throw new Problem(`Invalid scheduler ${label}.`, 500); return value; };
const normalizedOwner = value => { try { return getAddress(value).toLowerCase(); } catch { throw new Problem('Invalid scheduler owner.'); } };

/** One process-wide durable admission and dispatch queue.
 * The tenant Kit owns budget accounting and provider execution. enqueue() only
 * accepts references to jobs already durably reserved by that Kit. run() must
 * independently verify that saved job is still queued with that reservation.
 *
 * At-most-once dispatch: persist running BEFORE invoking run(); interrupted
 * dispatches become uncertain on restart and are never automatically retried.
 * Completion is not a claim that an external inference charge was reconciled.
 * Queued cancellation keeps the reservation held unless the Kit independently
 * proves that releasing it is safe. Running cancellation is only a stop request.
 */
export class GlobalScheduler {
  constructor({ state = { version: 1, sequence: 0, lastOwner: null, entries: [] }, save, run,
    onUncertain = async () => {}, onCancel = async () => {}, activeSlots = 2, maxQueued = 100,
    maxPerOwner = 10, maxEntries = 50000, now = Date.now } = {}) {
    if (typeof save !== 'function' || typeof run !== 'function' || typeof onUncertain !== 'function' || typeof onCancel !== 'function') throw new Problem('Scheduler persistence and execution callbacks are required.', 500);
    this.state = state; this.persist = save; this.run = run; this.onUncertain = onUncertain; this.onCancel = onCancel; this.now = now;
    this.activeSlots = integer(activeSlots, 1, 32, 'active slots'); this.maxQueued = integer(maxQueued, 1, 10000, 'queue size');
    this.maxPerOwner = integer(maxPerOwner, 1, maxQueued, 'per-owner queue size'); this.maxEntries = integer(maxEntries, maxQueued, 1000000, 'ledger size');
    this.healthy = true; this.stopped = false; this.active = new Map(); this.ticking = false; this.notifying = new Set();
    this.validate();
    let changed = false;
    for (const entry of this.state.entries) if (entry.status === 'running') {
      entry.status = 'uncertain'; entry.finishedAt = this.now(); entry.notificationPending = 'uncertain';
      entry.reason = 'Worker restarted after durable dispatch. Execution may have reached the provider; no automatic retry.'; changed = true;
    }
    if (changed) this.save();
  }
  validate() {
    const s = this.state, ids = new Set(), sequence = new Set();
    if (!s || s.version !== 1 || !Number.isSafeInteger(s.sequence) || s.sequence < 0 || !Array.isArray(s.entries) || s.entries.length > this.maxEntries || (s.lastOwner !== null && normalizedOwner(s.lastOwner) !== s.lastOwner)) throw new Problem('Invalid scheduler recovery state. Preserve the original ledger.', 503);
    for (const e of s.entries) {
      if (!e || normalizedOwner(e.owner) !== e.owner || !identifier(e.projectId) || !identifier(e.jobId) || e.id !== `${e.owner}:${e.jobId}` || ids.has(e.id) ||
          !Number.isSafeInteger(e.sequence) || e.sequence < 1 || e.sequence > s.sequence || sequence.has(e.sequence) || !STATES.has(e.status) ||
          !Number.isSafeInteger(e.reservation) || e.reservation < 1 || e.reservation > 1_000_000_000 || !Number.isSafeInteger(e.queuedAt) || e.queuedAt < 0 ||
          typeof e.cancelRequested !== 'boolean' ||
          (e.nextAttemptAt !== undefined && (!Number.isSafeInteger(e.nextAttemptAt) || e.nextAttemptAt < 0)) ||
          (e.status === 'running' && (!Number.isSafeInteger(e.startedAt) || e.startedAt < e.queuedAt)) ||
          (e.notificationPending !== undefined && !['uncertain', 'cancelled'].includes(e.notificationPending))) throw new Problem('Invalid scheduler recovery entry. Preserve the original ledger.', 503);
      ids.add(e.id); sequence.add(e.sequence);
    }
  }
  assertHealthy() { if (!this.healthy) throw new Problem('Scheduler persistence is blocked. No further jobs can dispatch.', 503); }
  save() {
    this.assertHealthy();
    try { this.validate(); this.persist(); }
    catch { this.healthy = false; throw new Problem('Scheduler persistence failed. Preserve the queue before restarting.', 503); }
  }
  get(owner, jobId) { owner = normalizedOwner(owner); return this.state.entries.find(e => e.owner === owner && e.jobId === jobId); }
  assertCapacity(owner) {
    this.assertHealthy(); if (this.stopped) throw new Problem('Worker is draining; try again after it restarts.', 503);
    owner = normalizedOwner(owner);
    // Running jobs retain their admission place: a capacity-only deferral must
    // be able to rejoin the queue without exceeding either bound.
    const waiting = this.state.entries.filter(e => e.status === 'queued' || e.status === 'running');
    if (waiting.length >= this.maxQueued) throw new Problem('The shared work queue is full. No new work was dispatched.', 429);
    if (waiting.filter(e => e.owner === owner).length >= this.maxPerOwner) throw new Problem('This wallet has reached its queued-task limit.', 429);
    // Retain terminal IDs rather than silently forgetting replay protection.
    // An operator must archive/reconcile the ledger before extending this bound.
    if (this.state.entries.length >= this.maxEntries) throw new Problem('The durable work ledger reached its configured retention limit. Existing queued work is preserved.', 503);
    return true;
  }
  enqueue({ owner, projectId, jobId, reservation }) {
    this.assertHealthy(); owner = normalizedOwner(owner);
    if (!identifier(projectId) || !identifier(jobId) || !Number.isSafeInteger(reservation) || reservation < 1 || reservation > 1_000_000_000) throw new Problem('A durably reserved project job is required.');
    const existing = this.get(owner, jobId);
    if (existing) {
      if (existing.projectId !== projectId || existing.reservation !== reservation) throw new Problem('A queue identity was reused with different job terms.', 409);
      return clone(existing);
    }
    this.assertCapacity(owner);
    const entry = { id: `${owner}:${jobId}`, owner, projectId, jobId, reservation, sequence: ++this.state.sequence,
      status: 'queued', queuedAt: this.now(), cancelRequested: false };
    this.state.entries.push(entry); this.save(); return clone(entry);
  }
  canRestore(owner, projectId, jobId, reservation) {
    const entry = this.get(owner, jobId);
    return this.healthy && entry?.status === 'queued' && entry.projectId === projectId && entry.reservation === reservation;
  }
  #next() {
    const busyOwners = new Set([...this.active.values()].map(item => item.entry.owner));
    const waiting = this.state.entries.filter(e => e.status === 'queued' && (e.nextAttemptAt || 0) <= this.now() && !busyOwners.has(e.owner));
    const owners = [...new Set(waiting.map(e => e.owner))].sort();
    if (!owners.length) return null;
    const owner = owners.find(o => o > (this.state.lastOwner || '')) || owners[0];
    return waiting.filter(e => e.owner === owner).sort((a, b) => a.sequence - b.sequence)[0];
  }
  async #notify(entry) {
    if (!entry.notificationPending || this.notifying.has(entry.id)) return;
    this.notifying.add(entry.id);
    try {
      const callback = entry.notificationPending === 'cancelled' ? this.onCancel : this.onUncertain;
      await callback(clone(entry));
      this.assertHealthy(); delete entry.notificationPending; this.save();
    } catch {
      // The terminal queue entry prevents re-execution even if its tenant
      // notification cannot yet persist. Retry only this idempotent bookkeeping.
    } finally { this.notifying.delete(entry.id); }
  }
  async tick() {
    this.assertHealthy(); if (this.ticking || this.stopped) return this.snapshot();
    this.ticking = true;
    try {
      for (const e of this.state.entries.filter(e => e.notificationPending)) await this.#notify(e);
      this.assertHealthy();
      while (!this.stopped && this.active.size < this.activeSlots) {
        const entry = this.#next(); if (!entry) break;
        entry.status = 'running'; entry.startedAt = this.now(); this.state.lastOwner = entry.owner;
        this.save(); // No provider callback is possible before this succeeds.
        const controller = new AbortController(), item = { entry, controller, promise: null };
        this.active.set(entry.id, item);
        item.promise = Promise.resolve().then(() => this.run(clone(entry), { signal: controller.signal })).then(
          result => this.#finish(entry, result),
          () => this.#finish(entry, { status: 'uncertain' })
        ).catch(() => {
          // Persistence failure leaves a durable running entry, which is
          // uncertain on restart. Never release a slot into additional work.
          this.healthy = false;
        }).finally(() => { this.active.delete(entry.id); });
      }
      return this.snapshot();
    } finally { this.ticking = false; }
  }
  async #finish(entry, result) {
    this.assertHealthy();
    if (result?.deferred === true) {
      // Only the trusted Kit callback can emit this before changing its saved
      // job to running or reaching a paid provider request. Never infer a safe
      // retry from a generic network error, timeout, or thrown exception.
      if (entry.cancelRequested) {
        entry.status = 'cancelled'; entry.finishedAt = this.now(); entry.notificationPending = 'cancelled';
      } else {
        entry.status = 'queued'; entry.nextAttemptAt = this.now() + 1000; entry.deferrals = (entry.deferrals || 0) + 1; delete entry.startedAt;
      }
      this.save(); await this.#notify(entry); return;
    }
    const status = result?.status;
    entry.status = status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'uncertain';
    entry.finishedAt = this.now();
    if (entry.status === 'uncertain') {
      entry.reason = 'Execution did not return a confirmed completed job. Reservations remain held; no automatic retry.';
      entry.notificationPending = 'uncertain';
    } else if (entry.status === 'cancelled') entry.notificationPending = 'cancelled';
    this.save(); await this.#notify(entry);
  }
  async cancel(owner, jobId) {
    this.assertHealthy(); const entry = this.get(owner, jobId);
    if (!entry) throw new Problem('Queued task not found for this wallet.', 404);
    if (entry.status === 'queued') {
      entry.status = 'cancelled'; entry.cancelRequested = true; entry.finishedAt = this.now(); entry.notificationPending = 'cancelled';
      entry.reason = 'Cancelled before dispatch. Budget remains reserved unless separately reconciled.'; this.save(); await this.#notify(entry);
    } else if (entry.status === 'running' && !entry.cancelRequested) {
      entry.cancelRequested = true; this.save(); this.active.get(entry.id)?.controller.abort();
    }
    return clone(entry);
  }
  snapshot(owner) {
    const normalized = owner === undefined ? null : normalizedOwner(owner);
    const entries = normalized ? this.state.entries.filter(e => e.owner === normalized) : this.state.entries;
    return { healthy: this.healthy, draining: this.stopped, activeSlots: this.activeSlots, maxQueued: this.maxQueued, maxPerOwner: this.maxPerOwner,
      active: entries.filter(e => e.status === 'running').length, queued: entries.filter(e => e.status === 'queued').length,
      uncertain: entries.filter(e => e.status === 'uncertain').length, ledgerUsed: this.state.entries.length, ledgerLimit: this.maxEntries,
      entries: clone(entries.filter(e => !TERMINAL.has(e.status) || e.notificationPending).concat(entries.filter(e => TERMINAL.has(e.status) && !e.notificationPending).slice(-50))) };
  }
  async drain() { await Promise.allSettled([...this.active.values()].map(item => item.promise)); return this.snapshot(); }
  stop({ cancelRunning = false } = {}) {
    this.stopped = true;
    if (cancelRunning && this.active.size) {
      for (const { entry } of this.active.values()) entry.cancelRequested = true;
      this.save(); for (const { controller } of this.active.values()) controller.abort();
    }
    return this.snapshot();
  }
}
