import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Problem } from './agent.mjs';

// Public transaction metadata only. This journal deliberately cannot hold daemon
// credentials, private notes, signed transaction bytes, or a signing key.
export class PublicJournal {
  #file; #digest = null; #healthy = true; #busy = false; #validate;
  constructor(file, initial, validate) {
    this.#file = resolve(file); this.#validate = validate;
    this.state = structuredClone(initial);
    if (existsSync(this.#file)) {
      try { const raw = this.#read(); this.state = JSON.parse(raw); validate(this.state); this.#digest = digest(raw); }
      catch { throw new Problem('Invalid public operation journal. Preserve it for recovery.', 503); }
    }
  }
  get healthy() { return this.#healthy; }
  snapshot() { return structuredClone(this.state); }
  #read() {
    const fd = openSync(this.#file, 'r');
    try { const stat = fstatSync(fd); if (!stat.isFile() || stat.size > 4_000_000) throw new Error(); return readFileSync(fd, 'utf8'); }
    finally { closeSync(fd); }
  }
  async exclusive(fn) {
    if (!this.#healthy) throw new Problem('Operation journal is blocked after a persistence failure.', 503);
    if (this.#busy) throw new Problem('Another operation is in progress.', 409);
    this.#busy = true; let lock;
    try {
      mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 });
      try { lock = openSync(this.#file + '.lock', 'wx', 0o600); }
      catch { throw new Problem('Operation journal is locked. Inspect recovery before removing a stale lock.', 409); }
      const current = existsSync(this.#file) ? digest(this.#read()) : null;
      if (current !== this.#digest) { this.#healthy = false; throw new Problem('Operation journal changed in another process. Reload it before continuing.', 503); }
      return await fn();
    } catch (error) {
      if (error instanceof Problem) throw error;
      throw new Problem('Operation failed. Inspect its saved state before retrying.', 502);
    } finally {
      this.#busy = false;
      if (lock !== undefined) {
        try { closeSync(lock); unlinkSync(this.#file + '.lock'); }
        catch { this.#healthy = false; throw new Problem('Cannot release the operation journal lock.', 503); }
      }
    }
  }
  save() {
    const tmp = this.#file + '.' + randomUUID() + '.tmp';
    try {
      this.#validate(this.state);
      const raw = JSON.stringify(this.state); if (Buffer.byteLength(raw) > 4_000_000) throw new Error();
      mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 });
      const fd = openSync(tmp, 'wx', 0o600);
      try { writeFileSync(fd, raw); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp, this.#file);
      if (process.platform !== 'win32') { const dir = openSync(dirname(this.#file), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); } }
      this.#digest = digest(raw);
    } catch {
      this.#healthy = false; try { unlinkSync(tmp); } catch {}
      throw new Problem('Cannot persist operation state. Further operations are blocked.', 503);
    }
  }
}
const digest = raw => createHash('sha256').update(raw).digest('hex');
