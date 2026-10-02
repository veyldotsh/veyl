import { Problem, positive } from './agent.mjs';
import { accountingIdentity, ACCOUNTING_MARGIN_MICRO_USD } from './charge-accounting.mjs';

// Interface review pin, not a claim that the local daemon's binary is attested.
export const ZKAPI_SOURCE_REVISION = 'b826c169b4831665822529f535f824265f50630b';

// OpenRouter reasoning models may require signed/encrypted continuation blocks
// on the next tool round. Preserve their order and contents, never display or
// persist them as a deliverable, and never truncate a signed sequence.
function reasoningContinuation(message) {
  const invalid = () => { throw new Problem('Invalid or oversized model reasoning continuation. Budget stays reserved.', 502); };
  for (const field of ['reasoning', 'reasoning_content']) if (message[field] != null && typeof message[field] !== 'string') invalid();
  const details = message.reasoning_details;
  if (details != null) {
    if (!Array.isArray(details) || details.length > 64) invalid();
    const payloads = { 'reasoning.text': 'text', 'reasoning.encrypted': 'data', 'reasoning.summary': 'summary' };
    for (const block of details) {
      if (!block || Array.isArray(block) || typeof block !== 'object' || !Object.hasOwn(payloads, block.type) || typeof block[payloads[block.type]] !== 'string' ||
          (block.id != null && typeof block.id !== 'string') || (block.format != null && typeof block.format !== 'string') ||
          (block.signature != null && typeof block.signature !== 'string') || (block.index !== undefined && (!Number.isSafeInteger(block.index) || block.index < 0))) invalid();
    }
  }
  const continuation = details?.length ? { reasoning_details: details } : typeof message.reasoning === 'string' ? { reasoning: message.reasoning } : typeof message.reasoning_content === 'string' ? { reasoning_content: message.reasoning_content } : details ? { reasoning_details: details } : {};
  if (Buffer.byteLength(JSON.stringify(continuation)) > 128 * 1024) invalid();
  return continuation;
}

