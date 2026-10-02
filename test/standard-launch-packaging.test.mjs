import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { checkStandardLaunchArtifact } from '../scripts/check-standard-launch-artifact.mjs';

const root = resolve(import.meta.dirname, '..');
const name = 'VeylAgentLaunchFactory';
const compiled = JSON.parse(readFileSync(resolve(root, `contracts/out/${name}.sol/${name}.json`), 'utf8'));
function fixture(t, policy, { artifact = compiled, abi = compiled.abi } = {}) {
  const parent = resolve(root, 'output'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(resolve(parent, 'standard-package-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const put = (path, value) => { const full = resolve(directory, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, JSON.stringify(value)); };
  put('config/mainnet.json', { agentMarkets: policy });
  if (artifact) put(`contracts/out/${name}.sol/${name}.json`, artifact);
  if (abi) put(`contracts/abi/${name}.json`, abi);
  return directory;
}

test('inactive legacy packages stay compatible and an included new artifact must match its ABI', t => {
  assert.deepEqual(checkStandardLaunchArtifact(fixture(t, {}, { artifact: null, abi: null })), { required: false, checked: false, contract: name });
  assert.equal(checkStandardLaunchArtifact(root).checked, true);
  assert.equal(checkStandardLaunchArtifact(fixture(t, { standardLaunch: false })).checked, true);
  assert.throws(() => checkStandardLaunchArtifact(fixture(t, {}, { abi: null })), /both/);
  assert.throws(() => checkStandardLaunchArtifact(fixture(t, {}, { abi: [] })), /ABI differs/);
});

test('active factory and retained standard addresses require artifacts before worker activation', t => {
  for (const policy of [{ standardLaunch: true }, { standardLaunch: false, standardFactory: '0x1111111111111111111111111111111111111111' }]) {
    assert.throws(() => checkStandardLaunchArtifact(fixture(t, policy, { artifact: null, abi: null })), /both/);
    assert.equal(checkStandardLaunchArtifact(fixture(t, policy)).required, true);
  }
});

test('packaging rejects oversized runtime, constructor initcode, and foreign compiler settings', t => {
  const largeRuntime = structuredClone(compiled); largeRuntime.deployedBytecode.object = '0x' + '01'.repeat(24577);
  assert.throws(() => checkStandardLaunchArtifact(fixture(t, { standardLaunch: true }, { artifact: largeRuntime })), /size limits/);
  const largeInit = structuredClone(compiled); largeInit.bytecode.object = '0x' + '01'.repeat(49152 - 255);
  assert.throws(() => checkStandardLaunchArtifact(fixture(t, { standardLaunch: true }, { artifact: largeInit })), /size limits/);
  const foreign = structuredClone(compiled); foreign.metadata.settings.optimizer.runs = 201;
  assert.throws(() => checkStandardLaunchArtifact(fixture(t, { standardLaunch: true }, { artifact: foreign })), /compiler or target/);
});

test('all worker install and upgrade paths check the new package before service mutation', () => {
  for (const file of ['install-worker.sh', 'upgrade-worker.sh', 'upgrade-accounting-worker.sh']) {
    const source = readFileSync(resolve(root, 'deployment', file), 'utf8');
    const check = source.indexOf('"$release/scripts/check-standard-launch-artifact.mjs" "$release"');
    assert.ok(check >= 0, file + ' must inspect the candidate package');
    const mutation = file === 'install-worker.sh' ? source.indexOf('install -o root -g root -m 644 <(veyl_render') : file === 'upgrade-worker.sh' ? source.indexOf('switched=1; switch_current') : source.indexOf('transition=1');
    assert.ok(mutation > check, file + ' must reject before switching an installed worker');
  }
});
