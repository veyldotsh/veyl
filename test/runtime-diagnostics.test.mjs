import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZkApiProvider } from '../src/provider.mjs';
import { Store } from '../src/store.mjs';
import { Kit } from '../src/kit.mjs';

test('daemon error parsing retains only fixed enums and bounds discarded messages', async () => {
  for (const [body, expected] of [
    [JSON.stringify({ error: { code: 'verifier_binding_mismatch', message: 'secret-key private-prompt' } }), 'verifier_binding_mismatch'],
    [JSON.stringify({ error: { code: 'secret-key private-prompt', message: 'private-prompt' } }), undefined],
    ['invalid private-prompt', undefined],
    [JSON.stringify({ error: { code: 'wallet_error', message: 'private-prompt'.repeat(1000) } }), undefined],
  ]) {
    let calls = 0;
    const provider = new ZkApiProvider({ fetcher: async () => { calls++; return new Response(body, { status: 502 }); } });
    await assert.rejects(provider.request('/v1/chat/completions', { model: 'fixture' }), error => {
      assert.equal(error.runtimeFailureCode, expected);
      assert.doesNotMatch(JSON.stringify(error) + error.message, /secret-key|private-prompt/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('interrupted paid call saves safe diagnostic, never releases cap or retries, and survives reload', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'veyl-diagnostic-')), 'state.json'); let calls = 0;
  const provider = new ZkApiProvider({ key: 'offline-fixture-only', fetcher: async () => { calls++; return new Response(JSON.stringify({ error: { code: 'verifier_response_rejected', message: 'secret-key private-prompt' } }), { status: 502 }); } });
  provider.models = async () => [{ id: 'fixture', oa_request_limit_micro_usd: 1000000, oa_accounting_margin_micro_usd: 1000 }];
  provider.accountingIdentity = async () => ({ version: 1, journal_id: 'a'.repeat(32) });
  provider.callSettlement = async () => { throw new Error('pending'); };
  const store = new Store(file, 'zkapi'), kit = new Kit({ store, provider, chain: {}, agentTools: null });
  const project = kit.create({ requestKey: randomUUID(), name: 'Diagnostic', symbol: 'DIAG', purpose: 'Fixture', template: 'research', swarm: false, model: 'fixture', total: 4004000, daily: 4004000, request: 1001000 });
  const input = { requestKey: randomUUID(), prompt: 'Fixture task' };
  const job = await kit.submit(project.id, input); await kit.execution;
  assert.equal(job.status, 'interrupted'); assert.equal(job.failureCode, 'verifier_response_rejected');
  assert.equal(project.committed, 1001000); assert.equal(job.reservation, 1001000); assert.equal(calls, 1);
  assert.equal((await kit.submit(project.id, input)).id, job.id); assert.equal(calls, 1);
  const restored = new Store(file, 'zkapi'); assert.equal(restored.data.jobs[0].failureCode, job.failureCode);
  assert.equal(restored.data.projects[0].committed, 1001000);
  assert.doesNotMatch(readFileSync(file, 'utf8'), /secret-key|private-prompt/);
  const malformed = JSON.parse(readFileSync(file)); malformed.jobs[0].failureCode = 'private-prompt'; writeFileSync(file, JSON.stringify(malformed));
  assert.throws(() => new Store(file, 'zkapi'), /schema or accounting mismatch/);
});
