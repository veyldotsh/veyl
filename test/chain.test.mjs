import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { LocalChain } from '../src/chain.mjs';

const accounts = ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222'];

async function listen(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function rpcHandler(results, calls) {
  return async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    calls.push(request.method);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: results[request.method] }));
  };
}

test('local chain rejects RPC redirects before reaching their destination', async t => {
  // A second reachable loopback endpoint makes this regression safe and deterministic:
  // without redirect:error both clients would follow it and receive valid RPC answers.
  for (const status of [307, 308]) await t.test(`HTTP ${status}`, async t => {
    const targetCalls = [];
    const target = await listen(t, rpcHandler({ eth_chainId: '0x7a69', eth_accounts: accounts }, targetCalls));
    let initialCalls = 0;
    const origin = await listen(t, (_req, res) => {
      initialCalls++;
      res.writeHead(status, { Location: target }); res.end();
    });
    const chain = new LocalChain(origin);
    await assert.rejects(chain.client.getChainId());
    await assert.rejects(chain.wallet.getAddresses());
    assert.equal(initialCalls, 2);
    assert.deepEqual(targetCalls, []);
  });
});

test('local chain accepts only an Anvil identity on chain 31337 before account access', async t => {
  for (const [name, results, expectedCalls, error] of [
    ['mainnet chain ID', { eth_chainId: '0x1' }, ['eth_chainId'], /Only Anvil chain 31337/],
    ['non-Anvil client', { eth_chainId: '0x7a69', web3_clientVersion: 'Geth/test' }, ['eth_chainId', 'web3_clientVersion'], /Expected a local Anvil/],
  ]) await t.test(name, async t => {
    const calls = [];
    const chain = new LocalChain(await listen(t, rpcHandler(results, calls)));
    await assert.rejects(chain.check(), error);
    assert.deepEqual(calls, expectedCalls);
  });
});

test('local chain readiness uses read-only RPC methods with an allowed local mock', async t => {
  const calls = [];
  const origin = await listen(t, rpcHandler({ eth_chainId: '0x7a69', web3_clientVersion: 'anvil/test', eth_accounts: accounts }, calls));
  const chain = new LocalChain(origin);
  assert.equal((await chain.status()).ready, true);
  assert.equal(chain.account, accounts[0]);
  assert.equal(chain.platformAccount, accounts[1]);
  assert.deepEqual(calls, ['eth_chainId', 'web3_clientVersion', 'eth_accounts']);
});
