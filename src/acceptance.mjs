import { createHash } from 'node:crypto';
import { getAddress } from 'viem';
import { Problem } from './agent.mjs';
import { PublicJournal } from './public-journal.mjs';
import { ZKAPI_SOURCE_REVISION } from './provider.mjs';

const fields = ['version', 'runId', 'daemonOrigin', 'expectedFundingAddress', 'model', 'depositGwei', 'maxDepositTotalWei', 'maxRequestMicroUsd', 'maxCalls', 'maxTotalMicroUsd', 'withdrawalDestination', 'maxWithdrawalFeeWei', 'exclusiveProfile'];
const phaseNames = new Set(['new', 'deposit-prepared', 'deposit-submitting', 'deposit-pending', 'deposit-active', 'job-submitting', 'job-finished', 'withdrawal-quoting', 'withdrawal-ready', 'withdrawal-submitting', 'withdrawal-pending', 'complete']);
const exactKeys = (value, allowed) => value && !Array.isArray(value) && typeof value === 'object' && Object.keys(value).every(key => allowed.includes(key));
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const wei = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 10n ** 18n;
const address = value => { try { const result = getAddress(value).toLowerCase(); if (/^0x0{40}$/.test(result)) throw new Error(); return result; } catch { throw new Problem('Acceptance requires explicit nonzero public addresses.'); } };

export function acceptancePlan(input) {
  if (!exactKeys(input, fields) || input.version !== 1 || !/^[a-f0-9-]{36}$/.test(input.runId || '') || input.exclusiveProfile !== true ||
      typeof input.model !== 'string' || !input.model.trim() || input.model.length > 256 || !/^[1-9][0-9]{0,9}$/.test(input.depositGwei || '') || BigInt(input.depositGwei) > 1_000_000_000n ||
      !wei(input.maxDepositTotalWei) || !wei(input.maxWithdrawalFeeWei) || !integer(input.maxRequestMicroUsd, 1, 6_000_000) || !integer(input.maxCalls, 2, 4) ||
      !integer(input.maxTotalMicroUsd, 1, 24_000_000) || input.maxTotalMicroUsd !== input.maxRequestMicroUsd * input.maxCalls || BigInt(input.maxDepositTotalWei) < BigInt(input.depositGwei) * 1_000_000_000n) throw new Problem('Invalid public acceptance terms. Supply exact deposit, model-call and withdrawal fee limits; never include credentials.');
  let origin; try { origin = new URL(input.daemonOrigin); } catch { throw new Problem('Invalid acceptance daemon origin.'); }
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Problem('Acceptance can use only a dedicated HTTP 127.0.0.1 daemon.');
  const config = Object.fromEntries(fields.map(key => [key, input[key]])); config.daemonOrigin = origin.origin;
  config.expectedFundingAddress = address(input.expectedFundingAddress); config.withdrawalDestination = address(input.withdrawalDestination);
  if (config.expectedFundingAddress === config.withdrawalDestination) throw new Problem('Withdrawal destination must differ from the daemon payment address.');
  const approvalDigest = hash({ scope: 'Veyl funded acceptance v1', sourceRevision: ZKAPI_SOURCE_REVISION, config });
  return { config, approvalDigest, sourceRevision: ZKAPI_SOURCE_REVISION, mode: 'dry-run', paidInferenceCalls: 0, signedTransactions: 0,
    maximums: { modelCalls: config.maxCalls, inferenceMicroUsd: config.maxTotalMicroUsd, depositPrincipalGwei: config.depositGwei, depositIncludingGasWei: config.maxDepositTotalWei, withdrawalGasWei: config.maxWithdrawalFeeWei },
    boundary: 'One exclusive pre-funded public payment address; one private deposit, one Veyl task using save_note, and one exact-destination whole-note withdrawal. No treasury signer, contract deployment or automatic retry. Verified per-job final billing remains unavailable.' };
}

/** Operator-only acceptance state machine. Construction and inspect never sign.
 * Real operations require the exact public-plan digest AND explicit enablement.
 * The funding controller remains responsible for protocol/quote validation. */
