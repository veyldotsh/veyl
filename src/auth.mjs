import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { getAddress, verifyMessage } from 'viem';
import { Problem } from './agent.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('hex');
export function equalSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export const SESSION_COOKIE = '__Host-veyl';
export function sessionCookie(token, maxAge = 86400) { return `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`; }
export function cookieToken(value = '') {
  const entries = value.split(';').map(s => s.trim()).filter(s => s.startsWith(SESSION_COOKIE + '='));
  if (entries.length !== 1) return null;
  const token = entries[0].slice(SESSION_COOKIE.length + 1);
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}

// EOA sign-in only. Contract-wallet authentication must use an explicit ERC-1271
// verifier rather than silently treating a contract address as an EOA.
export class WalletAuth {
  constructor({ origin, state, save, now = Date.now, verify = verifyMessage, maxChallenges = 1000, maxSessions = 1000 }) {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error('PUBLIC_ORIGIN must be an HTTPS origin.');
    this.origin = url.origin; this.domain = url.host; this.state = state; this.healthy = true; this.now = now; this.verify = verify;
    this.save = () => { try { save(); } catch { this.healthy = false; throw new Problem('Authentication persistence is blocked.', 503); } };
    this.verifying = new Set(); this.rates = new Map();
    this.maxChallenges = maxChallenges; this.maxSessions = maxSessions;
    if (state.version !== 1 || !Array.isArray(state.challenges) || !Array.isArray(state.sessions) || state.challenges.length > maxChallenges || state.sessions.length > maxSessions) throw new Error('Invalid or over-capacity authentication state.');
  }
  prune() {
    const now = this.now();
    this.state.challenges = this.state.challenges.filter(c => c.expires > now);
    this.state.sessions = this.state.sessions.filter(s => s.expires > now);
    for (const [key, item] of this.rates) if (item.until < now) this.rates.delete(key);
  }
  limit(key) {
    if (!this.healthy) throw new Problem('Authentication persistence is blocked.', 503);
    this.prune(); const entry = this.rates.get(key) || { until: this.now() + 60_000, count: 0 };
    if (++entry.count > 12) throw new Problem('Too many authentication requests. Try again in a minute.', 429);
    if (this.rates.size >= 10000 && !this.rates.has(key)) throw new Problem('Authentication is temporarily busy.', 503);
    this.rates.set(key, entry);
  }
  challenge({ address, chainId }, client = 'unknown') {
    this.limit(client);
    if (chainId !== 1) throw new Problem('Sign in with Ethereum mainnet.');
    try { address = getAddress(address); } catch { throw new Problem('A valid wallet address is required.'); }
    const id = random(), nonce = randomBytes(16).toString('hex'), issued = this.now(), expires = issued + 300_000;
    const message = `${this.domain} wants you to sign in with your Ethereum account:\n${address}\n\nSign in to Veyl. This signature does not authorize a transaction or spending.\n\nURI: ${this.origin}\nVersion: 1\nChain ID: 1\nNonce: ${nonce}\nIssued At: ${new Date(issued).toISOString()}\nExpiration Time: ${new Date(expires).toISOString()}\nRequest ID: ${id}`;
    if (this.state.challenges.length >= this.maxChallenges) throw new Problem('Authentication is temporarily busy.', 503);
    this.state.challenges.push({ id, address, message, expires }); this.save();
    return { id, message, expiresAt: new Date(expires).toISOString() };
  }
  async authenticate({ id, signature }, client = 'unknown') {
    this.limit(client);
    const challenge = this.state.challenges.find(c => c.id === id);
    if (!challenge || challenge.expires <= this.now() || this.verifying.has(id)) throw new Problem('Sign-in challenge expired or already used.', 401);
    if (typeof signature !== 'string' || !/^0x[a-fA-F0-9]{130}$/.test(signature)) throw new Problem('Invalid wallet signature.', 401);
    this.verifying.add(id);
    try {
      let valid = false;
      // Correct-length hex can still have invalid ECDSA scalars or recovery bits.
      // The local verifier throws for these inputs; they are rejected sign-ins.
      try { valid = await this.verify({ address: challenge.address, message: challenge.message, signature }); } catch {}
      if (!valid) throw new Problem('Invalid wallet signature.', 401);
      if (challenge.expires <= this.now()) throw new Problem('Sign-in challenge expired.', 401);
      if (this.state.sessions.length >= this.maxSessions) throw new Problem('Active session capacity has been reached. Try again later.', 503);
      const token = random(), csrf = random();
      this.state.challenges = this.state.challenges.filter(c => c.id !== id);
      // Bound sessions per address and keep other devices independently revocable.
      const previous = this.state.sessions.filter(s => s.address === challenge.address).sort((a, b) => a.expires - b.expires);
      const remove = new Set(previous.slice(0, Math.max(0, previous.length - 9)).map(s => s.hash));
      this.state.sessions = this.state.sessions.filter(s => !remove.has(s.hash));
      const session = { hash: digest(token), address: challenge.address, csrf, expires: this.now() + 86400_000 };
      this.state.sessions.push(session); this.save();
      return { token, address: session.address, csrf, expiresAt: new Date(session.expires).toISOString() };
    } finally { this.verifying.delete(id); }
  }
  session(cookie) {
    if (!this.healthy) throw new Problem('Authentication persistence is blocked.', 503);
    const token = cookieToken(cookie); if (!token) return null;
    const hash = digest(token), session = this.state.sessions.find(s => equalSecret(s.hash, hash));
    return session && session.expires > this.now() ? session : null;
  }
  require(cookie, csrf) {
    const session = this.session(cookie); if (!session) throw new Problem('Sign in with your wallet.', 401);
    if (csrf !== undefined && !equalSecret(session.csrf, csrf)) throw new Problem('Invalid session request.', 403);
    return session;
  }
  logout(cookie, csrf) { const session = this.require(cookie, csrf); this.state.sessions = this.state.sessions.filter(s => s !== session); this.save(); }
}
