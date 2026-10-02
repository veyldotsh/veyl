import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { backup, restore } from '../src/backup.mjs';
function fixture(t) { const base = mkdtempSync(resolve(tmpdir(), 'veyl-backup-')); t.after(() => { if (!base.startsWith(resolve(tmpdir(), 'veyl-backup-'))) throw new Error('Invalid cleanup target'); rmSync(base, { force: true, recursive: true }); }); const directory = resolve(base, 'data'); mkdirSync(directory); return { base, directory, output: resolve(base, 'snapshot.enc'), stateKey: randomBytes(32), backupKey: randomBytes(32) }; }
test('offline backup encrypts private files, restores only into quarantine and invalidates sessions', async t => {
  const f = fixture(t); writeFileSync(resolve(f.directory, 'wallet.json'), 'private wallet state'); writeFileSync(resolve(f.directory, 'auth.sealed.json'), 'old sessions');
  const result = await backup(f); assert.equal(result.encrypted, true); assert.equal(result.files, 1);
  assert.ok(!readFileSync(f.output, 'utf8').includes('private wallet state'));
  const recovered = resolve(f.base, 'recovered'), restored = restore({ input: f.output, directory: recovered, backupKey: f.backupKey });
  assert.equal(restored.quarantined, true); assert.equal(readFileSync(resolve(recovered, 'wallet.json'), 'utf8'), 'private wallet state');
  assert.ok(existsSync(resolve(recovered, 'RESTORE_REQUIRES_RECONCILIATION'))); assert.ok(!existsSync(resolve(recovered, 'auth.sealed.json')));
  assert.throws(() => restore({ input: f.output, directory: recovered, backupKey: f.backupKey }), /new, empty/);
});
test('running worker and corrupt backup cannot produce a usable wallet restoration', async t => {
  const f = fixture(t); writeFileSync(resolve(f.directory, 'process.lock'), '123');
  await assert.rejects(backup(f), /Stop the Veyl worker/); rmSync(resolve(f.directory, 'process.lock'));
  await backup(f);
  const recovered = resolve(f.base, 'wrong-key'); assert.throws(() => restore({ input: f.output, directory: recovered, backupKey: randomBytes(32) }));
  assert.ok(!existsSync(recovered));
});
