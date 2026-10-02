import { Problem } from './agent.mjs';

export function activityQuery(url) {
  const query = url.searchParams;
  if ([...query.keys()].some(name => !['before', 'limit'].includes(name)) || ['before', 'limit'].some(name => query.getAll(name).length > 1)) throw new Problem('Unsupported activity query.');
  const limit = query.get('limit'), before = query.get('before');
  if (limit !== null && (!/^[1-9]\d{0,2}$/.test(limit) || Number(limit) > 100)) throw new Problem('Activity limit must be between one and 100.');
  if (before !== null && (!/^[a-zA-Z0-9_-]{1,400}$/.test(before))) throw new Problem('Invalid activity cursor.');
  return { ...(limit === null ? {} : { limit: Number(limit) }), ...(before === null ? {} : { before }) };
}
