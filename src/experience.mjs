import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getAddress } from 'viem';
import { SealedState } from './encrypted-state.mjs';
import { Problem } from './agent.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ownerAddress = owner => getAddress(owner).toLowerCase();
const iso = value => new Date(value).toISOString();
const projectId = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const text = (value, max, label) => { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Problem(`Invalid ${label}.`); return value.trim(); };
const fields = (value, allowed) => { if (!isObject(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Problem('Unexpected request fields.'); };

/** Private, deterministic notices. Collection reads saved state only. */
export class ExperienceNotifications {
  #store; #owner; #now; #seen;
  constructor({ file, key, owner, now = Date.now } = {}) {
    this.#owner = ownerAddress(owner); this.#now = now;
    this.#store = new SealedState(file, key, `notifications:${this.#owner}`, { version: 1, owner: this.#owner, notifications: [], seen: [] });
    const s = this.#store.data;
    if (s.version !== 1 || s.owner !== this.#owner || !Array.isArray(s.notifications) || s.notifications.length > 100 || !Array.isArray(s.seen) || s.seen.length > 32768 || new Set(s.seen).size !== s.seen.length || s.seen.some(id => !/^[a-f0-9]{64}$/.test(id)) || s.notifications.some(item => !s.seen.includes(item.id) || !projectId(item.projectId) || !Number.isFinite(Date.parse(item.at)) || (item.readAt !== null && !Number.isFinite(Date.parse(item.readAt))))) throw new Problem('Private notification state needs recovery.', 503);
    this.#seen = new Set(s.seen);
  }
  get healthy() { return this.#store.healthy; }
  snapshot() { return { notifications: structuredClone(this.#store.data.notifications).reverse(), unread: this.#store.data.notifications.filter(item => item.readAt === null).length, capacityReached: this.#seen.size >= 32768 }; }
  sync({ projects = [], jobs = [], socialSnapshots = [] } = {}) {
    if (!this.#store.healthy) throw new Problem('Notification persistence is blocked.', 503);
    const candidates = [], ids = new Set(projects.map(p => p.id));
    const add = (id, kind, project, title, message, at) => { if (ids.has(project) && Number.isFinite(Date.parse(at))) candidates.push({ id: hash([kind, project, id]), kind, projectId: project, title, message, at: iso(at), readAt: null }); };
    for (const job of jobs) {
      if (job.autonomy) continue; // One terminal-cycle notice covers its several jobs.
      if (job.status === 'completed') add(job.id, job.research ? 'research-completed' : 'job-completed', job.projectId, job.research?.kind === 'review' ? 'Research review ready' : job.research ? 'Research report ready' : 'Task complete', 'A saved result is ready in Deliverables.', job.finishedAt || job.at);
      if (job.status === 'interrupted') add(job.id, /budget|allowance|spending/i.test(job.error || '') ? 'budget-blocked' : 'job-interrupted', job.projectId, 'Task needs attention', 'Inspect the saved task and any unresolved spending reservations before starting replacement work.', job.finishedAt || job.at);
    }
    const now = iso(this.#now()), day = now.slice(0, 10);
    for (const p of projects) {
      if ([p.policy?.total, p.policy?.daily, p.policy?.request, p.committed].every(Number.isSafeInteger) && p.policy.total > 0 && p.policy.daily > 0 && p.policy.request > 0 && p.committed >= 0) {
        const remainingTotal = Math.max(0, p.policy.total - p.committed), remainingDaily = Math.max(0, p.policy.daily - (p.days?.[day] || 0));
        if (remainingTotal <= Math.max(p.policy.request, Math.floor(p.policy.total / 10)) || remainingDaily <= Math.max(p.policy.request, Math.floor(p.policy.daily / 10))) {
          add(hash([day, p.policy.total, p.policy.daily, p.policy.request]), 'low-budget', p.id, 'Inference budget is low', `$${(remainingTotal / 1e6).toFixed(6)} total and $${(remainingDaily / 1e6).toFixed(6)} today remain available after existing reservations. Review Runtime limits and unresolved charges.`, now);
        }
      }
      for (const cycle of p.autonomy?.cycles || []) {
        if (cycle.status === 'completed') add(cycle.id, 'autonomy-completed', p.id, 'Autonomous research ready', 'A completed cycle and its saved results are ready in Activity and Deliverables.', cycle.finishedAt || cycle.at);
        if (['blocked', 'interrupted'].includes(cycle.status)) add(cycle.id, /budget|allowance|spending/i.test(cycle.error || '') ? 'budget-blocked' : 'autonomy-blocked', p.id, 'Autonomous research needs attention', 'Inspect the saved cycle, policy and any unresolved reservations before starting replacement work.', cycle.finishedAt || cycle.at);
      }
    }
    for (const p of projects) for (const check of p.research?.checks || []) {
      if (check.status === 'error') add(check.id, 'source-failed', p.id, 'Source check failed', 'A source could not be read. The previous baseline was retained.', check.finishedAt || check.startedAt);
      for (const kind of ['report', 'review']) if (check[kind]?.status === 'blocked') add(`${check.id}:${kind}`, /budget|allowance|spending/i.test(check[kind].error || '') ? 'budget-blocked' : 'research-blocked', p.id, 'Research needs attention', 'A report or review could not be admitted. Check Runtime and Research before trying new work.', check[kind].attemptedAt || check.finishedAt || check.startedAt);
    }
    for (const social of socialSnapshots) {
      for (const [channel, account] of Object.entries(social.accounts || {})) if (account?.status === 'reconnect_required') add(account.connectionId, 'connection-failed', social.projectId, 'Reconnect a social account', `The ${channel === 'x' ? 'X' : 'Telegram'} connection needs authorization before it can publish.`, iso(account.connectedAt));
      for (const item of social.outbox || []) if (['failed', 'unknown'].includes(item.status)) add(`${item.id}:${item.status}`, 'publication-attention', social.projectId, 'Publication needs attention', item.status === 'unknown' ? 'The provider outcome is unknown. Inspect the destination before preparing a replacement.' : 'The provider rejected a publication. Inspect its saved status.', iso(item.attemptedAt || item.createdAt));
    }
    let changed = false;
    for (const item of candidates.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))) {
      if (this.#seen.has(item.id) || this.#seen.size >= 32768) continue;
      this.#seen.add(item.id); this.#store.data.seen.push(item.id); this.#store.data.notifications.push(item); changed = true;
    }
    if (changed) { this.#store.data.notifications = this.#store.data.notifications.slice(-100); this.#store.save(); }
    return this.snapshot();
  }
  ack(input) {
    fields(input, ['id']);
    if (typeof input.id !== 'string' || (input.id !== 'all' && !/^[a-f0-9]{64}$/.test(input.id))) throw new Problem('Choose a notification to mark read.');
    const items = this.#store.data.notifications.filter(item => input.id === 'all' || item.id === input.id);
    if (input.id !== 'all' && !items.length) throw new Problem('Notification not found.', 404);
    let changed = false; for (const item of items) if (item.readAt === null) { item.readAt = iso(this.#now()); changed = true; }
    if (changed) this.#store.save(); return this.snapshot();
  }
}

/** Opt-in immutable-content snapshots. No private project is exposed by lookup. */
export class ShowcaseDirectory {
  #store; #projectForOwner; #origin; #now;
  constructor({ file, key, projectForOwner, origin = 'https://veyl.sh', now = Date.now } = {}) {
    if (typeof projectForOwner !== 'function') throw new TypeError('An owner-scoped project resolver is required.');
    const url = new URL(origin); if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new TypeError('Use the public HTTPS origin.');
    this.#origin = url.origin; this.#projectForOwner = projectForOwner; this.#now = now;
    this.#store = new SealedState(file, key, 'public-showcase-directory', { version: 1, pages: [], audit: [] });
    const s = this.#store.data;
    if (s.version !== 1 || !Array.isArray(s.pages) || s.pages.length > 100 || !Array.isArray(s.audit) || s.audit.length > 200 || Buffer.byteLength(JSON.stringify(s)) > 8 * 1024 * 1024 || s.pages.some(page => !projectId(page.projectId) || !/^0x[a-f0-9]{40}$/.test(page.owner) || !/^[A-Za-z0-9_-]{24}$/.test(page.slug) || typeof page.active !== 'boolean' || !isObject(page.public) || !Array.isArray(page.public.artifacts))) throw new Problem('Public showcase state needs recovery.', 503);
  }
  get healthy() { return this.#store.healthy; }
  #project(owner, id) { if (!projectId(id)) throw new Problem('Invalid project.'); const p = this.#projectForOwner(ownerAddress(owner), id); if (!p || p.id !== id) throw new Problem('Project not found.', 404); return p; }
  #owned(row) { return row?.active ? { slug: row.slug, url: `${this.#origin}/agents/${row.slug}`, title: row.public.title, description: row.public.description, artifactIds: row.public.artifacts.map(item => item.id), updatedAt: row.public.updatedAt } : null; }
  owned(owner, id) { this.#project(owner, id); return { showcase: this.#owned(this.#store.data.pages.find(row => row.owner === ownerAddress(owner) && row.projectId === id)) }; }
  publish(owner, input) {
    fields(input, ['projectId', 'title', 'description', 'artifactIds']); owner = ownerAddress(owner);
    const p = this.#project(owner, input.projectId), title = text(input.title, 100, 'public title'), description = text(input.description, 600, 'public description');
    if (!Array.isArray(input.artifactIds) || input.artifactIds.length < 1 || input.artifactIds.length > 5 || new Set(input.artifactIds).size !== input.artifactIds.length) throw new Problem('Select one to five saved results.');
    const artifacts = input.artifactIds.map((id, index) => {
      if (!projectId(id)) throw new Problem('Invalid saved result.');
      const artifact = p.artifacts.find(item => item.id === id);
      if (!artifact || !['demo', 'zkapi'].includes(artifact.mode) || typeof artifact.content !== 'string' || !artifact.content.trim() || artifact.content.length > 32000 || !Number.isFinite(Date.parse(artifact.at))) throw new Problem('Selected saved result was not found or cannot be shared.', 404);
      // Saved titles are often copied from private prompts. Never export them.
      return { id, title: `Result ${index + 1}`, content: artifact.content, at: artifact.at, mode: artifact.mode };
    });
    let row = this.#store.data.pages.find(item => item.owner === owner && item.projectId === p.id);
    const at = iso(this.#now()), slug = row?.active ? row.slug : randomBytes(18).toString('base64url');
    const page = { slug, title, description, artifacts, publishedAt: row?.active ? row.public.publishedAt : at, updatedAt: at };
    if (Buffer.byteLength(JSON.stringify(page)) > 98304) throw new Problem('Selected public results exceed the 96 KB page limit. Share fewer or shorter results.', 413);
    if (!row && this.#store.data.pages.length >= 100) throw new Problem('Public page capacity reached.', 409);
    const next = { owner, projectId: p.id, slug, active: true, public: page };
    const state = { ...this.#store.data, pages: [...this.#store.data.pages.filter(item => item !== row), next], audit: [...this.#store.data.audit, { id: randomUUID(), action: row?.active ? 'update' : 'publish', owner, projectId: p.id, slug, at }].slice(-200) };
    if (Buffer.byteLength(JSON.stringify(state)) > 8 * 1024 * 1024) throw new Problem('Public page storage capacity reached.', 507);
    this.#store.data = state; this.#store.save(); return { showcase: this.#owned(next) };
  }
  revoke(owner, input) {
    fields(input, ['projectId']); owner = ownerAddress(owner); this.#project(owner, input.projectId);
    const row = this.#store.data.pages.find(item => item.owner === owner && item.projectId === input.projectId);
    if (row?.active) { row.active = false; row.public.artifacts = []; this.#store.data.audit.push({ id: randomUUID(), action: 'revoke', owner, projectId: input.projectId, slug: row.slug, at: iso(this.#now()) }); this.#store.data.audit = this.#store.data.audit.slice(-200); this.#store.save(); }
    return { showcase: null };
  }
  public(slug) {
    if (typeof slug !== 'string' || !/^[A-Za-z0-9_-]{24}$/.test(slug)) throw new Problem('Public agent page not found.', 404);
    if (!this.#store.healthy) throw new Problem('Public page storage needs recovery.', 503);
    const row = this.#store.data.pages.find(item => item.active && item.slug === slug);
    if (!row) throw new Problem('Public agent page not found.', 404);
    const page = row.public;
    return { page: { slug: page.slug, title: page.title, description: page.description, publishedAt: page.publishedAt, updatedAt: page.updatedAt, artifacts: page.artifacts.map(({ id, title, content, at, mode }) => ({ id, title, content, at, mode })) } };
  }
}
