import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createVeylMcpServer } from '../packages/veyl/mcp.mjs';
import { VeylClient, VeylApiError } from '../packages/veyl/client.mjs';

const requestKey = '12345678-1234-1234-1234-123456789012';
const token = 'veyl_sk_' + 'd'.repeat(64);
const initialize = { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'veyl-test', version: '1.0.0' } };
async function protocol(t, client) {
  const [peer, transport] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createVeylMcpServer({ client }), { transport });
  t.after(() => handle.close());
  let sequence = 0;
  const pending = new Map();
  peer.onmessage = message => { if (message.id !== undefined) pending.get(message.id)?.(message); };
  await peer.start();
  async function send(method, params) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(Error('MCP test response timed out')); }, 5000);
      pending.set(id, value => { clearTimeout(timer); pending.delete(id); resolve(value); });
      peer.send({ jsonrpc: '2.0', id, method, params }).catch(reject);
    });
  }
  const opened = await send('initialize', initialize);
  assert.equal(opened.result.serverInfo.name, 'veyl');
  await peer.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return { send, call: (name, args = {}) => send('tools/call', { name, arguments: args }) };
}

test('MCP negotiates the protocol and exposes fifteen scoped tools with honest annotations', async t => {
  const p = await protocol(t, {}), reply = await p.send('tools/list', {});
  const tools = reply.result.tools;
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['veyl_activity', 'veyl_autonomy', 'veyl_project', 'veyl_models', 'veyl_jobs', 'veyl_job', 'veyl_memory', 'veyl_drafts', 'veyl_submit_job', 'veyl_save_memory', 'veyl_prepare_draft', 'veyl_research', 'veyl_create_watchlist', 'veyl_update_watchlist', 'veyl_check_watchlist'].sort());
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.annotations.openWorldHint, true);
    assert.equal(tool.annotations.idempotentHint, true);
    assert.equal(tool.annotations.readOnlyHint, !['veyl_submit_job', 'veyl_save_memory', 'veyl_prepare_draft', 'veyl_create_watchlist', 'veyl_update_watchlist', 'veyl_check_watchlist'].includes(tool.name));
    assert.equal(tool.annotations.destructiveHint, ['veyl_submit_job', 'veyl_create_watchlist', 'veyl_update_watchlist', 'veyl_check_watchlist'].includes(tool.name));
  }
  assert.match(tools.find(tool => tool.name === 'veyl_submit_job').description, /inference budget/);
  assert.match(tools.find(tool => tool.name === 'veyl_prepare_draft').description, /Does not connect accounts, approve or publish/);
  assert.ok((await p.call('veyl_publish')).error);
});

test('MCP tool calls route through the SDK with exact project-bound requests and defaults', async t => {
  const calls = [];
  const client = new VeylClient({ token, fetch: async (url, init) => { calls.push({ url, init }); return new Response('{"saved":true}'); } });
  const p = await protocol(t, client);
  const cases = [
    ['veyl_project', {}, 'project'], ['veyl_models', {}, 'models'],
    ['veyl_jobs', { requestKey }, `jobs?requestKey=${requestKey}`], ['veyl_job', { jobId: 'job_123' }, 'jobs/job_123'],
    ['veyl_memory', {}, 'memory'], ['veyl_drafts', {}, 'drafts'],
    ['veyl_research', {}, 'research'], ['veyl_activity', {}, 'activity'], ['veyl_autonomy', {}, 'autonomy'],
    ['veyl_create_watchlist', { requestKey, name: 'Changes', brief: 'Summarize changes.', sources: ['https://ethereum.org/en/'], enabled: false, cadenceMinutes: 60 }, 'research/watchlists'],
    ['veyl_update_watchlist', { watchId: requestKey, enabled: false }, `research/watchlists/${requestKey}`],
    ['veyl_check_watchlist', { watchId: requestKey, requestKey }, `research/watchlists/${requestKey}/checks`],
    ['veyl_submit_job', { requestKey, prompt: 'Review sources' }, 'jobs'],
    ['veyl_save_memory', { requestKey, content: 'Confirmed decision' }, 'memory'],
    ['veyl_prepare_draft', { channel: 'x', text: 'Ready for owner review', idempotencyKey: requestKey }, 'drafts']
  ];
  for (const [name, args, path] of cases) {
    const reply = await p.call(name, args);
    assert.equal(reply.result.isError, undefined);
    assert.deepEqual(reply.result.structuredContent, { saved: true });
    const sent = calls.at(-1);
    assert.equal(sent.url, `https://veyl.sh/api/developer/v1/${path}`);
    assert.equal(sent.init.headers.Authorization, `Bearer ${token}`);
    assert.equal(sent.init.credentials, 'omit');
    if (sent.init.method === 'POST') { const { watchId: _watchId, ...body } = args; assert.deepEqual(JSON.parse(sent.init.body), name === 'veyl_prepare_draft' ? { ...body, madeWithAi: true } : body); }
  }
  assert.equal(calls.length, cases.length);
});

