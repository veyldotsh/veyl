import { Problem } from './agent.mjs';
import { createHash } from 'node:crypto';

const clip = (value, length = 512) => typeof value === 'string' ? value.slice(0, length) : '';
export function jobCharge(job) {
  const calls = job.steps.flatMap(step => [step, ...(step.additionalCalls || [])]).map(step => step.callAccounting).filter(Boolean);
  const settled = calls.filter(call => call.status === 'settled');
  const settledMicroUsd = settled.reduce((sum, call) => sum + call.valuationMicroUsd, 0);
  return { mode: job.mode, settledWei: settled.reduce((sum, call) => sum + BigInt(call.chargeWei), 0n).toString(), settledMicroUsd, pendingMicroUsd: job.mode === 'demo' ? 0 : Math.max(0, job.reservation - settledMicroUsd), settledCalls: settled.length, totalCalls: calls.length,
    ...(job.mode === 'demo' ? { simulatedMicroUsd: job.steps.reduce((sum, step) => sum + (step.simulatedCharge || 0), 0) } : {}) };
}
const labels = { read_source: 'Read source', chain_read: 'Read Ethereum balance', save_note: 'Save project note', prepare_social_draft: 'Prepare social draft' };
const eventLabels = { created: 'Agent created', status: 'Project status changed', settings: 'Settings updated', source: 'Source saved', funded: 'Treasury funded', token: 'Token deployed', market: 'Market launched', trade: 'Trade recorded', fees: 'Fees collected', 'fee-revenue': 'Fee revenue recorded', 'fee-retry': 'Fee check recorded', 'schedule-paused': 'Schedule paused', 'schedule-deferred': 'Schedule deferred', 'runtime-release': 'Runtime released' };
const cursorFor = event => Buffer.from(JSON.stringify([event.at, event.id])).toString('base64url');
const order = (a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id);

/** A projection of durable events, never a simulated stream of private thoughts. */
export class Activity {
  constructor(kit) { this.kit = kit; }
  snapshot(projectId, { limit = 100, before = null } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Problem('Activity limit must be between one and 100.');
    let cursor;
    if (before !== null && before !== undefined && before !== '') {
      try { if (typeof before !== 'string' || before.length > 400 || !/^[a-zA-Z0-9_-]+$/.test(before)) throw Error(); cursor = JSON.parse(Buffer.from(before, 'base64url')); if (!Array.isArray(cursor) || cursor.length !== 2 || !Number.isFinite(Date.parse(cursor[0])) || typeof cursor[1] !== 'string' || cursor[1].length > 160) throw Error(); } catch { throw new Problem('Invalid activity cursor.'); }
    }
    const p = this.kit.project(projectId), events = [], allJobs = this.kit.store.data.jobs.filter(job => job.projectId === projectId), jobs = allJobs.slice(-200);
    const add = event => { if (event.at && Number.isFinite(Date.parse(event.at))) events.push(event); };
    for (const job of jobs) {
      add({ id: `job-${job.id}`, at: job.at, finishedAt: job.finishedAt || null, type: 'job', status: job.status, title: job.autonomy ? `Autonomous ${job.autonomy.phase}` : job.research ? `Source ${job.research.kind}` : 'Agent task', jobId: job.id, cycleId: job.autonomy?.cycleId || null, details: `${job.model || p.model} · ${job.steps.length === 1 ? job.steps[0].role : `${job.steps.length} stages`}`, charge: jobCharge(job), artifactId: job.artifactId || null });
      job.steps.forEach((step, index) => {
        if (step.at && job.steps.length > 1) add({ id: `stage-${job.id}-${index}`, at: step.at, finishedAt: step.finishedAt || null, type: 'stage', status: step.status, title: clip(step.role, 80), jobId: job.id, cycleId: job.autonomy?.cycleId || null, details: step.status === 'completed' ? 'Model response saved.' : step.status === 'uncertain' ? 'The outcome is uncertain; its unresolved charge remains reserved.' : step.status === 'not-dispatched' ? 'Stopped before model dispatch; unused stage reservation released.' : 'Stage started.' });
        for (const action of step.toolActivity || []) {
          const evidence = action.evidence || action.result || {}, source = typeof evidence.source === 'string' && evidence.source.startsWith('https://') ? evidence.source.slice(0, 2048) : null;
          add({ id: `tool-${job.id}-${index}-${action.id}`, at: action.at, finishedAt: action.finishedAt || null, type: 'tool', status: action.status, title: labels[action.name] || 'Recorded tool action', jobId: job.id, cycleId: job.autonomy?.cycleId || null,
            ...(source ? { source, fetchedAt: evidence.fetchedAt || null } : {}), details: action.status === 'failed' ? 'The tool did not complete; no automatic retry was recorded.' : action.name === 'chain_read' && evidence.blockNumber ? `Ethereum block ${clip(evidence.blockNumber, 32)} · ${clip(evidence.kind, 32)}` : action.name === 'prepare_social_draft' ? 'Draft prepared. Publication, if any, is recorded separately by the social service.' : action.name === 'save_note' ? 'Project note saved.' : source ? `Captured public source${evidence.truncated ? ' (bounded excerpt)' : ''}.` : 'Action recorded by the worker.' });
        }
      });
    }
    for (const check of p.research?.checks || []) {
      add({ id: `check-${check.id}`, at: check.startedAt, finishedAt: check.finishedAt, type: 'watch-check', status: check.status, title: clip(check.name, 80), details: `${check.sources.length} source result(s) recorded.`, checkId: check.id });
      check.sources.forEach((source, index) => add({ id: `source-${check.id}-${index}`, at: source.attemptedAt, finishedAt: source.finishedAt, type: 'source', status: source.status, title: source.status === 'error' ? 'Source unavailable' : source.status === 'baseline' ? 'Source baseline saved' : source.status === 'changed' ? 'Captured source changed' : 'Captured source unchanged', source: source.url, fetchedAt: source.fetchedAt, details: source.status === 'error' ? 'No readable source result was captured.' : `Comparison covers up to ${source.excerptLimit || 20000} readable characters.`, checkId: check.id }));
    }
    for (const cycle of p.autonomy?.cycles || []) add({ id: `cycle-${cycle.id}`, at: cycle.at, finishedAt: cycle.finishedAt, type: 'autonomy-cycle', status: cycle.status, title: cycle.question ? clip(cycle.question, 160) : 'Autonomous question planning', cycleId: cycle.id, details: cycle.status === 'completed' ? clip(cycle.summary, 512) : clip(cycle.error || 'Recorded cycle; follow-up stages use separate budget admission.') });
    p.events.slice(-200).filter(event => !['task', 'delivered'].includes(event.type)).forEach(event => add({ id: `event-${event.id || createHash('sha256').update(JSON.stringify([event.at, event.type, event.message])).digest('hex').slice(0, 32)}`, at: event.at, type: 'project-event', status: 'recorded', title: eventLabels[event.type] || clip(event.type, 80).replace(/-/g, ' ').replace(/^./, letter => letter.toUpperCase()), details: clip(event.message) }));
    events.sort(order);
    const filtered = cursor ? events.filter(event => event.at < cursor[0] || event.at === cursor[0] && event.id < cursor[1]) : events;
    const selected = filtered.slice(0, limit);
    while (Buffer.byteLength(JSON.stringify(selected)) > 740000) selected.pop();
    return { events: selected, nextCursor: filtered.length > selected.length && selected.length ? cursorFor(selected.at(-1)) : null, omitted: Math.max(0, allJobs.length - jobs.length), transport: 'polling', generatedAt: this.kit.now().toISOString() };
  }
}
