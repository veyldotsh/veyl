import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { readdirSync, lstatSync, readFileSync, writeFileSync, mkdirSync, existsSync, openSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { relative, resolve, sep, dirname, isAbsolute } from 'node:path';
import { createServer } from 'node:net';
import { SealedState } from './encrypted-state.mjs';

const aad = Buffer.from('veyl-offline-backup-v1');
const sum = b => createHash('sha256').update(b).digest('hex');
const isFree = port => new Promise(r => { const s = createServer(); s.once('error', () => r(false)); s.listen(port, '127.0.0.1', () => s.close(() => r(true))); });
function files(root, directory = root, result = []) {
  for (const item of readdirSync(directory)) {
    const path = resolve(directory, item), stat = lstatSync(path);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || stat.nlink > 1 && stat.isFile()) throw new Error('Backup refuses symbolic links, hard links and special files.');
    if (stat.isDirectory()) files(root, path, result); else result.push(path);
  }
  return result;
}
export async function backup({ directory, output, stateKey, backupKey, portFree = isFree }) {
  directory = resolve(directory); output = resolve(output);
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw new Error('Backup requires a real state directory.');
  if (output === directory || output.startsWith(directory + sep)) throw new Error('Write backups outside the live data directory.');
  if (existsSync(resolve(directory, 'process.lock'))) throw new Error('Stop the Veyl worker cleanly before taking a consistent wallet backup.');
  if (existsSync(resolve(directory, 'RESTORE_REQUIRES_RECONCILIATION'))) throw new Error('Reconcile quarantined restoration before taking another backup.');
  const registryFile = resolve(directory, 'tenants', 'runtimes.sealed.json');
  if (existsSync(registryFile)) {
    const registry = new SealedState(registryFile, stateKey, 'runtime-configuration', {});
    for (const entry of registry.data.projects) {
      if (!await portFree(Number(new URL(entry.origin).port)) || entry.companionPort && !await portFree(entry.companionPort)) throw new Error('A daemon is still running. Stop it before copying its wallet journal.');
    }
  }
  const paths = files(directory), entries = []; let total = 0;
  if (paths.length > 10000) throw new Error('Backup file limit exceeded.');
  for (const path of paths) {
    // Sessions are intentionally invalidated after a restore.
    if (relative(directory, path) === 'auth.sealed.json') continue;
    const data = readFileSync(path); total += data.length;
    if (total > 256_000_000) throw new Error('Backup exceeds the 256 MB safety limit.');
    entries.push({ path: relative(directory, path).split(sep).join('/'), size: data.length, sha256: sum(data), data: data.toString('base64') });
  }
  const snapshot = { version: 1, createdAt: new Date().toISOString(), offline: true, entries };
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', backupKey, iv); cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(snapshot)), cipher.final()]);
  const envelope = JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') });
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  if (existsSync(output)) throw new Error('A backup already exists at this path.');
  const temporary = output + '.tmp'; writeFileSync(temporary, envelope, { flag: 'wx', mode: 0o600 });
  const fd = openSync(temporary, 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); } renameSync(temporary, output);
  return { createdAt: snapshot.createdAt, files: entries.length, bytes: total, encrypted: true, sha256: sum(Buffer.from(envelope)) };
}
export function restore({ input, directory, backupKey }) {
  directory = resolve(directory);
  if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) throw new Error('Restore requires a real recovery directory.');
  if (existsSync(directory) && readdirSync(directory).length) throw new Error('Restore requires a new, empty recovery directory; live state is never overwritten.');
  const raw = readFileSync(input); if (raw.length > 500_000_000) throw new Error('Backup size is invalid.');
  const envelope = JSON.parse(raw), iv = Buffer.from(envelope.iv || '', 'base64'), tag = Buffer.from(envelope.tag || '', 'base64');
  if (envelope.version !== 1 || iv.length !== 12 || tag.length !== 16 || typeof envelope.data !== 'string') throw new Error('Backup format is invalid.');
  const decipher = createDecipheriv('aes-256-gcm', backupKey, iv); decipher.setAAD(aad); decipher.setAuthTag(tag);
  const snapshot = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]));
  if (snapshot.version !== 1 || snapshot.offline !== true || !Array.isArray(snapshot.entries) || snapshot.entries.length > 10000) throw new Error('Backup manifest is invalid.');
  const checked = [], names = new Set(); let total = 0;
  for (const entry of snapshot.entries) {
    if (typeof entry.path !== 'string' || entry.path.length > 1000 || isAbsolute(entry.path) || entry.path.includes('\\') || entry.path.includes(':') || entry.path.split('/').some(p => !p || p === '.' || p === '..') || names.has(entry.path)) throw new Error('Unsafe backup path.');
    const path = resolve(directory, entry.path); if (!path.startsWith(directory + sep)) throw new Error('Unsafe backup path.');
    const data = Buffer.from(entry.data, 'base64'); total += data.length;
    if (data.length !== entry.size || sum(data) !== entry.sha256 || total > 256_000_000) throw new Error('Backup file integrity check failed.');
    checked.push({ path, data }); names.add(entry.path);
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Write the quarantine marker first; partial restoration can never start a worker.
  writeFileSync(resolve(directory, 'RESTORE_REQUIRES_RECONCILIATION'), JSON.stringify({ restoredAt: new Date().toISOString(), backupCreatedAt: snapshot.createdAt, reason: 'Offline snapshot restored. Check canonical receipts, nullifiers and daemon recovery before enabling inference or funding. Sessions were invalidated.' }, null, 2), { mode: 0o600, flag: 'wx' });
  for (const entry of checked) { mkdirSync(dirname(entry.path), { recursive: true, mode: 0o700 }); writeFileSync(entry.path, entry.data, { mode: 0o600, flag: 'wx' }); }
  return { files: checked.length, bytes: total, quarantined: true, sessionsRestored: false };
}