export class DemoProvider {
  mode = 'demo';
  async models() { return [{ id: 'demo/research-agent', oa_request_limit_micro_usd: 500_000 }]; }
  async complete(body) {
    await new Promise(resolve => setTimeout(resolve, 400));
    const role = /You are (\w+)/.exec(body.messages[0].content)?.[1] || 'Specialist';
    const task = body.messages.at(-1).content.split('TASK:\n').at(-1).slice(0, 1000);
    const output = role === 'Planner'
      ? `## Execution plan\n\n1. Clarify the objective and inspect saved context.\n2. Separate supported claims from assumptions.\n3. Produce a deliverable with explicit limitations.\n4. Send it to the reviewer before delivery.`
      : role === 'Reviewer'
      ? `## Review and final handoff\n\nThe planner and specialist stages completed in the local simulation. Their outputs are retained in the job record.\n\n### Acceptance checklist\n- The task and its spending reservation were saved before execution.\n- Prior memory and attached sources were included in context.\n- The final deliverable is available for download.\n\n### Evidence boundary\nThis is a deterministic demonstration, not AI-generated research or an audit. No external claim has been verified by a model. Connect zkAPI to run this workflow with real inference.`
      : `## ${role} handoff\n\n### Objective\n${task}\n\n### Approach\nUse the supplied context, identify missing evidence, and prepare a clear result. This template exercises the real job, memory, budget and artifact pipeline.\n\n### Open work\nConnect a funded zkAPI daemon for a model-generated deliverable. External actions such as deployment or publishing require separate integrations.`;
    return { answer: `> LOCAL SIMULATION · No model was called.\n\n${output}`, verification: 'simulation', demoCharge: 30_000 };
  }
}
export class ZkApiProvider {
  mode = 'zkapi';
  constructor({ base = 'http://127.0.0.1:8787', key = '', fetcher = fetch } = {}) {
    const url = new URL(base);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Problem('zkAPI must use an HTTP 127.0.0.1 daemon origin without a path.');
    this.base = url.origin; this.key = key; this.fetcher = fetcher;
  }
  async request(path, body, localHeaders = {}) {
    try {
      const response = await this.fetcher(this.base + path, { method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { 'Content-Type': 'application/json', ...(this.key ? { Authorization: `Bearer ${this.key}` } : {}), ...localHeaders },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(body ? 180_000 : 15_000) });
      if (!response.ok) { await response.body?.cancel(); const error = new Problem(`zkAPI returned HTTP ${response.status}. Check the daemon locally; requests are never automatically retried.`, 502); error.daemonUnavailable = response.status !== 404; throw error; }
      const reader = response.body.getReader(); const chunks = []; let size = 0;
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 2_000_000) { await reader.cancel(); throw new Problem('Daemon response too large.', 502); } chunks.push(value); }
      return { data: JSON.parse(Buffer.concat(chunks).toString('utf8')), headers: response.headers };
    } catch (error) { if (error instanceof Problem) throw error; const failure = new Problem('Cannot read the local zkAPI daemon response. Check its configuration and recovery state.', 502); failure.daemonUnavailable = true; throw failure; }
  }
  async models() {
    const { data } = await this.request('/v1/models');
    if (!Array.isArray(data?.data)) throw new Problem('Invalid daemon model catalog.', 502);
    const seen = new Set();
    return data.data.map(item => {
      if (!item || typeof item.id !== 'string' || !item.id.trim() || item.id.length > 256 || seen.has(item.id)) throw new Problem('Invalid or ambiguous daemon model catalog.', 502);
      let cap;
      try { cap = positive(item.oa_request_limit_micro_usd, 'daemon model cap'); }
      catch { throw new Problem('Daemon model lacks a valid request cap; inference is blocked.', 502); }
      seen.add(item.id); return { id: item.id, oa_request_limit_micro_usd: cap, oa_accounting_margin_micro_usd: ACCOUNTING_MARGIN_MICRO_USD };
    });
  }
  async diagnostics({ expectedNetwork = 'mainnet' } = {}) {
    if (!['mainnet', 'sepolia'].includes(expectedNetwork)) throw new Problem('Expected daemon network must be mainnet or sepolia.');
    const { data: health } = await this.request('/healthz');
    if (health?.status !== 'ok') throw new Problem('Invalid daemon health response.', 502);
    const report = {
      sourceRevision: ZKAPI_SOURCE_REVISION,
      reachable: true,
      configurationVerified: false,
      fundedBalanceVerified: false,
      signedSettlementAvailable: false,
      keyReuseWindow: 'not exposed by the inference API',
      scope: 'Read-only daemon-reported metadata; no binary attestation, funding or settlement check.'
    };
    // Upstream requires the local inference bearer for /admin/status even when
    // /v1 inference itself is keyless. Never load its private management token.
    if (!this.key) return { ...report, configuration: 'not checked; authenticated status requires a local API key' };
    const { data: status } = await this.request('/admin/status');
    if (status?.backend !== 'zkapi' || status.network !== expectedNetwork || status.request_budget_policy !== 'model') throw new Problem('Daemon metadata does not match the expected zkAPI network and model budget policy.', 502);
    return { ...report, configuration: 'daemon-reported match', backend: 'zkapi', network: status.network, requestBudgetPolicy: 'model' };
  }
  async accountingIdentity() {
    if (!this.key) throw new Problem('Authenticated per-call accounting is required before inference.', 503);
    return accountingIdentity((await this.request('/v1/accounting')).data);
  }
  async callSettlement(callId) {
    if (!this.key || typeof callId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(callId)) throw new Problem('Invalid accounting lookup.', 503);
    return (await this.request('/v1/call-settlements/' + callId)).data;
  }
  async complete(body, accounting) {
    const localHeaders = {};
    if (accounting) {
      const { callId, reservedMicroUsd, journalId } = accounting;
      if (!this.key || typeof callId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(callId) || !/^[0-9a-f]{32}$/.test(journalId) || !Number.isSafeInteger(reservedMicroUsd) || reservedMicroUsd < 1 || reservedMicroUsd > 1_000_000_000) throw new Problem('Invalid durable accounting context.', 503);
      Object.assign(localHeaders, { 'X-Veyl-Call-Id': callId, 'X-Veyl-Journal-Id': journalId, 'X-Veyl-Reserved-Micro-Usd': String(reservedMicroUsd) });
    }
    const { data, headers } = await this.request('/v1/chat/completions', body, localHeaders);
    const message = data?.choices?.[0]?.message;
    const answer = message?.content;
    const offered = new Set((Array.isArray(body.tools) ? body.tools : []).filter(tool => tool?.type === 'function').map(tool => tool.function?.name));
    const toolCalls = [];
    if (message?.tool_calls !== undefined && message?.tool_calls !== null) {
      if (!Array.isArray(message.tool_calls) || message.tool_calls.length > 8) throw new Problem('Invalid or excessive model tool calls. Budget stays reserved.', 502);
      const ids = new Set();
      for (const call of message.tool_calls) {
        if (!call || call.type !== 'function' || typeof call.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(call.id) || ids.has(call.id) ||
            typeof call.function?.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(call.function.name) || !offered.has(call.function.name) ||
            typeof call.function.arguments !== 'string' || Buffer.byteLength(call.function.arguments) > 8192) throw new Problem('Model requested an invalid or unavailable tool. Budget stays reserved.', 502);
        let args; try { args = JSON.parse(call.function.arguments); } catch { throw new Problem('Model tool arguments are not valid JSON. Budget stays reserved.', 502); }
        if (!args || Array.isArray(args) || typeof args !== 'object') throw new Problem('Model tool arguments must be a JSON object. Budget stays reserved.', 502);
        ids.add(call.id); toolCalls.push({ id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments } });
      }
    }
    if ((typeof answer !== 'string' || !answer.trim()) && !toolCalls.length) throw new Problem('No text answer or valid tool request was returned. Budget stays reserved.', 502);
    if (answer !== null && answer !== undefined && typeof answer !== 'string') throw new Problem('Invalid assistant response content. Budget stays reserved.', 502);
    const status = headers.get('x-oa-verification-status');
    const detail = headers.get('x-oa-verification-detail');
    if ((status === 'verified' && detail) ||
        (status === 'verifier-unavailable' && detail !== 'trusted_station_fallback') ||
        (status !== null && !['verified', 'verifier-unavailable'].includes(status)) ||
        (status === null && detail)) throw new Problem('Daemon returned inconsistent verification metadata. Budget stays reserved.', 502);
    const verification = status === 'verified' ? 'daemon-reported verified' : status === 'verifier-unavailable' ? 'daemon-reported verification unavailable' : 'not reported';
    // Provider JSON (including usage.cost) and OA ownership-verification headers
    // contain no signed wallet settlement or application-to-lease correlation.
    // The caller must retain its full cap after every live response.
    return { answer: (answer || '').slice(0, 32_000), ...(toolCalls.length ? { toolCalls, reasoningContinuation: reasoningContinuation(message) } : {}), verification, verificationDetail: detail || null, settlement: { status: 'unreconciled', signedReceiptVerified: false } };
  }
}