export class FundedAcceptance {
  constructor({ file, config, provider, funding, kit, expiryGuard, enabled = false }) {
    this.plan = acceptancePlan(config); this.provider = provider; this.funding = funding; this.kit = kit; this.expiryGuard = expiryGuard; this.enabled = enabled === true;
    this.journal = new PublicJournal(file, { version: 1, approvalDigest: this.plan.approvalDigest, phase: 'new', calls: [] }, state => {
      if (!exactKeys(state, ['version', 'approvalDigest', 'phase', 'calls', 'depositId', 'projectId', 'jobId', 'withdrawalId', 'noteId']) || state.version !== 1 || state.approvalDigest !== this.plan.approvalDigest || !phaseNames.has(state.phase) || !Array.isArray(state.calls) || state.calls.length > this.plan.config.maxCalls ||
          state.calls.some((call, i) => !exactKeys(call, ['index', 'status']) || call.index !== i || !['dispatching', 'received', 'uncertain'].includes(call.status))) throw new Error('Invalid acceptance recovery state.');
      for (const name of ['depositId', 'projectId', 'jobId', 'withdrawalId']) if (state[name] !== undefined && !/^[a-f0-9-]{36}$/.test(state[name])) throw new Error('Invalid acceptance identity.');
      if (state.noteId !== undefined && !integer(state.noteId, 0, 0xffffffff)) throw new Error('Invalid acceptance note.');
    });
  }
  report() { const state = this.journal.snapshot(); return { ...state, mode: 'funded-acceptance', maximums: this.plan.maximums, paidCallsAttempted: state.calls.length, actualBilledUsageVerified: false, noAutomaticInferenceRetry: true }; }
  async inspect() {
    const diagnostics = await this.provider.diagnostics(), models = await this.provider.models();
    const selected = models.find(model => model.id === this.plan.config.model);
    return { ...this.plan, mode: 'read-only', diagnostics, selectedModel: selected || null, modelWithinApprovedCeiling: !!selected && selected.oa_request_limit_micro_usd <= this.plan.config.maxRequestMicroUsd };
  }
  armed(digest) { if (!this.enabled || digest !== this.plan.approvalDigest) throw new Problem('Paid acceptance is disabled. It requires operator enablement and the exact reviewed plan digest.', 403); }
  save(phase) { if (phase) this.journal.state.phase = phase; this.journal.save(); }
  intent(id, kind = 'deposit') { return this.funding.snapshot()[kind === 'deposit' ? 'intents' : 'operations'].find(item => item.id === id); }
  checkedQuote(intent, kind) {
    const c = this.plan.config, q = intent?.quote;
    if (!q || address(intent.address) !== c.expectedFundingAddress || (kind === 'deposit' ? intent.amountGwei !== c.depositGwei || !wei(q.recommended_total_wei) || BigInt(q.recommended_total_wei) > BigInt(c.maxDepositTotalWei) :
      intent.request?.destination !== c.withdrawalDestination || q.note_id !== this.journal.state.noteId || q.amount > Number(c.depositGwei) || !wei(q.fee_reserve_wei) || BigInt(q.fee_reserve_wei) > BigInt(c.maxWithdrawalFeeWei))) throw new Problem('Acceptance quote exceeds the approved identity or spending terms.', 409);
    if (BigInt(q.balance_wei) < BigInt(q.recommended_total_wei)) throw new Problem('The dedicated payment address lacks the exact quote funds. Top up separately after review; this harness never transfers treasury funds.', 409);
  }
  async run(approvalDigest) {
    this.armed(approvalDigest);
    return this.journal.exclusive(async () => {
      const c = this.plan.config, s = this.journal.state;
      if (s.phase === 'complete') return this.report();
      if (typeof this.expiryGuard?.assertCanInfer !== 'function') throw new Problem('Paid acceptance requires the canonical note-expiry guard.', 409);
      const diagnostics = await this.provider.diagnostics(), models = await this.provider.models(), model = models.find(item => item.id === c.model);
      if (diagnostics.configuration !== 'daemon-reported match' || diagnostics.backend !== 'zkapi' || diagnostics.network !== 'mainnet' || diagnostics.requestBudgetPolicy !== 'model' || !model || model.oa_request_limit_micro_usd > c.maxRequestMicroUsd) throw new Problem('The dedicated daemon or model does not match the approved acceptance plan.', 409);
      if (!this.funding.capabilities().approvalEnabled || this.funding.capabilities().daemonOrigin !== c.daemonOrigin) throw new Problem('Dedicated daemon approvals are disabled or the origin changed.', 403);
      if (s.phase === 'new') {
        const status = await this.funding.inspect();
        if (address(status.funding.address) !== c.expectedFundingAddress || !['ready', 'waiting_funds'].includes(status.funding.phase)) throw new Problem('Acceptance requires the exact dedicated payment address with no pre-existing active note.', 409);
        const intent = await this.funding.quote({ idempotencyKey: c.runId + '-deposit', amountGwei: c.depositGwei }); s.depositId = intent.id; this.save('deposit-prepared');
      }
      if (s.phase === 'deposit-prepared') {
        const intent = await this.funding.refresh(s.depositId); this.checkedQuote(intent, 'deposit'); this.save('deposit-submitting');
        try { await this.funding.approve({ intentId: intent.id, quoteId: intent.quote.id, approvalDigest: intent.approvalDigest }); } finally { this.save('deposit-pending'); }
      }
      if (['deposit-submitting', 'deposit-pending'].includes(s.phase)) {
        const intent = await this.funding.recover(s.depositId);
        if (intent.status !== 'active') return { ...this.report(), nextAction: intent.transactionHash ? 'Explicit resume-deposit with the saved transaction hash; no inference was retried.' : 'Inspect daemon recovery; an unknown approval is never repeated.' };
        this.save('deposit-active');
      }
      if (s.phase === 'deposit-active') {
        const project = this.kit.create({ requestKey: c.runId, name: 'Funded acceptance', symbol: 'VERIFY', purpose: 'A bounded integration check: save the supplied note using save_note, then give one short answer. Do not use any other tool.', template: 'research', swarm: false, model: c.model, total: c.maxTotalMicroUsd, daily: c.maxTotalMicroUsd, request: c.maxRequestMicroUsd });
        s.projectId = project.id; this.save('job-submitting');
        const job = await this.kit.submit(project.id, { requestKey: c.runId + '-task', prompt: `Use save_note exactly once with content "Veyl acceptance ${c.runId}". Then reply briefly that this note was saved. Do not merely describe the tool call.` });
        s.jobId = job.id; this.save(); await this.kit.execution;
      }
      if (s.phase === 'job-submitting') {
        const job = this.kit.store.data.jobs.find(item => item.id === s.jobId || item.requestKey === c.runId + '-task');
        if (!job || job.status !== 'completed') return { ...this.report(), nextAction: 'Inspect the saved job. It is absent or unfinished and will never be dispatched again by this harness.' };
        const project = this.kit.project(s.projectId);
        if (!project.notes.some(note => note.content === `Veyl acceptance ${c.runId}`) || !job.steps.some(step => step.toolActivity?.some(activity => activity.name === 'save_note' && activity.status === 'completed')) || project.committed > c.maxTotalMicroUsd) throw new Problem('The funded task did not complete the required real save_note tool round. No inference retry is authorized.', 409);
        this.save('job-finished');
      }
      if (s.phase === 'job-finished') {
        const status = await this.funding.inspectOperation('withdrawal');
        if (status.phase !== 'ready') return { ...this.report(), nextAction: 'Wait for daemon settlement, then run this same approved acceptance again. No inference is repeated.' };
        if (address(status.address) !== c.expectedFundingAddress || !integer(status.noteId, 0, 0xffffffff) || BigInt(status.privateBalanceGwei) > BigInt(c.depositGwei)) throw new Problem('Withdrawal note does not match the dedicated acceptance deposit.', 409);
        s.noteId = status.noteId; this.save('withdrawal-quoting');
      }
      if (s.phase === 'withdrawal-quoting') {
        const operation = await this.funding.quoteOperation({ kind: 'withdrawal', idempotencyKey: c.runId + '-withdrawal', noteId: s.noteId, destination: c.withdrawalDestination });
        s.withdrawalId = operation.id; this.save('withdrawal-ready');
      }
      if (s.phase === 'withdrawal-ready') {
        const operation = await this.funding.refreshOperation(s.withdrawalId); this.checkedQuote(operation, 'withdrawal'); this.save('withdrawal-submitting');
        try { await this.funding.approveOperation({ intentId: operation.id, quoteId: operation.quote.id, approvalDigest: operation.approvalDigest }); } finally { this.save('withdrawal-pending'); }
      }
      if (['withdrawal-submitting', 'withdrawal-pending'].includes(s.phase)) {
        const operation = await this.funding.recoverOperation(s.withdrawalId);
        if (operation.status === 'complete') this.save('complete');
        else return { ...this.report(), nextAction: operation.transactionHash ? 'Explicit resume-withdrawal with the exact saved transaction hash.' : 'Inspect daemon recovery. Never repeat an unknown withdrawal approval.' };
      }
      return this.report();
    });
  }
  async dispatch(body) {
    // The Kit wrapper must call this method for every model round. Recording the
    // attempt before I/O prevents restart or lost responses from buying again.
    const s = this.journal.state, c = this.plan.config;
    if (!this.enabled || s.phase !== 'job-submitting' || body.model !== c.model || s.calls.length >= c.maxCalls || s.calls.some(call => call.status !== 'received')) throw new Problem('Acceptance call limit or recovery state prohibits another paid request.', 409);
    await this.expiryGuard.assertCanInfer();
    const call = { index: s.calls.length, status: 'dispatching' }; s.calls.push(call); this.save();
    try { const result = await this.provider.complete(body); call.status = 'received'; this.save(); return result; }
    catch (error) { call.status = 'uncertain'; this.save(); throw error; }
  }
  async resume({ approvalDigest, kind, transactionHash }) {
    this.armed(approvalDigest);
    return this.journal.exclusive(async () => {
      const s = this.journal.state, deposit = kind === 'deposit';
      if (!['deposit', 'withdrawal'].includes(kind) || !['deposit-pending', 'deposit-submitting', 'withdrawal-pending', 'withdrawal-submitting'].includes(s.phase) || !s.phase.startsWith(kind === 'deposit' ? 'deposit-' : 'withdrawal-')) throw new Problem('No matching saved transaction is eligible for explicit recovery.', 409);
      const id = deposit ? s.depositId : s.withdrawalId, intent = this.intent(id, kind);
      if (!/^0x[a-fA-F0-9]{64}$/.test(transactionHash || '') || intent?.transactionHash?.toLowerCase() !== transactionHash.toLowerCase()) throw new Problem('Recovery must name the exact saved transaction hash.', 409);
      const result = deposit ? await this.funding.resume({ intentId: id, transactionHash }) : await this.funding.resumeOperation({ intentId: id, transactionHash });
      if (deposit && result.status === 'active') this.save('deposit-active');
      if (!deposit && result.status === 'complete') this.save('complete');
      return this.report();
    });
  }
}
