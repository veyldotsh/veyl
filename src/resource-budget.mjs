import { readdirSync, lstatSync, statfsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Problem } from './agent.mjs';

function measure(directory) {
  const fs = statfsSync(directory, { bigint: true }); let bytes = 0, files = 0; const pending = [directory];
  while (pending.length) {
    const dir = pending.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name); let stat; try { stat = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (stat.isSymbolicLink()) throw new Error('State contains an unexpected symlink.');
      if (stat.isDirectory()) pending.push(path); else if (stat.isFile()) { bytes += stat.size; files++; } else throw new Error('State contains a special file.');
      if (files > 100000) throw new Error('State file limit exceeded.');
    }
  }
  return { bytes, files, available: Number(fs.bavail * fs.bsize) };
}
export class ResourceBudget {
  constructor({ directory, maxBytes = 2 * 1024 ** 3, minFreeBytes = 512 * 1024 ** 2, now = Date.now, inspect = measure }) {
    if (![maxBytes, minFreeBytes].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('Invalid storage capacity.');
    this.directory = directory; this.maxBytes = maxBytes; this.minFreeBytes = minFreeBytes; this.now = now; this.inspect = inspect; this.checked = null;
  }
  snapshot() {
    if (!this.checked || this.now() - this.checked.at >= 10000) {
      try { const value = this.inspect(this.directory); this.checked = { ...value, at: this.now(), healthy: value.bytes < this.maxBytes && value.available >= this.minFreeBytes }; }
      catch { this.checked = { at: this.now(), healthy: false, error: 'Storage cannot be inspected safely.' }; }
    }
    return { ...this.checked, maxBytes: this.maxBytes, minFreeBytes: this.minFreeBytes };
  }
  assertCapacity() { if (!this.snapshot().healthy) throw new Problem('Runtime storage limit reached or free space is too low. New work is blocked; existing recovery data is preserved.', 503); }
}
