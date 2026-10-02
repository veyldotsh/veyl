import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

export function stateKey(value) {
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value)) throw new Error('VEYL_STATE_KEY must contain 32 random bytes encoded as 64 hex characters.');
  return Buffer.from(value, 'hex');
}
export function encryptedCodec(key, context) {
  if (!Buffer.isBuffer(key) || key.length !== 32 || typeof context !== 'string' || !context) throw new Error('Invalid encrypted state configuration.');
  const aad = Buffer.from(`veyl-state-v1:${context}`);
  return {
    encode(value) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad);
      const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
    },
    decode(value) {
      const envelope = JSON.parse(value);
      if (envelope.version !== 1 || typeof envelope.iv !== 'string' || typeof envelope.tag !== 'string' || typeof envelope.data !== 'string') throw new Error('Invalid encrypted state.');
      const iv = Buffer.from(envelope.iv, 'base64'), tag = Buffer.from(envelope.tag, 'base64');
      if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid encrypted state.');
      const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAAD(aad); decipher.setAuthTag(tag);
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8'));
    }
  };
}
export class SealedState {
  constructor(file, key, context, initial) {
    this.file = file; this.codec = encryptedCodec(key, context); this.healthy = true; this.diskHash = null;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    try { const raw = readFileSync(file, 'utf8'); this.data = this.codec.decode(raw); this.diskHash = createHash('sha256').update(raw).digest('hex'); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Encrypted state cannot be read. Preserve the file and recover its original key.'); this.data = initial; this.save(); }
  }
  save() {
    if (!this.healthy) throw new Error('State persistence is blocked.');
    let lock;
    try {
      lock = openSync(this.file + '.write-lock', 'wx', 0o600);
      let current = null;
      try { current = createHash('sha256').update(readFileSync(this.file, 'utf8')).digest('hex'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (current !== this.diskHash) throw new Error('Encrypted state changed in another process.');
      const temporary = this.file + '.tmp';
      const encoded = this.codec.encode(this.data); writeFileSync(temporary, encoded, { mode: 0o600 });
      const fd = openSync(temporary, 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, this.file);
      if (process.platform !== 'win32') { const dir = openSync(dirname(this.file), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); } }
      this.diskHash = createHash('sha256').update(encoded).digest('hex');
    } catch { this.healthy = false; throw new Error('State persistence failed.'); }
    finally { if (lock !== undefined) { closeSync(lock); unlinkSync(this.file + '.write-lock'); } }
  }
}
