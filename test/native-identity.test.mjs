import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { RuntimeProvisioner } from '../src/runtime-provision.mjs';
import { ZKAPI_SOURCE_REVISION } from '../src/provider.mjs';

test('native accounting requires the exact source lock and installed binary hashes', t => {
  const directory = mkdtempSync(resolve(tmpdir(), 'veyl-native-identity-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const executable = resolve(directory, 'clientd'), walletBinary = resolve(directory, 'walletd'), proofSetupDir = resolve(directory, 'proofs'), manifest = resolve(directory, 'manifest.json');
  mkdirSync(proofSetupDir);
  for (const path of [executable, walletBinary, resolve(proofSetupDir, 'manifest.json')]) writeFileSync(path, 'offline identity fixture');
  const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
  const sourceLock = new URL('../deployment/native/source-lock.json', import.meta.url), lock = JSON.parse(readFileSync(sourceLock, 'utf8'));
  const valid = { version: 2, patch: 'VEYL_CALL_ACCOUNTING_V1', sourceRevision: ZKAPI_SOURCE_REVISION,
    sourceLockSha256: digest(sourceLock), companionRevision: lock.companionRevision, protocolRevision: lock.protocolRevision,
    clientSha256: digest(executable), walletSha256: digest(walletBinary), proofManifestSha256: digest(resolve(proofSetupDir, 'manifest.json')) };
  const create = identity => {
    writeFileSync(manifest, JSON.stringify(identity));
    return new RuntimeProvisioner({ directory, executable, walletBinary, proofSetupDir, manifest, configuration: { projects: [] }, save() {} });
  };
  assert.equal(create(valid).binaryIdentityVerified, true);
  for (const field of ['sourceLockSha256', 'companionRevision', 'protocolRevision', 'sourceRevision', 'clientSha256', 'walletSha256', 'proofManifestSha256', 'patch']) {
    assert.throws(() => create({ ...valid, [field]: 'changed' }), /identity differs/);
  }
  writeFileSync(walletBinary, 'changed executable');
  assert.throws(() => create(valid), /identity differs/);
});
