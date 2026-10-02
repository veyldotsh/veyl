import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentTools } from '../src/agent-tools.mjs';

const owner = '0x1111111111111111111111111111111111111111', token = '0x2222222222222222222222222222222222222222';
const hash = '0x' + 'a'.repeat(64);
function fixture({ chainId = 1, code = '0x6000', reorg = false } = {}) {
  const calls = [], projects = [{ id: 'project-a', notes: [] }, { id: 'project-b', notes: [] }];
  const context = { projectId: 'project-a', jobId: 'job-1', callId: 'call-1', kit: {
    project: id => { const p = projects.find(p => p.id === id); if (!p) throw new Error('Unknown project'); return p; },
    note: (id, content) => { const p = projects.find(p => p.id === id); p.notes.push({ id: 'note-1', content, at: '2026-10-01T00:00:00.000Z' }); return p; }
  } };
  const tools = new AgentTools({ client: {
    getChainId: async () => chainId,
    getBlock: async args => ({ number: 123n, hash: args.blockNumber && reorg ? '0x' + 'b'.repeat(64) : hash }),
    getCode: async args => { calls.push(['code', args]); return code; },
    getBalance: async args => { calls.push(['eth', args]); return 123456789n; },
    readContract: async args => { calls.push(['token', args]); return 987654321n; }
  }, sourceReader: async url => { calls.push(['source', url]); return { url, text: 'Independent source evidence.', fetchedAt: '2026-10-01T00:00:00.000Z' }; } });
  return { tools, calls, projects, context };
}

test('agent tool catalog is strict and has no signing, generic HTTP, shell, or publishing tool', () => {
  const f = fixture(), schemas = f.tools.schemas();
  assert.deepEqual(schemas.map(s => s.function.name), ['read_source', 'chain_read', 'save_note', 'prepare_social_draft']);
  for (const s of schemas) { assert.equal(s.function.strict, true); assert.equal(s.function.parameters.additionalProperties, false); assert.deepEqual(s.function.parameters.required, Object.keys(s.function.parameters.properties)); }
  schemas[0].function.name = 'arbitrary'; assert.equal(f.tools.schemas()[0].function.name, 'read_source');
});

test('agent draft provenance comes only from trusted runtime identity and auto policy remains a later decision', async () => {
  const f = fixture(); let received;
  f.context.prepareSocialDraft = async (input, provenance) => { received = { input, provenance }; return { id: 'draft', status: 'draft', autoEligible: true, approvalDigest: 'PRIVATE_APPROVAL' }; };
  const result = await f.tools.execute({ name: 'prepare_social_draft', arguments: { channel: 'x', text: 'A supported update.' } }, f.context);
  assert.deepEqual(received.provenance, { jobId: f.context.jobId, callId: f.context.callId });
  assert.equal(received.input.jobId, undefined); assert.equal(result.requiresHumanReview, false); assert.equal(result.approvalMode, 'automatic-policy'); assert.equal(result.published, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_APPROVAL/);
  await assert.rejects(f.tools.execute({ name: 'prepare_social_draft', arguments: { channel: 'x', text: 'Spoof', jobId: 'other' } }, f.context), /schema/);
});

test('read_source enforces reviewed HTTPS domains before executing even an injected source reader', async () => {
  const f = fixture();
  for (const url of ['http://ethereum.org', 'https://127.0.0.1/', 'https://ethereum.org.evil.example/', 'https://user:password@ethereum.org/', 'https://ethereum.org:444/']) await assert.rejects(f.tools.execute({ name: 'read_source', arguments: { url } }, f.context));
  assert.equal(f.calls.length, 0);
  const result = await f.tools.execute({ name: 'read_source', arguments: JSON.stringify({ url: 'https://ethereum.org/' }) }, f.context);
  assert.equal(result.trust, 'untrusted-source-content'); assert.equal(result.source, 'https://ethereum.org/');
});

test('Ethereum balance reads pin all queries to one identified block and report raw token units', async () => {
  const f = fixture();
  const eth = await f.tools.execute({ name: 'chain_read', arguments: { kind: 'eth_balance', address: owner, token: null } }, f.context);
  assert.equal(eth.rawBalance, '123456789'); assert.equal(eth.unit, 'wei'); assert.equal(eth.blockNumber, '123'); assert.equal(eth.blockHash, hash);
  const balance = await f.tools.execute({ name: 'chain_read', arguments: { kind: 'erc20_balance', address: owner, token } }, f.context);
  assert.equal(balance.rawBalance, '987654321'); assert.equal(balance.decimals, null); assert.equal(balance.unit, 'raw-token-units');
  assert.ok(f.calls.every(c => c[1].blockNumber === 123n));
  const request = f.calls.find(c => c[0] === 'token')[1]; assert.equal(request.functionName, 'balanceOf'); assert.deepEqual(request.args, [owner]);
});