test('MCP rejects extra authority, invalid paths, malformed keys and empty payloads before API dispatch', async t => {
  let calls = 0;
  const p = await protocol(t, new Proxy({}, { get: () => () => { calls++; return {}; } }));
  for (const [name, args] of [
    ['veyl_project', { projectId: 'other-project' }], ['veyl_job', { jobId: '../funding' }],
    ['veyl_submit_job', { requestKey: 'short', prompt: 'Work' }], ['veyl_submit_job', { requestKey, prompt: 'Work', approve: true }],
    ['veyl_save_memory', { requestKey, content: '   ' }], ['veyl_save_memory', { requestKey: requestKey + '_', content: 'Note' }],
    ['veyl_prepare_draft', { channel: 'x', text: 'x'.repeat(4097), idempotencyKey: requestKey }],
    ['veyl_prepare_draft', { channel: 'telegram', text: 'Hello', idempotencyKey: requestKey, publish: true }],
    ['veyl_prepare_draft', { channel: 'email', text: 'Hello', idempotencyKey: requestKey }]
    , ['veyl_research', { projectId: 'other' }]
    , ['veyl_create_watchlist', { requestKey, name: 'Changes', brief: 'Summarize changes.', sources: ['https://ethereum.org'], cadenceMinutes: 60 }]
    , ['veyl_check_watchlist', { watchId: requestKey, requestKey, projectId: 'other' }]
    , ['veyl_update_watchlist', { watchId: requestKey }]
  ]) {
    const reply = await p.call(name, args);
    assert.ok(reply.error || reply.result?.isError, `${name} should reject invalid input`);
  }
  assert.equal(calls, 0);
});

test('MCP preserves uncertain mutation outcomes, never retries and does not reveal error credentials', async t => {
  let calls = 0;
  const p = await protocol(t, { submitJob: async () => { calls++; throw new VeylApiError(`Bearer ${token}`, { status: 503, code: 'NETWORK_ERROR', requestId: token, uncertain: true }); } });
  const reply = await p.call('veyl_submit_job', { requestKey, prompt: 'Research' });
  assert.equal(calls, 1);
  assert.equal(reply.result.isError, true);
  assert.equal(reply.result.structuredContent.uncertain, true);
  assert.equal(reply.result.structuredContent.status, 503);
  assert.match(reply.result.structuredContent.error, /veyl_jobs with the original requestKey/);
  assert.match(reply.result.structuredContent.error, /Do not create a new idempotency key/);
  assert.equal(JSON.stringify(reply).includes(token), false);
});

test('MCP reports missing token scopes and strips arbitrary thrown error details', async t => {
  const p = await protocol(t, {
    memory: async () => { throw new VeylApiError('Not allowed', { status: 403, code: 'SCOPE_REQUIRED' }); },
    prepareDraft: async () => { throw Error(`Internal stack ${token}`); }
  });
  const denied = (await p.call('veyl_memory')).result;
  assert.equal(denied.structuredContent.uncertain, false);
  assert.match(denied.structuredContent.error, /required scope/);
  const unknown = (await p.call('veyl_prepare_draft', { channel: 'telegram', text: 'Hello', idempotencyKey: requestKey })).result;
  assert.equal(unknown.structuredContent.uncertain, true);
  assert.equal(JSON.stringify(unknown).includes(token), false);
});

test('MCP forwards long raw X URLs for server-side weighted counting', async t => {
  const text = 'https://example.com/' + 'a'.repeat(300); let seen;
  const p = await protocol(t, { prepareDraft: async args => { seen = args; return { draft: { preview: { text: args.text } } }; } });
  const reply = (await p.call('veyl_prepare_draft', { channel: 'x', text, idempotencyKey: requestKey })).result;
  assert.equal(reply.isError, undefined); assert.equal(seen.text, text);
});

test('MCP executable uses clean stdio and exits after input closes, without contacting the API', async t => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../packages/veyl/mcp.mjs', import.meta.url))], { env: { SystemRoot: process.env.SystemRoot, VEYL_API_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = '', stderr = '', sequence = 0;
  const pending = new Map();
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    output += chunk;
    for (;;) { const end = output.indexOf('\n'); if (end < 0) break; const message = JSON.parse(output.slice(0, end)); output = output.slice(end + 1); pending.get(message.id)?.(message); }
  });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => reject(Error('CLI MCP response timed out')), 5000);
    pending.set(id, message => { clearTimeout(timer); pending.delete(id); resolve(message); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  assert.equal((await send('initialize', initialize)).result.serverInfo.name, 'veyl');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  assert.equal((await send('tools/list', {})).result.tools.length, 15);
  child.stdin.end();
  assert.deepEqual(await closed, { code: 0, signal: null });
  assert.equal(stderr, '');
  assert.equal(output, '');
});

test('MCP executable fails closed on missing credentials without exposing environment or protocol noise', async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../packages/veyl/mcp.mjs', import.meta.url))], { env: { SystemRoot: process.env.SystemRoot, VEYL_API_TOKEN: 'invalid-private-value' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise(resolve => child.once('close', resolve));
  assert.equal(code, 1); assert.equal(stdout, ''); assert.match(stderr, /Set VEYL_API_TOKEN/); assert.equal(stderr.includes('invalid-private-value'), false);
});
