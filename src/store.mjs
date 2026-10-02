import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { Problem } from './agent.mjs';
import { validateCall, ACCOUNTING_MARGIN_MICRO_USD } from './charge-accounting.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const amount = value => Number.isSafeInteger(value) && value >= 0;
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
export const TENANT_STATE_MAX_BYTES = 16 * 1024 * 1024;
export const MODEL_OUTPUT_RESERVE_BYTES = 256 * 1024;
const bytes = value => Buffer.byteLength(JSON.stringify(value));
function validate(data, mode) {
  const invalid = () => { throw new Error('State schema or accounting mismatch. Preserve recovery data.'); };
  if (!object(data) || data.version !== 2 || data.mode !== mode || !Array.isArray(data.projects) || !Array.isArray(data.jobs)) invalid();
  const projects = new Map(), keys = new Set(), jobs = new Set(), totals = new Map(), days = new Map(), calls = new Set(), receipts = new Set(), sessions = new Set();
  for (const p of data.projects) {
    if (!object(p) || typeof p.id !== 'string' || projects.has(p.id) || typeof p.requestKey !== 'string' || keys.has(p.requestKey) ||
        !['active', 'paused'].includes(p.status) || !['research', 'builder', 'community'].includes(p.template) || typeof p.swarm !== 'boolean' ||
        typeof p.model !== 'string' || !p.model || typeof p.purpose !== 'string' || !object(p.policy) ||
        !['total', 'daily', 'request'].every(k => amount(p.policy[k]) && p.policy[k] > 0 && p.policy[k] <= 1_000_000_000) ||
        p.policy.request > p.policy.daily || p.policy.daily > p.policy.total || !amount(p.committed) || p.committed > p.policy.total || !object(p.days) ||
        !Object.entries(p.days).every(([day, held]) => date(day) && amount(held)) ||
        !['notes', 'sources', 'artifacts', 'events'].every(k => Array.isArray(p[k])) ||
        !p.notes.every(n => object(n) && typeof n.content === 'string') || !p.sources.every(s => object(s) && typeof s.url === 'string' && typeof s.text === 'string') ||
        !p.artifacts.every(a => object(a) && typeof a.id === 'string' && typeof a.title === 'string' && typeof a.content === 'string')) invalid();
    if (p.schedule !== null && (!object(p.schedule) || ![15, 60, 1440].includes(p.schedule.minutes) || typeof p.schedule.prompt !== 'string' || !Number.isFinite(Date.parse(p.schedule.nextAt)))) invalid();
    if (p.accountingJournalId !== undefined && !/^[0-9a-f]{32}$/.test(p.accountingJournalId)) invalid();
    if (p.accountingRecoveryCursor !== undefined && !amount(p.accountingRecoveryCursor)) invalid();
    projects.set(p.id, p); keys.add(p.requestKey); totals.set(p.id, 0); days.set(p.id, new Map());
  }
  keys.clear();
  for (const job of data.jobs) {
    const p = projects.get(job?.projectId);
    if (!p || !object(job) || typeof job.id !== 'string' || jobs.has(job.id) || typeof job.requestKey !== 'string' || keys.has(job.requestKey) || job.mode !== mode ||
        !['queued', 'running', 'completed', 'interrupted'].includes(job.status) || !date(job.day) || !amount(job.cap) || job.cap === 0 || job.cap > 1_000_000_000 ||
        !amount(job.reservation) || !Array.isArray(job.steps) || ![1, 3].includes(job.steps.length)) invalid();
    if ((job.model !== undefined && (typeof job.model !== 'string' || !job.model || job.model.length > 256)) || (job.dispatch !== undefined && job.dispatch !== 'scheduler') || (job.dispatch === 'scheduler' && !job.model)) invalid();
    if (job.storageReservationBytes !== undefined && (!amount(job.storageReservationBytes) || job.storageReservationBytes > TENANT_STATE_MAX_BYTES)) invalid();
    if (job.modelCap !== undefined && (mode !== 'zkapi' || !amount(job.modelCap) || job.modelCap < 1 || job.cap !== job.modelCap + ACCOUNTING_MARGIN_MICRO_USD)) invalid();
    const heldFor = call => {
      if (call === undefined) return job.cap;
      if (job.modelCap === undefined || calls.has(call.callId)) invalid();
      const held = validateCall(call, { journalId: p.accountingJournalId, cap: job.cap, modelCap: job.modelCap });
      calls.add(call.callId);
      const session = call.report?.binding?.session_id, receipt = call.report?.receipt?.receipt_id;
      if (session) { const id = call.journalId + ':' + session; if (sessions.has(id)) invalid(); sessions.add(id); }
      if (receipt) { const id = call.journalId + ':' + receipt; if (receipts.has(id)) invalid(); receipts.add(id); }
      return held;
    };
    let reservation = 0;
    for (const step of job.steps) {
      if (!object(step) || !['queued', 'running', 'completed', 'uncertain'].includes(step.status)) invalid();
      const day = step.day ?? job.day, held = step.simulatedCharge ?? heldFor(step.callAccounting);
      if (step.callAccounting && (mode !== 'zkapi' || step.status === 'queued')) invalid();
      if (!date(day) || !amount(held) || held > job.cap || (step.simulatedCharge !== undefined && (mode !== 'demo' || step.status !== 'completed'))) invalid();
      reservation += held; days.get(p.id).set(day, (days.get(p.id).get(day) || 0) + held);
      if (step.additionalCalls !== undefined) {
        if (mode !== 'zkapi' || !Array.isArray(step.additionalCalls) || step.additionalCalls.length > 3) invalid();
        for (const call of step.additionalCalls) {
          if (!object(call) || !date(call.day) || !['running', 'completed', 'uncertain'].includes(call.status)) invalid();
          const held = heldFor(call.callAccounting);
          reservation += held; days.get(p.id).set(call.day, (days.get(p.id).get(call.day) || 0) + held);
        }
      }
    }
    if (reservation !== job.reservation || (job.status === 'completed' && job.steps.some(s => s.status !== 'completed'))) invalid();
    totals.set(p.id, totals.get(p.id) + reservation); jobs.add(job.id); keys.add(job.requestKey);
  }
  for (const p of projects.values()) {
    if (totals.get(p.id) !== p.committed) invalid();
    const expected = days.get(p.id);
    if (!Object.entries(p.days).every(([day, held]) => held === (expected.get(day) || 0)) || ![...expected].every(([day, held]) => p.days[day] === held)) invalid();
  }
}

