import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeSmokeScope, checkSmokeCatalog, requireSmokeAccounting } from '../scripts/runtime-smoke-scope.mjs';

test('runtime smoke defaults to strict full catalog acceptance and rejects unknown flags', async () => {
  assert.equal(runtimeSmokeScope([]), 'full');
  assert.equal(runtimeSmokeScope(['--recovery-only']), 'wallet-recovery');
  for (const args of [['--recovery-only=true'], ['--recovery-only', '--other'], ['--skip-catalog']]) assert.throws(() => runtimeSmokeScope(args));
  let calls = 0;
  const result = await checkSmokeCatalog({ async models() { calls++; return [{ id: 'verified-model' }]; } }, runtimeSmokeScope([]));
  assert.equal(calls, 1); assert.equal(result.catalogChecked, true); assert.equal(result.modelCount, 1); assert.equal(result.modelCatalogReady, true); assert.equal(result.inferenceReady, false);
});

test('full runtime smoke propagates issuer errors and rejects empty or malformed catalogs', async () => {
  const error = Object.assign(new Error('catalog unavailable'), { code: 'models_unavailable', status: 502 });
  await assert.rejects(checkSmokeCatalog({ async models() { throw error; } }, 'full'), actual => actual === error);
  for (const response of [[], null, { data: [] }]) await assert.rejects(checkSmokeCatalog({ async models() { return response; } }, 'full'));
});

test('explicit recovery scope never queries catalog or claims inference readiness', async () => {
  const result = await checkSmokeCatalog({ async models() { assert.fail('Recovery acceptance must not query or reinterpret the catalog.'); } }, 'wallet-recovery');
  assert.deepEqual(result, { acceptanceScope: 'wallet-recovery', catalogChecked: false, modelCatalogReady: null, modelCount: null, inferenceReady: false });
  assert.throws(() => requireSmokeAccounting('wallet-recovery', false));
  requireSmokeAccounting('wallet-recovery', true);
  await assert.rejects(checkSmokeCatalog({}, 'unknown'));
  assert.throws(() => requireSmokeAccounting('unknown', true));
});
