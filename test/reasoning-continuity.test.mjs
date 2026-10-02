import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZkApiProvider } from '../src/provider.mjs';
import { Kit } from '../src/kit.mjs';
import { Store } from '../src/store.mjs';
import { fixtureCharge } from './fixtures/charge-accounting.mjs';

const call = { id: 'call_note', type: 'function', function: { name: 'save_note', arguments: '{"content":"Saved public note"}' } };
const tools = [{ type: 'function', function: { name: 'save_note', parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false } } }];
const details = [
  { type: 'reasoning.text', text: 'private-continuation-marker', signature: 'opaque-signature-marker', id: null, format: 'anthropic-claude-v1', index: 0 },
  { type: 'reasoning.encrypted', data: 'opaque-encrypted-marker', id: 'encrypted-1', format: 'google-gemini-v1', index: 1, provider_metadata: { opaque: true } },
  { type: 'reasoning.summary', summary: 'private-summary-marker', id: 'summary-1', format: 'openai-responses-v1', index: 2 }
];
const response = message => new Response(JSON.stringify({ choices: [{ message }] }));
const complete = fields => new ZkApiProvider({ fetcher: async () => response({ content: null, tool_calls: [call], ...fields }) }).complete({ tools });

test('tool continuations preserve complete signed and encrypted blocks without normalizing their contents', async () => {
  const result = await complete({ reasoning_details: details, reasoning: 'redundant raw copy' });
  assert.deepEqual(result.reasoningContinuation, { reasoning_details: details });
  assert.equal(JSON.stringify(result.reasoningContinuation.reasoning_details), JSON.stringify(details));
  for (const field of ['reasoning', 'reasoning_content']) assert.deepEqual((await complete({ [field]: 'raw private reasoning' })).reasoningContinuation, { [field]: 'raw private reasoning' });
  assert.deepEqual((await complete({ reasoning_details: [], reasoning: 'raw fallback' })).reasoningContinuation, { reasoning: 'raw fallback' });
});

test('malformed, unsupported and oversized reasoning continuations fail closed instead of being dropped or truncated', async () => {
  for (const fields of [
    { reasoning_details: {} }, { reasoning_details: [null] }, { reasoning_details: [{ type: 'unknown', data: 'opaque' }] },
    { reasoning_details: [{ type: 'reasoning.encrypted', data: 1 }] }, { reasoning_details: [{ ...details[0], signature: {} }] },
    { reasoning_details: [{ ...details[0], index: -1 }] }, { reasoning_details: Array.from({ length: 65 }, () => details[0]) },
    { reasoning_details: [{ ...details[0], text: 'x'.repeat(128 * 1024) }] }, { reasoning: 'x'.repeat(128 * 1024) }, { reasoning: {} }
  ]) await assert.rejects(complete(fields), error => error.status === 502 && /Budget stays reserved/.test(error.message));
});

test('final text outputs never expose provider reasoning as deliverable fields', async () => {
  const provider = new ZkApiProvider({ fetcher: async () => response({ content: 'Public answer', reasoning_details: details, reasoning: 'private raw marker' }) });
  const result = await provider.complete({});
  assert.equal(result.answer, 'Public answer'); assert.equal(result.reasoningContinuation, undefined);
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('real provider and Kit forward opaque reasoning only in memory, with the exact next HTTP body durably hashed', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'veyl-reasoning-')); t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = join(folder, 'state.json'), requests = [], reports = new Map();
  const provider = new ZkApiProvider({ key: 'offline-fixture', fetcher: async (url, options) => {
    const path = new URL(url).pathname;
    if (path === '/v1/models') return new Response(JSON.stringify({ data: [{ id: 'fixture/reasoning', oa_request_limit_micro_usd: 500000 }] }));
    if (path === '/v1/accounting') return new Response(JSON.stringify({ version: 1, journal_id: 'a'.repeat(32) }));
    if (path.startsWith('/v1/call-settlements/')) return new Response(JSON.stringify(reports.get(path.split('/').at(-1))));
    assert.equal(path, '/v1/chat/completions'); requests.push(JSON.parse(options.body));
    const id = options.headers['X-Veyl-Call-Id'], disk = JSON.parse(readFileSync(file));
    const saved = disk.jobs[0].steps.flatMap(step => [step, ...(step.additionalCalls || [])]).find(step => step.callAccounting?.callId === id).callAccounting;
    assert.equal(saved.requestHash, createHash('sha256').update(options.body).digest('hex'));
    reports.set(id, fixtureCharge({ callId: id, session: String(requests.length).repeat(64), receipt: String(requests.length).repeat(64) }).report);
    return response(requests.length === 1 ? { content: null, tool_calls: [call], reasoning_details: details } : { content: 'Public completed answer', reasoning: 'private final marker' });
  } });
  const kit = new Kit({ store: new Store(file, 'zkapi'), provider, chain: {}, now: () => new Date(1800000000 * 1000), agentTools: { schemas: () => tools, execute: async () => ({ noteId: 'fixture-note' }) } });
  const project = kit.create({ requestKey: randomUUID(), name: 'Reasoning', symbol: 'REASON', purpose: 'Check continuity', template: 'research', swarm: false, model: 'fixture/reasoning', total: 2000000, daily: 2000000, request: 501000 });
  const job = await kit.submit(project.id, { requestKey: randomUUID(), prompt: 'Save a note' }); await kit.execution;
  assert.equal(job.status, 'completed'); assert.equal(requests.length, 2); assert.equal(project.committed, 60000);
  assert.deepEqual(requests[1].messages.find(message => message.role === 'assistant'), { role: 'assistant', content: null, tool_calls: [call], reasoning_details: details });
  const saved = readFileSync(file, 'utf8');
  for (const marker of ['private-continuation-marker', 'opaque-signature-marker', 'opaque-encrypted-marker', 'private-summary-marker', 'private final marker', 'reasoning_details']) assert.equal(saved.includes(marker), false);
  assert.equal(project.artifacts[0].content, 'Public completed answer');
});