export class Store {
  constructor(file, mode, codec = { encode: value => JSON.stringify(value), decode: value => JSON.parse(value) }, { preserveQueued = () => false, maxBytes = TENANT_STATE_MAX_BYTES } = {}) {
    if (typeof preserveQueued !== 'function') throw new Problem('Invalid queue restoration policy.', 503);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 128 * 1024 || maxBytes > TENANT_STATE_MAX_BYTES) throw new Problem('Invalid tenant storage limit.', 503);
    this.maxBytes = maxBytes; this.recoveryBytes = 64 * 1024;
    this.file = file;
    this.codec = codec;
    this.mode = mode;
    this.healthy = true;
    mkdirSync(dirname(file), { recursive: true });
    try {
      // Bound allocation before parsing/decrypting. Encrypted base64 and legacy
      // pretty JSON have overhead; the decoded canonical JSON is bounded below.
      if (statSync(file).size > maxBytes * 2 + 4096) throw new Problem('Tenant state file exceeds its storage limit. Preserve it for recovery.', 507);
      this.data = this.codec.decode(readFileSync(file, 'utf8'));
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; this.data = { version: 2, mode, projects: [], jobs: [] }; }
    validate(this.data, mode);
    if (bytes(this.data) > this.maxBytes) throw new Problem('Tenant state exceeds its storage limit. Preserve it for recovery.', 507);
    for (const job of this.data.jobs) if (['queued', 'running'].includes(job.status)) {
      // Only a durable scheduler record matching this exact untouched job can
      // preserve admission. Never infer safety from a queued label alone.
      let restored = false;
      if (job.status === 'queued' && job.dispatch === 'scheduler' && job.reservation === job.cap * job.steps.length && job.steps.every(step => step.status === 'queued' && step.output === undefined && !step.callAccounting && !step.additionalCalls?.length && !step.toolActivity?.length)) {
        try { restored = preserveQueued(job) === true; } catch { /* No proof means no dispatch. */ }
      }
      if (restored) continue;
      job.status = 'interrupted'; job.error = 'Runtime restarted. Unsettled reservations remain held. This job will not retry automatically.';
      job.storageReservationBytes = 0;
      for (const step of job.steps) if (step.status === 'running') step.status = 'uncertain';
      for (const step of job.steps) for (const call of step.additionalCalls || []) if (call.status === 'running') call.status = 'uncertain';
    }
    for (const job of this.data.jobs) if (!['queued', 'running'].includes(job.status)) job.storageReservationBytes = 0;
    this.save();
  }
  assertHealthy() { if (!this.healthy) throw new Problem('Persistence failed. Runtime is blocked; preserve state and restart only after recovery.', 503); }
  storage() {
    const usedBytes = bytes(this.data), reservedBytes = this.data.jobs.reduce((sum, job) => sum + (job.storageReservationBytes || 0), 0);
    return { usedBytes, reservedBytes, maxBytes: this.maxBytes, recoveryBytes: this.recoveryBytes, availableBytes: Math.max(0, this.maxBytes - this.recoveryBytes - usedBytes - reservedBytes) };
  }
  assertCapacity(additionalBytes = 0) {
    this.assertHealthy();
    if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 0) throw new Problem('Invalid storage reservation.', 503);
    const space = this.storage();
    if (space.usedBytes + space.reservedBytes + additionalBytes > this.maxBytes - this.recoveryBytes) {
      const error = new Problem('Tenant storage is full. Existing accounting and recovery records are preserved; new work is stopped.', 507);
      error.code = 'TENANT_STORAGE_FULL'; throw error;
    }
  }
  reserveOutput(job, requiredBytes) {
    if (!this.data.jobs.includes(job) || !['queued', 'running'].includes(job.status) || !Number.isSafeInteger(requiredBytes) || requiredBytes < 0) throw new Problem('Invalid job storage reservation.', 503);
    const extra = Math.max(0, requiredBytes - (job.storageReservationBytes || 0));
    this.assertCapacity(extra + 64);
    job.storageReservationBytes = (job.storageReservationBytes || 0) + extra;
    this.save();
  }
  save({ consume } = {}) {
    this.assertHealthy();
    try {
    // Convert a job's pre-dispatch output reservation into actual stored bytes.
    // Unrelated user edits use normal save() and cannot spend this allowance.
    if (consume) {
      if (!this.data.jobs.includes(consume)) throw new Error('Unknown output reservation.');
      const growth = Math.max(0, bytes(this.data) - (this.savedBytes || 0));
      if (growth > (consume.storageReservationBytes || 0)) throw new Error('Output exceeded its storage reservation.');
      consume.storageReservationBytes -= growth;
    }
    validate(this.data, this.mode);
    const space = this.storage();
    if (space.usedBytes + space.reservedBytes > this.maxBytes) throw new Error('Tenant storage hard limit exceeded.');
    const temp = this.file + '.tmp';
    writeFileSync(temp, this.codec.encode(this.data), { mode: 0o600 });
    const fd = openSync(temp, 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, this.file);
    if (process.platform !== 'win32') { const directory = openSync(dirname(this.file), 'r'); try { fsyncSync(directory); } finally { closeSync(directory); } }
    this.savedBytes = bytes(this.data);
    } catch { this.healthy = false; throw new Problem('Persistence failed. Runtime is blocked; preserve state and restart only after recovery.', 503); }
  }
}
