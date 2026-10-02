import { createHash, createHmac, randomBytes } from 'node:crypto';
import { equalSecret } from './auth.mjs';
import { Problem } from './agent.mjs';

const signedHeaders = ['content-type', 'cookie', 'origin', 'x-agent-csrf', 'x-veyl-client'];
function keyBytes(key) { if (typeof key !== 'string' || !/^[a-fA-F0-9]{64}$/.test(key)) throw new Error('VEYL_GATEWAY_KEY must be 64 hex characters.'); return Buffer.from(key, 'hex'); }
function canonical({ method, path, headers, body, time, nonce }) {
  // Preserve existing session signatures during rolling updates. A bearer
  // header, when present, is additionally bound; adding/removing it invalidates
  // the signature. The secret itself is never returned or logged.
  const values = signedHeaders.map(name => String(headers[name] || ''));
  if (headers.authorization !== undefined) values.push(String(headers.authorization));
  return JSON.stringify([method, path, time, nonce, values, createHash('sha256').update(body).digest('hex')]);
}
export function signGateway({ key, method, path, headers, body, now = Date.now() }) {
  const time = String(now), nonce = randomBytes(24).toString('hex');
  const signature = createHmac('sha256', keyBytes(key)).update(canonical({ method, path, headers, body, time, nonce })).digest('hex');
  return { 'x-veyl-time': time, 'x-veyl-nonce': nonce, 'x-veyl-signature': signature };
}
export class GatewayVerifier {
  constructor({ key, now = Date.now }) { this.key = keyBytes(key); this.now = now; this.seen = new Map(); }
  verify({ method, path, headers, body }) {
    const time = headers['x-veyl-time'], nonce = headers['x-veyl-nonce'], signature = headers['x-veyl-signature'], now = this.now();
    if (typeof time !== 'string' || !/^\d{13}$/.test(time) || Math.abs(now - Number(time)) > 30_000 || typeof nonce !== 'string' || !/^[a-f0-9]{48}$/.test(nonce)) throw new Problem('Invalid service request.', 403);
    const expected = createHmac('sha256', this.key).update(canonical({ method, path, headers, body, time, nonce })).digest('hex');
    if (!equalSecret(expected, signature)) throw new Problem('Invalid service request.', 403);
    for (const [id, expires] of this.seen) if (expires < now) this.seen.delete(id);
    if (this.seen.has(nonce)) throw new Problem('Service request already used.', 409);
    if (this.seen.size >= 100_000) throw new Problem('Service is temporarily busy.', 503);
    this.seen.set(nonce, now + 60_000);
  }
}
