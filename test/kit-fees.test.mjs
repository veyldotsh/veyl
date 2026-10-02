import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Kit } from '../src/kit.mjs';
import { Store } from '../src/store.mjs';

const start = Date.parse('2026-10-01T12:00:00Z');
const cadence = 300_000;
const marketChain = () => ({ chainId: 31337, type: 'local-anvil', hook: `0x${'1'.repeat(40)}` });
function fixture(t, { live = false, withMarket = true, pendingFees = '0.001' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'veyl-kit-fees-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'kit.json'), calls = [];
  let clock = start;
  const provider = { mode: live ? 'zkapi' : 'demo',
    models: async () => { calls.push(['models']); return [{ id: 'fixture/model', oa_request_limit_micro_usd: 500_000 }]; },
    complete: async () => { calls.push(['complete']); return { answer: 'Offline fixture deliverable', verification: 'fixture', demoCharge: 30_000 }; }
  };
  const markets = {
    launch: async p => { calls.push(['launch', p.id]); return marketChain(); },
    status: async p => { calls.push(['status', p.id]); return { configured: true, pendingFees }; },
    harvest: async p => { calls.push(['harvest', p.id]); return { amount: pendingFees, hash: `0x${'a'.repeat(64)}`, distribution: { hashes: [] } }; }
  };
  const chain = { revenueStatus: async p => {
    calls.push(['revenueStatus', p.id]);
    return { configured: true, claimable: { treasury: '0', creator: '0', platform: '0' } };
  } };
  const store = new Store(file, provider.mode), kit = new Kit({ store, provider, chain, markets, now: () => new Date(clock) });
  const create = () => kit.create({ requestKey: randomUUID(), name: 'Fee keeper fixture', symbol: 'FEE', purpose: 'Test local fee cadence.',
    template: 'research', swarm: false, model: 'fixture/model', total: 5_000_000, daily: 3_000_000, request: 1_000_000 });
  const p = create();
  if (withMarket) { p.chain = marketChain(); p.nextFeeHarvestAt = new Date(start).toISOString(); store.save(); }
  return { dir, file, kit, store, markets, chain, provider, calls, p, create, now: () => clock, setClock: value => { clock = value; } };
}

test('local market launch schedules its first automatic harvest five minutes later', async t => {
  const f = fixture(t, { withMarket: false });
  await f.kit.market(f.p.id, 'launch');
  assert.equal(f.p.nextFeeHarvestAt, new Date(start + cadence).toISOString());
  assert.equal(JSON.parse(readFileSync(f.file)).projects[0].nextFeeHarvestAt, f.p.nextFeeHarvestAt);
  await f.kit.tickFees();
  assert.deepEqual(f.calls, [['launch', f.p.id]]);
  f.setClock(start + cadence); await f.kit.tickFees();
  assert.deepEqual(f.calls.slice(1), [['status', f.p.id], ['harvest', f.p.id]]);
});

test('zero-fee check durably advances cadence before I/O and sends no harvest transaction', async t => {
  const f = fixture(t, { pendingFees: '0' });
  const status = f.markets.status;
  f.markets.status = async p => {
    assert.equal(JSON.parse(readFileSync(f.file)).projects[0].nextFeeHarvestAt, new Date(f.now() + cadence).toISOString());
    return status(p);
  };
  await f.kit.tickFees();
  assert.deepEqual(f.calls, [['status', f.p.id], ['revenueStatus', f.p.id]]);
  assert.equal(f.p.events.some(e => e.type === 'fees'), false);
  assert.equal(f.p.committed, 0); assert.deepEqual(f.p.days, {});
  f.setClock(start + cadence - 1); await f.kit.tickFees();
  assert.equal(f.calls.length, 2);
  f.setClock(start + cadence); await f.kit.tickFees();
  assert.equal(f.calls.length, 4);
});

test('due positive fees use the guarded harvest operation and do not credit inference allowance', async t => {
  const f = fixture(t, { pendingFees: '0.000000000000000001' });
  const harvest = f.markets.harvest;
  f.markets.harvest = async p => {
    assert.equal(f.kit.operations.has(p.id), true);
    assert.equal(JSON.parse(readFileSync(f.file)).projects[0].nextFeeHarvestAt, new Date(start + cadence).toISOString());
    return harvest(p);
  };
  const policy = structuredClone(f.p.policy);
  await f.kit.tickFees();
  assert.deepEqual(f.calls, [['status', f.p.id], ['harvest', f.p.id]]);
  assert.equal(f.p.events.filter(e => e.type === 'fees').length, 1);
  assert.equal(f.kit.operations.size, 0); assert.deepEqual(f.p.policy, policy);
  assert.equal(f.p.committed, 0); assert.deepEqual(f.p.days, {});
});

test('keeper skips markets not yet due, busy projects and projects without a hook', async t => {
  const f = fixture(t);
  f.p.nextFeeHarvestAt = new Date(start + 1).toISOString(); f.store.save();
  await f.kit.tickFees(); assert.deepEqual(f.calls, []);
  f.setClock(start + 1); f.kit.operations.add(f.p.id);
  await f.kit.tickFees(); assert.deepEqual(f.calls, []);
  assert.equal(f.p.nextFeeHarvestAt, new Date(start + 1).toISOString());
  f.kit.operations.delete(f.p.id); delete f.p.chain.hook;
  await f.kit.tickFees(); assert.deepEqual(f.calls, []);
});

test('keeper checks at most one due market per tick without starving another market', async t => {
  const f = fixture(t, { pendingFees: '0' });
  const second = f.create(); second.chain = marketChain(); f.store.save();
  await f.kit.tickFees(); assert.deepEqual(f.calls, [['status', f.p.id], ['revenueStatus', f.p.id]]);
  assert.equal(second.nextFeeHarvestAt, undefined);
  await f.kit.tickFees(); assert.deepEqual(f.calls, [['status', f.p.id], ['revenueStatus', f.p.id], ['status', second.id], ['revenueStatus', second.id]]);
  await f.kit.tickFees(); assert.equal(f.calls.length, 4);
});

test('status, router reads and harvest failures retain five-minute retry cadence without leaking raw errors', async t => {
  for (const method of ['status', 'revenueStatus', 'harvest']) {
    const f = fixture(t, { pendingFees: method === 'revenueStatus' ? '0' : '0.001' }); let attempts = 0;
    (method === 'revenueStatus' ? f.chain : f.markets)[method] = async () => { attempts++; throw new Error('private RPC failure detail'); };
    await f.kit.tickFees();
    assert.equal(attempts, 1); assert.equal(f.kit.operations.size, 0);
    const retries = f.p.events.filter(e => e.type === 'fee-retry');
    assert.equal(retries.length, 1); assert.doesNotMatch(retries[0].message, /private RPC/);
    assert.equal(new Store(f.file, 'demo').data.projects[0].nextFeeHarvestAt, new Date(start + cadence).toISOString());
    f.setClock(start + cadence - 1); await f.kit.tickFees(); assert.equal(attempts, 1);
    f.setClock(start + cadence); await f.kit.tickFees(); assert.equal(attempts, 2);
    assert.equal(f.p.nextFeeHarvestAt, new Date(start + 2 * cadence).toISOString());
  }
});

test('keeper retries every remaining router share after the hook flush succeeds but distribution fails', async t => {
  for (const role of ['treasury', 'creator', 'platform']) {
    const f = fixture(t); let pendingFees = '0.001', attempts = 0;
    const claimable = { treasury: '0', creator: '0', platform: '0' };
    f.markets.status = async p => { f.calls.push(['status', p.id]); return { configured: true, pendingFees }; };
    f.chain.revenueStatus = async p => { f.calls.push(['revenueStatus', p.id]); return { configured: true, claimable: { ...claimable } }; };
    f.markets.harvest = async p => {
      f.calls.push(['harvest', p.id]); attempts++;
      assert.equal(f.kit.operations.has(p.id), true);
      if (attempts === 1) {
        pendingFees = '0'; claimable[role] = '0.000000000000000001';
        throw new Error('distribution failed after a successful flush');
      }
      assert.equal(pendingFees, '0');
      assert.equal(claimable[role], '0.000000000000000001');
      claimable[role] = '0';
      return { amount: '0', hash: null, distribution: { hashes: [`0x${'b'.repeat(64)}`] } };
    };
    await f.kit.tickFees();
    assert.equal(attempts, 1); assert.equal(f.p.events.filter(e => e.type === 'fee-retry').length, 1);
    f.setClock(start + cadence - 1); await f.kit.tickFees(); assert.equal(attempts, 1);
    f.setClock(start + cadence); await f.kit.tickFees();
    assert.equal(attempts, 2);
    assert.deepEqual(f.calls.slice(-3), [['status', f.p.id], ['revenueStatus', f.p.id], ['harvest', f.p.id]]);
    assert.equal(f.p.events.filter(e => e.type === 'fees').length, 1);
    assert.equal(f.p.committed, 0); assert.deepEqual(f.p.days, {});
    f.setClock(start + 2 * cadence); await f.kit.tickFees();
    assert.equal(attempts, 2); assert.equal(f.kit.operations.size, 0);
    assert.deepEqual(f.calls.slice(-2), [['status', f.p.id], ['revenueStatus', f.p.id]]);
  }
});

test('unhealthy persistence blocks every keeper read and transaction', async t => {
  const f = fixture(t); f.store.healthy = false;
  await assert.rejects(f.kit.tickFees(), e => e.status === 503);
  await assert.rejects(f.kit.tick(), e => e.status === 503);
  assert.deepEqual(f.calls, []);
});

test('failed cadence checkpoint blocks I/O and retains the last durable deadline', async t => {
  const f = fixture(t); const previous = readFileSync(f.file, 'utf8');
  f.store.file = join(f.dir, 'blocked-destination'); mkdirSync(f.store.file);
  await assert.rejects(f.kit.tickFees(), e => e.status === 503);
  assert.equal(f.store.healthy, false); assert.deepEqual(f.calls, []);
  assert.equal(readFileSync(f.file, 'utf8'), previous);
});

test('live inference mode and absent market integration never invoke automatic market actions', async t => {
  const f = fixture(t, { live: true }); const deadline = f.p.nextFeeHarvestAt;
  await f.kit.tickFees(); await f.kit.tick();
  assert.deepEqual(f.calls, []); assert.equal(f.p.nextFeeHarvestAt, deadline);
  const demo = fixture(t); demo.kit.markets = null;
  await demo.kit.tickFees(); assert.deepEqual(demo.calls, []);
});

test('main tick processes due fees before accepting a scheduled agent job', async t => {
  const f = fixture(t);
  f.p.schedule = { minutes: 15, prompt: 'Run the offline scheduled fixture', nextAt: new Date(start).toISOString() }; f.store.save();
  await f.kit.tick(); await f.kit.execution;
  assert.deepEqual(f.calls.map(call => call[0]), ['status', 'harvest', 'models', 'complete']);
  assert.equal(f.store.data.jobs[0].status, 'completed');
  assert.equal(f.p.nextFeeHarvestAt, new Date(start + cadence).toISOString());
  assert.equal(f.p.schedule.nextAt, new Date(start + 15 * 60_000).toISOString());
});
