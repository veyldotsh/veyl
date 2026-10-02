import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getAddress } from 'viem';
import { SealedState } from './encrypted-state.mjs';
import { Problem } from './agent.mjs';

export const DEVELOPER_SCOPES = Object.freeze(['read', 'jobs', 'memory', 'drafts']);
export const DEVELOPER_BEARER = /^Bearer (veyl_sk_[a-f0-9]{64})$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const uuid = value => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value || '');
const publicKey = record => { const { hash, owner, ...metadata } = record; return structuredClone(metadata); };
function validScopes(scopes) { return Array.isArray(scopes) && scopes.length > 0 && scopes.length <= DEVELOPER_SCOPES.length && new Set(scopes).size === scopes.length && scopes.every(scope => DEVELOPER_SCOPES.includes(scope)); }

/** One bounded encrypted registry; only hashes of 256-bit bearer secrets persist.
 * Lookup is indexed by hash, and no client-provided wallet/project selects a tenant.
 * Issuance and revocation are exclusively wallet-session routes in production. */
export class DeveloperKeys {
  constructor({ file, key, now = Date.now, maxKeys = 10000, maxActivePerProject = 10, maxActivePerOwner = 50 } = {}) {
    this.now = now; this.maxKeys = maxKeys; this.maxActivePerProject = maxActivePerProject; this.maxActivePerOwner = maxActivePerOwner;
    if (![maxKeys, maxActivePerProject, maxActivePerOwner].every(n => Number.isSafeInteger(n) && n > 0) || maxKeys > 10000) throw new Error('Invalid developer-key capacity.');
    this.store = new SealedState(file, key, 'developer-api-keys', { version: 1, keys: [] });
    const state = this.store.data;
    if (state.version !== 1 || !Array.isArray(state.keys) || state.keys.length > maxKeys || Object.keys(state).some(k => !['version', 'keys'].includes(k))) throw new Error('Invalid developer-key registry.');
    this.byHash = new Map(); this.byId = new Map(); this.byOwner = new Map(); this.rates = new Map();
    for (const record of state.keys) {
      if (Object.keys(record).sort().join(',') !== 'createdAt,expiresAt,hash,id,name,owner,projectId,revokedAt,scopes' || !uuid(record.id) || !uuid(record.projectId) || !/^0x[a-f0-9]{40}$/.test(record.owner || '') || !/^[a-f0-9]{64}$/.test(record.hash || '') || !validScopes(record.scopes) || typeof record.name !== 'string' || !record.name.trim() || record.name.length > 80 || ![record.createdAt, record.expiresAt].every(Number.isSafeInteger) || record.expiresAt <= record.createdAt || record.expiresAt - record.createdAt > 90 * 86400000 || !(record.revokedAt === null || Number.isSafeInteger(record.revokedAt)) || this.byHash.has(record.hash) || this.byId.has(record.id)) throw new Error('Invalid developer-key record.');
      this.index(record);
    }
  }
  index(record) {
    this.byHash.set(record.hash, record); this.byId.set(record.id, record);
    const records = this.byOwner.get(record.owner) || []; records.push(record); this.byOwner.set(record.owner, records);
  }
  assertHealthy() { if (!this.store.healthy) throw new Problem('Developer-key persistence is blocked.', 503); }
  save() { try { this.store.save(); } catch { throw new Problem('Developer-key persistence is blocked.', 503); } }
  list(owner, projectId) { this.assertHealthy(); const records = this.byOwner.get(getAddress(owner).toLowerCase()) || []; return records.filter(record => record.projectId === projectId).map(publicKey); }
  issue(owner, projectId, input = {}) {
    this.assertHealthy(); owner = getAddress(owner).toLowerCase();
    if (!uuid(projectId) || Object.keys(input).some(k => !['name', 'scopes', 'expiresInDays'].includes(k)) || typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 80 || /[\u0000-\u001f]/.test(input.name) || !validScopes(input.scopes)) throw new Problem('Choose a key name and only supported project scopes.');
    const days = input.expiresInDays === undefined ? 30 : input.expiresInDays;
    if (!Number.isInteger(days) || days < 1 || days > 90) throw new Problem('Key expiry must be 1–90 days.');
    const now = this.now(), records = this.byOwner.get(owner) || [], active = records.filter(r => r.revokedAt === null && r.expiresAt > now);
    if (this.store.data.keys.length >= this.maxKeys || active.length >= this.maxActivePerOwner || active.filter(r => r.projectId === projectId).length >= this.maxActivePerProject) throw new Problem('Developer-key capacity reached. Revoke unused active keys or preserve and archive the registry.', 409);
    const token = 'veyl_sk_' + randomBytes(32).toString('hex');
    const record = { id: randomUUID(), hash: digest(token), owner, projectId, name: input.name.trim(), scopes: [...input.scopes].sort(), createdAt: now, expiresAt: now + days * 86400000, revokedAt: null };
    this.store.data.keys.push(record); this.save(); this.index(record);
    return { key: publicKey(record), token };
  }
  revoke(owner, projectId, keyId) {
    this.assertHealthy(); const record = this.byId.get(keyId);
    if (!record || record.owner !== getAddress(owner).toLowerCase() || record.projectId !== projectId) throw new Problem('Developer key not found.', 404);
    if (record.revokedAt === null) { record.revokedAt = this.now(); this.save(); }
    return { key: publicKey(record) };
  }
  limit(id, max) {
    const now = this.now();
    // Bounded even for attackers presenting many distinct invalid credentials.
    if (this.rates.size >= 4096) for (const [key, value] of this.rates) if (value.until <= now) this.rates.delete(key);
    let value = this.rates.get(id);
    if (!value || value.until <= now) { if (!value && this.rates.size >= 4096) throw new Problem('Developer authentication is temporarily busy.', 503); value = { until: now + 60000, count: 0 }; this.rates.set(id, value); }
    if (++value.count > max) throw new Problem('Developer request limit reached. Try again in a minute.', 429);
  }
  authenticate(authorization, client = 'unknown') {
    this.assertHealthy(); this.limit('client:' + digest(String(client)), 180);
    const match = typeof authorization === 'string' && DEVELOPER_BEARER.exec(authorization);
    const record = match && this.byHash.get(digest(match[1]));
    if (!record || record.revokedAt !== null || record.expiresAt <= this.now()) throw new Problem('Invalid, expired or revoked developer key.', 401);
    this.limit('key:' + record.id, 60);
    return { keyId: record.id, address: record.owner, projectId: record.projectId, scopes: [...record.scopes] };
  }
}
