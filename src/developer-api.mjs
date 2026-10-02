import { randomUUID } from 'node:crypto';
import { Problem } from './agent.mjs';
import { AGENT_TOOL_SCHEMAS } from './agent-tools.mjs';
import { activityQuery } from './api-queries.mjs';

const pick = (value, names) => Object.fromEntries(names.filter(name => value[name] !== undefined).map(name => [name, value[name]]));
const requestKey = value => typeof value === 'string' && /^[a-zA-Z0-9-]{16,80}$/.test(value);
const schema = (body, required, optional = []) => { if (required.some(name => !Object.hasOwn(body, name)) || Object.keys(body).some(name => ![...required, ...optional].includes(name))) throw new Problem('Request fields do not match this developer endpoint.'); };
const requireScope = (identity, scope) => { if (!identity.scopes.includes(scope)) { const error = new Problem(`This developer key requires the ${scope} scope.`, 403); error.code = 'INSUFFICIENT_SCOPE'; throw error; } };
const projectFields = ['id', 'name', 'symbol', 'purpose', 'template', 'swarm', 'status', 'model', 'policy', 'committed', 'days', 'schedule', 'createdAt'];

/** Explicit fixed-project allowlist. No route delegates to the owner router.
 * Budget, memory/storage and tool caps remain those of the original Kit. */
export async function developerRequest({ identity, method, url, body, registry, kit }) {
  const base = '/api/developer/v1/', route = url.pathname.slice(base.length);
  if (!url.pathname.startsWith(base)) throw new Problem('Not found.', 404);
  const project = kit.project(identity.projectId);
  const query = [...url.searchParams.keys()];
  if (query.length && !(method === 'GET' && (route === 'activity' || route === 'jobs' && query.length === 1 && query[0] === 'requestKey' && requestKey(url.searchParams.get('requestKey'))))) throw new Problem('Unsupported developer query.');
  if (method === 'GET') {
    requireScope(identity, 'read');
    if (route === 'project') return { status: 200, body: { project: { ...pick(project, projectFields), capabilities: { apiVersion: 1, scopes: identity.scopes, inference: 'per-project-zkapi', jobsUseProjectTools: true, publishing: false, transactions: false, settlementReconciliation: kit.provider?.mode === 'zkapi' ? 'authenticated-native-call-receipts' : false, settlement: 'Exact ETH charges require matching native receipts. Unknown and legacy caps stay reserved; USD values use the original quote.' }, tools: AGENT_TOOL_SCHEMAS } } };
    if (route === 'models') return { status: 200, body: { models: await registry.catalog(identity.address, project.id) } };
    if (route === 'jobs') { const jobs = kit.store.data.jobs.filter(job => job.projectId === project.id && (!query.length || job.requestKey === url.searchParams.get('requestKey'))); return { status: 200, body: { jobs: jobs.slice(-100).map(job => pick(job, ['id', 'requestKey', 'projectId', 'prompt', 'model', 'mode', 'status', 'at', 'finishedAt', 'day', 'cap', 'reservation', 'artifactId', 'error'])), hasMore: jobs.length > 100 } }; }
    if (/^jobs\/[a-f0-9-]{36}$/.test(route)) {
      const job = kit.store.data.jobs.find(job => job.projectId === project.id && job.id === route.slice(5));
      if (!job) throw new Problem('Job not found.', 404);
      return { status: 200, body: { job, artifact: project.artifacts.find(artifact => artifact.id === job.artifactId && artifact.jobId === job.id) || null } };
    }
    if (route === 'memory') return { status: 200, body: { memory: project.notes } };
    if (route === 'research') return { status: 200, body: kit.research.snapshot(project.id) };
    if (route === 'autonomy') return { status: 200, body: kit.autonomy.snapshot(project.id) };
    if (route === 'activity') return { status: 200, body: kit.activity.snapshot(project.id, activityQuery(url)) };
    if (route === 'drafts') { const drafts = registry.social(identity.address, project.id).snapshot().outbox; return { status: 200, body: { drafts: drafts.slice(-100), hasMore: drafts.length > 100 } }; }
  }
  if (method === 'POST' && route === 'jobs') {
    requireScope(identity, 'jobs'); schema(body, ['requestKey', 'prompt']);
    registry.resources.assertCapacity();
    return { status: 202, body: { job: await kit.submit(project.id, body) } };
  }
  if (method === 'POST' && (route === 'research/watchlists' || /^research\/watchlists\/[a-f0-9-]{36}(?:\/checks)?$/.test(route))) {
    requireScope(identity, 'jobs');
    const fields = ['name', 'brief', 'sources', 'enabled', 'cadenceMinutes', 'reviewerModel'];
    if (route === 'research/watchlists') schema(body, ['requestKey', ...fields.slice(0, 5)], ['reviewerModel']);
    else if (route.endsWith('/checks')) schema(body, ['requestKey']);
    else schema(body, [], fields);
    kit.store.assertHealthy(); registry.resources.assertCapacity();
    if (route === 'research/watchlists') return { status: 201, body: { watchlist: await kit.research.create(project.id, body) } };
    const watchId = route.split('/')[2];
    if (route.endsWith('/checks')) return { status: 200, body: { check: await kit.research.check(project.id, watchId, body) } };
    return { status: 200, body: { watchlist: await kit.research.update(project.id, watchId, body) } };
  }
  if (method === 'POST' && route === 'memory') {
    requireScope(identity, 'memory'); schema(body, ['requestKey', 'content']); kit.store.assertHealthy();
    if (!requestKey(body.requestKey) || typeof body.content !== 'string' || !body.content.trim() || body.content.trim().length > 8000 || body.content.includes('\0')) throw new Problem('Memory requires a unique request key and 1–8,000 characters.');
    const content = body.content.trim(), existing = project.notes.find(note => note.requestKey === body.requestKey);
    if (existing) { if (existing.content !== content) throw new Problem('Request key already used for different memory.', 409); return { status: 201, body: { memory: existing } }; }
    if (project.notes.length >= 100) throw new Problem('Memory limit reached.');
    registry.resources.assertCapacity();
    const note = { id: randomUUID(), content, at: kit.now().toISOString(), requestKey: body.requestKey };
    kit.store.assertCapacity(Buffer.byteLength(JSON.stringify(note)) + 128); project.notes.push(note); kit.store.save();
    return { status: 201, body: { memory: note } };
  }
  if (method === 'POST' && route === 'drafts') {
    requireScope(identity, 'drafts'); schema(body, ['channel', 'text', 'idempotencyKey'], ['madeWithAi']);
    kit.store.assertHealthy(); registry.resources.assertCapacity();
    return { status: 201, body: { draft: await registry.social(identity.address, project.id).draft(body) } };
  }
  throw new Problem('Developer endpoint not found. Keys cannot authorize funding, settings, publishing or transactions.', 404);
}
