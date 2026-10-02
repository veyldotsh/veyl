import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Kit } from '../src/kit.mjs';
import { Store } from '../src/store.mjs';

function setup({ daily = 4_000_000, forever = false, failSecond = false } = {}) {
  const file = join(mkdtempSync(join(tmpdir(), 'veyl-tools-')), 'kit.json'); const requests = [], toolRuns = [];
  const provider = { mode: 'zkapi', models: async () => [{ id: 'fixture', oa_request_limit_micro_usd: 500_000 }], complete: async body => {
    requests.push(structuredClone(body)); const saved = JSON.parse(readFileSync(file));
    assert.equal(saved.projects[0].committed, requests.length * 500_000);
    if (failSecond && requests.length === 2) throw new Error('Ambiguous upstream outcome');
    return forever || requests.length === 1 ? { answer: '', toolCalls: [{ id: 'call-' + requests.length, type: 'function', function: { name: 'read_source', arguments: '{"url":"https://ethereum.org/"}' } }] } : { answer: 'Source-based answer', verification: 'fixture' };
  } };
  const agentTools = { schemas: () => [{ type: 'function', function: { name: 'read_source' } }], execute: async (input, context) => { toolRuns.push({ input, context }); return { source: 'https://ethereum.org/', text: 'Untrusted source content' }; } };
  const store = new Store(file, 'zkapi'); const kit = new Kit({ store, provider, chain: {}, agentTools });
  const p = kit.create({ requestKey: randomUUID(), name: 'Tool test', symbol: 'TOOLS', purpose: 'Read evidence.', template: 'research', swarm: false, model: 'fixture', total: 4_000_000, daily, request: 500_000 });
  return { kit, p, requests, toolRuns, file };
}
test('tool rounds reserve durably before each model call and feed bounded results back', async () => {
  const { kit, p, requests, toolRuns, file } = setup(); const job = await kit.submit(p.id, { requestKey: randomUUID(), prompt: 'Read the source' }); await kit.execution;
  assert.equal(job.status, 'completed'); assert.equal(p.committed, 1_000_000); assert.equal(requests.length, 2); assert.equal(toolRuns.length, 1);
  assert.equal(toolRuns[0].context.projectId, p.id); assert.equal(requests[1].messages.at(-1).role, 'tool'); assert.equal(requests[1].messages.at(-1).tool_call_id, 'call-1');
  assert.equal(job.steps[0].toolActivity[0].status, 'completed'); assert.equal(new Store(file, 'zkapi').data.projects[0].committed, 1_000_000);
});
test('an exhausted budget cannot dispatch a second model call', async () => {
  const { kit, p, requests, file } = setup({ daily: 500_000 }); const job = await kit.submit(p.id, { requestKey: randomUUID(), prompt: 'Limited' }); await kit.execution;
  assert.equal(job.status, 'interrupted'); assert.equal(requests.length, 1); assert.equal(p.committed, 500_000); assert.equal(new Store(file, 'zkapi').data.projects[0].committed, 500_000);
});
test('unbounded tool requests stop at four calls and never run the fourth tool batch', async () => {
  const { kit, p, requests, toolRuns, file } = setup({ forever: true }); const job = await kit.submit(p.id, { requestKey: randomUUID(), prompt: 'No infinite loops' }); await kit.execution;
  assert.equal(job.status, 'interrupted'); assert.equal(requests.length, 4); assert.equal(toolRuns.length, 3); assert.equal(requests[3].tool_choice, 'none'); assert.equal(new Store(file, 'zkapi').data.projects[0].committed, 2_000_000);
});
test('uncertain additional inference retains its cap and does not replay tools on restart', async () => {
  const { kit, p, requests, toolRuns, file } = setup({ failSecond: true }); const job = await kit.submit(p.id, { requestKey: randomUUID(), prompt: 'Recover' }); await kit.execution;
  assert.equal(job.status, 'interrupted'); assert.equal(job.steps[0].additionalCalls[0].status, 'uncertain'); assert.equal(p.committed, 1_000_000);
  new Store(file, 'zkapi'); assert.equal(requests.length, 2); assert.equal(toolRuns.length, 1);
});