test('wrong network, missing token code, and a reorg fail without returning an invented balance', async () => {
  for (const settings of [{ chainId: 8453 }, { code: undefined }, { reorg: true }]) {
    const f = fixture(settings);
    if (Object.hasOwn(settings, 'code')) f.tools.client.getCode = async () => undefined;
    await assert.rejects(f.tools.execute({ name: 'chain_read', arguments: { kind: 'erc20_balance', address: owner, token } }, f.context));
  }
});

test('model arguments cannot choose another project, RPC method, endpoint, or contract selector', async () => {
  const f = fixture();
  for (const extra of [{ projectId: 'project-b' }, { method: 'eth_sendTransaction' }, { rpc: 'https://evil.example' }, { functionName: 'transfer' }]) await assert.rejects(f.tools.execute({ name: 'chain_read', arguments: { kind: 'eth_balance', address: owner, token: null, ...extra } }, f.context), /schema/);
  await assert.rejects(f.tools.execute({ name: 'save_note', arguments: { content: 'bad', projectId: 'project-b' } }, f.context), /schema/);
  await assert.rejects(f.tools.execute({ name: 'publish', arguments: {} }, f.context), /unavailable/);
  assert.equal(f.calls.length, 0); assert.equal(f.projects[1].notes.length, 0);
});

test('save_note calls only the scoped Kit memory path and reports the actual persisted note ID', async () => {
  const f = fixture();
  const result = await f.tools.execute({ name: 'save_note', arguments: { content: '  Remember this evidence.  ' } }, f.context);
  assert.equal(result.noteId, 'note-1'); assert.equal(result.projectId, 'project-a'); assert.equal(f.projects[0].notes[0].content, 'Remember this evidence.');
  assert.equal(f.projects[1].notes.length, 0);
});

test('social drafting has stable idempotency and never returns approval or publishing credentials to the model', async () => {
  const f = fixture(), calls = [];
  f.context.prepareSocialDraft = async args => { calls.push(args); return { id: 'draft-1', status: 'draft', approvalDigest: 'private-review-token', accessToken: 'secret' }; };
  const call = { name: 'prepare_social_draft', arguments: { channel: 'x', text: 'A draft for the human to review.' } };
  const result = await f.tools.execute(call, f.context); await f.tools.execute(call, f.context);
  assert.equal(calls[0].idempotencyKey, calls[1].idempotencyKey); assert.equal(calls[0].madeWithAi, true);
  assert.equal(result.published, false); assert.equal(result.requiresHumanReview, true); assert.equal(result.approvalDigest, undefined); assert.equal(result.accessToken, undefined);
  assert.equal(calls[0].projectId, undefined);
  await assert.rejects(f.tools.execute({ ...call, arguments: { channel: 'x', text: 'x'.repeat(4097) } }, f.context), /Invalid/);
  await assert.rejects(f.tools.execute(call, { ...f.context, prepareSocialDraft: undefined }), /Connect/);
});

test('social tool forwards bounded long URLs for authoritative server weighting', async () => {
  const f = fixture(), calls = [], message = 'Source: https://example.com/' + 'a'.repeat(300);
  f.context.prepareSocialDraft = async args => { calls.push(args); return { id: 'draft-long-url', status: 'draft' }; };
  const result = await f.tools.execute({ name: 'prepare_social_draft', arguments: { channel: 'x', text: message } }, f.context);
  assert.equal(f.tools.schemas().find(s => s.function.name === 'prepare_social_draft').function.parameters.properties.text.maxLength, 4096);
  assert.equal(calls.length, 1); assert.equal(calls[0].text, message); assert.equal(result.text, message); assert.equal(result.published, false);
  f.context.prepareSocialDraft = async () => { throw new Error('X draft exceeds the weighted limit.'); };
  await assert.rejects(f.tools.execute({ name: 'prepare_social_draft', arguments: { channel: 'x', text: 'x'.repeat(281) } }, f.context), /weighted limit/);
});

test('invalid argument objects and absent runtime scope are rejected before callbacks', async () => {
  const f = fixture();
  for (const args of ['not json', '[]', null, [], '{"content":"' + 'x'.repeat(16000) + '"}']) await assert.rejects(f.tools.execute({ name: 'save_note', arguments: args }, f.context));
  await assert.rejects(f.tools.execute({ name: 'read_source', arguments: { url: 'https://ethereum.org/' } }, {}), /project-scoped/);
  assert.equal(f.calls.length, 0); assert.equal(f.projects[0].notes.length, 0);
});

test('RPC transport errors never expose a configured endpoint credential to the model', async () => {
  const f = fixture(); f.tools.client.getChainId = async () => { throw new Error('https://rpc.example/private-api-token'); };
  await assert.rejects(f.tools.execute({ name: 'chain_read', arguments: { kind: 'eth_balance', address: owner, token: null } }, f.context), error => error.status === 502 && !error.message.includes('private-api-token'));
});
