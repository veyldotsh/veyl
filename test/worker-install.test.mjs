import test from 'node:test';
import assert from 'node:assert/strict';
import { patchControlSource } from '../scripts/patch-zkapi-control.mjs';
import { createWorkerEnvironment, validateWorkerEnvironment, workerEnvironment } from '../scripts/prepare-worker-env.mjs';

test('worker configuration generates independent private keys and rejects autonomous spending flags, unsafe bind, duplicate or extra configuration', () => {
  const raw = createWorkerEnvironment(); assert.equal(validateWorkerEnvironment(raw), true);
  const generated = [...raw.matchAll(/^VEYL_(STATE|GATEWAY|BACKUP)_KEY=([a-f0-9]{64})$/gm)].map(m => m[2]);
  assert.equal(generated.length, 3); assert.equal(new Set(generated).size, 3);
  assert.notEqual(createWorkerEnvironment(), raw);
  for (const changed of [
    raw.replace('VEYL_ENABLE_SOCIAL_PUBLISHING=false', 'VEYL_ENABLE_SOCIAL_PUBLISHING=true'),
    raw.replace('VEYL_FEE_KEEPER_ENABLED=false', 'VEYL_FEE_KEEPER_ENABLED=true'),
    raw.replace('BIND_HOST=127.0.0.1', 'BIND_HOST=0.0.0.0'),
    raw.replace('VEYL_MAX_ACTIVE_RUNTIMES=1', 'VEYL_MAX_ACTIVE_RUNTIMES=20'),
    raw + 'VEYL_OPERATOR_KEY=not-authorized\n', raw + 'PORT=4320\n', raw.replace(generated[1], generated[0]), raw.replace(generated[0], 'invalid')
  ]) assert.throws(() => validateWorkerEnvironment(changed));
  assert.equal(workerEnvironment({}).VEYL_DATA_DIR, '/home/veyl/veyl/worker-data/production');
});

test('existing configuration accepts only literal mainnet booleans while creation stays disabled', () => {
  const env = { VEYL_HOME: '/home/operator/veyl', VEYL_SERVICE_USER: 'operator', VEYL_ENABLE_MAINNET_TRANSACTIONS: 'true' };
  const raw = createWorkerEnvironment(env);
  assert.match(raw, /^VEYL_ENABLE_MAINNET_TRANSACTIONS=false$/m);
  for (const value of ['false', 'true']) assert.equal(validateWorkerEnvironment(raw.replace('VEYL_ENABLE_MAINNET_TRANSACTIONS=false', 'VEYL_ENABLE_MAINNET_TRANSACTIONS=' + value), env), true);
  for (const value of ['', 'TRUE', '1', 'yes', 'true ', 'false ']) assert.throws(() => validateWorkerEnvironment(raw.replace('VEYL_ENABLE_MAINNET_TRANSACTIONS=false', 'VEYL_ENABLE_MAINNET_TRANSACTIONS=' + value), env));
  assert.throws(() => validateWorkerEnvironment(raw + 'VEYL_ENABLE_ZKAPI_APPROVAL=true\n', env));
  assert.throws(() => validateWorkerEnvironment(raw + 'VEYL_ENABLE_MAINNET_TRANSACTIONS=true\n', env));
});

test('existing hosts validate private path overrides without changing their saved environment', () => {
  const env = { VEYL_HOME: '/home/operator/veyl', VEYL_SERVICE_USER: 'operator' };
  const raw = createWorkerEnvironment(env);
  assert.equal(validateWorkerEnvironment(raw, env), true);
  assert.equal(workerEnvironment(env).VEYL_DATA_DIR, '/home/operator/veyl/worker-data/production');
  assert.equal(workerEnvironment(env).VEYL_ZKAPI_CLIENTD, '/home/operator/veyl/bin/zkapi-clientd-control');
  assert.throws(() => validateWorkerEnvironment(raw, {}), /differs/);
});

test('native control verifier rejects foreign or already-patched input rather than applying a loose text patch', () => {
  assert.throws(() => patchControlSource('package main\n'), /Unexpected upstream/);
  assert.throws(() => patchControlSource('// VEYL_UNFUNDED_CONTROL_V1\npackage main\n'), /already patched/);
});
